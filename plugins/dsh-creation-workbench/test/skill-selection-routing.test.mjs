import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchService } from '../src/service.mjs';
import { extractSkillNames, pptEngineForSelection } from '../src/skill-commands.mjs';
import { slidesRuntimeAvailable } from '../src/baoyu-runtime.mjs';

const SLIDES_SKIP = slidesRuntimeAvailable() ? false : '需要本机安装 dsh-claude-slides（宝玉幻灯片插件）；按 README 干净检出并安装后运行';
import { createCardContext, creationTaskInput } from '../src/creation-context.mjs';

const refs = names => names.map(name => ({ name, hash: 'a'.repeat(64), path: null }));
function fixture(t, config = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wtt-exact-skills-')));
  const service = new WorkbenchService({ workspaceRoot: root, ...config });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const canvas = service.store.createRequirement({ title: '路由技术验收', operationId: randomUUID() });
  const input = extra => ({ requirementId: canvas.id, selectedCardIds: [`requirement:${canvas.id}`],
    outputType: 'text', instruction: '只处理本次资料，不调用模型。', selectedSkills: [], operationId: randomUUID(), ...extra });
  const create = extra => { const args = input(extra); return service.createTask(args, { skillRefs: refs(args.selectedSkills) }); };
  return { root, service, canvas, input, create };
}
function onlyCommands(created, names) {
  assert.deepEqual(created.task.input.skills, names);
  assert.deepEqual(extractSkillNames(created.prepared.prompt), ['wtt-creation-workbench', ...names]);
  assert.match(created.prepared.prompt, /只启动本任务列明的技能流程/);
}

test('a single Builder overrides the canvas baoyu hint and preserves exact routing across replay and restart', t => {
  const missing = path.join(os.tmpdir(), randomUUID());
  const f = fixture(t, { pptGeneratorSkillDir: missing });
  const args = f.input({ outputType: 'pptx', pptEngine: 'baoyu', selectedSkills: ['wtt-course-pptx-builder'], instruction: '/wtt-course-pptx-builder 按已确认分镜制作' });
  const created = f.service.createTask(args, { skillRefs: refs(args.selectedSkills) });
  assert.equal(created.task.input.pptEngine, 'native');
  assert.equal(created.task.input.productionRoute.stage, 'build');
  onlyCommands(created, ['wtt-course-pptx-builder']);
  assert.doesNotMatch(created.prepared.prompt, /claude-slides|wtt-course-pptx-generator/);
  assert.match(created.prepared.prompt, /八项确认/);
  assert.equal(f.service.createTask(args, { skillRefs: refs(args.selectedSkills) }).task.id, created.task.id);
  const stored = f.service.store.db.prepare('SELECT input_json FROM course_tasks WHERE id=?').get(created.task.id).input_json;
  const restarted = new WorkbenchService({ workspaceRoot: f.root });
  try { assert.equal(restarted.prepareTask({ taskId: created.task.id }).prepared.prompt, created.prepared.prompt); }
  finally { restarted.close(); }
  assert.equal(f.service.store.db.prepare('SELECT input_json FROM course_tasks WHERE id=?').get(created.task.id).input_json, stored);
});

test('Generator-only and custom PPT Skills never pull in an unselected production chain', t => {
  const f = fixture(t, { pptSkillDir: path.join(os.tmpdir(), randomUUID()) });
  for (const names of [['wtt-course-pptx-generator'], ['sample-layout'], ['sample-layout', 'sample-tone']]) {
    const result = f.create({ outputType: 'pptx', pptEngine: 'baoyu', selectedSkills: names });
    const expected = names;
    assert.equal(result.task.input.pptEngine, 'native');
    onlyCommands(result, expected);
    assert.doesNotMatch(result.prepared.prompt, /\/wtt-course-pptx-builder|\/claude-slides|PPT 链路：/);
  }
});

test('selecting both native Skills is deliberate and selecting incompatible makers fails before creating a task', t => {
  const f = fixture(t);
  const result = f.create({ outputType: 'pptx', pptEngine: 'baoyu', selectedSkills: ['wtt-course-pptx-generator', 'wtt-course-pptx-builder'] });
  onlyCommands(result, ['wtt-course-pptx-generator', 'wtt-course-pptx-builder']);
  assert.equal(result.task.input.pptEngine, 'native');
  const before = f.service.tasks.list(f.canvas.id).length;
  assert.throws(() => f.create({ outputType: 'pptx', pptEngine: 'baoyu', selectedSkills: ['wtt-course-pptx-builder', 'claude-slides'] }), /请只选择一种/);
  assert.equal(f.service.tasks.list(f.canvas.id).length, before);
});

test('default and explicitly selected baoyu makers omit the unselected course Generator', { skip: SLIDES_SKIP }, t => {
  const f = fixture(t);
  const defaults = f.create({ outputType: 'pptx', pptEngine: 'baoyu' });
  onlyCommands(defaults, ['claude-slides']);
  assert.deepEqual(defaults.task.input.selectedSkills, []);
  assert.equal(defaults.task.input.skillSelection.mode, 'default-renderer');
  assert.doesNotMatch(defaults.prepared.prompt, /wtt-course-pptx-generator|SVG builder/);
  const explicit = f.create({ outputType: 'pptx', pptEngine: 'native', selectedSkills: ['claude-slides', 'sample-tone'] });
  onlyCommands(explicit, ['claude-slides', 'sample-tone']);
  assert.equal(explicit.task.input.pptEngine, 'baoyu');
  assert.equal(explicit.task.input.skillSelection.mode, 'explicit');
  assert.doesNotMatch(explicit.prepared.prompt, /wtt-course-pptx-generator/);
});

test('each typed output respects empty and custom selections without requiring unrelated course Skills', t => {
  const missing = path.join(os.tmpdir(), randomUUID());
  const f = fixture(t, { courseSkillDir: missing, scriptSkillDir: missing, exerciseSkillDir: missing, pptSkillDir: missing, pptGeneratorSkillDir: missing });
  for (const outputType of ['text', 'outline', 'exercise', 'script', 'pptx']) {
    for (const selectedSkills of [[], ['sample-tone']]) {
      const result = f.create({ outputType, pptEngine: outputType === 'pptx' ? 'native' : undefined, selectedSkills });
      onlyCommands(result, selectedSkills);
      assert.doesNotMatch(result.prepared.prompt, /调用独立 wtt-course-scriptwriter|调用 wtt-course-exercise-builder|PPT 链路：/);
    }
  }
});

test('new canvas input always carries an authoritative empty selection for every output format', () => {
  for (const outputType of ['text', 'pptx', 'image', 'video', 'outline', 'exercise', 'script']) {
    const context = createCardContext({ projectId: 'project', requirement: { id: 'canvas' }, blank: true,
      anchor: { id: 'canvas:canvas', kind: 'canvas' }, outputType, generation: { mode: 'new' } });
    context.instruction = '整理本次内容';
    assert.deepEqual(creationTaskInput(context).selectedSkills, [], outputType);
  }
});

test('prepare-canvas never infers a course Skill from the origin of its background', t => {
  const f = fixture(t);
  const prepared = f.service.prepareCanvas(f.input());
  assert.deepEqual(extractSkillNames(prepared.prompt), ['wtt-creation-workbench']);
});

test('the course action resolves the configured outline skill and fails honestly without one', t => {
  const skillRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wtt-outline-skill-')));
  const outlineDir = path.join(skillRoot, 'outline-skill');
  mkdirSync(outlineDir, { recursive: true });
  writeFileSync(path.join(outlineDir, 'SKILL.md'), '---\nname: course-outline-skill\n---\n# outline\n');
  t.after(() => rmSync(skillRoot, { recursive: true, force: true }));
  const f = fixture(t, { courseSkillDir: outlineDir });
  assert.match(f.service.prepareCourse({ requirementId: f.canvas.id }).prompt, /\/course-outline-skill/,
    'the dedicated course-development action is still explicit');
  assert.deepEqual(f.service.courseOutlineSkill(), { name: 'course-outline-skill' });

  const missing = path.join(os.tmpdir(), randomUUID());
  const bare = fixture(t, { courseSkillDir: missing });
  assert.throws(() => bare.service.prepareCourse({ requirementId: bare.canvas.id }), /未找到课程大纲技能/);
  assert.deepEqual(bare.service.courseOutlineSkill(), { name: null });

  const unnamedRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wtt-outline-unnamed-')));
  const unnamed = path.join(unnamedRoot, '技能目录');
  mkdirSync(unnamed, { recursive: true });
  writeFileSync(path.join(unnamed, 'SKILL.md'), '# 没有 frontmatter 名称\n');
  t.after(() => rmSync(unnamedRoot, { recursive: true, force: true }));
  const odd = fixture(t, { courseSkillDir: unnamed });
  assert.deepEqual(odd.service.courseOutlineSkill(), { name: null });
});

test('UI and server use the same engine priority while plain custom Skills never expand it', () => {
  for (const [selectedSkills, hint, expected] of [
    [[], 'baoyu', 'baoyu'], [[], 'native', 'native'],
    [['wtt-course-pptx-builder'], 'baoyu', 'native'], [['wtt-course-pptx-generator'], 'baoyu', 'native'],
    [['sample-tone'], 'baoyu', 'native'], [['claude-slides'], 'native', 'baoyu'],
  ]) assert.equal(pptEngineForSelection({ selectedSkills, pptEngine: hint }), expected);
  assert.throws(() => pptEngineForSelection({ selectedSkills: ['claude-slides', 'wtt-course-pptx-builder'] }), /请只选择一种/);
});

test('internal callers cannot smuggle unselected slash commands through raw instructions', t => {
  const f = fixture(t);
  const before = f.service.tasks.list(f.canvas.id).length;
  assert.throws(() => f.create({ instruction: '/unselected-extra 扩写全课', selectedSkills: [] }), /指令中含未选择的技能/);
  assert.throws(() => f.create({ instruction: '/sample-tone /unselected-extra 扩写全课', selectedSkills: ['sample-tone'] }), /未选择的技能/);
  assert.equal(f.service.tasks.list(f.canvas.id).length, before);
  onlyCommands(f.create({ instruction: '/sample-tone 只整理指定正文', selectedSkills: ['sample-tone'] }), ['sample-tone']);
});

test('stage selection cannot force an incompatible resolved engine or supplement a Builder-only choice', t => {
  const f = fixture(t);
  for (const options of [
    { pptEngine: 'native', pptStage: 'build', selectedSkills: ['claude-slides'] },
    { pptEngine: 'native', pptStage: 'create', selectedSkills: ['wtt-course-pptx-builder'] },
  ]) assert.throws(() => f.create({ outputType: 'pptx', ...options }), /阶段/);
  assert.equal(f.service.tasks.list(f.canvas.id).length, 0);
});
