import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkbenchService } from '../src/service.mjs';

function fixture(t, config = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'wtt-creation-service-')));
  const service = new WorkbenchService({ workspaceRoot: root, ...config });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const requirement = service.store.createRequirement({ title: '课程生产协议验收', background: '技术材料，非真实客户资料', operationId: randomUUID() });
  const create = (outputType, extra = {}) => service.createTask({ requirementId: requirement.id,
    selectedCardIds: [`requirement:${requirement.id}`], instruction: '按当前课程材料完成指定交付',
    operationId: randomUUID(), ...(outputType === undefined ? {} : { outputType }), ...extra });
  return { root, service, requirement, create };
}

test('typed production routes preserve independent Skills, confirmation gates and task delivery directories', t => {
  const { root, service, create } = fixture(t);
  const expected = {
    outline: ['wtt-course-eight-steps-dev'],
    pptx: ['wtt-course-pptx-generator', 'wtt-course-pptx-builder'],
    exercise: ['wtt-course-exercise-builder'],
    script: ['wtt-course-scriptwriter'],
  };
  for (const type of service.creationTypes()) assert.equal(type.available, true, type.message);
  for (const [type, skills] of Object.entries(expected)) {
    const { task, prepared } = create(type, { outputPosition: { x: 490, y: 170 } });
    assert.equal(task.input.outputType, type);
    assert.deepEqual(task.input.skills, skills);
    assert.deepEqual(task.input.outputPosition, { x: 490, y: 170 });
    for (const skill of skills) assert.ok(prepared.prompt.includes(`/${skill}`));
    assert.match(prepared.prompt, /主任务会话/);
    assert.match(prepared.prompt, /主会话复核后/);
    assert.equal(prepared.cwd, root);
    if (type === 'outline') {
      assert.equal(prepared.outputDirectory, undefined);
      assert.match(prepared.prompt, /course_save_outline/);
    } else {
      assert.equal(prepared.outputDirectory, `courses/${task.requirementId}/tasks/${task.id}`);
      assert.equal(prepared.deliveryDirectory, `${prepared.outputDirectory}/delivery`);
      assert.ok(existsSync(path.join(root, prepared.deliveryDirectory)));
      assert.match(prepared.prompt, /course_register_artifact/);
      assert.ok(prepared.prompt.includes(task.id));
      assert.doesNotMatch(prepared.prompt, /course_save_outline 必须/);
    }
    if (type === 'pptx') {
      assert.match(prepared.prompt, /不强制先生成逐字稿/);
      assert.match(prepared.prompt, /八项确认/);
      assert.match(prepared.prompt, /preview_noneditable/);
      assert.match(prepared.prompt, /kind=storyboard/);
      assert.match(prepared.prompt, /validate_pptx_editability/);
    }
    if (type === 'exercise') {
      assert.match(prepared.prompt, /只允许 PDF、CSV/);
      assert.match(prepared.prompt, /制作清单留在 delivery 之外/);
      assert.match(prepared.prompt, /validate_package/);
    }
    if (type === 'script') {
      assert.match(prepared.prompt, /固定页补稿/);
      assert.match(prepared.prompt, /知识库根路径询问与编排确认/);
      assert.match(prepared.prompt, /不能假定“无知识库”/);
    }
  }
});

test('missing production dependencies disable only their type and preserve the legacy untyped outline API', t => {
  const missing = path.join(tmpdir(), `absent-creation-skills-${randomUUID()}`);
  const { service, create, requirement } = fixture(t, {
    courseSkillDir: missing, pptGeneratorSkillDir: missing, pptSkillDir: missing, exerciseSkillDir: missing, scriptSkillDir: missing,
  });
  const types = service.creationTypes();
  assert.deepEqual(types.map(type => type.id), ['outline', 'pptx', 'exercise', 'script', 'text', 'image', 'video']);
  assert.equal(types.find(type => type.id === 'text').available, true);
  for (const type of types.filter(type => !['text', 'image', 'video'].includes(type.id))) {
    assert.equal(type.available, false);
    assert.match(type.message, /缺少本机课程 Skill/);
    assert.throws(() => create(type.id), /暂不可用/);
  }
  assert.equal(service.tasks.list(requirement.id).length, 0);
  assert.equal(create(undefined).task.input.outputType, 'outline');
  assert.equal(create('image').task.input.generationMethod, 'skill');
  assert.equal(create('video').task.input.generationMethod, 'skill');
  assert.throws(() => create('audio'), /类型/);
  assert.throws(() => create(null), /类型/);
});

test('a frozen source hash is verified before a new task, while successful operation replay retains its original snapshot', t => {
  const { root, service, requirement, create } = fixture(t);
  const material = service.canvas.addMaterial({ requirementId: requirement.id, title: '已冻结原文', content: '不能被浮框后续选择替换的来源', operationId: randomUUID() }).material;
  const cardId = `material:${material.id}`;
  const input = { selectedCardIds: [cardId], sourceRefs: [{ cardId, hash: material.hash }], operationId: randomUUID() };
  const first = create('outline', input);
  assert.equal(first.task.input.sourceRefs[0].hash, material.hash);
  assert.throws(() => create('outline', { ...input, operationId: randomUUID(), sourceRefs: [{ cardId, hash: '0'.repeat(64) }] }), /来源|变化|hash|校验/);
  writeFileSync(path.join(root, material.path), '外改正文');
  const replay = create('outline', input);
  assert.equal(replay.task.id, first.task.id);
  assert.equal(replay.task.input.sources[0].content, first.task.input.sources[0].content);
  assert.throws(() => create('outline', { ...input, operationId: randomUUID() }), /外改|不可用|变化/);
});

test('task preparation refuses a symlink output parent without writing outside its project', t => {
  const { root, requirement, create } = fixture(t);
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'wtt-creation-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'courses', requirement.id), { recursive: true });
  symlinkSync(outside, path.join(root, 'courses', requirement.id, 'tasks'));
  assert.throws(() => create('script'), /目录不可用|替换/);
  assert.deepEqual(readdirSync(outside), []);
});

test('待审预览包含同任务全部实际大纲与附件，而非仅卡片主版本，并核对文件外改', async t => {
  const { root, service, requirement, create } = fixture(t);
  const { task, prepared } = create('text');
  service.tasks.bindSession({ taskId: task.id, sessionId: 'session-review' });
  const save = text => service.store.saveOutline({ requirementId: requirement.id, taskId: task.id, executionSessionId: 'session-review', markdown: text, operationId: randomUUID(), sourceCardIds: [`requirement:${requirement.id}`] });
  const v1 = save('# V1\n\n两人一组。');
  const v2 = save('# V2\n\n三人一组。');
  const filename = `${prepared.deliveryDirectory}/sample.md`;
  writeFileSync(path.join(root, filename), '# 实际附件');
  const file = await service.tasks.files.register({ taskId: task.id, kind: 'text', title: '审阅附件', path: filename, primary: false, operationId: randomUUID() }, { sessionId: 'session-review' });
  const read = () => service.reviewTaskOutputs({ taskId: task.id, requirementId: requirement.id });
  assert.deepEqual(read().outputs.map(output => output.node.id), [`outline:${v1.id}`, `outline:${v2.id}`, `artifact:${file.id}`]);
  assert.match(read().outputs[1].node.content, /三人一组/);
  assert.equal(read().outputs[1].node.status, 'ready');
  writeFileSync(path.join(root, v2.markdownPath), '# 外改');
  assert.equal(read().outputs[1].node.status, 'changed');
  const other = service.store.createRequirement({ background: '另一个需求', operationId: randomUUID() });
  assert.throws(() => service.reviewTaskOutputs({ taskId: task.id, requirementId: other.id }), /不属于当前需求/);
});
