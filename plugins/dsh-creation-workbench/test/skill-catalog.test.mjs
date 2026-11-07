import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Context } from '../.runtime/host/node_modules/@deepseek-ai/cordis/lib/index.js';
import { SkillRegistry } from '../.runtime/host/node_modules/@deepseek-ai/dsh-skill/lib/index.js';
import { apply as filesystem } from '@deepseek-ai/dsh-skill-filesystem';
import { createWorkbenchSkillCatalog } from '../src/skill-catalog.mjs';

function skill(root, name, content = `Fixture ${name}`, policy = '') {
  const directory = path.join(root, name); mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'SKILL.md');
  writeFileSync(file, `---\nname: ${name}\ndescription: "本机测试 ${name}"\n${policy}---\n${content}\n`);
  return file;
}

async function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'wtt-skill-catalog-')));
  const first = path.join(root, 'first'), second = path.join(root, 'second'), workspace = path.join(root, 'workspace');
  for (const directory of [first, second, workspace]) mkdirSync(directory);
  const ctx = new Context(); const registry = ctx.plugin(SkillRegistry); await registry;
  const controllers = [];
  t.after(async () => { for (const item of controllers.reverse()) await item.close(); await registry.dispose(); rmSync(root, { recursive: true, force: true }); });
  const options = { settingsFile: path.join(root, 'settings', 'skills.json'), skillDirectories: [first], favoriteSkills: [], workspaceRoot: workspace, skillWatch: false };
  return { root, first, second, workspace, ctx, options,
    async catalog(overrides = {}) { const item = await createWorkbenchSkillCatalog(ctx, { ...options, ...overrides }); controllers.push(item); return item; } };
}

test('native provider catalog respects Host winners, invocation policy and original resources', async t => {
  const f = await fixture(t);
  const custom = skill(f.first, 'shared-course', 'custom body');
  skill(f.first, 'user-only', 'user body', 'disable-model-invocation: true\n');
  skill(f.first, 'model-only', 'model body', 'user-invocable: false\n');
  const runtime = f.ctx.skills.register({ name: 'shared-course', description: 'Runtime course', source: 'runtime',
    path: path.join(f.root, 'runtime.md'), content: 'runtime body' });
  t.after(runtime);
  const catalog = await f.catalog({ favoriteSkills: ['shared-course', 'user-only'] });
  const result = await catalog.list(f.workspace);
  assert.deepEqual(result.skills.map(item => item.name), ['shared-course', 'user-only']);
  assert.equal(result.skills[0].path, path.join(f.root, 'runtime.md'));
  assert.equal(result.skills[0].favorite, true);
  assert.equal(result.skills[1].modelInvocable, false);
  assert.ok(result.warnings.some(warning => warning.includes(custom) && warning.includes('同名')));
  const selected = await catalog.resolve(f.workspace, ['shared-course', 'user-only', 'shared-course']);
  assert.deepEqual(selected.map(item => item.name), ['shared-course', 'user-only']);
  assert.equal(selected[0].hash, createHash('sha256').update('runtime body').digest('hex'));
  const loaded = await f.ctx.skills.get('user-only', { cwd: f.workspace });
  assert.deepEqual(loaded.resourceBase, { kind: 'directory', path: path.join(f.first, 'user-only') });
  await assert.rejects(catalog.resolve(f.workspace, ['model-only']), /不可调用/);
  await assert.rejects(catalog.resolve(f.workspace, ['/home/any/SKILL.md']), /合法 Skill/);
});

test('project discovery remains cwd-specific and outranks the added provider', async t => {
  const f = await fixture(t);
  skill(f.first, 'shared-course', 'custom body');
  const repository = path.join(f.root, 'repository'), subfolder = path.join(repository, 'courses');
  mkdirSync(path.join(repository, '.git'), { recursive: true }); mkdirSync(subfolder);
  const projectFile = skill(path.join(repository, '.agents', 'skills'), 'shared-course', 'project body');
  const hostProvider = f.ctx.plugin({ name: 'host-filesystem-fixture', inject: ['skills'], apply(ctx) {
    filesystem(ctx, { providerName: 'fixture-host', watch: false, dshHome: path.join(f.root, 'no-dsh'), agentsHome: path.join(f.root, 'no-agents') });
  } });
  await hostProvider; t.after(() => hostProvider.dispose());
  const catalog = await f.catalog();
  assert.equal((await catalog.list(subfolder)).skills.find(item => item.name === 'shared-course').path, projectFile);
  assert.equal((await catalog.resolve(subfolder, ['shared-course']))[0].hash, createHash('sha256').update('project body').digest('hex'));
  assert.equal((await catalog.resolve(f.workspace, ['shared-course']))[0].hash, createHash('sha256').update('custom body').digest('hex'));
});

test('settings save is durable, isolated, rejects invalid directories or favorites and disposes old sources', async t => {
  const f = await fixture(t);
  skill(f.first, 'first-skill'); const secondFile = skill(f.second, 'second-skill');
  const catalog = await f.catalog();
  const changed = await catalog.save({ directories: [f.second, f.second], favorites: ['second-skill', 'second-skill'] }, f.workspace);
  assert.deepEqual(changed.settings, { directories: [f.second], favorites: ['second-skill'], aliases: {} });
  assert.deepEqual(changed.skills.map(item => item.name), ['second-skill']);
  assert.equal(changed.skills[0].path, secondFile);
  assert.equal(statSync(f.options.settingsFile).mode & 0o777, 0o600);
  const durable = readFileSync(f.options.settingsFile, 'utf8');
  await assert.rejects(catalog.save({ directories: [path.join(f.root, 'missing')], favorites: [] }, f.workspace), /目录不可用/);
  await assert.rejects(catalog.save({ directories: [f.first], favorites: ['second-skill', 'missing-new'] }, f.workspace), /保存后的可调用目录/);
  await assert.rejects(catalog.save({ directories: [f.first], favorites: ['unknown'] }, f.workspace), /保存后的可调用目录/);
  assert.equal(readFileSync(f.options.settingsFile, 'utf8'), durable);
  assert.deepEqual((await catalog.list(f.workspace)).skills.map(item => item.name), ['second-skill']);
  changed.settings.directories.push('/arbitrary');
  assert.deepEqual((await catalog.list(f.workspace)).settings.directories, [f.second]);
  await catalog.close();
  assert.deepEqual(await f.ctx.skills.list({ cwd: f.workspace }), []);
  await assert.rejects(catalog.list(f.workspace), /已关闭/);
  const restored = await f.catalog();
  assert.deepEqual((await restored.list(f.workspace)).settings, { directories: [f.second], favorites: ['second-skill'], aliases: {} });
});

test('failed settings write preserves the registered source and corrupt startup settings are not overwritten', async t => {
  const f = await fixture(t);
  skill(f.first, 'first-skill'); skill(f.second, 'second-skill');
  const blocked = path.join(f.root, 'blocked'); mkdirSync(blocked);
  const catalog = await f.catalog({ settingsFile: blocked });
  await assert.rejects(catalog.save({ directories: [f.second], favorites: [] }, f.workspace));
  assert.deepEqual((await catalog.list(f.workspace)).skills.map(item => item.name), ['first-skill']);
  assert.equal((await f.ctx.skills.list({ cwd: f.workspace })).some(item => item.name === 'second-skill'), false);
  await catalog.close();
  const corrupted = path.join(f.root, 'corrupt.json'); writeFileSync(corrupted, '{invalid');
  const recovered = await f.catalog({ settingsFile: corrupted });
  assert.ok((await recovered.list(f.workspace)).warnings.some(message => message.includes('原设置文件保留')));
  assert.equal(readFileSync(corrupted, 'utf8'), '{invalid');
});

test('removing an extra directory retains a favorite provided by the Host fallback', async t => {
  const f = await fixture(t);
  const extraFile = skill(f.first, 'shared-favorite', 'extra body');
  const agentsHome = path.join(f.root, 'host-agents');
  const hostFile = skill(path.join(agentsHome, 'skills'), 'shared-favorite', 'host body');
  const hostProvider = f.ctx.plugin({ name: 'fallback-host-fixture', inject: ['skills'], apply(ctx) {
    filesystem(ctx, { providerName: 'fallback-host', watch: false, dshHome: path.join(f.root, 'no-dsh'), agentsHome });
  } });
  await hostProvider; t.after(() => hostProvider.dispose());
  const catalog = await f.catalog({ favoriteSkills: ['shared-favorite'] });
  assert.equal((await catalog.list(f.workspace)).skills[0].path, extraFile);

  const saved = await catalog.save({ directories: [], favorites: ['shared-favorite'], aliases: {} }, f.workspace);
  assert.equal(saved.skills[0].path, hostFile);
  assert.equal(saved.skills[0].favorite, true);
  assert.deepEqual(saved.settings, { directories: [], favorites: ['shared-favorite'], aliases: {} });
  assert.equal((await catalog.resolve(f.workspace, ['shared-favorite']))[0].hash, createHash('sha256').update('host body').digest('hex'));
  await catalog.close();
  const restored = await f.catalog();
  assert.equal((await restored.list(f.workspace)).skills[0].path, hostFile);
  assert.deepEqual((await restored.list(f.workspace)).settings, saved.settings);
});

test('favorite validation after provider exchange restores the previous definition and durable settings', async t => {
  const f = await fixture(t);
  const original = skill(f.first, 'kept-favorite', 'original body');
  skill(f.second, 'staged-skill', 'staged body');
  const catalog = await f.catalog();
  await catalog.save({ directories: [f.first], favorites: ['kept-favorite'], aliases: {} }, f.workspace);
  const durable = readFileSync(f.options.settingsFile, 'utf8');

  await assert.rejects(catalog.save({ directories: [f.second], favorites: ['not-installed'] }, f.workspace), /保存后的可调用目录/);
  assert.equal(readFileSync(f.options.settingsFile, 'utf8'), durable);
  const after = await catalog.list(f.workspace);
  assert.deepEqual(after.settings, { directories: [f.first], favorites: ['kept-favorite'], aliases: {} });
  assert.deepEqual(after.skills.map(item => item.name), ['kept-favorite']);
  assert.equal(after.skills[0].path, original);
  assert.equal(after.skills[0].favorite, true);
  assert.equal((await catalog.resolve(f.workspace, ['kept-favorite']))[0].hash, createHash('sha256').update('original body').digest('hex'));
  assert.equal((await f.ctx.skills.list({ cwd: f.workspace })).some(item => item.name === 'staged-skill'), false);
});

test('resolve reads the actual current definition rather than UI paths or cached bodies', async t => {
  const f = await fixture(t); const file = skill(f.first, 'changing-skill', 'version one');
  const catalog = await f.catalog();
  const before = (await catalog.resolve(f.workspace, ['changing-skill']))[0];
  skill(f.first, 'changing-skill', 'version two');
  const after = (await catalog.resolve(f.workspace, ['changing-skill']))[0];
  assert.equal(before.path, file); assert.equal(after.path, file); assert.notEqual(before.hash, after.hash);
  await assert.rejects(catalog.resolve(f.workspace, ['not-installed']), /不存在/);
  assert.deepEqual(await catalog.resolve(f.workspace, []), []);
});

test('legacy registration-only contexts remain usable without pretending explicit Skills are available', async () => {
  const catalog = await createWorkbenchSkillCatalog({ skills: { register() {} } });
  const listed = await catalog.list('/unused');
  assert.deepEqual(listed.skills, []); assert.ok(listed.warnings[0].includes('未提供完整 Skill'));
  assert.deepEqual(await catalog.resolve('/unused', []), []);
  await assert.rejects(catalog.resolve('/unused', ['some-skill']), /不可用/);
  await assert.rejects(catalog.save({ directories: [], favorites: [] }, '/unused'), /不可用/);
  await catalog.close();
});

test('star patches are immediate, serialized, global and retain the same filesystem provider', async t => {
  const f = await fixture(t); skill(f.first, 'alpha'); skill(f.first, 'beta');
  const catalog = await f.catalog(), before = await catalog.list(f.workspace);
  await Promise.all([catalog.updatePreference({ name: 'alpha', favorite: true }, f.workspace), catalog.updatePreference({ name: 'beta', favorite: true }, f.workspace)]);
  const renamed = await catalog.updatePreference({ name: 'alpha', label: '课程策划' }, f.workspace);
  assert.deepEqual(renamed.settings.favorites, ['alpha', 'beta']);
  assert.equal(renamed.skills.find(item => item.name === 'alpha').label, '课程策划');
  assert.equal(renamed.skills[0].provider, before.skills[0].provider);
  const otherProject = path.join(f.root, 'other'); mkdirSync(otherProject);
  assert.equal((await catalog.list(otherProject)).settings.aliases.alpha, '课程策划');
  const durable = readFileSync(f.options.settingsFile, 'utf8');
  assert.equal(JSON.parse(durable).version, 2);
  await assert.rejects(catalog.updatePreference({ name: 'alpha', label: '错误\n名称' }, f.workspace), /单行/);
  assert.equal(readFileSync(f.options.settingsFile, 'utf8'), durable);
  await catalog.close(); const restored = await f.catalog();
  assert.equal((await restored.list(f.workspace)).settings.aliases.alpha, '课程策划');
  await restored.updatePreference({ name: 'alpha', favorite: false }, f.workspace);
  assert.equal((await restored.list(f.workspace)).settings.aliases.alpha, undefined);
});

test('automatic roots and v1 migration preserve missing favorites so they can be removed', async t => {
  const f = await fixture(t); skill(f.first, 'wtt-course-scriptwriter');
  writeFileSync(f.options.settingsFile.replace('/settings/skills.json', '/legacy.json'), JSON.stringify({ version: 1, directories: [], favorites: ['wtt-course-scriptwriter-builtin', 'missing-skill'] }));
  const catalog = await f.catalog({ skillDirectories: undefined, autoSkillDirectories: [f.first], settingsFile: path.join(f.root, 'legacy.json') });
  const found = await catalog.list(f.workspace);
  assert.deepEqual(found.automaticDirectories, [f.first]);
  assert.deepEqual(found.settings.favorites, ['wtt-course-scriptwriter', 'missing-skill']);
  assert.ok(found.warnings.some(message => message.includes('missing-skill')));
  await catalog.updatePreference({ name: 'missing-skill', favorite: false }, f.workspace);
  assert.deepEqual((await catalog.list(f.workspace)).settings.favorites, ['wtt-course-scriptwriter']);
});
