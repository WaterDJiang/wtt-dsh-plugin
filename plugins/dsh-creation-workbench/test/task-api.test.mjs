import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../src/index.mjs';

test('HTTP actions and existing Agent tool share exact task, excerpt and version records', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtt-task-api-'));
  const disposers = [], tools = new Map();
  let endpoint;
  const ctx = {
    effect(action) { const dispose = action(); if (typeof dispose === 'function') disposers.push(dispose); },
    connection: { fetch: { register(entry) { endpoint = entry; return () => {}; } } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } },
    skills: { register() { return () => {}; } },
  };
  apply(ctx, { workspaceRoot: root, registryFile: path.join(root, 'projects.json'), courseSkillDir: path.join(root, 'absent-course-skill') });
  t.after(() => { for (const dispose of disposers.reverse()) dispose(); rmSync(root, { recursive: true, force: true }); });
  const call = async (action, data) => {
    const response = await endpoint.fetch(new Request('http://localhost/api/wtt-creation-workbench', {
      method: 'POST', body: JSON.stringify({ action, data }),
    }));
    const value = await response.json();
    assert.equal(response.status, 200, value.error);
    return value;
  };
  const get = async query => {
    const response = await endpoint.fetch(new Request(`http://localhost/api/wtt-creation-workbench?${query}`));
    assert.equal(response.status, 200);
    return response.json();
  };
  const requirement = await call('create', { title: '接口验收', operationId: randomUUID() });
  const { material } = await call('add-material', { requirementId: requirement.id, title: '输入', content: '精确摘录原文', operationId: randomUUID() });
  const excerpt = await call('add-excerpt', { requirementId: requirement.id, sourceCardId: `material:${material.id}`, sourceHash: material.hash,
    start: 2, end: 6, quote: '摘录原文', annotation: '讲师注释', title: '摘录', operationId: randomUUID() });
  const { task, prepared } = await call('create-task', { requirementId: requirement.id, selectedCardIds: [`material:${excerpt.material.id}`],
    instruction: '生成课程大纲', operationId: randomUUID() });
  assert.equal(prepared.requestId, task.requestId);
  assert.equal((await get(`tasks=${requirement.id}`))[0].id, task.id);
  assert.equal((await get(`task=${task.id}`)).input.sources[0].annotation, '讲师注释');
  await call('bind-task-session', { taskId: task.id, sessionId: 'native-session' });
  const accepted = await call('set-task-dispatch', { taskId: task.id, status: 'accepted' });
  assert.equal(accepted.status, 'accepted');
  const tool = tools.get('course_save_outline');
  assert.ok(tool.parameters.properties.taskId);
  const version = JSON.parse(await tool.execute({ requirementId: requirement.id, taskId: task.id, markdown: '# 已保存大纲',
    operationId: randomUUID(), sourceCardIds: [`material:${excerpt.material.id}`] }, {
    signal: new AbortController().signal, agent: { id: 'native-session' },
  }));
  const board = await get(`canvas=${requirement.id}`);
  assert.equal(board.tasks[0].status, 'output');
  assert.equal(board.tasks[0].artifacts[0].versionId, version.id);
  assert.equal((await get(`version=${version.id}`)).markdown, '# 已保存大纲');
  const manual = await call('save-outline', { requirementId: requirement.id, baseVersionId: version.id,
    markdown: '# 人工修订后的大纲', operationId: randomUUID() });
  const manualTask = (await get(`tasks=${requirement.id}`)).find(value => value.kind === 'manual');
  assert.equal(manualTask.artifacts[0].versionId, manual.id);
  const failed = await endpoint.fetch(new Request('http://localhost/api/wtt-creation-workbench', { method: 'POST', body: JSON.stringify({
    action: 'set-task-dispatch', data: { taskId: randomUUID(), status: 'accepted' },
  }) }));
  assert.equal(failed.status, 400);
  assert.match((await failed.json()).error, /任务不存在/);
});
