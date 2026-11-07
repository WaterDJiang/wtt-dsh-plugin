import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../src/index.mjs';

function fixture(t) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'wtt-cw12-api-')));
  const root = path.join(directory, 'A'); mkdirSync(root);
  const disposers = [], tools = new Map();
  let endpoint;
  const ctx = {
    effect(action) { const dispose = action(); if (typeof dispose === 'function') disposers.push(dispose); },
    connection: { fetch: { register(entry) { endpoint = entry; return () => {}; } } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } },
    skills: { register() { return () => {}; } },
  };
  apply(ctx, { workspaceRoot: root, registryFile: path.join(directory, 'projects.json') });
  t.after(() => { for (const dispose of disposers.reverse()) dispose(); rmSync(directory, { recursive: true, force: true }); });
  const response = (query = {}, action, data) => {
    const url = new URL('http://localhost/api/wtt-creation-workbench');
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
    return endpoint.fetch(new Request(url, action ? { method: 'POST', body: JSON.stringify({ action, data }) } : {}));
  };
  const json = async response => { const body = await response.json(); assert.equal(response.status, 200, body.error); return body; };
  return { directory, root, tools, response, get: async query => json(await response(query)),
    call: async (action, data, projectId) => json(await response({ projectId }, action, data)) };
}

const input = (requirementId, extra = {}) => ({ requirementId, instruction: 'HTTP 人工协议测试，不发送模型请求',
  selectedCardIds: [], selectedSkills: [], sourceRefs: [], outputType: 'text', generation: { mode: 'new' },
  outputPosition: { x: 700, y: 170 }, operationId: randomUUID(), ...extra });

test('background create and rename work through HTTP without changing frozen task sources or creating fake versions', async t => {
  const f = fixture(t), projectId = (await f.get({ projects: 1 })).defaultProjectId;
  const data = { background: '销售团队需要课程支持。保留后续背景原文。', operationId: randomUUID() };
  const requirement = await f.call('create', data, projectId);
  assert.equal(requirement.title, '销售团队需要课程支持');
  assert.equal(requirement.backgroundOnly, true);
  assert.equal((await f.call('create', data, projectId)).id, requirement.id);
  const source = (await f.get({ projectId, canvas: requirement.id })).nodes[0];
  assert.equal(source.content, data.background);
  const created = await f.call('create-task', input(requirement.id, { selectedCardIds: [source.id], sourceRefs: [{ cardId: source.id, hash: source.sourceHash }] }), projectId);
  const beforeTask = await f.get({ projectId, task: created.task.id });
  const rename = { requirementId: requirement.id, title: '销售 AI 课程', operationId: randomUUID() };
  const renamed = await f.call('rename-requirement', rename, projectId);
  assert.equal(renamed.title, rename.title);
  assert.equal(renamed.background, data.background);
  assert.equal((await f.call('rename-requirement', rename, projectId)).id, requirement.id);
  assert.deepEqual(await f.get({ projectId, task: created.task.id }), beforeTask);
  const board = await f.get({ projectId, canvas: requirement.id });
  assert.equal(board.nodes[0].sourceHash, source.sourceHash);
  const pending = await f.get({ projectId, requirementId: requirement.id, outputPending: created.task.outputCardId });
  assert.equal(pending.node.id, `output:${created.task.outputCardId}`);
  assert.equal(pending.node.kind, 'generation');
  assert.equal(pending.task.id, created.task.id);
  assert.deepEqual(pending.card.versions, []);
  assert.deepEqual(pending.task.files, []);
  assert.deepEqual(pending.task.artifacts, []);
  for (const key of ['sourceId', 'sourceHash', 'refId', 'path']) assert.equal(Object.hasOwn(pending.node, key), false);
  assert.equal(pending.task.input.requirement.title, requirement.title);
  assert.equal(pending.task.input.sources[0].hash, source.sourceHash);
  assert.equal(board.nodes.filter(node => node.outputCard).length, 1);
  const changedRename = await f.response({ projectId }, 'rename-requirement', { ...rename, title: '不可复用不同输入' });
  assert.equal(changedRename.status, 400);
  assert.match((await changedRename.json()).error, /不同内容/);
});

test('prepare-task retries the original task and frozen model only before submission; accepted and unknown tasks cannot resend', async t => {
  const f = fixture(t), projectId = (await f.get({ projects: 1 })).defaultProjectId;
  const requirement = await f.call('create', { background: '验证模型与重试冻结。', operationId: randomUUID() }, projectId);
  const modelSelection = { provider: 'custom-provider', model: 'course-model', reasoningEffort: 'high' };
  const created = await f.call('create-task', input(requirement.id, { modelSelection }), projectId);
  assert.deepEqual(created.prepared.modelSelection, modelSelection);
  const prepared = await f.call('prepare-task', { taskId: created.task.id }, projectId);
  assert.equal(prepared.task.id, created.task.id);
  assert.equal(prepared.prepared.taskId, created.task.id);
  assert.equal(prepared.prepared.requestId, created.prepared.requestId);
  assert.equal(prepared.prepared.projectId, projectId);
  assert.equal(prepared.prepared.cwd, f.root);
  assert.deepEqual(prepared.prepared.modelSelection, modelSelection);
  assert.deepEqual(prepared.task.input, created.task.input);
  await f.call('set-task-dispatch', { taskId: created.task.id, status: 'failed', error: '协议模拟发送失败' }, projectId);
  const retry = await f.call('prepare-task', { taskId: created.task.id, modelSelection: { provider: 'other', model: 'must-not-replace-frozen-route' } }, projectId);
  assert.equal(retry.task.id, created.task.id);
  assert.deepEqual(retry.prepared.modelSelection, modelSelection);
  const omittedProject = await f.response({}, 'prepare-task', { taskId: created.task.id });
  assert.equal(omittedProject.status, 400);
  assert.match((await omittedProject.json()).error, /必须指定当前项目/);
  await f.call('bind-task-session', { taskId: created.task.id, sessionId: `api-protocol:${created.task.id}` }, projectId);
  for (const status of ['accepted', 'unknown']) {
    await f.call('set-task-dispatch', { taskId: created.task.id, status }, projectId);
    const blocked = await f.response({ projectId }, 'prepare-task', { taskId: created.task.id });
    assert.equal(blocked.status, 400);
    assert.match((await blocked.json()).error, /已提交|待核对|不能重新发送/);
    const pending = await f.get({ projectId, requirementId: requirement.id, outputPending: created.task.outputCardId });
    assert.equal(pending.pendingGeneration.phase, 'unknown');
    assert.deepEqual(pending.card.versions, []);
  }
  assert.equal((await f.get({ projectId, tasks: requirement.id })).length, 1);
});

test('prepare-task and pending details reject a task or card belonging to another project', async t => {
  const f = fixture(t), projectA = (await f.get({ projects: 1 })).defaultProjectId;
  const requirement = await f.call('create', { background: '项目 A 的课程', operationId: randomUUID() }, projectA);
  const created = await f.call('create-task', input(requirement.id), projectA);
  const directoryB = path.join(f.directory, 'B'); mkdirSync(directoryB);
  const projectB = (await f.call('open-project', { path: directoryB })).project.id;
  const requirementB = await f.call('create', { background: '项目 B 的课程', operationId: randomUUID() }, projectB);
  const wrongTask = await f.response({ projectId: projectB }, 'prepare-task', { taskId: created.task.id });
  assert.equal(wrongTask.status, 400);
  assert.match((await wrongTask.json()).error, /任务不存在/);
  const wrongCard = await f.response({ projectId: projectB, requirementId: requirementB.id, outputPending: created.task.outputCardId });
  assert.equal(wrongCard.status, 400);
  assert.match((await wrongCard.json()).error, /不存在|不属于/);
  assert.equal((await f.get({ projectId: projectB, canvas: requirementB.id })).nodes.filter(node => node.outputCard).length, 0);
  const original = await f.get({ projectId: projectA, requirementId: requirement.id, outputPending: created.task.outputCardId });
  assert.equal(original.task.id, created.task.id);
  assert.equal(original.node.id, `output:${created.task.outputCardId}`);
});
