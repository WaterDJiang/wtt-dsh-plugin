import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchService, runProcess } from '../src/service.mjs';
import { normalizePolicy, createProductionObserver } from '../src/production-control.mjs';
import { amountMinor } from '../src/asset-ledger.mjs';
import { DocumentPreview } from '../src/document-preview.mjs';

function fixture(t, config = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wtt-optimizations-'))), service = new WorkbenchService({ workspaceRoot: root, ...config });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const requirement = service.store.createRequirement({ title: '优化验收 · 虚构课程', background: '仅技术测试，不是真实业务或收款', operationId: randomUUID() });
  const create = extra => service.createTask({ requirementId: requirement.id, selectedCardIds: [], outputType: 'text',
    instruction: '技术产物，不调用模型', generation: { mode: 'new' }, operationId: randomUUID(), ...extra });
  const file = async (created, name = '产物.md', content = '# 已保存正文') => {
    const filename = `${created.prepared.deliveryDirectory}/${name}`, sessionId = `session:${created.task.id}`;
    service.tasks.bindSession({ taskId: created.task.id, sessionId });
    writeFileSync(path.join(root, filename), content);
    return service.tasks.files.register({ taskId: created.task.id, kind: 'text', title: name, path: filename, operationId: randomUUID(), primary: true }, { sessionId });
  };
  return { root, service, requirement, create, file };
}

test('production budgets distinguish unknown usage, count auxiliary summary costs and never double count replay', t => {
  const { service, create } = fixture(t), { task, prepared } = create();
  assert.equal(prepared.agentPreset, 'wtt-course-economy');
  assert.equal(service.production.inspect(task.id).usage.available, false);
  assert.equal(service.production.check(task.id), null);
  service.production.setTaskBudget({ taskId: task.id, contextMode: 'economy', maxSteps: 3, maxInputTokens: 10000, maxOutputTokens: 1000 });
  const values = { tokenUsage: { uncachedInputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 0, outputTokens: 40 }, sessionStats: { steps: 2, llmMs: 1000, toolMs: 20 }, contextPressure: { pressureTokens: 250, contextWindow: 1000 } };
  service.production.sample(task.id, values); service.production.sample(task.id, values);
  const event = { type: 'compaction/summary', seq: 12, data: { usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 20 } } };
  service.production.auxiliary(task.id, event); service.production.auxiliary(task.id, event);
  assert.equal(service.production.inspect(task.id).usage.inputTokens, 400);
  assert.equal(service.production.inspect(task.id).usage.outputTokens, 60);
  assert.match(service.production.check(task.id), /达到模型回合预算/);
  service.production.setTaskBudget({ taskId: task.id, contextMode: 'economy', maxSteps: 5, maxInputTokens: 20000, maxOutputTokens: 2000 });
  assert.equal(service.production.check(task.id), null);
  assert.equal(service.production.inspect(task.id).usage.inputTokens, 400, 'raising budget does not add summary costs twice');
  assert.throws(() => normalizePolicy({ contextMode: 'economy', maxSteps: 0 }), /预算/);
});

test('native pre-step budget guard rejects another model request without executing or deleting queued work', async t => {
  const listeners = new Map(), agents = new Map();
  const ctx = { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) }, get(name) { return name === 'agents' ? agents : name === 'sessionProjections' ? { snapshot: () => ({ values: { tokenUsage: { uncachedInputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }, sessionStats: { steps: 1 } } }) } : undefined } };
  const observer = createProductionObserver(ctx); t.after(() => observer.close());
  const { root, service, create } = fixture(t, { attachProduction: observer.attach, readProductionUsage: observer.read });
  const { task } = create(); service.tasks.bindSession({ taskId: task.id, sessionId: 'native-budget' });
  service.production.setTaskBudget({ taskId: task.id, contextMode: 'economy', maxSteps: 1, maxInputTokens: 100, maxOutputTokens: 100 });
  const agent = { id: 'native-budget', session: { id: 'native-budget', header: { cwd: root } }, inbox: ['keep me'] }; agents.set(agent.id, agent);
  let next = false;
  assert.deepEqual(await listeners.get('agent/pre-step')({ agent }, async () => { next = true; return { kind: 'enter', messages: [] } }), { kind: 'reject' });
  assert.equal(next, false); assert.deepEqual(agent.inbox, ['keep me']); assert.ok(service.tasks.get(task.id));
});

test('handoff freezes exact files, keeps confirmations separate and preserves original bytes', async t => {
  const { root, service, create, file } = fixture(t), created = create(), artifact = await file(created);
  const result = service.production.checkpoint({ taskId: created.task.id, title: '分镜锁定交接', decisions: '需回看原生确认记录', pending: '等待模板选择' });
  assert.equal(result.files[0].hash, artifact.hash);
  assert.equal(createHash('sha256').update(readFileSync(path.join(root, result.path))).digest('hex'), result.hash);
  assert.match(result.authorization, /不代替真实用户批准/);
  assert.equal(service.production.inspect(created.task.id).checkpoints.length, 1);
});

test('review and delivery select exact versions, survive revisions and reject external file changes', async t => {
  const { root, service, requirement, create, file } = fixture(t), created = create(), first = await file(created);
  const task = service.tasks.get(created.task.id), scope = { requirementId: requirement.id, cardId: task.outputCardId, versionId: task.cardVersionId };
  assert.throws(() => service.assets.selectDelivery({ ...scope, operationId: randomUUID() }), /先审阅/);
  service.assets.review({ ...scope, state: 'approved', note: '技术内容审阅', operationId: randomUUID() });
  const input = { ...scope, selected: true, operationId: randomUUID() };
  service.assets.selectDelivery(input); service.assets.selectDelivery(input);
  assert.equal(service.assets.deliveryManifest(requirement.id).entries.length, 1);
  const revised = create({ generation: { mode: 'revise', cardId: scope.cardId, baseVersionId: scope.versionId } }); await file(revised, '第二版.md', '# 第二版');
  assert.equal(service.assets.course(requirement.id).cards[0].selectedVersionId, scope.versionId);
  assert.equal(service.assets.deliveryManifest(requirement.id).entries[0].hash, first.hash);
  writeFileSync(path.join(root, first.path), '# 外部修改');
  assert.throws(() => service.assets.deliveryManifest(requirement.id), /不可用|变化/);
});

test('business revisions, manual payments and reversals are independent of delivery and use integer amounts', t => {
  const { service, requirement } = fixture(t), requirementId = requirement.id;
  const form = { requirementId, revision: 0, stage: '已交付', customer: '虚构测试客户', nextAction: '约定回访', waitingFor: '', followUpDate: '2026-11-10', currency: 'CNY', receivable: '10.00', dueDate: '2026-11-15', note: '技术夹具', operationId: randomUUID() };
  service.assets.saveBusiness(form); assert.equal(service.assets.business(requirementId).receipts.length, 0);
  assert.throws(() => service.assets.saveBusiness({ ...form, operationId: randomUUID() }), /其他页面更新/);
  const receipt = amount => ({ requirementId, amount, currency: 'CNY', paidOn: '2026-11-03', note: '虚构已核对', confirmed: true, operationId: randomUUID() });
  const first = receipt('0.10'); service.assets.recordReceipt(first); service.assets.recordReceipt(first); service.assets.recordReceipt(receipt('0.20'));
  assert.equal(service.assets.business(requirementId).collectedByCurrency.CNY, 30);
  const original = service.assets.business(requirementId).receipts.find(receipt => receipt.amountMinor === 10);
  assert.throws(() => service.assets.recordReceipt({ ...receipt('1.00'), confirmed: false }), /明确确认/);
  service.assets.reverseReceipt({ requirementId, receiptId: original.id, confirmed: true, paidOn: '2026-11-03', note: '撤销测试', operationId: randomUUID() });
  assert.equal(service.assets.business(requirementId).receipts.length, 3);
  assert.equal(service.assets.business(requirementId).collectedByCurrency.CNY, 20);
  assert.equal(service.assets.business(requirementId).stage, '已交付');
  assert.equal(amountMinor('0.29'), 29); assert.throws(() => amountMinor('1.001'), /两位小数/);
});

test('legacy builtin setting never substitutes bundled course files and missing local dependencies stay visible', async t => {
  const missing = path.join(os.tmpdir(), randomUUID());
  const { service } = fixture(t, { capabilitySource: 'builtin', wordSkillDir: missing, courseSkillDir: missing, pptSkillDir: missing });
  assert.equal(service.capabilitySource, 'local');
  assert.equal(service.wordSkillDir, missing);
  assert.equal(service.creationTypes('pptx')[0].available, false);
  assert.ok(service.creationTypes('pptx')[0].skills.every(name => !name.endsWith('-builtin')));
  assert.throws(() => service.selectCapabilitySource({ source: 'builtin' }), /停止提供/);
  const checks = service.environment();
  assert.equal(checks.bundle, undefined);
  assert.equal(checks.checks.some(item => /内置/.test(item.name)), false);
});

test('actual PDF and Word page previews use verified source hash, keep original files and reject stale versions', async t => {
  const { root, service, create } = fixture(t), created = create(), sessionId = 'document-preview';
  service.tasks.bindSession({ taskId: created.task.id, sessionId });
  const dir = path.join(root, created.prepared.deliveryDirectory);
  await runProcess('python3', ['-c', 'from pathlib import Path; import fitz,sys; from docx import Document; p=Path(sys.argv[1]); d=fitz.open(); d.new_page().insert_text((70,70),"Verified PDF"); d.save(p/"preview.pdf"); w=Document(); w.add_paragraph("Verified Word preview"); w.save(p/"preview.docx")', dir]);
  const preview = new DocumentPreview(service);
  for (const name of ['preview.pdf', 'preview.docx']) {
    const artifact = await service.tasks.files.register({ taskId: created.task.id, kind: 'text', title: name, path: `${created.prepared.deliveryDirectory}/${name}`, operationId: randomUUID() }, { sessionId });
    const ref = `artifact:${artifact.id}`, manifest = await preview.get(ref, artifact.hash);
    assert.equal(manifest.pageCount, 1);
    assert.equal((await preview.page(ref, artifact.hash, 1)).bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    await assert.rejects(preview.get(ref, '0'.repeat(64)), /版本不一致|变化/);
    assert.equal(service.tasks.files.get(artifact.id).status, 'ready');
  }
});

test('checkpoint retries reuse one immutable handoff; unavailable delivery can be removed', async t => {
  const { root, service, requirement, create, file } = fixture(t), created = create(), artifact = await file(created);
  const args = { taskId: created.task.id, title: '幂等交接', operationId: randomUUID() };
  assert.deepEqual(service.production.checkpoint(args), service.production.checkpoint(args));
  assert.equal(service.production.inspect(created.task.id).checkpoints.length, 1);
  const task = service.tasks.get(created.task.id), scope = { requirementId: requirement.id, cardId: task.outputCardId, versionId: task.cardVersionId };
  service.assets.review({ ...scope, state: 'approved', note: '', operationId: randomUUID() });
  service.assets.selectDelivery({ ...scope, selected: true, operationId: randomUUID() });
  writeFileSync(path.join(root, artifact.path), '# 外改');
  service.assets.selectDelivery({ ...scope, selected: false, operationId: randomUUID() });
  assert.equal(service.assets.deliveryManifest(requirement.id).entries.length, 0);
});

test('legacy outline cards remain readable in assets without a new task and exact DOCX format is reported', async t => {
  const { service, requirement, create, root } = fixture(t);
  service.store.saveOutline({ requirementId: requirement.id, markdown: '# 旧版人工大纲', operationId: randomUUID() });
  assert.ok(service.assets.course(requirement.id).cards.length);
  const created = create(), sessionId = 'docx-format'; service.tasks.bindSession({ taskId: created.task.id, sessionId });
  const relative = `${created.prepared.deliveryDirectory}/准确文档.docx`;
  await runProcess(service.python, ['-c', 'from docx import Document;import sys;d=Document();d.add_paragraph("technical fixture");d.save(sys.argv[1])', path.join(root, relative)]);
  const result = await service.tasks.files.register({ taskId: created.task.id, kind: 'text', title: '准确文档.docx', path: relative, operationId: randomUUID(), primary: true }, { sessionId });
  const card = service.assets.course(requirement.id).cards.find(card => card.versions.some(version => version.primaryRef === `artifact:${result.id}`));
  assert.equal(card.versions[0].format, 'DOCX');
});

test('native retries count requests while failed stream usage stays within official totals', t => {
  const { service, create } = fixture(t), { task } = create();
  service.production.sample(task.id, { tokenUsage: { uncachedInputTokens: 40, cacheReadTokens: 80, cacheWriteTokens: 0, outputTokens: 6 }, sessionStats: { steps: 1 } });
  for (const event of [{ seq: 1, type: 'step/start', data: {} }, { seq: 2, type: 'assistant/attempt', data: { stream: [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 20, outputTokens: 2 } } }] } }, { seq: 3, type: 'llm/retry-started', data: {} }]) {
    service.production.auxiliary(task.id, event); service.production.auxiliary(task.id, event);
  }
  const usage = service.production.usage(task.id);
  assert.equal(usage.modelRequests, 2); assert.equal(usage.inputTokens, 120); assert.equal(usage.outputTokens, 6);
  assert.equal(usage.failures.inputTokens, 30); assert.equal(usage.failures.outputTokens, 2); assert.equal(usage.retries, 1);
});

test('dependent content records the source version that became stale without silently rewriting it', async t => {
  const { service, requirement, create, file } = fixture(t), origin = create(), first = await file(origin);
  const source = service.tasks.get(origin.task.id);
  const dependent = create({ selectedCardIds: [`artifact:${first.id}`] }); await file(dependent, '依赖稿.md');
  const revised = create({ generation: { mode: 'revise', cardId: source.outputCardId, baseVersionId: source.cardVersionId } }); await file(revised, '新版来源.md', '# 更新的原文');
  const card = service.assets.course(requirement.id).cards.find(card => card.versions.some(version => version.taskId === dependent.task.id));
  assert.equal(card.dependencyWarnings.length, 1); assert.equal(card.dependencyWarnings[0].source, `artifact:${first.id}`);
  assert.equal(service.tasks.get(dependent.task.id).input.sources[0].cardId, `artifact:${first.id}`);
});

test('selected local course directory drives dependency checks and clearing it removes stale availability', t => {
  const { root, service } = fixture(t, { courseSkillDir: path.join(os.tmpdir(), randomUUID()) });
  const file = path.join(root, 'SKILL.md'); writeFileSync(file, 'Local course fixture');
  service.applyLocalSkillPaths([{ name: 'wtt-course-eight-steps-dev', path: file }]);
  assert.equal(service.courseSkillDir, root);
  assert.equal(service.creationTypes('outline')[0].available, true);
  service.applyLocalSkillPaths([]);
  assert.equal(service.creationTypes('outline')[0].available, false);
});
