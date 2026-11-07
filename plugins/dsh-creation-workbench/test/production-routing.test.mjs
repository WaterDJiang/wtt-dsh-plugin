import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchService, runProcess } from '../src/service.mjs';

const ref = name => ({ name, hash: 'a'.repeat(64), path: null });
function fixture(t, config = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wtt-routing-')));
  const service = new WorkbenchService({ workspaceRoot: root, ...config });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const requirement = service.store.createRequirement({ title: '阶段路由技术项目', operationId: randomUUID() });
  const input = extra => ({ requirementId: requirement.id, selectedCardIds: [`requirement:${requirement.id}`],
    outputType: 'pptx', pptEngine: 'native', instruction: '保留真实来源及确认门', operationId: randomUUID(), ...extra });
  const create = extra => {
    const args = input(extra);
    return service.createTask(args, { skillRefs: (args.selectedSkills || []).map(ref) });
  };
  return { root, service, requirement, input, create };
}

test('explicit Builder needs no Generator and freezes build-only prompts on replay and restart', t => {
  const { root, service, create, input } = fixture(t, { pptGeneratorSkillDir: path.join(os.tmpdir(), randomUUID()) });
  assert.equal(service.creationTypes('pptx')[0].available, false);
  const args = input({ selectedSkills: ['wtt-course-pptx-builder'] });
  const created = service.createTask(args, { skillRefs: args.selectedSkills.map(ref) });
  assert.equal(created.task.input.productionRoute.stage, 'build');
  assert.deepEqual(created.task.input.skills, ['wtt-course-pptx-builder']);
  assert.doesNotMatch(created.prepared.prompt, /\/wtt-course-pptx-generator|PPT 链路：/);
  assert.match(created.prepared.prompt, /交接缺失、不合法或未确认时/);
  assert.match(created.prepared.prompt, /八项确认/);
  assert.match(created.prepared.prompt, /validate_pptx_editability/);
  assert.equal(service.createTask(args, { skillRefs: args.selectedSkills.map(ref) }).task.id, created.task.id);
  assert.throws(() => create({ pptStage: 'create' }), /暂不可用/);
  service.close();
  const restarted = new WorkbenchService({ workspaceRoot: root });
  try { assert.equal(restarted.prepareTask({ taskId: created.task.id }).prepared.prompt, created.prepared.prompt); }
  finally { restarted.close(); }
});

test('registered storyboard selects Builder; titles and natural-language claims cannot assert a handoff', async t => {
  const { root, service, create } = fixture(t);
  const original = create();
  assert.equal(original.task.input.productionRoute.stage, 'create');
  const sessionId = 'storyboard-session';
  service.tasks.bindSession({ taskId: original.task.id, sessionId });
  const filename = `${original.prepared.outputDirectory}/分镜.md`;
  writeFileSync(path.join(root, filename), '# 技术分镜\n\n尚需 Builder 核对完整交接。');
  const file = await service.tasks.files.register({ taskId: original.task.id, kind: 'storyboard', title: '已登记分镜',
    path: filename, operationId: randomUUID(), primary: false }, { sessionId });
  const built = create({ selectedCardIds: [`artifact:${file.id}`] });
  assert.equal(built.task.input.productionRoute.reason, 'registered-storyboard');
  assert.deepEqual(built.task.input.skills, ['wtt-course-pptx-builder']);
  const material = service.canvas.addMaterial({ requirementId: original.task.requirementId,
    title: '已确认分镜', content: '只是一段文字，不能证明机器交接合法', operationId: randomUUID() }).material;
  assert.equal(create({ selectedCardIds: [`material:${material.id}`], instruction: '已有分镜，仅回写备注' }).task.input.productionRoute.stage, 'create');
});

test('existing native PPT and same-card revision use edit tools without full course Skills', async t => {
  const { root, service, create } = fixture(t);
  const base = create({ generation: { mode: 'new' } });
  const filename = `${base.prepared.deliveryDirectory}/原课件.pptx`;
  await runProcess('python3', ['-c', 'from pptx import Presentation; from pptx.util import Inches; import sys; p=Presentation(); s=p.slides.add_slide(p.slide_layouts[6]); s.shapes.add_textbox(Inches(1), Inches(1), Inches(5), Inches(1)).text="Original title"; p.save(sys.argv[1])', path.join(root, filename)]);
  service.tasks.bindSession({ taskId: base.task.id, sessionId: 'base-session' });
  const file = await service.tasks.files.register({ taskId: base.task.id, kind: 'pptx', title: '原课件', path: filename,
    operationId: randomUUID(), primary: true }, { sessionId: 'base-session' });
  const revised = create({ selectedCardIds: [], generation: { mode: 'revise', cardId: base.task.outputCardId,
    baseVersionId: service.tasks.get(base.task.id).cardVersionId } });
  assert.equal(revised.task.input.productionRoute.stage, 'edit');
  assert.deepEqual(revised.task.input.skills, []);
  assert.doesNotMatch(revised.prepared.prompt, /\/wtt-course-pptx-(generator|builder)|PPT 链路：/);
  assert.match(revised.prepared.prompt, /不重新开发大纲、分镜/);
  assert.match(revised.prepared.prompt, /validate_pptx_editability/);
  const explicit = create({ selectedCardIds: [`artifact:${file.id}`], selectedSkills: ['pptx'] });
  assert.deepEqual(explicit.task.input.skills, ['pptx']);
  assert.equal(explicit.task.input.productionRoute.reason, 'existing-ppt');
  const newCourse = create({ selectedCardIds: [`artifact:${file.id}`], selectedSkills: ['wtt-course-pptx-generator'] });
  assert.equal(newCourse.task.input.productionRoute.stage, 'create', 'explicit full design remains possible');
});

test('explicit stage participates in idempotency and rejects incompatible engines and Skills before task creation', t => {
  const { service, input, create, requirement } = fixture(t);
  const args = input({ pptStage: 'build' });
  const created = service.createTask(args);
  assert.equal(created.task.input.pptStage, 'build');
  assert.equal(service.createTask(args).task.id, created.task.id);
  assert.throws(() => service.createTask({ ...args, pptStage: 'edit' }), /不同内容/);
  const count = service.tasks.list(requirement.id).length;
  for (const invalid of [{ pptStage: 'unknown' }, { outputType: 'text', pptStage: 'edit' },
    { pptEngine: 'baoyu', pptStage: 'build' }, { pptStage: 'edit', selectedSkills: ['wtt-course-pptx-builder'] },
    { pptStage: 'build', selectedSkills: ['wtt-course-pptx-generator'] }]) {
    assert.throws(() => create(invalid), /阶段|引擎/);
  }
  assert.equal(service.tasks.list(requirement.id).length, count);
});

test('legacy task replay keeps its frozen full chain and unchanged input JSON', t => {
  const { service, requirement, input } = fixture(t);
  const args = input();
  const snapshot = { requirement, sources: [], selection: null, instruction: args.instruction, outputType: 'pptx',
    skills: ['wtt-course-pptx-generator', 'wtt-course-pptx-builder'] };
  const legacy = service.tasks.create(args, snapshot);
  const before = service.store.db.prepare('SELECT input_json FROM course_tasks WHERE id=?').get(legacy.id).input_json;
  const replay = service.createTask(args);
  assert.equal(replay.task.id, legacy.id);
  assert.equal(replay.task.input.productionRoute, undefined);
  assert.match(replay.prepared.prompt, /PPT 链路：/);
  assert.match(replay.prepared.prompt, /\/wtt-course-pptx-generator/);
  assert.equal(service.store.db.prepare('SELECT input_json FROM course_tasks WHERE id=?').get(legacy.id).input_json, before);
});
