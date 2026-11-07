import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkbenchService } from '../src/service.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'wtt-cw12-requirement-')));
  const service = new WorkbenchService({ workspaceRoot: root });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, service, store: service.store };
}

test('background-only entry preserves its text, derives the first sentence title and replays without duplication', t => {
  const { store, service, root } = fixture(t);
  const background = '  企业希望把 AI 用在销售工作中。第二句保留原始背景。\n包括案例与练习。  ';
  const input = { background, operationId: randomUUID() }, created = store.createRequirement(input);
  assert.equal(created.title, '企业希望把 AI 用在销售工作中');
  assert.equal(created.background, background);
  assert.equal(created.backgroundOnly, true);
  assert.equal(store.createRequirement(input).id, created.id);
  assert.equal(store.listRequirements().length, 1);
  assert.throws(() => store.createRequirement({ ...input, background: '另一背景' }), /不同内容/);
  const node = service.canvas.getBoard(created.id).nodes[0];
  assert.equal(node.content, background);
  assert.equal(node.requirementBackground, background);
  assert.equal(node.content.includes('客户：待补充'), false);
  const reopened = new WorkbenchService({ workspaceRoot: root });
  try {
    assert.equal(reopened.store.getRequirement(created.id).backgroundOnly, true);
    assert.equal(reopened.canvas.getBoard(created.id).nodes[0].sourceHash, node.sourceHash);
  } finally { reopened.close(); }
});

test('first sentence titles handle newlines, English and long Unicode while the 30000 character background limit is enforced', t => {
  const { store } = fixture(t);
  const create = background => store.createRequirement({ background, operationId: randomUUID() });
  assert.equal(create('第一句\n第二段').title, '第一句');
  assert.equal(create('A first sentence. Another sentence.').title, 'A first sentence');
  const unicode = '🙂'.repeat(45);
  assert.equal([...create(unicode).title].length, 40);
  assert.equal(create('长'.repeat(30_000)).background.length, 30_000);
  for (const background of ['', ' \n ', null, {}, '长'.repeat(30_001), '含\0字符']) {
    assert.throws(() => create(background), /背景|30000/);
  }
});

test('rename changes only the name and timestamp, preserving background hashes, frozen tasks and legacy rows', t => {
  const { store, service } = fixture(t);
  const legacy = store.createRequirement({ title: '旧名称', customer: '历史客户', audience: '历史学员', background: '保留原背景', objectives: '旧目标', operationId: randomUUID() });
  const originalRow = store.db.prepare('SELECT * FROM requirements WHERE id=?').get(legacy.id);
  const created = store.createRequirement({ background: '只填背景信息。无需其他字段。', operationId: randomUUID() });
  const before = service.canvas.getBoard(created.id).nodes[0];
  const args = { requirementId: created.id, selectedCardIds: [before.id], sourceRefs: [{ cardId: before.id, hash: before.sourceHash }],
    selectedSkills: [], outputType: 'text', generation: { mode: 'new' }, instruction: '生成大纲', operationId: randomUUID() };
  const task = service.createTask(args).task;
  const oldTaskRow = store.db.prepare('SELECT * FROM course_tasks WHERE id=?').get(task.id);
  const rename = { requirementId: created.id, title: '手动课程名称', operationId: randomUUID() };
  assert.equal(store.renameRequirement(rename).title, rename.title);
  assert.equal(store.renameRequirement(rename).id, created.id);
  assert.equal(store.getRequirement(created.id).background, created.background);
  assert.equal(service.canvas.getBoard(created.id).nodes[0].sourceHash, before.sourceHash);
  assert.equal(service.tasks.get(task.id).input.requirement.title, created.title);
  assert.deepEqual(store.db.prepare('SELECT * FROM course_tasks WHERE id=?').get(task.id), oldTaskRow);
  assert.deepEqual(store.db.prepare('SELECT * FROM requirements WHERE id=?').get(legacy.id), originalRow);
  assert.throws(() => store.renameRequirement({ ...rename, title: '不同名称' }), /不同内容/);
  assert.throws(() => store.renameRequirement({ ...rename, operationId: randomUUID(), title: ' ' }), /需求标题/);
  assert.throws(() => store.renameRequirement({ ...rename, operationId: randomUUID(), requirementId: randomUUID() }), /需求不存在/);
  assert.deepEqual(service.canvas.validateSourceRefs(created.id, args.sourceRefs, { selectedCardIds: args.selectedCardIds }).map(ref => ref.hash), [before.sourceHash]);
});

test('the explicit-title API keeps its original schema, source digest and operation fingerprint', t => {
  const { store, service } = fixture(t);
  const input = { title: '旧式需求', customer: '客户 A', audience: '销售团队', background: '保留旧字段', objectives: '旧目标', operationId: randomUUID() };
  const created = store.createRequirement(input), node = service.canvas.getBoard(created.id).nodes[0];
  assert.equal(Object.hasOwn(created, 'backgroundOnly'), false);
  assert.equal(store.createRequirement(input).id, created.id);
  assert.equal(node.content, '客户：客户 A\n\n受众：销售团队\n\n背景：保留旧字段\n\n目标：旧目标');
  const renamed = store.renameRequirement({ requirementId: created.id, title: '旧式需求改名', operationId: randomUUID() });
  assert.equal(renamed.customer, input.customer);
  assert.equal(service.canvas.getBoard(created.id).nodes[0].sourceHash, node.sourceHash);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM requirement_entry_modes WHERE requirement_id=?').get(created.id).n, 0);
  assert.throws(() => store.createRequirement({ title: '', background: '不能用空标题伪装旧 API', operationId: randomUUID() }), /需求标题/);
});
