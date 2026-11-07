import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WorkbenchService } from '../src/service.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wtt-output-cards-')));
  const service = new WorkbenchService({ workspaceRoot: root, ...options });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const requirement = service.store.createRequirement({ title: '版本卡技术夹具', background: '保留所有历史文件', operationId: randomUUID() });
  const input = extra => ({ requirementId: requirement.id, instruction: '创作第一版内容', outputType: 'text', selectedCardIds: [],
    sourceRefs: [], selectedSkills: [], generation: { mode: 'new' }, outputPosition: { x: 800, y: 160 }, operationId: randomUUID(), ...extra });
  const create = extra => service.createTask(input(extra));
  async function file(created, name = 'body.md', content = '# 已保存的正文', extra = {}) {
    const kind = extra.kind || 'text';
    const relative = `${['storyboard', 'support'].includes(kind) ? created.prepared.outputDirectory : created.prepared.deliveryDirectory}/${name}`;
    writeFileSync(path.join(root, relative), content);
    const sessionId = `session:${created.task.id}`;
    service.tasks.bindSession({ taskId: created.task.id, sessionId });
    return service.tasks.files.register({ taskId: created.task.id, operationId: randomUUID(), path: relative, kind, title: name, ...extra }, { sessionId });
  }
  return { root, service, requirement, input, create, file };
}
const outputNodes = (service, requirementId) => service.canvas.getBoard(requirementId).nodes.filter(node => node.outputCard);

test('new text cards publish only a primary, preserve attachments and append V2/V3 from the selected base without adding nodes', async t => {
  const { service, root, requirement, create, input, file } = fixture(t);
  const args = input(), first = service.createTask(args);
  assert.equal(outputNodes(service, requirement.id).length, 1);
  assert.equal(outputNodes(service, requirement.id)[0].kind, 'generation');
  assert.equal(outputNodes(service, requirement.id)[0].outputCard.versions.length, 0);
  assert.ok(first.task.outputCardId);
  const attachment = await file(first, 'attachment.md', '同代附件', { primary: false });
  assert.equal(service.tasks.get(first.task.id).status, 'output');
  assert.equal(outputNodes(service, requirement.id)[0].kind, 'generation');
  assert.equal(outputNodes(service, requirement.id)[0].outputCard.versions.length, 0);
  const one = await file(first, 'primary.md', '# V1 正文', { primary: true });
  const initial = outputNodes(service, requirement.id)[0], cardId = initial.outputCard.id;
  assert.equal(initial.outputCard.number, 1);
  assert.equal(initial.sourceId, `artifact:${one.id}`);
  assert.equal(initial.id, `output:${first.task.outputCardId}`);
  assert.equal(service.createTask(args).task.outputCardId, cardId);
  assert.equal(initial.outputCard.versions[0].outputs.length, 2);
  assert.equal(initial.outputCard.versions[0].outputs.find(output => output.sourceId === `artifact:${attachment.id}`).role, 'attachment');
  assert.equal(service.canvas.getBoard(requirement.id).edges.length, 0, 'empty independent inputs do not fabricate requirement provenance');
  const v1 = initial.outputCard.versionId;
  const second = create({ instruction: '创作第二版', generation: { mode: 'revise', cardId, baseVersionId: v1 } });
  assert.notEqual(first.task.id, second.task.id);
  assert.equal(second.task.input.revision.sourceId, `artifact:${one.id}`);
  assert.deepEqual(second.task.input.sources, []);
  const two = await file(second, 'body.md', '# V2 正文');
  const current = outputNodes(service, requirement.id)[0];
  assert.equal(current.id, initial.id);
  assert.equal(current.sourceId, `artifact:${two.id}`);
  assert.equal(current.refId, two.id);
  assert.equal(current.sourceHash, two.hash);
  assert.deepEqual(current.position, initial.position);
  assert.equal(current.outputCard.versions.length, 2);
  const third = create({ instruction: '从第一版修改，追加第三版', generation: { mode: 'revise', cardId, baseVersionId: v1 } });
  await file(third, 'body.md', '# V3 正文');
  const described = service.cards.describe({ requirementId: requirement.id, cardId });
  assert.equal(described.version.number, 3);
  assert.equal(described.version.baseVersionId, v1);
  assert.equal(described.editor.instruction, '从第一版修改，追加第三版');
  assert.equal(service.cards.describe({ requirementId: requirement.id, cardId, versionId: v1 }).node.path, one.path);
  assert.equal(sha(readFileSync(path.join(root, one.path))), one.hash);
  assert.equal(outputNodes(service, requirement.id).length, 1);
  assert.throws(() => service.createTask({ ...args, generation: { mode: 'revise', cardId, baseVersionId: v1 } }), /不同内容/);
  assert.throws(() => service.tasks.bindSession({ taskId: second.task.id, sessionId: `session:${first.task.id}` }), /其他会话/);
});

test('PPT production files do not publish versions; only an actual validated PPTX becomes the primary', async t => {
  const { service, requirement, create, file, root } = fixture(t);
  const created = create({ outputType: 'pptx' });
  await file(created, 'storyboard.md', '# 分镜素材', { kind: 'storyboard' });
  assert.equal(outputNodes(service, requirement.id).length, 1);
  assert.equal(outputNodes(service, requirement.id)[0].kind, 'generation');
  assert.equal(outputNodes(service, requirement.id)[0].outputCard.versions.length, 0);
  await assert.rejects(file(created, 'wrong-primary.md', '# 不是成品', { kind: 'support', primary: true }), /主产物必须匹配/);
  const deck = path.join(root, 'fixture.pptx');
  const result = spawnSync('python3', ['-c', 'import sys; from pptx import Presentation; from pptx.util import Inches; p=Presentation(); s=p.slides.add_slide(p.slide_layouts[6]); s.shapes.add_textbox(Inches(1),Inches(1),Inches(6),Inches(1)).text="CW10 editable output"; p.save(sys.argv[1])', deck]);
  assert.equal(result.status, 0, result.stderr.toString());
  const artifact = await file(created, 'real.pptx', readFileSync(deck), { kind: 'pptx', primary: true });
  await file(created, 'notes.md', '# PPT附属资料', { kind: 'support' });
  const nodes = outputNodes(service, requirement.id);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].outputCard.type, 'pptx');
  assert.equal(nodes[0].sourceId, `artifact:${artifact.id}`);
  assert.equal(nodes[0].outputCard.versions.length, 1);
  assert.equal(nodes[0].outputCard.versions[0].outputs.length, 3);
});

test('legacy reads are virtual and write no card rows; explicit adoption keeps old records and the stable display id', async t => {
  const { service, requirement, input, file, create } = fixture(t);
  const source = service.canvas.getBoard(requirement.id).nodes[0];
  const old = service.createTask(input({ generation: undefined, selectedCardIds: [source.id], sourceRefs: [{ cardId: source.id, hash: source.sourceHash }] }));
  const a = await file(old, 'old-a.md', '# 原A');
  const b = await file(old, 'old-b.md', '# 原B');
  const originalRows = service.store.db.prepare('SELECT * FROM course_tasks WHERE id=?').get(old.task.id);
  const oldFiles = service.store.db.prepare('SELECT * FROM task_files WHERE task_id=? ORDER BY id').all(old.task.id);
  const board = service.canvas.getBoard(requirement.id);
  for (const node of board.nodes.filter(node => node.outputCard)) service.cards.describe({ requirementId: requirement.id, cardId: node.outputCard.id });
  for (const table of ['output_cards', 'output_card_versions', 'output_card_tasks', 'output_card_outputs']) assert.equal(service.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  const legacy = board.nodes.find(node => node.refId === a.id);
  const revised = create({ instruction: '明确修订原A', generation: { mode: 'revise', cardId: legacy.outputCard.id, baseVersionId: legacy.outputCard.versionId } });
  await file(revised, 'new-a.md', '# 新A');
  const nodes = outputNodes(service, requirement.id);
  assert.equal(nodes.length, 2, 'separate legacy resources from one Task are not merged');
  const updated = nodes.find(node => node.id === `artifact:${a.id}`);
  assert.equal(updated.outputCard.versions.length, 2);
  assert.ok(nodes.some(node => node.id === `artifact:${b.id}`));
  assert.deepEqual(service.store.db.prepare('SELECT * FROM course_tasks WHERE id=?').get(old.task.id), originalRows);
  assert.deepEqual(service.store.db.prepare('SELECT * FROM task_files WHERE task_id=? ORDER BY id').all(old.task.id), oldFiles);
});

test('late older attempts append real history but do not replace the newer successful request as the default', async t => {
  const { service, requirement, create, file } = fixture(t);
  const first = create(); await file(first);
  const original = outputNodes(service, requirement.id)[0];
  const generation = { mode: 'revise', cardId: original.outputCard.id, baseVersionId: original.outputCard.versionId };
  const slow = create({ instruction: '较早提交但晚返回', generation });
  const fast = create({ instruction: '较晚提交但先完成', generation });
  const newer = await file(fast, 'newer.md', '# 用户后续意图');
  const older = await file(slow, 'older.md', '# 较早任务迟到结果');
  const node = outputNodes(service, requirement.id)[0];
  assert.equal(node.sourceId, `artifact:${newer.id}`);
  assert.deepEqual(node.outputCard.versions.map(version => version.number), [1, 2, 3]);
  const lateVersion = node.outputCard.versions.find(version => version.primaryRef === `artifact:${older.id}`);
  assert.equal(lateVersion.number, 3);
  assert.equal(service.cards.describe({ requirementId: requirement.id, cardId: node.outputCard.id, versionId: lateVersion.id }).node.sourceId, `artifact:${older.id}`);
});

test('hidden historical inputs remain exact physical references; changed inputs retain frozen body and warn instead of rebinding', async t => {
  const { service, requirement, create, input, file, root } = fixture(t);
  const first = create(); const one = await file(first, 'v1.md', '# 旧版唯一正文');
  const base = outputNodes(service, requirement.id)[0];
  const second = create({ instruction: '第二版', generation: { mode: 'revise', cardId: base.outputCard.id, baseVersionId: base.outputCard.versionId } });
  const two = await file(second, 'v2.md', '# 新版不同正文');
  const args = input({ selectedCardIds: [`artifact:${one.id}`], sourceRefs: [{ cardId: `artifact:${one.id}`, hash: one.hash }] });
  const referenced = service.createTask(args); const produced = await file(referenced, 'comparison.md', '# 引用旧版');
  const node = outputNodes(service, requirement.id).find(value => value.refId === produced.id);
  const described = () => service.cards.describe({ requirementId: requirement.id, cardId: node.outputCard.id });
  assert.equal(described().editor.references[0].id, `artifact:${one.id}`);
  assert.equal(described().editor.references[0].nodeId, base.id);
  assert.equal(described().editor.references[0].sourceHash, one.hash);
  assert.equal(described().editor.references[0].content, '# 旧版唯一正文');
  assert.deepEqual(described().provenanceEdges.map(edge => [edge.source, edge.target]), [[`artifact:${one.id}`, `artifact:${produced.id}`]]);
  writeFileSync(path.join(root, one.path), '# 外改');
  const frozen = described().editor.references[0];
  assert.equal(frozen.content, '# 旧版唯一正文');
  assert.equal(frozen.sourceHash, one.hash);
  assert.equal(frozen.unavailable, true);
  assert.match(frozen.referenceNote, /未换成最新版/);
  assert.notEqual(frozen.id, `artifact:${two.id}`);
  assert.throws(() => service.createTask({ ...args, operationId: randomUUID() }), /不可用|外改/);
});

test('card publication is atomic with artifact registration and rollback creates no fake version', async t => {
  const { service, requirement, create, file } = fixture(t);
  const created = create();
  service.store.db.exec("CREATE TRIGGER reject_card_version BEFORE INSERT ON output_card_versions BEGIN SELECT RAISE(ABORT,'reject card publication'); END");
  await assert.rejects(file(created), /reject card publication/);
  assert.equal(service.tasks.get(created.task.id).files.length, 0);
  assert.equal(outputNodes(service, requirement.id).length, 1);
  assert.equal(outputNodes(service, requirement.id)[0].kind, 'generation');
  assert.equal(outputNodes(service, requirement.id)[0].outputCard.versions.length, 0);
  assert.equal(service.store.db.prepare('SELECT count(*) AS n FROM output_card_versions').get().n, 0);
  service.store.db.exec('DROP TRIGGER reject_card_version');
  await file(created, 'recovered.md');
  assert.equal(outputNodes(service, requirement.id)[0].outputCard.number, 1);
});

test('outline global numbering and exact Word binding remain separate from card versions', async t => {
  const { service, root, requirement, create } = fixture(t);
  const first = create(), sessionId = `outline:${first.task.id}`;
  service.tasks.bindSession({ taskId: first.task.id, sessionId });
  const save = (created, markdown, session = sessionId) => service.store.saveOutline({ requirementId: requirement.id, markdown,
    taskId: created.task.id, executionSessionId: session, sourceCardIds: [], operationId: randomUUID() });
  const one = save(first, '# 大纲原版');
  save(first, '# 同代另一个已保存大纲');
  let node = outputNodes(service, requirement.id)[0];
  assert.equal(node.outputCard.versions.length, 1);
  assert.equal(node.sourceId, `outline:${one.id}`);
  const wordPath = one.markdownPath.replace(/outline\.md$/, 'outline.docx');
  const word = spawnSync('python3', ['-c', 'import sys; from docx import Document; d=Document(); d.add_paragraph("CW10 exact Word version"); d.save(sys.argv[1])', path.join(root, wordPath)]);
  assert.equal(word.status, 0, word.stderr.toString());
  service.store.markWordExport({ versionId: one.id, relativePath: wordPath });
  assert.equal(outputNodes(service, requirement.id).length, 1);
  assert.equal(outputNodes(service, requirement.id)[0].outputCard.versions.length, 1);
  const revised = create({ generation: { mode: 'revise', cardId: node.outputCard.id, baseVersionId: node.outputCard.versionId } });
  const newSession = `outline:${revised.task.id}`;
  service.tasks.bindSession({ taskId: revised.task.id, sessionId: newSession });
  const three = save(revised, '# 新一代大纲', newSession);
  node = outputNodes(service, requirement.id)[0];
  assert.equal(three.number, 3);
  assert.equal(node.outputCard.number, 2);
  assert.equal(service.cards.describe({ requirementId: requirement.id, cardId: node.outputCard.id, versionId: node.outputCard.versions[0].id }).node.wordPath, wordPath);
  assert.deepEqual((await service.download(one.id)).bytes, readFileSync(path.join(root, wordPath)));
  const manual = service.store.saveOutline({ requirementId: requirement.id, markdown: '# 人工无生成记录', operationId: randomUUID() });
  const manualNode = outputNodes(service, requirement.id).find(value => value.sourceId === `outline:${manual.id}`);
  assert.equal(service.cards.describe({ requirementId: requirement.id, cardId: manualNode.outputCard.id }).editor.recorded, false);
});

test('media revisions publish on the original card without adding the old output as a reference; unknown jobs add no version', async t => {
  const made = spawnSync('python3', ['-c', 'import io,sys; from PIL import Image; b=io.BytesIO(); Image.new("RGB",(2,2)).save(b,format="PNG"); sys.stdout.buffer.write(b.getvalue())']);
  assert.equal(made.status, 0, made.stderr.toString());
  const submissions = [];
  const provider = {
    async capabilities() { return { endpoint: 'http://127.0.0.1:8000', healthy: true, credentialConfigured: true,
      modelDefaults: { image: { model: 'jimeng-5.0', ratio: '4:3', resolution: '2k' } },
      models: [{ id: 'jimeng-5.0', type: 'image', maxReferences: 10, requiresReference: false, ratios: ['4:3'], resolutions: ['2k'] }] }; },
    async submit(data) { submissions.push(data); if (submissions.length === 3) throw Object.assign(new Error('未知'), { code: 'submission_unknown' }); return { resultBase64: made.stdout.toString('base64') }; },
    async close() {},
  };
  const { service, requirement, input } = fixture(t, { mediaProvider: provider });
  const wait = async (id, status = 'succeeded') => {
    for (let n = 0; n < 400; n++) { if (service.media.get(id).job.status === status) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail(`media ${id} did not become ${status}`);
  };
  const a = await service.media.create(input({ outputType: 'image' })); await wait(a.task.id);
  const node = outputNodes(service, requirement.id)[0];
  const generation = { mode: 'revise', cardId: node.outputCard.id, baseVersionId: node.outputCard.versionId };
  const b = await service.media.create(input({ outputType: 'image', instruction: '改变配色', generation })); await wait(b.task.id);
  assert.equal(outputNodes(service, requirement.id).length, 1);
  assert.equal(outputNodes(service, requirement.id)[0].outputCard.versions.length, 2);
  assert.deepEqual(submissions[1].references, []);
  const c = await service.media.create(input({ outputType: 'image', instruction: '未知提交不加版本', generation })); await wait(c.task.id, 'unknown');
  service.media.resume(c.task.id);
  assert.equal(submissions.length, 3);
  assert.equal(outputNodes(service, requirement.id)[0].outputCard.versions.length, 2);
});

test('successful versions and original editor snapshots survive reopening and cannot be targeted from another requirement', async t => {
  const { service, requirement, root, input, file } = fixture(t);
  const source = service.canvas.getBoard(requirement.id).nodes[0];
  const old = service.createTask(input({ outputType: undefined, generation: undefined, selectedCardIds: [source.id],
    sourceRefs: [{ cardId: source.id, hash: source.sourceHash }] }));
  const sessionId = `session:${old.task.id}`;
  service.tasks.bindSession({ taskId: old.task.id, sessionId });
  const outline = service.store.saveOutline({ requirementId: requirement.id, taskId: old.task.id, executionSessionId: sessionId,
    markdown: '# 隐式旧课程路由', sourceCardIds: [source.id], operationId: randomUUID() });
  const legacy = outputNodes(service, requirement.id).find(node => node.sourceId === `outline:${outline.id}`);
  assert.equal(service.cards.describe({ requirementId: requirement.id, cardId: legacy.outputCard.id }).editor.outputType, 'outline');
  const newer = service.createTask(input({ instruction: '独立的新一代', generation: { mode: 'revise', cardId: legacy.outputCard.id, baseVersionId: legacy.outputCard.versionId } }));
  await file(newer, 'new.md', '# 新版');
  const selected = outputNodes(service, requirement.id).find(node => node.id === legacy.id);
  const expected = service.cards.describe({ requirementId: requirement.id, cardId: selected.outputCard.id });
  service.close();
  const reopened = new WorkbenchService({ workspaceRoot: root });
  try {
    const restored = reopened.cards.describe({ requirementId: requirement.id, cardId: selected.outputCard.id });
    assert.equal(restored.node.id, legacy.id);
    assert.equal(restored.node.sourceId, expected.node.sourceId);
    assert.deepEqual(restored.card.versions, expected.card.versions);
    assert.equal(restored.editor.instruction, '独立的新一代');
    assert.equal(reopened.cards.describe({ requirementId: requirement.id, cardId: selected.outputCard.id,
      versionId: legacy.outputCard.versionId }).editor.outputType, 'outline');
    const foreign = reopened.store.createRequirement({ title: '另一个需求', operationId: randomUUID() });
    assert.throws(() => reopened.cards.describe({ requirementId: foreign.id, cardId: selected.outputCard.id }), /不存在|不属于|无效/);
    assert.throws(() => reopened.createTask({ ...input(), requirementId: foreign.id,
      generation: { mode: 'revise', cardId: selected.outputCard.id, baseVersionId: selected.outputCard.versionId } }), /不存在|不属于|无效/);
  } finally { reopened.close(); }
});
