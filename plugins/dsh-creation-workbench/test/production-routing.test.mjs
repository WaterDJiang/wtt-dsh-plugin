import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchService, runProcess } from '../src/service.mjs';
import { createProductionObserver } from '../src/production-control.mjs';

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

test('workbench requests use the resolved model and task scope across formats and skills', async t => {
  const listeners = new Map();
  const models = {
    luna: { context: { contextWindow: 272_000 }, defaultMaxTokens: 128_000 },
    glm: { context: { contextWindow: 1_000_000 }, defaultMaxTokens: 131_072 },
    small: { context: { contextWindow: 32_000 }, defaultMaxTokens: 6_000 },
  };
  const calls = [];
  const ctx = {
    on(name, handler, options) { listeners.set(name, { handler, options }); return () => listeners.delete(name); },
    llm: { async resolveModelInfo(provider, model) { calls.push([provider, model]); return models[model]; } },
    sessionProjections: { snapshot: () => ({ values: { sessionStats: { steps: 1 }, contextPressure: { contextWindow: 1_000_000 } } }) },
  };
  const observer = createProductionObserver(ctx);
  t.after(() => observer.close());
  const { root, service, create, requirement } = fixture(t, { attachProduction: observer.attach });
  const bind = extra => {
    const { task } = create(extra);
    const session = { id: `session:${task.id}`, header: { cwd: root } };
    service.tasks.bindSession({ taskId: task.id, sessionId: session.id });
    return { task, session };
  };
  const { handler, options } = listeners.get('agent/request');
  assert.equal(options.prepend, true);
  const run = (session, request) => handler({ agent: { id: session.id, session } }, async () => request);
  const { task, session } = bind({ selectedSkills: ['wtt-course-pptx-builder'] });
  const luna = { provider: 'openai', model: 'luna', reasoningEffort: 'high' };
  const glm = { provider: 'zai', model: 'glm' };
  assert.deepEqual(await run(session, luna), { ...luna, maxTokens: 48_000 });
  assert.deepEqual(await run(session, glm), { ...glm, maxTokens: 48_000 });
  assert.deepEqual(calls.slice(0, 2), [['openai', 'luna'], ['zai', 'glm']]);
  assert.equal((await run(session, { ...luna, maxTokens: 8_000 })).maxTokens, 8_000);
  assert.equal((await run(session, { ...luna, model: 'small' })).maxTokens, 6_000);
  const unknown = { ...luna, model: 'unknown' };
  assert.equal(await run(session, unknown), unknown);
  assert.equal(await run({ ...session, header: { cwd: '/another-project' } }, luna), luna);
  assert.equal(await run({ ...session, id: 'unbound' }, luna), luna);
  const text = { outputType: 'text', pptEngine: undefined, selectedSkills: [] };
  const custom = { ...text, selectedSkills: ['custom-production'] };
  assert.equal((await run(bind({ pptStage: 'edit', selectedSkills: [] }).session, glm)).maxTokens, 48_000);
  assert.equal((await run(bind(text).session, luna)).maxTokens, 48_000);
  assert.equal((await run(bind(custom).session, luna)).maxTokens, 48_000);
  const material = service.canvas.addMaterial({ requirementId: requirement.id, title: '验收资料', content: '选段正文和全文内容', operationId: randomUUID() }).material;
  const sourceCardId = `material:${material.id}`;
  const selected = { selectedCardIds: [sourceCardId], selection: { sourceCardId, sourceHash: material.hash, start: 0, end: 4, quote: '选段正文' } };
  assert.equal((await run(bind({ ...custom, ...selected }).session, luna)).maxTokens, 16_000);
  assert.equal((await run(bind({ selectedSkills: ['wtt-course-pptx-builder'], ...selected }).session, luna)).maxTokens, 16_000);

  session.requestHeader = () => ({ config: { ...glm, maxTokens: 48_000 } });
  listeners.get('session/event').handler(session, { type: 'request/header' });
  const { usage, policy } = service.production.inspect(task.id);
  assert.equal(usage.contextWindow, 1_000_000);
  assert.equal(usage.requestMaxTokens, 48_000);
  assert.equal(policy.maxOutputTokens, 300_000);

  service.production.savePolicy({ ...policy, contextMode: 'host' });
  assert.equal(await run(bind({ ...custom, ...selected }).session, luna), luna);
});

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

test('any explicit Skill can register independently positioned outputs, with one primary and optional attachments', async t => {
  const { root, service, create } = fixture(t);
  const skill = create({ outputType: 'text', pptEngine: undefined, selectedSkills: ['custom-production'],
    generation: { mode: 'new' }, outputPosition: { x: 400, y: 100 } });
  const task = skill.task, sessionId = 'custom-production-session';
  const write = (relative, content) => {
    const filename = path.join(root, relative);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, content);
    return relative;
  };
  assert.match(skill.prepared.prompt, /按文件各建卡/);
  assert.doesNotMatch(skill.prepared.prompt, /course-handoff|wtt-course-pptx-generator/);
  service.tasks.bindSession({ taskId: task.id, sessionId });
  const canvas = service.canvas.getBoard(task.requirementId);
  const anchor = canvas.nodes.find(node => node.outputCard?.id === task.outputCardId);
  service.canvas.saveBoard({ requirementId: task.requirementId, expectedRevision: canvas.revision, positions: {
    [anchor.id]: anchor.position, [`requirement:${task.requirementId}`]: { x: 686, y: 100 },
  }, viewport: canvas.viewport });
  const files = [
    { kind: 'exercise', title: '练习题', name: '练习.csv', bytes: '项目,得分\n一,10\n', primary: false },
    { kind: 'support', title: '交接数据', name: '交接.json', bytes: '{"ready":true}' },
    { kind: 'storyboard', title: '确认分镜', name: '分镜.md', bytes: '# 已确认的分镜', primary: true },
    { kind: 'support', title: '内部说明', name: '内部.md', bytes: '# 内部说明', presentation: 'attachment' },
    { kind: 'script', title: '讲稿', name: '讲稿.md', bytes: '# 独立讲稿' },
  ].map(({ name, bytes, ...file }) => ({ ...file, path: write(`${skill.prepared.deliveryDirectory}/${name}`, bytes), operationId: randomUUID() }));
  const args = { taskId: task.id, files };
  const registered = await service.tasks.files.registerBatch(args, { sessionId });
  assert.equal(registered.succeeded, 5);
  const replay = await service.tasks.files.registerBatch(args, { sessionId });
  assert.deepEqual(replay.results.map(item => item.id), registered.results.map(item => item.id));
  const result = service.canvas.getBoard(task.requirementId);
  const cards = result.nodes.filter(node => node.taskId === task.id);
  assert.deepEqual(cards.map(node => node.title).sort(), ['交接数据', '确认分镜', '练习题', '讲稿'].sort());
  const overlaps = (a, b) => a.position.x < b.position.x + 258 && a.position.x + 258 > b.position.x
    && a.position.y < b.position.y + 208 && a.position.y + 208 > b.position.y;
  for (const card of cards) assert.ok(result.nodes.every(node => node.id === card.id || !overlaps(node, card)));
  const main = service.outcomes.manifest({ requirementId: task.requirementId, cardId: task.outputCardId });
  assert.equal(main.selectedRef, `artifact:${registered.results[2].id}`);
  assert.deepEqual(main.files.map(file => file.title).sort(), ['内部说明', '确认分镜'].sort());
  const child = cards.find(node => node.title === '交接数据');
  const childManifest = service.outcomes.manifest({ requirementId: task.requirementId, cardId: child.outputCard.id });
  assert.deepEqual(childManifest.files.map(file => file.title), ['交接数据']);
  assert.ok(result.edges.some(edge => edge.target === child.id));
  const next = create({ selectedCardIds: [child.sourceId], selectedSkills: ['another-skill'] });
  service.tasks.bindSession({ taskId: next.task.id, sessionId: 'consumer-session' });
  assert.match(next.prepared.prompt, /field=files/);
  const related = service.readTaskSource({ taskId: next.task.id, cardId: child.sourceId, field: 'files' }, 'consumer-session');
  assert.equal(related.length, 4);
  assert.ok(related.files.some(file => file.path === registered.results[2].path && file.hash === registered.results[2].hash));
  const position = { x: 300, y: 800 };
  service.canvas.saveBoard({ requirementId: task.requirementId, expectedRevision: result.revision,
    positions: { ...Object.fromEntries(result.nodes.map(node => [node.id, node.position])), [child.id]: position }, viewport: result.viewport });
  service.close();
  const reopened = new WorkbenchService({ workspaceRoot: root });
  try {
    const restored = reopened.canvas.getBoard(task.requirementId).nodes;
    assert.deepEqual(restored.find(node => node.id === child.id).position, position);
    for (const card of cards.filter(node => node.id !== child.id)) assert.deepEqual(restored.find(node => node.id === card.id).position, card.position);
  } finally { reopened.close(); }
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
