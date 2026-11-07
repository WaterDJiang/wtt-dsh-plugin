import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectRegistry } from '../src/project-registry.mjs';

function fixture(t) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'wtt-project-registry-')));
  const a = path.join(directory, '项目 A'), b = path.join(directory, '项目 B');
  mkdirSync(a); mkdirSync(b);
  const config = { workspaceRoot: a, registryFile: path.join(directory, 'state', 'projects.json') };
  const instances = [];
  const create = (extra = {}) => { const registry = new ProjectRegistry({ ...config, ...extra }); instances.push(registry); return registry; };
  t.after(() => { instances.forEach(registry => registry.close()); rmSync(directory, { recursive: true, force: true }); });
  return { directory, a, b, config, create };
}

test('project registry canonicalizes aliases, persists recents and last selection without changing the legacy default', t => {
  const { directory, a, b, config, create } = fixture(t);
  const registry = create();
  const defaultId = registry.defaultProjectId;
  assert.equal(registry.list().activeProjectId, defaultId);
  assert.equal(existsSync(config.registryFile), false);
  const projectB = registry.open(b);
  const alias = path.join(directory, 'B 的别名'); symlinkSync(b, alias, 'dir');
  assert.equal(registry.open(alias).id, projectB.id);
  assert.equal(registry.list().projects.length, 2);
  assert.equal(registry.get().workspaceRoot, a);
  const saved = JSON.parse(readFileSync(config.registryFile));
  assert.equal(saved.activeProjectId, projectB.id);
  assert.equal(saved.projects.find(project => project.id === projectB.id).path, b);
  registry.close();
  const restarted = create();
  assert.equal(restarted.list().activeProjectId, projectB.id);
  assert.equal(restarted.list().defaultProjectId, defaultId);
  assert.equal(restarted.get(projectB.id).workspaceRoot, b);
  assert.equal(restarted.get().workspaceRoot, a);
});

test('invalid or unavailable project paths fail without creating directories or replacing the last selection', t => {
  const { directory, b, create } = fixture(t);
  const registry = create();
  const active = registry.open(b).id;
  const missing = path.join(directory, '不存在的项目');
  const regular = path.join(directory, 'file.txt'); writeFileSync(regular, '原文件');
  for (const value of [missing, regular, 'relative/project', '', '\0']) assert.throws(() => registry.open(value));
  assert.equal(existsSync(missing), false);
  assert.equal(registry.list().activeProjectId, active);
  registry.close();
  renameSync(b, b + '-moved');
  const restarted = create();
  const listed = restarted.list();
  assert.equal(listed.activeProjectId, restarted.defaultProjectId);
  assert.match(listed.error, /上次打开的项目不可用/);
  assert.ok(listed.projects.some(project => project.id === active));
  assert.throws(() => restarted.get(active), /项目目录不可用/);
  assert.equal(existsSync(b), false);
});

test('a failed durable registry write leaves the prior selection and services intact', t => {
  const { directory, a, b, create } = fixture(t);
  const blocker = path.join(directory, 'not-a-directory'); writeFileSync(blocker, '保留原文件');
  const registry = create({ registryFile: path.join(blocker, 'projects.json') });
  const original = registry.get();
  assert.throws(() => registry.open(b), /保存项目列表失败，当前项目未切换/);
  assert.equal(registry.list().activeProjectId, registry.defaultProjectId);
  assert.equal(registry.list().projects.length, 1);
  assert.equal(registry.get(), original);
  assert.equal(original.workspaceRoot, a);
  assert.equal(original.store.closed, false);
  assert.equal(readFileSync(blocker, 'utf8'), '保留原文件');
});

test('concurrent project opens retain all records and canonical directory identities', async t => {
  const { directory, config, create } = fixture(t);
  const registry = create();
  const directories = Array.from({ length: 6 }, (_, index) => path.join(directory, `并发项目-${index}`));
  directories.forEach(directory => mkdirSync(directory));
  const projects = await Promise.all(directories.map(directory => Promise.resolve().then(() => registry.open(directory))));
  const saved = JSON.parse(readFileSync(config.registryFile));
  assert.equal(saved.projects.length, 7);
  for (const project of projects) assert.ok(saved.projects.some(record => record.id === project.id));
  assert.equal(saved.activeProjectId, projects.at(-1).id);
  const moved = directories[0] + '-old'; renameSync(directories[0], moved); mkdirSync(directories[0]);
  assert.throws(() => registry.get(projects[0].id), /已被替换/);
});

test('tool project routing follows trusted session origin and rejects forged or unknown projects', t => {
  const { directory, a, b, create } = fixture(t);
  const registry = create();
  const projectB = registry.open(b);
  const agent = cwd => ({ agent: { id: randomUUID(), session: { header: { cwd } } } });
  assert.equal(registry.forExecution(undefined, agent(a)), registry.get());
  assert.equal(registry.forExecution(undefined, agent(b)), registry.get(projectB.id));
  assert.equal(registry.forExecution(projectB.id, agent(b)), registry.get(projectB.id));
  assert.throws(() => registry.forExecution(projectB.id, agent(a)), /项目标识与当前会话目录不一致/);
  assert.throws(() => registry.forExecution(projectB.id, {}), /无法核对会话项目目录/);
  assert.throws(() => registry.forExecution('invalid', agent(b)), /项目标识无效/);
  const unopened = path.join(directory, '未打开'); mkdirSync(unopened);
  assert.throws(() => registry.forExecution(undefined, agent(unopened)), /会话所属项目尚未打开/);
  assert.equal(existsSync(path.join(unopened, '.wtt-workbench')), false);
  assert.equal(registry.forExecution(undefined, { agent: { id: 'legacy-session' } }), registry.get());
});
