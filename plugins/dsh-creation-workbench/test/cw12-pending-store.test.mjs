import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkbenchService } from '../src/service.mjs';
import { usableCreationSource } from '../src/creation-context.mjs';
import { readNativeTaskState } from '../src/native-task-state.mjs';

function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'wtt-cw12-pending-')));
  let service = new WorkbenchService({ workspaceRoot: root, ...options });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const requirement = service.store.createRequirement({ background: '验证生成过程。保留文件与布局。', operationId: randomUUID() });
  const input = extra => ({ requirementId: requirement.id, instruction: '生成课程文本', outputType: 'text', selectedCardIds: [],
    sourceRefs: [], selectedSkills: [], generation: { mode: 'new' }, outputPosition: { x: 700, y: 160 }, operationId: randomUUID(), ...extra });
  const board = () => service.canvas.getBoard(requirement.id);
  const card = () => board().nodes.find(node => node.outputCard);
  const accept = task => {
    service.tasks.bindSession({ taskId: task.id, sessionId: `session:${task.id}` });
    service.tasks.setDispatch({ taskId: task.id, status: 'accepted' });
  };
  const file = async (created, { kind = 'text', primary = true, content = '# 正式文件', name = 'body.md' } = {}) => {
    const directory = ['support', 'storyboard'].includes(kind) ? created.prepared.outputDirectory : created.prepared.deliveryDirectory;
    const relative = `${directory}/${name}`;
    writeFileSync(path.join(root, relative), content);
    const sessionId = `session:${created.task.id}`;
    service.tasks.bindSession({ taskId: created.task.id, sessionId });
    return service.tasks.files.register({ taskId: created.task.id, operationId: randomUUID(), path: relative, kind, primary, title: name }, { sessionId });
  };
  return { root, requirement, input, board, card, accept, file, get service() { return service; },
    reopen() { service.close(); service = new WorkbenchService({ workspaceRoot: root, ...options }); return service; } };
}

test('an idle Agent does not deny a real published file or invent output before publication', async t => {
  const agents = new Map();
  const ctx = { agents: { get: id => agents.get(id) } };
  const f = fixture(t, { runtimeStateReader: task => readNativeTaskState(ctx, task) });
  const created = f.service.createTask(f.input());
  f.accept(created.task);
  agents.set(`session:${created.task.id}`, { id: `session:${created.task.id}`, status: 'idle' });
  const before = f.service.tasks.get(created.task.id);
  assert.equal(before.runtimeState.phase, 'idle');
  assert.equal(before.files.length, 0);
  assert.equal(before.cardVersionId, undefined);
  assert.doesNotMatch(before.runtimeState.message, /尚未登记|生成完成|成功/);
  const artifact = await f.file(created);
  const after = f.service.tasks.get(created.task.id);
  assert.equal(after.runtimeState.phase, 'idle');
  assert.equal(after.files[0].id, artifact.id);
  assert.ok(after.cardVersionId);
  assert.equal(after.runtimeState.message, before.runtimeState.message);
  assert.doesNotMatch(after.runtimeState.message, /尚未登记/);
  f.reopen();
  const restored = f.service.tasks.get(created.task.id);
  assert.equal(restored.files[0].hash, artifact.hash);
  assert.equal(restored.cardVersionId, after.cardVersionId);
  assert.doesNotMatch(restored.runtimeState.message, /尚未登记/);
});

test('a persisted generation card has no fake version, file or reference and a safe retry keeps its identity', t => {
  const f = fixture(t), args = f.input(), created = f.service.createTask(args);
  const node = f.card();
  assert.equal(node.id, `output:${created.task.outputCardId}`);
  assert.equal(node.kind, 'generation');
  assert.deepEqual(node.position, args.outputPosition);
  assert.deepEqual(node.outputCard.versions, []);
  assert.equal(node.outputCard.versionId, null);
  for (const key of ['refId', 'sourceId', 'sourceHash', 'path', 'generatedFile']) assert.equal(Object.hasOwn(node, key), false);
  assert.equal(usableCreationSource(node), false);
  assert.throws(() => f.service.canvas.validateSources(f.requirement.id, [node.id]), /不存在/);
  assert.throws(() => f.service.canvas.validateSourceRefs(f.requirement.id, [{ cardId: node.id, hash: 'a'.repeat(64) }]), /来源/);
  assert.throws(() => f.service.cards.describe({ requirementId: f.requirement.id, cardId: node.outputCard.id }), /尚无成功产物/);
  const pending = f.service.cards.describePending({ requirementId: f.requirement.id, cardId: node.outputCard.id });
  assert.equal(pending.task.id, created.task.id);
  assert.equal(pending.task.input.instruction, args.instruction);
  assert.equal(Object.hasOwn(pending, 'version'), false);
  f.service.tasks.setDispatch({ taskId: created.task.id, status: 'failed', error: '模型连接失败' });
  assert.equal(f.card().pendingGeneration.error, '模型连接失败');
  assert.equal(f.card().pendingGeneration.phase, 'failed');
  assert.equal(f.service.createTask(args).task.id, created.task.id);
  f.reopen();
  assert.equal(f.card().id, node.id);
  assert.equal(f.card().pendingGeneration.phase, 'failed');
  assert.equal(f.board().nodes.filter(value => value.outputCard).length, 1);
  assert.equal(f.service.tasks.get(created.task.id).files.length, 0);
});

test('moving, grouping and manually connecting the placeholder survives actual publication and restart', async t => {
  const f = fixture(t), created = f.service.createTask(f.input());
  const node = f.card(), requirementId = `requirement:${f.requirement.id}`, current = f.board();
  const position = { x: 1200, y: -250 };
  const groups = [{ id: 'group-cw12', title: '需求及产物', nodeIds: [requirementId, node.id] }];
  const edges = [{ id: 'manual-cw12', source: requirementId, target: node.id }];
  f.service.canvas.saveBoard({ requirementId: f.requirement.id, expectedRevision: current.revision,
    positions: { [node.id]: position }, groups, edges, viewport: current.viewport });
  assert.deepEqual(f.card().position, position);
  assert.ok(f.board().edges.some(edge => edge.id === edges[0].id && edge.target === node.id));
  const published = await f.file(created);
  assert.equal(f.card().id, node.id);
  assert.equal(f.card().sourceId, `artifact:${published.id}`);
  assert.equal(f.card().sourceHash, published.hash);
  assert.equal(f.card().outputCard.number, 1);
  assert.equal(f.card().pendingGeneration, undefined);
  assert.deepEqual(f.card().position, position);
  assert.deepEqual(f.board().groups, groups);
  assert.ok(f.board().edges.some(edge => edge.id === edges[0].id));
  f.reopen();
  assert.equal(f.card().id, node.id);
  assert.deepEqual(f.card().position, position);
  assert.deepEqual(f.board().groups, groups);
  assert.ok(f.board().edges.some(edge => edge.id === edges[0].id));
  assert.equal(f.board().nodes.filter(value => value.outputCard).length, 1);
});

test('only real runtime signals say generating or waiting; acceptance and intermediate files are not completion', async t => {
  const f = fixture(t), created = f.service.createTask(f.input({ outputType: 'pptx' }));
  f.accept(created.task);
  assert.equal(f.card().pendingGeneration.phase, 'unknown');
  let phase = 'generating';
  f.service.tasks.runtimeStateReader = task => task.id === created.task.id ? { phase } : null;
  assert.equal(f.card().pendingGeneration.phase, 'generating');
  phase = 'awaiting-input';
  assert.equal(f.card().pendingGeneration.phase, 'awaiting-input');
  phase = 'awaiting-approval';
  assert.equal(f.card().pendingGeneration.phase, 'awaiting-approval');
  await f.file(created, { kind: 'storyboard', primary: false });
  const task = f.service.tasks.get(created.task.id);
  assert.equal(task.status, 'output', 'the legacy task status still records attachments');
  assert.equal(task.dispatchStatus, 'output', 'the file registrar records its file fact independently of a formal card version');
  assert.equal(task.cardVersionId, undefined);
  assert.equal(f.card().kind, 'generation');
  assert.equal(f.card().outputCard.versions.length, 0);
  assert.equal(f.card().pendingGeneration.phase, 'awaiting-approval');
  f.reopen();
  assert.equal(f.card().pendingGeneration.phase, 'unknown', 'restart does not invent a live runtime signal');
  assert.equal(f.card().outputCard.versions.length, 0);
});

test('publishing an outline keeps the original execution on the same versioned card until it stops', t => {
  const f = fixture(t), created = f.service.createTask(f.input());
  f.accept(created.task);
  let phase = 'generating';
  f.service.tasks.runtimeStateReader = task => task.id === created.task.id ? { phase } : null;
  const nodeId = f.card().id;
  const version = f.service.store.saveOutline({ requirementId: f.requirement.id, taskId: created.task.id,
    operationId: randomUUID(), markdown: '# 大纲阶段稿', executionSessionId: `session:${created.task.id}` });
  const scope = { requirementId: f.requirement.id, cardId: created.task.outputCardId };
  for (const nextPhase of ['generating', 'awaiting-input', 'awaiting-approval']) {
    phase = nextPhase;
    const { node, task, pendingGeneration } = f.service.cards.describePending(scope);
    assert.equal(node.id, nodeId);
    assert.equal(node.sourceId, `outline:${version.id}`);
    assert.equal(node.outputCard.number, 1);
    assert.equal(task.id, created.task.id);
    assert.equal(pendingGeneration.phase, nextPhase);
    assert.equal(pendingGeneration.published, true);
    assert.equal(pendingGeneration.sessionId, `session:${created.task.id}`);
  }
  phase = 'idle';
  assert.equal(f.card().pendingGeneration, undefined);
  assert.equal(f.card().outputCard.number, 1);
  phase = 'generating';
  assert.equal(f.card().pendingGeneration.taskId, created.task.id, 'the same session can resume after saving');
  const revision = f.service.createTask(f.input({ generation: { mode: 'revise', cardId: scope.cardId, baseVersionId: f.card().outputCard.versionId } }));
  assert.equal(f.card().pendingGeneration.taskId, revision.task.id);
});

test('revision keeps the old physical source and version while a new attempt runs; late work does not replace a newer head', async t => {
  const f = fixture(t), first = f.service.createTask(f.input());
  const original = await f.file(first), one = f.card();
  const generation = { mode: 'revise', cardId: one.outputCard.id, baseVersionId: one.outputCard.versionId };
  const second = f.service.createTask(f.input({ generation, instruction: '较早修订' }));
  f.accept(second.task);
  assert.equal(f.card().sourceId, `artifact:${original.id}`);
  assert.equal(f.card().sourceHash, original.hash);
  assert.equal(f.card().outputCard.versions.length, 1);
  assert.equal(f.card().pendingGeneration.taskId, second.task.id);
  assert.equal(usableCreationSource(f.card()), true);
  const third = f.service.createTask(f.input({ generation, instruction: '较新修订' }));
  const newer = await f.file(third, { content: '# 较新版本' });
  assert.equal(f.card().sourceId, `artifact:${newer.id}`);
  assert.equal(f.card().pendingGeneration, undefined, 'an older request cannot cover the newer head with its pending state');
  await f.file(second, { content: '# 迟到版本' });
  assert.equal(f.card().id, one.id);
  assert.equal(f.card().sourceId, `artifact:${newer.id}`);
  assert.equal(f.card().outputCard.versions.length, 3);
  assert.equal(f.board().nodes.filter(value => value.outputCard).length, 1);
});

test('unattached PPT edit candidates and tasks in other projects cannot create or open this card', t => {
  const f = fixture(t), created = f.service.createTask(f.input());
  const edit = f.service.tasks.createPptEdit({ requirementId: f.requirement.id, operationId: randomUUID(), kind: 'ai',
    fingerprint: 'a'.repeat(64), snapshot: { workflow: 'ppt-edit', requirement: { id: f.requirement.id },
      outputCardId: created.task.outputCardId, instruction: '单页修改待确认', pptEdit: { scope: 'slide' } } });
  assert.equal(f.service.tasks.get(edit.id).outputCardId, undefined);
  assert.equal(f.board().nodes.filter(value => value.outputCard).length, 1);
  const other = f.service.store.createRequirement({ background: '其他课程', operationId: randomUUID() });
  assert.throws(() => f.service.cards.describePending({ requirementId: other.id, cardId: created.task.outputCardId }), /不属于/);
  assert.equal(f.service.canvas.getBoard(other.id).nodes.filter(value => value.outputCard).length, 0);
  const rootB = realpathSync(mkdtempSync(path.join(tmpdir(), 'wtt-cw12-other-')));
  const serviceB = new WorkbenchService({ workspaceRoot: rootB });
  try {
    const requirementB = serviceB.store.createRequirement({ background: '项目 B', operationId: randomUUID() });
    assert.throws(() => serviceB.cards.describePending({ requirementId: requirementB.id, cardId: created.task.outputCardId }), /不存在/);
    assert.equal(serviceB.canvas.getBoard(requirementB.id).nodes.filter(value => value.outputCard).length, 0);
  } finally { serviceB.close(); rmSync(rootB, { recursive: true, force: true }); }
});

test('model routing is frozen and changing the selected model cannot replay an earlier operation', t => {
  const f = fixture(t), args = f.input({ modelSelection: { provider: 'custom', model: 'first', reasoningEffort: 'high' } });
  const created = f.service.createTask(args);
  assert.deepEqual(created.task.input.modelSelection, args.modelSelection);
  assert.equal(f.service.createTask({ ...args, modelSelection: { ...args.modelSelection } }).task.id, created.task.id);
  assert.throws(() => f.service.createTask({ ...args, modelSelection: { provider: 'custom', model: 'second' } }), /不同内容/);
  assert.throws(() => f.service.createTask({ ...args, operationId: randomUUID(), modelSelection: { provider: '', model: 'first' } }), /模型选择/);
  f.reopen();
  assert.deepEqual(f.service.tasks.get(created.task.id).input.modelSelection, args.modelSelection);
});

test('a legacy unfinished NULL node is projected without mutating the old row, then publishes with the same visible ID', async t => {
  const f = fixture(t), created = f.service.createTask(f.input());
  f.service.store.db.prepare('UPDATE output_cards SET node_id=NULL WHERE id=?').run(created.task.outputCardId);
  const before = f.service.store.db.prepare('SELECT * FROM output_cards WHERE id=?').get(created.task.outputCardId);
  const pending = f.card();
  assert.equal(pending.id, `output:${created.task.outputCardId}`);
  f.service.cards.describePending({ requirementId: f.requirement.id, cardId: created.task.outputCardId });
  assert.deepEqual(f.service.store.db.prepare('SELECT * FROM output_cards WHERE id=?').get(created.task.outputCardId), before);
  await f.file(created);
  assert.equal(f.card().id, pending.id);
  assert.equal(f.card().outputCard.number, 1);
});

test('unknown media submission keeps a persisted empty card and never resubmits on resume or restart', async t => {
  let submissions = 0, release;
  let started;
  const submitting = new Promise(resolve => { started = resolve; });
  const provider = {
    async capabilities() { return { endpoint: 'http://127.0.0.1:8000', healthy: true, credentialConfigured: true,
      modelDefaults: { image: { model: 'jimeng-test', ratio: '4:3', resolution: '2k' } },
      models: [{ id: 'jimeng-test', type: 'image', maxReferences: 10, requiresReference: false, ratios: ['4:3'], resolutions: ['2k'] }] }; },
    async submit() { submissions++; started(); return new Promise((_, reject) => { release = () => reject(Object.assign(new Error('提交结果未知'), { code: 'submission_unknown' })); }); },
    close() {},
  };
  const f = fixture(t, { mediaProvider: provider });
  const created = await f.service.media.create(f.input({ outputType: 'image' }));
  await submitting;
  const pending = f.card();
  assert.equal(pending.kind, 'generation');
  assert.equal(pending.outputCard.type, 'image');
  assert.equal(pending.pendingGeneration.phase, 'submitting');
  release();
  for (let n = 0; n < 100 && f.service.media.get(created.task.id).job.status !== 'unknown'; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.card().pendingGeneration.phase, 'unknown');
  assert.equal(f.card().pendingGeneration.canResume, false);
  assert.equal(f.card().outputCard.versions.length, 0);
  f.reopen();
  f.service.media.resume(created.task.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.card().id, pending.id);
  assert.equal(f.card().pendingGeneration.phase, 'unknown');
  assert.equal(submissions, 1);
  assert.equal(f.service.tasks.get(created.task.id).files.length, 0);
});
