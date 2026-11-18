// Synthetic, local-only workload for project-agent state, search and recovery.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkbenchService } from '../src/service.mjs';
import { ProjectAgent } from '../src/project-agent.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'wtt-project-audit-'));
const service = new WorkbenchService({ workspaceRoot: root });
const sends = [];
let stopAttempts = 0;
const host = {
  createSession: async () => randomUUID(),
  createTask: async (svc, input, sources, settings, authorized, title) =>
    authorized() && svc.createTask(input, { projectInputs: { sources, settings, title } }),
  prompt: async (_service, _id, prepared) => {
    sends.push(prepared.taskId);
    return { accepted: true };
  },
  stop: async () => {
    if (++stopAttempts === 1) throw Error('模拟 DSH 取消回执暂时不可用');
  },
};
const agent = new ProjectAgent(service, host);
const report = {};
const time = fn => {
  const start = performance.now();
  fn();
  return Math.round((performance.now() - start) * 100) / 100;
};
function measure(fn, samples = 9) {
  fn();
  const times = Array.from({ length: samples }, () => time(fn)).sort((a, b) => a - b);
  return { medianMs: times[Math.floor(samples / 2)], p95Ms: times[Math.ceil(samples * .95) - 1], samples };
}
try {
  const sessionId = (await agent.session()).sessionId;
  const board = service.store.createCanvas({ title: '性能样本', operationId: randomUUID() }).id;
  const refs = [];
  for (let i = 0; i < 300; i++) {
    const { material } = service.canvas.addMaterial({ requirementId: board, title: '素材 ' + i,
      content: 'a'.repeat(8192), operationId: randomUUID() });
    if (i < 24) refs.push({ cardId: 'material:' + material.id, requirementId: board });
  }
  const turn = (mode, selected = []) => agent.turn({ sessionId, requirementId: board,
    refs: selected, mode, text: '整理素材' }).id;
  const step = { title: '脚本', instruction: '写脚本', type: 'text', requirementId: board };
  let reads = 0;
  const getBoard = service.canvas.getBoard.bind(service.canvas);
  service.canvas.getBoard = (...args) => { reads++; return getBoard(...args); };
  const propose = (mode, steps, selected = []) => {
    const id = turn(mode, selected);
    agent.tool(sessionId, 'plan', id, { title: '独立委托', steps });
    return id;
  };
  let selectedPlan, explicitPlan;
  report.planSelected24 = measure(() => { selectedPlan = propose('plan', [step], refs); });
  report.planSelected24.boardReadsPerRun = reads / (1 + report.planSelected24.samples);
  reads = 0;
  report.planExplicit24 = measure(() => { explicitPlan = propose('plan', [{ ...step, refs }]); });
  report.planExplicit24.boardReadsPerRun = reads / (1 + report.planExplicit24.samples);
  service.canvas.getBoard = getBoard;
  const sourceChars = id => agent.steps(id)[0].data.sources.reduce((sum, source) => sum + source.content.length, 0);
  report.frozenContentChars = { selected: sourceChars(selectedPlan), explicit: sourceChars(explicitPlan) };

  const activePlan = propose('auto', [step]);
  await agent.tick();
  assert.equal(sends.length, 1);
  let firstStop, secondStop;
  try { await agent.control({ id: activePlan, command: 'stop' }); } catch (error) { firstStop = error.message; }
  const failedStopState=agent.db.prepare('SELECT state FROM pa_plans WHERE id=?').get(activePlan).state;
  assert.equal(failedStopState,'stopping');
  try { await agent.control({ id: activePlan, command: 'stop' }); } catch (error) { secondStop = error.message; }
  report.cancel = { firstStop, failedStopState, secondStop, stopAttempts, taskStatus: service.tasks.get(sends[0]).dispatchStatus,
    planState: agent.db.prepare('SELECT state FROM pa_plans WHERE id=?').get(activePlan).state };

  const oldest = agent.db.prepare("SELECT id FROM pa_plans WHERE state='approval' ORDER BY rowid LIMIT 1").get().id;
  while (agent.db.prepare("SELECT count(*) AS n FROM pa_plans WHERE state='approval'").get().n < 101) propose('plan', [step]);
  const visible = Array.from({ length: Math.ceil(agent.progress().total / 20) }, (_, page) => agent.plans(page)).flat(), attention = agent.attention();
  report.pending = { actual: 101, listed: visible.filter(p=>p.state==='approval').length, oldestListed: visible.some(p => p.id === oldest),
    notices: attention.filter(e => e.type === 'pending').length, oldestInNotices: attention.some(e => e.key === 'plan:' + oldest) };
  report.listPlans = measure(() => agent.plans());

  const memory = agent.memory;
  memory.event('known', '修正', 'G08 主产物登记', '采访视频可以播放，但无法加入引用。', { cardId: 'G08' }, '2026-06-10');
  report.memory = [];
  let n = 0;
  for (const count of [1000, 10000]) {
    agent.db.exec('BEGIN');
    for (; n < count; n++) {
      const day = '2026-07-' + String(1 + n % 28).padStart(2, '0');
      memory.event('sample-' + n, '制作日志', '镜头验收 ' + n, '核对脚本与画面的衔接，并登记制作结果。'.repeat(8), {}, day);
    }
    agent.db.exec('COMMIT');
    memory.project();
    const query = '之前的视频为何能播放却无法加到引用';
    assert.equal(memory.search(query)[0]?.id, 'known');
    const indexed = measure(() => memory.search('G08'));
    const natural = measure(() => memory.search(query));
    const twoCharacters = measure(() => memory.search('引用'));
    let counter = 0;
    const update = measure(() => {
      memory.event('update-' + count + '-' + counter++, '制作日志', '当日补记', '补记制作决定。', {}, '2026-07-25');
      memory.project();
    });
    report.memory.push({ count, indexed, natural, twoCharacters, update });
  }
  assert.equal(report.cancel.stopAttempts,2);
  assert.equal(report.cancel.planState,'stopped');
  assert.equal(report.planExplicit24.boardReadsPerRun,1);
  assert.equal(report.frozenContentChars.explicit,report.frozenContentChars.selected);
  assert.equal(report.frozenContentChars.explicit,60000);
  assert.equal(report.pending.listed,101);
  assert.equal(report.pending.notices,101);
  assert.ok(report.pending.oldestInNotices&&report.pending.oldestListed);
  // Reopen a fixture with the pre-upgrade schema to measure the one-time cost separately.
  agent.db.exec('DROP TRIGGER pa_index_short; DROP TABLE pa_short_vocab; DROP TABLE pa_short_fts');
  const startMigration = performance.now();
  const upgraded = new ProjectAgent(service, host);
  report.firstUpgradeMs = Number((performance.now() - startMigration).toFixed(2));
  assert.equal(upgraded.memory.search('之前的视频为何能播放却无法加到引用')[0]?.id,'known');
  report.sqliteIntegrity = agent.db.prepare('PRAGMA integrity_check').get().integrity_check;
  report.foreignKeyErrors = agent.db.prepare('PRAGMA foreign_key_check').all().length;
  console.log(JSON.stringify(report, null, 2));
  assert.ok(report.memory.find(sample=>sample.count===10000).natural.p95Ms<100,'万条日志整句检索 p95 超过预算');
  assert.equal(report.sqliteIntegrity,'ok');
  assert.equal(report.foreignKeyErrors,0);
} finally {
  service.close();
  rmSync(root, { recursive: true, force: true });
}
