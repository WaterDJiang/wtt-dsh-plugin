import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchService } from '../src/service.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wtt-batch-')));
  const service = new WorkbenchService({ workspaceRoot: root });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const requirement = service.store.createRequirement({ title: '批量登记技术项目', operationId: randomUUID() });
  const created = service.createTask({ requirementId: requirement.id, outputType: 'text', instruction: '真实文件，非 AI 生成',
    selectedCardIds: [], generation: { mode: 'new' }, operationId: randomUUID() });
  const taskId = created.task.id, sessionId = 'batch-session';
  service.tasks.bindSession({ taskId, sessionId });
  const file = (name, content = '# 内容\n\n保留实际字节', extra = {}) => {
    const relative = `${created.prepared.deliveryDirectory}/${name}`;
    writeFileSync(path.join(root, relative), content);
    return { kind: 'text', title: name, path: relative, operationId: randomUUID(), ...extra };
  };
  const batch = (files, options = {}) => service.tasks.files.registerBatch({ taskId, files }, { sessionId, ...options });
  return { root, service, requirement, created, taskId, sessionId, file, batch };
}

test('20 real files batch once, mirror once, return compact results and preserve one card version on replay/restart', async t => {
  const { root, service, requirement, taskId, file, batch } = fixture(t);
  const files = Array.from({ length: 20 }, (_, i) => file(`${i + 1}.md`, `# 第${i + 1}项`, { primary: i === 0 }));
  const sync = service.deliverables.sync.bind(service.deliverables);
  let calls = 0;
  service.deliverables.sync = (...args) => { calls++; return sync(...args); };
  const result = await batch(files);
  assert.equal(result.ok, true); assert.equal(result.succeeded, 20); assert.equal(calls, 1);
  assert.equal(service.tasks.get(taskId).files.length, 20);
  assert.equal(result.results[0].validation, undefined);
  for (const entry of result.results) {
    assert.equal(entry.delivery.status, 'ready');
    assert.equal(createHash('sha256').update(readFileSync(path.join(root, entry.delivery.path))).digest('hex'), entry.hash);
  }
  const board = service.canvas.getBoard(requirement.id), output = board.nodes.find(n => n.outputCard);
  assert.equal(output.outputCard.versions.length, 1);
  assert.equal(output.outputCard.versions[0].outputs.length, 20);
  const replay = await batch(files);
  assert.deepEqual(replay.results.map(x => x.id), result.results.map(x => x.id));
  assert.equal(service.tasks.get(taskId).files.length, 20);
  service.close();
  const restarted = new WorkbenchService({ workspaceRoot: root });
  try { assert.equal(restarted.tasks.get(taskId).files.length, 20); assert.equal(restarted.canvas.getBoard(requirement.id).nodes.find(n => n.outputCard).outputCard.versions.length, 1); }
  finally { restarted.close(); }
});

test('mixed success reports exact failures, preserves successes and retries only repaired items', async t => {
  const { root, service, taskId, file, batch } = fixture(t);
  const good = file('主文件.md', '# 主文件', { primary: true });
  const empty = file('空文件.md', '', { primary: false });
  const other = file('其他.md', '# 不应登记', { taskId: randomUUID() });
  const escape = { ...file('越界.md'), path: 'outside.md' };
  const first = await batch([good, empty, other, escape]);
  assert.equal(first.ok, false); assert.equal(first.succeeded, 1); assert.equal(first.failed, 3);
  assert.match(first.results[1].error, /非空/);
  assert.match(first.results[2].error, /同一个任务/);
  assert.match(first.results[3].error, /本任务/);
  assert.equal(service.tasks.get(taskId).files.length, 1);
  writeFileSync(path.join(root, empty.path), '# 已修复');
  const retry = await batch([empty]);
  assert.equal(retry.ok, true); assert.equal(service.tasks.get(taskId).files.length, 2);
  writeFileSync(path.join(root, good.path), '# 外改');
  const changed = await batch([good]);
  assert.equal(changed.ok, false); assert.equal(changed.results[0].status, 'changed');
  assert.equal(service.tasks.get(taskId).files.length, 2);
});

test('batch enforces session, size and specialized workflow gates without writing successful artifacts', async t => {
  const { service, taskId, file, batch } = fixture(t);
  const input = file('文件.md');
  await assert.rejects(batch([input], { sessionId: 'foreign' }), /当前会话/);
  await assert.rejects(batch([]), /1–100/);
  await assert.rejects(batch(Array(101).fill(input)), /1–100/);
  const media = await batch([{ ...input, kind: 'image' }]);
  assert.match(media.results[0].error, /媒体/);
  for (const snapshot of [{ outputType: 'pptx', pptEngine: 'baoyu' }, { outputType: 'pptx', workflow: 'ppt-edit' }]) {
    service.store.db.prepare('UPDATE course_tasks SET input_json=? WHERE id=?').run(JSON.stringify(snapshot), taskId);
    const forbidden = await batch([{ ...input, kind: 'pptx' }]);
    assert.equal(forbidden.succeeded, 0);
    assert.match(forbidden.results[0].error, /右栏|待确认/);
  }
  assert.equal(service.tasks.get(taskId).files.length, 0);
});

test('cancellation retains completed item and marks every unexecuted item, with no new registrations on pre-abort', async t => {
  const { service, file, batch, taskId } = fixture(t);
  const controller = new AbortController(), files = [file('1.md'), file('2.md'), file('3.md')];
  const register = service.tasks.files.register.bind(service.tasks.files);
  service.tasks.files.register = async (...args) => { const result = await register(...args); controller.abort(); return result; };
  const result = await batch(files, { signal: controller.signal });
  assert.equal(result.succeeded, 1); assert.equal(result.results[1].skipped, true); assert.equal(result.results[2].skipped, true);
  assert.equal(service.tasks.get(taskId).files.length, 1);
  const aborted = await batch([file('4.md')], { signal: controller.signal });
  assert.equal(aborted.succeeded, 0); assert.equal(service.tasks.get(taskId).files.length, 1);
});

test('mirror failure does not erase successful registration or pretend directory copy succeeded', async t => {
  const { service, file, batch, taskId } = fixture(t);
  service.deliverables.sync = () => { throw new Error('技术夹具：目录只读'); };
  const result = await batch([file('成功登记.md')]);
  assert.equal(result.ok, false); assert.equal(result.succeeded, 1);
  assert.match(result.syncError, /目录只读/);
  assert.equal(service.tasks.get(taskId).files.length, 1);
});
