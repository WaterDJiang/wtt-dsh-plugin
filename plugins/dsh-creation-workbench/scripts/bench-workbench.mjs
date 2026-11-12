import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const { values } = parseArgs({ options: {
  cards: { type: 'string', default: '100' },
  samples: { type: 'string', default: '7' },
  module: { type: 'string', default: process.cwd() },
  json: { type: 'string' },
  check: { type: 'boolean', default: false },
  baseline: { type: 'string' },
} });
const cards = Number(values.cards), samples = Number(values.samples);
assert(Number.isInteger(cards) && cards >= 10 && cards <= 1000, '--cards 为 10 至 1000');
assert(Number.isInteger(samples) && samples >= 7 && samples <= 30, '--samples 为 7 至 30');
const { WorkbenchService } = await import(pathToFileURL(path.resolve(values.module, 'src/service.mjs')));
const root = await mkdtemp(path.join(tmpdir(), 'wtt-perf-fixture-'));
const heading = '# 合成性能样本\n\n';
const body = heading + 'x'.repeat(8192 - Buffer.byteLength(heading));
let service;
try {
  service = new WorkbenchService({ workspaceRoot: root });
  await writeFile(path.join(root, '共享资料.md'), '# 跨画布共享\n' + '合成文件。'.repeat(30_000));
  const canvases = [];
  for (let canvas = 0; canvas < 3; canvas++) {
    const { id } = service.store.createCanvas({ title: '基准画布 ' + canvas, operationId: randomUUID() });
    const shared = await service.projectFiles.preview('共享资料.md');
    await service.projectFiles.reference({ requirementId: id, path: shared.path, hash: shared.hash,
      position: { x: 40, y: 40 }, operationId: randomUUID() });
    for (let index = 1; index < cards; index++) {
      if (index % 10) {
        service.canvas.addMaterial({ requirementId: id, title: '合成素材 ' + index,
          content: body, operationId: randomUUID() });
      } else {
        const { task, prepared } = service.createTask({ requirementId: id, instruction: '合成成果 ' + index,
          outputType: 'text', selectedCardIds: [], sourceRefs: [], selectedSkills: [],
          generation: { mode: 'new' }, operationId: randomUUID(), outputPosition: { x: 420, y: index * 300 } });
        const file = path.join(prepared.deliveryDirectory, '合成成果.md');
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), body);
        const sessionId = 'benchmark:' + task.id;
        service.tasks.bindSession({ taskId: task.id, sessionId });
        await service.tasks.files.register({ taskId: task.id, path: file, title: '合成成果 ' + index,
          kind: 'text', primary: true, operationId: randomUUID() }, { sessionId });
      }
    }
    canvases.push(id);
  }
  const requirementId = canvases[0];
  let board = service.canvas.getBoard(requirementId);
  assert.equal(board.nodes.length, cards);
  const shared = board.nodes.find(node => node.projectFile);
  const selections = [{ nodeId: shared.id }];
  const counters = { reads: 0, bytes: 0, queries: 0, boards: 0 };
  const originalRead = fs.readFileSync;
  fs.readFileSync = function (...args) {
    const value = originalRead.apply(this, args);
    counters.reads++;
    counters.bytes += Buffer.byteLength(value);
    return value;
  };
  syncBuiltinESMExports();
  const prepare = service.store.db.prepare.bind(service.store.db);
  service.store.db.prepare = (...args) => { counters.queries++; return prepare(...args); };
  const getRawBoard = service.canvas.getRawBoard.bind(service.canvas);
  service.canvas.getRawBoard = (...args) => { counters.boards++; return getRawBoard(...args); };

  const results = {};
  function measure(name, operation, setup, cleanup) {
    const times = [], costs = [];
    for (let round = 0; round <= samples; round++) {
      const input = setup?.();
      for (const key of Object.keys(counters)) counters[key] = 0;
      const start = performance.now();
      const result = operation(input);
      const elapsed = performance.now() - start;
      if (round) { times.push(elapsed); costs.push({ ...counters }); }
      cleanup?.(result);
    }
    times.sort((a, b) => a - b);
    results[name] = { medianMs: +times[Math.floor(times.length / 2)].toFixed(2),
      p95Ms: +times[Math.ceil(times.length * 0.95) - 1].toFixed(2),
      cost: Object.fromEntries(Object.keys(counters).map(key => [key, Math.round(costs.reduce((n, cost) => n + cost[key], 0) / costs.length)])) };
  }
  measure('boardRead', () => { board = service.canvas.getBoard(requirementId); return board; });
  measure('serialize', () => JSON.stringify(board));
  measure('deliverableSync', () => service.deliverables.sync(requirementId));
  const positions = Object.fromEntries(board.nodes.map(node => [node.id, node.position]));
  measure('layoutSave', () => {
    positions[shared.id] = { ...positions[shared.id], x: positions[shared.id].x + 1 };
    board = service.canvas.saveBoard({ requirementId, expectedRevision: board.revision, positions, viewport: board.viewport });
    return board;
  });
  measure('deletePlan', () => {
    const plan = service.recycle.plan({ requirementId, selections });
    assert.equal(plan.files.find(file => file.path === '共享资料.md').references.length, 2);
    return plan;
  });
  measure('removeNode', plan => service.recycle.remove({ planId: plan.id }),
    () => service.recycle.plan({ requirementId, selections }),
    result => service.recycle.restore({ entryId: result.id }));
  const report = { schema: 1, dataset: 1, environment: { node: process.version, platform: process.platform, arch: process.arch },
    cards, canvases: 3, samples, bodyBytes: Buffer.byteLength(body),
    responseBytes: Buffer.byteLength(JSON.stringify(board)), results };
  if (values.json) await writeFile(values.json, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (values.check) {
    for (const name of ['deletePlan', 'removeNode']) {
      assert(results[name].cost.boards <= 1, name + ' 不应重建其他画布或重复读取当前画布');
    }
    for (const [name, limit] of Object.entries({ boardRead: 500, layoutSave: 500, deletePlan: 300, removeNode: 300 })) {
      assert(results[name].p95Ms <= limit, name + ' p95 超过 ' + limit + 'ms');
    }
  }
  if (values.baseline) {
    const baseline = JSON.parse(fs.readFileSync(values.baseline, 'utf8'));
    assert.equal(baseline.dataset, report.dataset, '数据集版本不同');
    assert.equal(baseline.cards, cards, '卡片规模不同');
    assert.equal(baseline.bodyBytes, report.bodyBytes, '正文大小不同');
    assert.equal(baseline.canvases, report.canvases, '画布数量不同');
    assert.equal(baseline.samples, report.samples, '采样次数不同');
    assert.deepEqual(baseline.environment, report.environment, '运行环境不同');
    for (const [name, result] of Object.entries(results)) {
      const old = baseline.results[name].medianMs;
      assert(!(result.medianMs > old * 1.2 && result.medianMs - old >= 20), name + ' 中位数退步超过 20% 且至少增加 20ms');
    }
  }
} finally {
  service?.close();
  await rm(root, { recursive: true, force: true });
}
