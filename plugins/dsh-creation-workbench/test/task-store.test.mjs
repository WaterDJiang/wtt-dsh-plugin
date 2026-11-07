import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkbenchService } from '../src/service.mjs';
import { sourceView } from '../src/source-range.mjs';

function fixture(t, config = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'wtt-task-'));
  const service = new WorkbenchService({ ...config, workspaceRoot: root });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const requirement = service.store.createRequirement({ title: '制课任务验收', background: '真实需求背景', operationId: randomUUID() });
  const material = service.canvas.addMaterial({ requirementId: requirement.id, title: '客户资料', content: '用户原文\r\n课堂任务😀\n第三行', operationId: randomUUID() }).material;
  const input = { requirementId: requirement.id, selectedCardIds: [`material:${material.id}`], instruction: '生成课堂任务大纲', operationId: randomUUID() };
  const save = (extra = {}) => service.store.saveOutline({ requirementId: requirement.id, markdown: '# 任务对应大纲\n\n实际保存的正文',
    sourceCardIds: input.selectedCardIds, operationId: randomUUID(), ...extra });
  return { root, service, requirement, material, input, save };
}

test('AI task freezes validated inputs, request identity and prompt; replay never admits a second task', t => {
  const { root, service, requirement, material, input } = fixture(t);
  const { task, prepared } = service.createTask(input);
  assert.equal(task.status, 'draft');
  assert.equal(task.kind, 'ai');
  assert.equal(task.sessionId, null);
  assert.deepEqual(task.artifacts, []);
  assert.equal(task.input.requirement.background, '真实需求背景');
  assert.equal(task.input.sources[0].hash, material.hash);
  assert.equal(task.input.sources[0].content, material.content);
  assert.equal(prepared.taskId, task.id);
  assert.equal(prepared.requestId, task.requestId);
  assert.match(prepared.prompt, new RegExp(task.id));
  writeFileSync(path.join(root, material.path), '原来源已外改');
  assert.deepEqual(service.createTask(input), { task, prepared });
  assert.throws(() => service.createTask({ ...input, instruction: '不同意图' }), /标识已用于不同内容/);
  assert.equal(service.canvas.getBoard(requirement.id).tasks.length, 1);
  assert.equal('input' in service.tasks.list(requirement.id)[0], false);
});

test('task selection validates exact stored source and keeps excerpt annotation separate from original quote', t => {
  const { service, requirement, material, input } = fixture(t);
  const view = sourceView(material.content), start = view.indexOf('课堂任务');
  const selection = { sourceCardId: input.selectedCardIds[0], sourceHash: material.hash, start, end: start + 4, quote: '课堂任务' };
  const result = service.createTask({ ...input, selection });
  assert.equal(result.task.input.sources[0].content, '课堂任务');
  assert.equal(result.task.input.selection.rangeLabel, '第 2 行');
  assert.doesNotMatch(result.prepared.prompt, /第三行/);
  for (const invalid of [{ ...selection, quote: '伪造' }, { ...selection, sourceHash: '0'.repeat(64) }, { ...selection, start: start + 5, end: start + 6, quote: '\uDE00' }]) {
    assert.throws(() => service.createTask({ ...input, operationId: randomUUID(), selection: invalid }), /正文|范围|变化/);
  }
  const excerpt = service.canvas.addExcerpt({ requirementId: requirement.id, ...selection, title: '摘录来源', annotation: '补充课堂实操', operationId: randomUUID() });
  const fromExcerpt = service.createTask({ ...input, operationId: randomUUID(), selectedCardIds: [`material:${excerpt.material.id}`] });
  assert.equal(fromExcerpt.task.input.sources[0].content, '课堂任务');
  assert.equal(fromExcerpt.task.input.sources[0].annotation, '补充课堂实操');
  const subSelection = service.createTask({ ...input, instruction: '仅讨论选段', operationId: randomUUID(), selectedCardIds: [`material:${excerpt.material.id}`],
    selection: { sourceCardId: `material:${excerpt.material.id}`, sourceHash: excerpt.material.hash, start: 0, end: 2, quote: '课堂' } });
  assert.equal(subSelection.task.input.sources[0].content, '课堂');
  assert.doesNotMatch(subSelection.prepared.prompt, /课堂任务/);
  assert.equal(service.tasks.list(requirement.id).length, 3);
});

test('foreign and unavailable inputs fail before creating any task', t => {
  const { root, service, material, input } = fixture(t);
  const other = service.store.createRequirement({ title: '其他需求', operationId: randomUUID() });
  assert.throws(() => service.createTask({ ...input, selectedCardIds: [`requirement:${other.id}`] }), /当前需求/);
  assert.throws(() => service.createTask({ ...input, selection: { sourceCardId: `requirement:${other.id}` } }), /选段来源/);
  writeFileSync(path.join(root, material.path), '外改来源');
  assert.throws(() => service.createTask(input), /不可用或已外改/);
  assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM course_tasks').get().n, 0);
});

test('oversized passages are explicitly refused; accepted passage appears once within the source budget', t => {
  const { service, requirement, input } = fixture(t);
  const content = '长'.repeat(12_001);
  const material = service.canvas.addMaterial({ requirementId: requirement.id, title: '长来源', content, operationId: randomUUID() }).material;
  const cardId = `material:${material.id}`;
  const selection = { sourceCardId: cardId, sourceHash: material.hash, start: 0, end: content.length, quote: content };
  assert.throws(() => service.createTask({ ...input, selectedCardIds: [cardId], selection }), /12000.*缩小.*整份/);
  assert.deepEqual(service.tasks.list(requirement.id), []);
  const accepted = service.createTask({ ...input, selectedCardIds: [cardId],
    selection: { ...selection, end: 12_000, quote: content.slice(0, 12_000) } });
  assert.equal(accepted.task.input.sources[0].content.length, 12_000);
  assert.equal(accepted.task.input.selection.quote.length, 12_000);
  assert.equal(accepted.prepared.prompt.split(content.slice(0, 12_000)).length - 1, 1);
  assert.equal(accepted.task.input.sources[0].noteTruncated, undefined);
});

test('passage-first budgeting preserves late selected text and bounds all other sources with explicit excerpt notices', t => {
  const { service, requirement, input } = fixture(t);
  const materials = ['甲', '乙', '丙', '丁', '戊', '己', '庚'].map((value, index) =>
    service.canvas.addMaterial({ requirementId: requirement.id, title: `大来源${index}`, content: value.repeat(20_000), operationId: randomUUID() }).material);
  const selectedCardIds = materials.map(material => `material:${material.id}`);
  const source = materials[5], passage = source.content.slice(0, 3000);
  const selected = service.createTask({ ...input, selectedCardIds,
    selection: { sourceCardId: selectedCardIds[5], sourceHash: source.hash, start: 0, end: passage.length, quote: passage } });
  const sources = selected.task.input.sources;
  assert.deepEqual(sources.map(item => item.content.length), [12_000, 12_000, 12_000, 12_000, 9000, 3000, 0]);
  assert.equal(sources.reduce((total, item) => total + item.content.length, 0), 60_000);
  assert.equal(sources[5].content, passage);
  assert.equal(sources[5].noteTruncated, undefined);
  for (const source of sources.filter((_, index) => index !== 5)) assert.match(source.noteTruncated, /仅为节选/);
  assert.equal(selected.prepared.prompt.split(passage).length - 1, 1);
  const all = service.createTask({ ...input, operationId: randomUUID(), selectedCardIds });
  assert.deepEqual(all.task.input.sources.map(item => item.content.length), [12_000, 12_000, 12_000, 12_000, 12_000, 0, 0]);
  const first = service.createTask({ ...input, operationId: randomUUID(), selectedCardIds,
    selection: { sourceCardId: selectedCardIds[0], sourceHash: materials[0].hash, start: 0, end: 3000, quote: materials[0].content.slice(0, 3000) } });
  assert.deepEqual(first.task.input.sources.map(item => item.content.length), [3000, 12_000, 12_000, 12_000, 12_000, 9000, 0]);
});

test('large excerpt origin metadata cannot duplicate an unbounded quote into a task prompt', t => {
  const { service, requirement, input } = fixture(t);
  const content = '原'.repeat(20_000);
  const source = service.canvas.addMaterial({ requirementId: requirement.id, title: '父来源', content, operationId: randomUUID() }).material;
  const excerpt = service.canvas.addExcerpt({ requirementId: requirement.id, sourceCardId: `material:${source.id}`, sourceHash: source.hash,
    start: 0, end: content.length, quote: content, title: '长摘录', annotation: '独立注释', operationId: randomUUID() }).material;
  const result = service.createTask({ ...input, selectedCardIds: [`material:${excerpt.id}`] });
  const snapshot = result.task.input.sources[0];
  assert.equal(snapshot.content.length, 12_000);
  assert.equal(snapshot.excerptInfo.quote, undefined);
  assert.equal(snapshot.annotation, '独立注释');
  assert.match(snapshot.noteTruncated, /仅为节选/);
  assert.doesNotMatch(result.prepared.prompt, new RegExp('原'.repeat(12_001)));
});

test('accepted is not completion, unknown cannot be blindly resubmitted and session identity cannot change', t => {
  const { service, input } = fixture(t);
  const { task } = service.createTask(input);
  assert.throws(() => service.tasks.setDispatch({ taskId: task.id, status: 'accepted' }), /尚未绑定会话/);
  service.tasks.setDispatch({ taskId: task.id, status: 'submitting' });
  service.tasks.bindSession({ taskId: task.id, sessionId: 'native-session' });
  const accepted = service.tasks.setDispatch({ taskId: task.id, status: 'accepted' });
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(accepted.artifacts, []);
  assert.throws(() => service.tasks.bindSession({ taskId: task.id, sessionId: 'another-session' }), /不能替换/);
  assert.throws(() => service.tasks.setDispatch({ taskId: task.id, status: 'submitting' }), /不能直接重发/);
  service.tasks.setDispatch({ taskId: task.id, status: 'unknown', error: '连接中断，可能已经受理' });
  assert.throws(() => service.tasks.setDispatch({ taskId: task.id, status: 'submitting' }), /不能直接重发/);
  const replay = service.createTask(input);
  assert.equal(replay.task.status, 'unknown');
  assert.equal(replay.prepared.requestId, task.requestId);
  assert.equal(replay.task.sessionId, 'native-session');
});

test('missing-model failure records no session or artifacts; unfinished dispatch recovers as unknown after restart', t => {
  const { root, service, requirement, input } = fixture(t);
  const failed = service.createTask(input).task;
  service.tasks.setDispatch({ taskId: failed.id, status: 'failed', error: '尚未配置模型' });
  const pending = service.createTask({ ...input, operationId: randomUUID() }).task;
  service.tasks.bindSession({ taskId: pending.id, sessionId: 'preserved-session' });
  service.tasks.setDispatch({ taskId: pending.id, status: 'submitting' });
  service.close();
  const restored = new WorkbenchService({ workspaceRoot: root });
  try {
    assert.equal(restored.tasks.get(failed.id).status, 'failed');
    assert.equal(restored.tasks.get(failed.id).error, '尚未配置模型');
    assert.equal(restored.tasks.get(failed.id).sessionId, null);
    assert.deepEqual(restored.tasks.get(failed.id).artifacts, []);
    assert.equal(restored.tasks.get(pending.id).status, 'unknown');
    assert.equal(restored.tasks.get(pending.id).sessionId, 'preserved-session');
    assert.equal(restored.tasks.get(pending.id).requestId, pending.requestId);
    assert.equal(restored.canvas.getBoard(requirement.id).tasks.length, 2);
  } finally { restored.close(); }
});

test('only the exact saved version becomes a task output; later dispatch failures cannot demote it', t => {
  const { root, service, requirement, input, save } = fixture(t);
  const { task } = service.createTask(input);
  service.tasks.bindSession({ taskId: task.id, sessionId: 'native-session' });
  const actualInput = { taskId: task.id, executionSessionId: 'native-session', operationId: randomUUID() };
  const actual = save(actualInput);
  const unrelated = save({ markdown: '# 随后的无关大纲' });
  assert.notEqual(actual.id, unrelated.id);
  let result = service.tasks.get(task.id);
  assert.equal(result.status, 'output');
  assert.deepEqual(result.artifacts, [{ versionId: actual.id, number: actual.number, markdownPath: actual.markdownPath, wordPath: null }]);
  assert.equal(save(actualInput).id, actual.id);
  assert.equal(service.tasks.get(task.id).artifacts.length, 1);
  assert.equal(service.tasks.setDispatch({ taskId: task.id, status: 'failed', error: '迟到的失败回执' }).status, 'output');
  assert.equal(service.tasks.get(task.id).error, null);
  const wordPath = actual.markdownPath.replace('outline.md', 'outline.docx');
  writeFileSync(path.join(root, wordPath), '仅用于关联契约测试的非空文件');
  service.store.markWordExport({ versionId: actual.id, relativePath: wordPath });
  result = service.tasks.get(task.id);
  assert.equal(result.artifacts[0].wordPath, wordPath);
  assert.equal(result.artifacts[0].versionId, actual.id);
  assert.equal(service.canvas.getBoard(requirement.id).tasks.find(item => item.id === task.id).artifacts[0].versionId, actual.id);
});

test('task source scope, requirement and execution session are checked before saving any version', t => {
  const { root, service, requirement, input, save } = fixture(t);
  const { task } = service.createTask(input);
  service.tasks.bindSession({ taskId: task.id, sessionId: 'expected-session' });
  const foreign = service.store.createRequirement({ title: '其他需求', operationId: randomUUID() });
  for (const invalid of [
    { requirementId: foreign.id },
    { sourceCardIds: [`requirement:${requirement.id}`] },
    { executionSessionId: 'foreign-session' },
  ]) assert.throws(() => save({ taskId: task.id, ...invalid }), /任务|来源|会话/);
  assert.equal(service.store.getRequirement(requirement.id).versions.length, 0);
  assert.equal(service.tasks.get(task.id).status, 'draft');
  assert.equal(existsSync(path.join(root, 'courses', requirement.id, 'v001')), false);
});

test('output-link failure rolls back version file, operation and task update; the same operation can retry', t => {
  const { root, service, requirement, input, save } = fixture(t);
  const { task } = service.createTask(input);
  const attempt = { taskId: task.id, operationId: randomUUID() };
  service.store.db.exec("CREATE TRIGGER reject_artifact BEFORE INSERT ON task_artifacts BEGIN SELECT RAISE(ABORT,'artifact association rejected'); END");
  assert.throws(() => save(attempt), /artifact association rejected/);
  assert.deepEqual(service.store.getRequirement(requirement.id).versions, []);
  assert.equal(existsSync(path.join(root, 'courses', requirement.id, 'v001')), false);
  assert.equal(service.tasks.get(task.id).status, 'draft');
  assert.equal(service.store.db.prepare('SELECT id FROM operations WHERE id=?').get(attempt.operationId), undefined);
  service.store.db.exec('DROP TRIGGER reject_artifact');
  const actual = save(attempt);
  assert.equal(actual.number, 1);
  assert.equal(service.tasks.get(task.id).artifacts[0].versionId, actual.id);
});

test('manual revision creates one task and exact output atomically while legacy saves retain their old contract', t => {
  const { root, service, requirement, save } = fixture(t);
  const base = save();
  const before = readFileSync(path.join(root, base.markdownPath));
  assert.deepEqual(service.tasks.list(requirement.id), []);
  const attempt = { markdown: '# 人工修订\n\n新正文', baseVersionId: base.id, operationId: randomUUID() };
  const version = save(attempt);
  assert.equal(save(attempt).id, version.id);
  const [summary] = service.tasks.list(requirement.id), task = service.tasks.get(summary.id);
  assert.equal(task.kind, 'manual');
  assert.equal(task.status, 'output');
  assert.equal(task.requestId, null);
  assert.equal(task.input.baseVersionId, base.id);
  assert.equal(task.input.sources[0].hash, base.hash);
  assert.deepEqual(task.artifacts.map(item => item.versionId), [version.id]);
  assert.deepEqual(readFileSync(path.join(root, base.markdownPath)), before);
  const foreign = service.store.createRequirement({ title: '其他需求', operationId: randomUUID() });
  assert.throws(() => save({ baseVersionId: service.store.saveOutline({ requirementId: foreign.id, markdown: '# 外部基准', operationId: randomUUID() }).id }), /基准版本/);
  service.store.db.exec("CREATE TRIGGER reject_manual BEFORE INSERT ON task_artifacts BEGIN SELECT RAISE(ABORT,'manual output rejected'); END");
  assert.throws(() => save({ baseVersionId: base.id, markdown: '# 不能留下成功任务' }), /manual output rejected/);
  assert.equal(service.tasks.list(requirement.id).length, 1);
  assert.equal(service.store.getRequirement(requirement.id).versions.length, 2);
  assert.equal(existsSync(path.join(root, 'courses', requirement.id, 'v003')), false);
});

test('real converter attaches Word to the task version; conversion failure never invents Word output', async t => {
  const { root, service, input, save } = fixture(t);
  const task = service.createTask(input).task;
  const actual = save({ taskId: task.id, markdown: '# 真实任务产物\n\n课堂目标与教学活动。' });
  await service.exportWord({ versionId: actual.id });
  const artifact = service.tasks.get(task.id).artifacts[0];
  assert.equal(artifact.versionId, actual.id);
  assert.equal(readFileSync(path.join(root, artifact.wordPath)).subarray(0, 2).toString(), 'PK');
  const failedTask = service.createTask({ ...input, operationId: randomUUID() }).task;
  const failedVersion = save({ taskId: failedTask.id });
  service.wordSkillDir = path.join(root, 'missing-word-skill');
  await assert.rejects(service.exportWord({ versionId: failedVersion.id }), /执行失败/);
  const failedArtifact = service.tasks.get(failedTask.id).artifacts[0];
  assert.equal(failedArtifact.versionId, failedVersion.id);
  assert.equal(failedArtifact.wordPath, null);
  assert.equal(service.tasks.get(failedTask.id).status, 'output');
});
