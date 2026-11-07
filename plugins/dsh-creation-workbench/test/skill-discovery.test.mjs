import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerWorkbenchSkills } from '../src/skills.mjs';
import { createWorkbenchSkillCatalog } from '../src/skill-catalog.mjs';

// Host framework modules come from the local DSH install; skip honestly when README setup hasn't run.
const [cordis, hostSkill] = await Promise.all([
  import('../.runtime/host/node_modules/@deepseek-ai/cordis/lib/index.js').catch(() => null),
  import('../.runtime/host/node_modules/@deepseek-ai/dsh-skill/lib/index.js').catch(() => null),
]);
const hostModules = cordis && hostSkill ? { Context: cordis.Context, SkillRegistry: hostSkill.SkillRegistry } : null;
const { Context, SkillRegistry } = hostModules ?? {};
const HOST_SKIP = hostModules ? false : '需先按 README「干净检出」安装 .runtime/host（@deepseek-ai/dsh 0.2.1-rc.5）';
const test = hostModules ? nodeTest : (...args) => {
  const fn = args.find(arg => typeof arg === 'function');
  const options = args.find(arg => arg && typeof arg === 'object');
  nodeTest(args[0], { ...(options || {}), skip: HOST_SKIP }, fn);
};

test('workbench registers only its internal protocol and never shadows local course skills', async t => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'wtt-local-skills-')));
  const file = path.join(root, 'wtt-course-eight-steps-dev', 'SKILL.md'); mkdirSync(path.dirname(file));
  writeFileSync(file, '---\nname: wtt-course-eight-steps-dev\ndescription: Local course\n---\n原始本机技能正文');
  const ctx = new Context(), registry = ctx.plugin(SkillRegistry); await registry;
  const registration = ctx.plugin({ name: 'protocol-fixture', inject: ['skills'], apply(child) { registerWorkbenchSkills(child); } }); await registration;
  const catalog = await createWorkbenchSkillCatalog(ctx, { workspaceRoot: root, skillDirectories: [root], settingsFile: path.join(root, 'settings.json'), skillWatch: false });
  t.after(async () => { await catalog.close(); await registration.dispose(); await registry.dispose(); rmSync(root, { recursive: true, force: true }); });
  const visible = await catalog.list(root);
  assert.deepEqual(visible.skills.map(item => item.name), ['wtt-course-eight-steps-dev']);
  assert.equal((await ctx.skills.get('wtt-course-eight-steps-dev', { cwd: root })).content, '原始本机技能正文');
  assert.equal(visible.skills[0].path, file);
  assert.equal((await ctx.skills.snapshot({ cwd: root })).skills.some(item => item.name.endsWith('-builtin')), false);
  assert.ok((await ctx.skills.get('wtt-creation-workbench', { cwd: root })).content.includes('# WTT 创作工作台'));
  assert.equal(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).files.includes('resources'), false);
});
