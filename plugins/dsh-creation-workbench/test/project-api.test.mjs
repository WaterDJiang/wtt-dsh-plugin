import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../src/index.mjs';

function application(config) {
  const disposers = [], tools = new Map();
  let route;
  const ctx = {
    effect(action) { const dispose = action(); if (typeof dispose === 'function') disposers.push(dispose); },
    connection: { fetch: { register(entry) { route = entry; return () => {}; } } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } },
    skills: { register() { return () => {}; } },
  };
  apply(ctx, config);
  let closed = false;
  const response = (query = {}, action, data) => {
    const url = new URL('http://localhost/api/wtt-creation-workbench');
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
    return route.fetch(new Request(url, action ? { method: 'POST', body: JSON.stringify({ action, data }) } : {}));
  };
  const get = async query => { const res = await response(query); const body = await res.json(); assert.equal(res.status, 200, body.error); return body; };
  const call = async (action, data, projectId) => { const res = await response({ projectId }, action, data); const body = await res.json(); assert.equal(res.status, 200, body.error); return body; };
  return { get, call, response, tools, close() { if (!closed) { closed = true; for (const dispose of disposers.reverse()) dispose(); } } };
}

test('project HTTP routing isolates copied UUIDs, downloads, pending exports and Agent saves', async t => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'wtt-project-api-')));
  const a = path.join(directory, 'A'), b = path.join(directory, 'B'); mkdirSync(a);
  const skillDir = path.join(directory, 'outline-skill'); mkdirSync(skillDir);
  writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: course-outline-skill\n---\n');
  const config = { workspaceRoot: a, registryFile: path.join(directory, 'projects.json'), courseSkillDir: skillDir };
  const applications = [];
  const create = () => { const app = application(config); applications.push(app); return app; };
  t.after(() => { applications.forEach(app => app.close()); rmSync(directory, { recursive: true, force: true }); });
  let app = create();
  const browsedOnly = path.join(directory, '只浏览未打开'); mkdirSync(browsedOnly);
  const browsing = await app.get({ directory: browsedOnly, projectId: 'not-a-project' });
  assert.equal(browsing.path, browsedOnly);
  assert.deepEqual(browsing.entries, []);
  assert.equal(existsSync(path.join(browsedOnly, '.wtt-workbench')), false, 'directory browsing must not resolve or create a project service');
  const projectA = (await app.get({ projects: 1 })).projects[0];
  const requirement = await app.call('create', { title: '复制后共享 UUID 的需求', operationId: randomUUID() }, projectA.id);
  const v1 = await app.call('save-outline', { requirementId: requirement.id, markdown: '# 共同基线', operationId: randomUUID() }, projectA.id);
  const word = await app.call('export-word', { versionId: v1.id }, projectA.id);
  const bytesA = readFileSync(path.join(a, word.wordPath));
  app.close(); // Checkpoint SQLite before copying the exact business identities into B.
  cpSync(a, b, { recursive: true });
  const bytesB = Buffer.from('B-specific download routing fixture');
  writeFileSync(path.join(b, word.wordPath), bytesB);
  app = create();
  const projectB = (await app.call('open-project', { path: b })).project;
  assert.notEqual(projectA.id, projectB.id);
  assert.equal((await app.get({ projectId: projectB.id })).requirements[0].id, requirement.id);
  assert.equal((await app.get({})).projectId, projectA.id, 'legacy requests retain the fixed default after B opens');
  for (const [id, expected] of [[projectA.id, bytesA], [projectB.id, bytesB]]) {
    const res = await app.response({ projectId: id, download: v1.id });
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), expected);
  }
  const v2 = await app.call('save-outline', { requirementId: requirement.id, markdown: '# 只属于 A 的第二版', operationId: randomUUID() }, projectA.id);
  const pendingA = app.call('export-word', { versionId: v2.id }, projectA.id);
  await app.call('open-project', { path: b });
  const exportedA = await pendingA;
  assert.equal(existsSync(path.join(a, exportedA.wordPath)), true);
  assert.equal(existsSync(path.join(b, exportedA.wordPath)), false);
  assert.equal((await app.get({ projectId: projectB.id })).requirements[0].versions.length, 1);

  const controller = new AbortController();
  const execution = cwd => ({ signal: controller.signal, agent: { id: 'session-owned-by-project', session: { header: { cwd } } } });
  const save = app.tools.get('course_save_outline');
  await assert.rejects(save.execute({ projectId: projectB.id, requirementId: requirement.id, markdown: '# 伪造项目', operationId: randomUUID() }, execution(a)), /项目标识与当前会话目录不一致/);
  await assert.rejects(save.execute({ projectId: projectB.id, requirementId: requirement.id, markdown: '# 无可信会话', operationId: randomUUID() }, { signal: controller.signal }), /无法核对会话项目目录/);
  const savedB = JSON.parse(await save.execute({ projectId: projectB.id, requirementId: requirement.id, markdown: '# B 自己的第二版', operationId: randomUUID() }, execution(b)));
  assert.equal(savedB.number, 2);
  assert.equal(readFileSync(path.join(b, savedB.markdownPath), 'utf8'), '# B 自己的第二版');
  assert.equal(readFileSync(path.join(a, v2.markdownPath), 'utf8'), '# 只属于 A 的第二版');
  assert.equal(JSON.parse(await app.tools.get('course_list_requirements').execute({}, execution(b))).projectId, projectB.id);

  for (const action of ['prepare-course', 'prepare-canvas']) {
    const prepared = await app.call(action, { requirementId: requirement.id, selectedCardIds: [`outline:${savedB.id}`], instruction: '根据大纲继续修订' }, projectB.id);
    assert.equal(prepared.projectId, projectB.id); assert.equal(prepared.cwd, b); assert.ok(prepared.prompt.includes(projectB.id));
  }
  const created = await app.call('create-task', { requirementId: requirement.id, selectedCardIds: [`outline:${savedB.id}`], instruction: '修订 B 大纲', operationId: randomUUID() }, projectB.id);
  assert.equal(created.prepared.projectId, projectB.id);
  assert.equal((await app.get({ projectId: projectA.id, tasks: requirement.id })).length, 0);
  const missing = path.join(directory, '误输目录');
  const failed = await app.response({}, 'open-project', { path: missing });
  assert.equal(failed.status, 400); assert.equal(existsSync(missing), false);
  const malformed = await app.response({ projectId: 'not-a-project' }); assert.equal(malformed.status, 400);
  app.close();
  const restarted = create();
  const listed = await restarted.get({ projects: 1 });
  assert.equal(listed.activeProjectId, projectB.id);
  assert.equal((await restarted.get({ projectId: projectB.id, task: created.task.id })).instruction, '修订 B 大纲');
});
