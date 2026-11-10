import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../src/index.mjs';

test('real registered task files download by exact project and cannot bypass the bound Agent session', async t => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'wtt-creation-api-')));
  const other = realpathSync(mkdtempSync(path.join(tmpdir(), 'wtt-creation-api-other-')));
  const disposers = [], tools = new Map();
  let endpoint;
  const ctx = {
    effect(action) { const dispose = action(); if (typeof dispose === 'function') disposers.push(dispose); },
    connection: { fetch: { register(entry) { endpoint = entry; return () => {}; } } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } },
    skills: { register() { return () => {}; } },
  };
  apply(ctx, { workspaceRoot: root, registryFile: path.join(root, 'projects.json') });
  t.after(() => { for (const dispose of disposers.reverse()) dispose(); rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); });
  const response = (query = {}, action, data) => endpoint.fetch(new Request(`http://localhost/api/wtt-creation-workbench?${new URLSearchParams(query)}`,
    action ? { method: 'POST', body: JSON.stringify({ action, data }) } : undefined));
  const call = async (action, data, projectId) => {
    const result = await response(projectId ? { projectId } : {}, action, data);
    const value = await result.json(); assert.equal(result.status, 200, value.error); return value;
  };
  const requirement = await call('create', { title: '逐字稿文件技术验收', background: '未选背景不发给模型', operationId: randomUUID() });
  const original = '甲'.repeat(3999) + '😀' + '乙'.repeat(5000);
  const { material } = await call('add-material', { requirementId: requirement.id, title: '长引用', content: original, operationId: randomUUID() });
  const cardId = `material:${material.id}`;
  const created = await call('create-task', { requirementId: requirement.id,
    selectedCardIds: [cardId], outputType: 'script', instruction: '协议验收，无模型调用', operationId: randomUUID() });
  assert.deepEqual(created.task.input.selectedSkills, []);
  assert.deepEqual(created.task.input.skills, []);
  assert.doesNotMatch(created.prepared.prompt, /\/wtt-course-scriptwriter/);
  assert.doesNotMatch(created.prepared.prompt, /未选背景不发给模型|甲{50}|capturedAt/);
  assert.match(created.prepared.prompt, /course_read_task_source/);
  const projectId = created.prepared.projectId, taskId = created.task.id;
  await call('bind-task-session', { taskId, sessionId: 'trusted-session' }, projectId);
  await call('set-task-dispatch', { taskId, status: 'accepted' }, projectId);
  const relative = `${created.prepared.deliveryDirectory}/讲师逐字稿.md`;
  const content = '# 技术验收逐字稿\n\n人工文件，仅验证任务产物登记和下载；不是 AI 生成。\n';
  writeFileSync(path.join(root, relative), content);
  const register = tools.get('course_register_artifact'); assert.ok(register);
  const args = { projectId, taskId, kind: 'script', title: '逐字稿（人工技术验收）', path: relative, operationId: randomUUID() };
  const execution = (cwd = root, id = 'trusted-session') => ({ signal: new AbortController().signal, agent: { id, session: { header: { cwd } } } });
  const read = tools.get('course_read_task_source');
  const sourceArgs = { projectId, taskId, cardId };
  await assert.rejects(read.execute(sourceArgs, execution(root, 'other-session')), /绑定的主会话/);
  await assert.rejects(read.execute({ ...sourceArgs, cardId: `requirement:${requirement.id}` }, execution()), /不在当前任务/);
  writeFileSync(path.join(root, material.path), '任务发出后改过的原资料');
  const pages = [];
  let offset = 0;
  do {
    const page = JSON.parse(await read.execute({ ...sourceArgs, offset }, execution()));
    assert.ok(page.text.length <= 4000);
    pages.push(page.text);
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(pages[0].length, 3999);
  assert.equal(pages.join(''), original);
  await assert.rejects(register.execute(args, execution(root, 'other-session')), /会话|绑定/);
  await assert.rejects(register.execute(args, { signal: new AbortController().signal }), /原生会话|会话/);
  const file = JSON.parse(await register.execute(args, execution()));
  const replay = JSON.parse(await register.execute(args, execution())); assert.equal(replay.id, file.id);
  const metadata = await response({ projectId, artifact: file.id }); assert.equal(metadata.status, 200); assert.equal((await metadata.json()).id, file.id);
  const downloaded = await response({ projectId, downloadArtifact: file.id });
  assert.equal(downloaded.status, 200); assert.match(downloaded.headers.get('content-type'), /markdown|text/); assert.equal(await downloaded.text(), content);
  const detail = await response({ projectId, task: taskId }); assert.equal((await detail.json()).files[0].id, file.id);
  const batch = tools.get('course_register_artifacts'); assert.ok(batch);
  assert.equal(batch.parameters.properties.files.type, 'array');
  const batchInput = { projectId, taskId, files: ['附录一.md', '附录二.md'].map(name => {
    const filename = `${created.prepared.deliveryDirectory}/${name}`;
    writeFileSync(path.join(root, filename), `# ${name}\n\n真实批量登记文件`);
    return { kind: 'script', title: name, path: filename, operationId: randomUUID(), primary: false };
  }) };
  await assert.rejects(batch.execute(batchInput, execution(root, 'other-session')), /会话|绑定/);
  await assert.rejects(batch.execute(batchInput, { signal: new AbortController().signal }), /原生会话|会话/);
  const batchResult = JSON.parse(await batch.execute(batchInput, execution()));
  assert.equal(batchResult.ok, true); assert.equal(batchResult.succeeded, 2);
  assert.equal((await (await response({ projectId, task: taskId })).json()).files.length, 3);
  for (const entry of batchResult.results) {
    const downloadedBatch = await response({ projectId, downloadArtifact: entry.id });
    assert.equal(downloadedBatch.status, 200); assert.match(await downloadedBatch.text(), /真实批量登记文件/);
  }
  const projectB = (await call('open-project', { path: other })).project;
  assert.equal((await response({ projectId: projectB.id, downloadArtifact: file.id })).status, 400);
  await assert.rejects(read.execute({ ...sourceArgs, projectId: projectB.id }, execution()), /项目标识与当前会话目录不一致/);
  await assert.rejects(register.execute({ ...args, projectId: projectB.id }, execution()), /项目标识与当前会话目录不一致/);
  await assert.rejects(batch.execute({ ...batchInput, projectId: projectB.id }, execution()), /项目标识与当前会话目录不一致/);
  const direct = await response({ projectId }, 'register-artifact', args); assert.equal(direct.status, 400);
  assert.match((await direct.json()).error, /不支持/);
  writeFileSync(path.join(root, relative), '# 已被外部修改\n');
  const changed = await response({ projectId, downloadArtifact: file.id }); assert.equal(changed.status, 400);
  assert.match((await changed.json()).error, /变化|外改|修改|hash|校验/);
});
