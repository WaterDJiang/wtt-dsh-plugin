import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WorkbenchService } from '../src/service.mjs';

function fixture(t, config = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'wtt-text-task-')));
  const service = new WorkbenchService({ workspaceRoot: root, ...config });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const requirement = service.store.createRequirement({ title: '普通文本技术验收', operationId: randomUUID() });
  const input = extra => ({ requirementId: requirement.id, selectedCardIds: [`requirement:${requirement.id}`],
    outputType: 'text', instruction: '按明确指令整理文字，不启动模型。', operationId: randomUUID(), ...extra });
  const create = (extra = {}, skillRefs = []) => service.createTask(input(extra), { skillRefs });
  return { root, service, requirement, input, create };
}
const ref = (name, extra = {}) => ({ name, path: null, hash: 'a'.repeat(64), description: '测试用已解析 Skill 元数据', ...extra });

test('plain text tasks remain synchronous, need no course Skill and never force the eight-step slash', t => {
  const missing = path.join(tmpdir(), randomUUID());
  const { service, create } = fixture(t, { courseSkillDir: missing, scriptSkillDir: missing, exerciseSkillDir: missing });
  assert.equal(service.creationTypes('text')[0].available, true);
  const result = create();
  assert.equal(result.then, undefined);
  assert.equal(result.task.input.outputType, 'text');
  assert.deepEqual(result.task.input.skills, []);
  assert.deepEqual(result.task.input.skillRefs, []);
  assert.equal(result.task.input.skill, null);
  assert.deepEqual(result.prepared.explicitSkills, []);
  assert.deepEqual(result.prepared.explicitSkillRefs, []);
  assert.doesNotMatch(result.prepared.prompt, /\/wtt-course-eight-steps-dev|\/wtt-course-scriptwriter/);
  assert.match(result.prepared.prompt, /kind=text/);
  assert.match(result.prepared.outputDirectory, new RegExp(`/tasks/${result.task.id}$`));
});

test('explicit Skills freeze their true metadata and a changed Skill cannot replay or rewrite an existing task', t => {
  const { service, input } = fixture(t);
  const args = input({ instruction: '/sample-text 按此 Skill 整理正文', selectedSkills: ['sample-text'] });
  const metadata = ref('sample-text', { path: '/technical/skills/sample-text/SKILL.md', resourceBase: { kind: 'directory', path: '/technical/skills/sample-text' } });
  const created = service.createTask(args, { skillRefs: [metadata] });
  assert.deepEqual(created.task.input.selectedSkills, ['sample-text']);
  assert.deepEqual(created.task.input.skills, ['sample-text']);
  assert.deepEqual(created.prepared.explicitSkills, ['sample-text']);
  assert.equal(created.prepared.explicitSkillRefs[0].hash, metadata.hash);
  assert.match(created.prepared.prompt, /\/sample-text/);
  assert.equal(service.createTask(args, { skillRefs: [structuredClone(metadata)] }).task.id, created.task.id);
  for (const changed of [{ hash: 'b'.repeat(64) }, { path: '/different/SKILL.md' }, { description: '变更后的说明' }]) {
    assert.throws(() => service.createTask(args, { skillRefs: [{ ...metadata, ...changed }] }), /旧任务已保留.*新建任务/);
  }
  metadata.resourceBase.path = '/mutated-after-freeze';
  assert.equal(service.tasks.get(created.task.id).input.skillRefs[0].resourceBase.path, '/technical/skills/sample-text');
  assert.equal(service.tasks.list(created.task.requirementId).length, 1);
  assert.throws(() => service.createTask(input({ selectedSkills: ['unknown-skill'] })), /真实目录解析/);
  assert.throws(() => service.createTask(input({ selectedSkills: ['sample-text', 'sample-text'] }), { skillRefs: [ref('sample-text'), ref('sample-text')] }), /不重复/);
});

test('text follows explicit course Skills and PPT never supplements a custom Skill with a course chain', t => {
  const { create } = fixture(t);
  const names = ['wtt-course-eight-steps-dev', 'wtt-course-exercise-builder', 'wtt-course-scriptwriter'];
  const selected = create({ selectedSkills: names, instruction: names.map(name => `/${name}`).join(' ') }, names.map(name => ref(name)));
  assert.match(selected.prepared.prompt, /course_save_outline/);
  assert.match(selected.prepared.prompt, /既有 vNNN/);
  assert.match(selected.prepared.prompt, /正式.*PDF.*CSV/);
  assert.match(selected.prepared.prompt, /固定页/);
  const ppt = create({ outputType: 'pptx', selectedSkills: ['sample-tone'], instruction: '/sample-tone 保留可编辑 PPT 流程' }, [ref('sample-tone')]);
  assert.deepEqual(ppt.task.input.skills, ['sample-tone']);
  assert.deepEqual(ppt.prepared.explicitSkills, ['sample-tone']);
  assert.match(ppt.prepared.prompt, /原生可编辑性/);
});

test('slash tokens inside frozen data never invoke unselected Skills, while JSON decoding restores original content', t => {
  const { service, requirement, input } = fixture(t);
  const content = '示例 /unselected-skill 后续\n原资料含 URL https://example.test/a 和 /another-skill 文本';
  const { material } = service.canvas.addMaterial({ requirementId: requirement.id, title: '资料 /title-skill 示例', content, operationId: randomUUID() });
  const result = service.createTask(input({ selectedCardIds: [`material:${material.id}`], selectedSkills: [] }));
  assert.doesNotMatch(result.prepared.prompt, /\/unselected-skill|\/another-skill|\/title-skill/);
  assert.match(result.prepared.prompt, /\\u002funselected-skill/);
  const sources = result.prepared.prompt.split('\n\n').find(part => part.startsWith('[{"cardId":'));
  assert.equal(JSON.parse(sources)[0].content, content);
  assert.equal(result.task.input.sources[0].content, content);
  const explicit = service.createTask(input({ instruction: '/selected-skill 明确调用', selectedCardIds: [`material:${material.id}`], selectedSkills: ['selected-skill'] }), { skillRefs: [ref('selected-skill')] });
  assert.match(explicit.prepared.prompt, /\/selected-skill/);
  assert.doesNotMatch(explicit.prepared.prompt, /\/unselected-skill/);
});

test('text task files register actual MD, TXT, CSV, DOCX and PDF, preserving typed delivery and session boundaries', async t => {
  const { root, service, requirement, create } = fixture(t);
  const { task, prepared } = create();
  service.tasks.bindSession({ taskId: task.id, sessionId: 'text-session' });
  const directory = path.join(root, prepared.deliveryDirectory);
  const generated = spawnSync('python3', ['-c', [
    'import sys,os,fitz', 'from docx import Document', 'root=sys.argv[1]',
    'd=Document()', 'd.add_paragraph("真实普通文本文件")', 'd.save(os.path.join(root,"plain.docx"))',
    'p=fitz.open()', 'page=p.new_page()', 'page.insert_text((40,60),"Text delivery fixture")', 'p.save(os.path.join(root,"plain.pdf"))', 'p.close()',
  ].join('; '), directory], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  for (const [name, content] of [['plain.md', '# 普通文本\n真实保存'], ['plain.txt', '普通TXT正文'], ['plain.csv', '\ufeff题号,材料\n一,独立材料\n'], ['script.md', '# 讲师逐字稿\n人工技术验收']]) writeFileSync(path.join(directory, name), content);
  const register = (name, kind = 'text', sessionId = 'text-session') => service.tasks.files.register({ taskId: task.id, kind,
    title: `技术验收 ${name}`, path: `${prepared.deliveryDirectory}/${name}`, operationId: randomUUID() }, { sessionId });
  for (const name of ['plain.md', 'plain.txt', 'plain.csv', 'plain.docx', 'plain.pdf']) {
    const file = await register(name); assert.equal(file.kind, 'text'); assert.equal(file.validation.status, 'passed');
  }
  assert.equal((await register('script.md', 'script')).kind, 'script');
  writeFileSync(path.join(directory, 'exercise.csv'), '\ufeff题号,材料\n一,课程练习材料\n');
  assert.equal((await register('exercise.csv', 'exercise')).kind, 'exercise');
  await assert.rejects(register('script.md', 'exercise'), /格式不匹配/);
  await assert.rejects(register('fake.pptx', 'text'), /格式不匹配/);
  await assert.rejects(register('fake.pptx', 'pptx'), /必须匹配/);
  await assert.rejects(register('plain.md', 'storyboard'), /分镜仅/);
  await assert.rejects(register('plain.md', 'text', 'other-session'), /未绑定当前会话/);
  const outline = service.store.saveOutline({ requirementId: requirement.id, markdown: '# 独立大纲版本', taskId: task.id,
    sourceCardIds: [`requirement:${requirement.id}`], operationId: randomUUID(), executionSessionId: 'text-session' });
  assert.equal(service.tasks.get(task.id).artifacts[0].versionId, outline.id);
  assert.equal(service.tasks.get(task.id).files.length, 7);
});
