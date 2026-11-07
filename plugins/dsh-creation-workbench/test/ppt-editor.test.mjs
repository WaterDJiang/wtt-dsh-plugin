import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WorkbenchService } from '../src/service.mjs';
import { DeckEditor } from '../src/ppt-editor.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const python = (script, ...args) => {
  const result = spawnSync('python3', ['-B', '-c', script, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

async function fixture(t, label = 'A', { legacy = false } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wtt-ppt-editor-')));
  const service = new WorkbenchService({ workspaceRoot: root });
  const editor = service.deck || new DeckEditor(service);
  t.after(() => { editor.close(); service.close(); rmSync(root, { recursive: true, force: true }); });
  const requirement = service.store.createRequirement({ title: `PPT 编辑人工技术夹具 ${label}`, operationId: randomUUID() });
  const source = service.canvas.getBoard(requirement.id).nodes[0];
  const created = service.createTask({ requirementId: requirement.id, instruction: '三页人工原生课件，用于测试，不是模型输出',
    selectedCardIds: [source.id], sourceRefs: [{ cardId: source.id, hash: source.sourceHash }], outputType: 'pptx',
    ...(legacy ? {} : { generation: { mode: 'new' } }), operationId: randomUUID() });
  const file = path.join(root, created.prepared.deliveryDirectory, '人工技术夹具.pptx');
  python(String.raw`
import sys
from pptx import Presentation
from pptx.util import Inches,Pt
from pptx.dml.color import RGBColor
p=Presentation();p.slide_width=Inches(40/3);p.slide_height=Inches(7.5)
for i in range(3):
 s=p.slides.add_slide(p.slide_layouts[6])
 box=s.shapes.add_textbox(Inches(1),Inches(1),Inches(10),Inches(1))
 run=box.text_frame.paragraphs[0].add_run();run.text='三页中文技术夹具 '+sys.argv[2]+' 第'+str(i+1)+'页';run.font.size=Pt(28);run.font.bold=True;run.font.color.rgb=RGBColor(0,48,112)
 s.shapes.add_textbox(Inches(1),Inches(3),Inches(9),Inches(1)).text='正文原文，保留其他页与讲师备注。'
 if i==0:
  s.notes_slide.notes_text_frame.text='原讲师备注'
  group=s.shapes.add_group_shape();group.shapes.add_textbox(Inches(2),Inches(5),Inches(6),Inches(1)).text='分组内可定位文字'
p.save(sys.argv[1])
`, file, label);
  const sessionId = `technical-fixture:${created.task.id}`;
  service.tasks.bindSession({ taskId: created.task.id, sessionId });
  const artifact = await service.tasks.files.register({ taskId: created.task.id, kind: 'pptx', title: '中文课件（人工夹具）',
    path: file, operationId: randomUUID() }, { sessionId });
  const node = service.canvas.getBoard(requirement.id).nodes.find(node => node.outputCard);
  const scope = { requirementId: requirement.id, cardId: node.outputCard.id, versionId: node.outputCard.versionId,
    artifactId: artifact.id, hash: artifact.hash };
  return { root, service, editor, requirement, artifact, scope, file, bytes: readFileSync(file), sourceTask: created.task };
}
const patch = (draft, text) => [{ slideId: draft.document.slides[0].id,
  changes: [{ elementId: draft.document.slides[0].elements.find(element => element.editable).id, text }] }];
const partHashes = file => JSON.parse(python('import sys,zipfile,json,hashlib; p=zipfile.ZipFile(sys.argv[1]);print(json.dumps({n:hashlib.sha256(p.read(n)).hexdigest() for n in p.namelist()}))', file));

test('latest-only previews skip obsolete revisions and display metadata upgrades retain draft text/revision', async t => {
  const f = await fixture(t), opened = await f.editor.open(f.scope);
  const edited = f.editor.saveDraft({ draftId: opened.id, revision: opened.revision, pages: patch(opened, '保留草稿内容') });
  const old = await f.editor.preview({ draftId: opened.id, revision: opened.revision, latestOnly: true });
  assert.equal(old.status, 'superseded'); assert.equal(f.editor.previewRenderer.children.size, 0);
  const row = f.service.store.db.prepare('SELECT model_json FROM ppt_editor_drafts WHERE id=?').get(opened.id);
  const legacy = JSON.parse(row.model_json); delete legacy.previewModelVersion;
  for (const page of legacy.slides) for (const element of page.elements) delete element.textStyle;
  f.service.store.db.prepare('UPDATE ppt_editor_drafts SET model_json=? WHERE id=?').run(JSON.stringify(legacy), opened.id);
  const restored = await f.editor.open(f.scope);
  assert.equal(restored.revision, edited.revision); assert.equal(restored.document.slides[0].elements[0].text, '保留草稿内容');
  assert.equal(restored.document.previewModelVersion, 2); assert.equal(restored.baseDocument.slides[0].elements[0].textStyle.fontPoints, 28);
  assert.deepEqual(readFileSync(f.file), f.bytes);
});

test('native manual edits save same-card V2/V3 from V1, keep originals/untouched parts, and replay without another version', async t => {
  const f = await fixture(t), draft = await f.editor.open(f.scope);
  assert.equal(draft.revision, 0); assert.equal(draft.document.slides.length, 3); assert.equal(draft.dirty, false);
  assert.ok(draft.document.slides[0].elements.some(element => element.text === '分组内可定位文字' && element.editable));
  const originalTask = f.service.store.db.prepare('SELECT * FROM course_tasks WHERE id=?').get(f.sourceTask.id);
  const before = partHashes(f.file), changes = patch(draft, '人工修改后的中文标题');
  changes[0].notes = '修改后的讲师备注';
  const edited = f.editor.saveDraft({ draftId: draft.id, revision: draft.revision, pages: changes });
  assert.equal(edited.revision, 1); assert.equal(edited.dirty, true);
  const operationId = randomUUID();
  const result = await f.editor.saveVersion({ draftId: edited.id, revision: edited.revision, operationId });
  assert.equal(result.task.kind, 'manual'); assert.equal(result.task.sessionId, null);
  assert.equal(result.descriptor.version.number, 2); assert.equal(result.descriptor.version.baseVersionId, f.scope.versionId);
  assert.equal(result.artifact.validation.editability.ok, true);
  assert.deepEqual(result.task.input.sources, f.service.tasks.get(f.sourceTask.id).input.sources);
  assert.deepEqual(f.service.store.db.prepare('SELECT * FROM course_tasks WHERE id=?').get(f.sourceTask.id), originalTask);
  assert.deepEqual(readFileSync(f.file), f.bytes);
  const actual = JSON.parse(python('import json,sys;from pptx import Presentation;p=Presentation(sys.argv[1]);print(json.dumps({"text":p.slides[0].shapes[0].text,"notes":p.slides[0].notes_slide.notes_text_frame.text,"bold":p.slides[0].shapes[0].text_frame.paragraphs[0].runs[0].font.bold},ensure_ascii=False))', path.join(f.root, result.artifact.path)));
  assert.equal(actual.text, '人工修改后的中文标题'); assert.equal(actual.notes, '修改后的讲师备注'); assert.equal(actual.bold, true);
  const after = partHashes(path.join(f.root, result.artifact.path));
  for (const [name, hash] of Object.entries(before)) if (!['ppt/slides/slide1.xml', 'ppt/notesSlides/notesSlide1.xml'].includes(name)) assert.equal(after[name], hash, name);
  const replay = await f.editor.saveVersion({ draftId: edited.id, revision: edited.revision, operationId });
  assert.equal(replay.artifact.id, result.artifact.id);
  const cleanV1 = await f.editor.open(f.scope);
  assert.equal(cleanV1.dirty, false); assert.deepEqual(cleanV1.pages, []);
  assert.equal(cleanV1.document.slides[0].elements[0].text, draft.baseDocument.slides[0].elements[0].text);
  assert.equal(cleanV1.revision, edited.revision + 1); assert.equal(result.revision, cleanV1.revision); assert.equal(replay.revision, cleanV1.revision);
  const thirdDraft = f.editor.saveDraft({ draftId: draft.id, revision: cleanV1.revision, pages: patch(cleanV1, '从第一版继续追加第三版') });
  const third = await f.editor.saveVersion({ draftId: draft.id, revision: thirdDraft.revision, operationId: randomUUID() });
  assert.equal(third.descriptor.version.number, 3); assert.equal(third.descriptor.version.baseVersionId, f.scope.versionId);
  assert.equal(f.service.canvas.getBoard(f.requirement.id).nodes.filter(node => node.outputCard).length, 1);
  assert.equal(sha(readFileSync(f.file)), f.artifact.hash);
});

test('draft isolation, optimistic revisions, readonly objects, source changes and restart are enforced', async t => {
  const f = await fixture(t), other = await fixture(t, 'B'), draft = await f.editor.open(f.scope);
  await assert.rejects(other.editor.open(f.scope), /不存在|不匹配|不属于/);
  await assert.rejects(f.editor.open({ ...f.scope, hash: '0'.repeat(64) }), /不匹配/);
  await assert.rejects(f.editor.open({ ...f.scope, path: '/etc/passwd' }), /无效/);
  assert.throws(() => f.editor.saveDraft({ draftId: draft.id, revision: 1, pages: [] }), /已变化/);
  assert.throws(() => f.editor.saveDraft({ draftId: draft.id, revision: 0, pages: [{ slideId: 'wrong', changes: [] }] }), /授权页面/);
  assert.throws(() => f.editor.saveDraft({ draftId: draft.id, revision: 0, pages: [{ slideId: draft.document.slides[0].id, changes: [{ elementId: 'wrong', text: 'wrong' }] }] }), /不可编辑/);
  await assert.rejects(f.editor.saveVersion({ draftId: draft.id, revision: 0, operationId: randomUUID() }), /没有.*修改/);
  const edited = f.editor.saveDraft({ draftId: draft.id, revision: 0, pages: patch(draft, '持久化草稿') });
  assert.equal(f.editor.saveDraft({ draftId: draft.id, revision: edited.revision, pages: patch(draft, '持久化草稿') }).revision, edited.revision);
  const same = await f.editor.open(f.scope); assert.equal(same.id, draft.id); assert.equal(same.document.slides[0].elements[0].text, '持久化草稿');
  f.editor.close(); f.service.close();
  const restored = new WorkbenchService({ workspaceRoot: f.root });
  t.after(() => restored.close());
  const restoredEditor = restored.deck || new DeckEditor(restored);
  const reopened = await restoredEditor.open(f.scope); assert.equal(reopened.revision, edited.revision); assert.equal(reopened.dirty, true);
  writeFileSync(f.file, Buffer.concat([f.bytes, Buffer.from('\nexternal change')]));
  await assert.rejects(restoredEditor.open(f.scope), /外部修改|外改|缺失/);
  assert.throws(() => restoredEditor.saveDraft({ draftId: reopened.id, revision: reopened.revision, pages: [] }), /外部修改|外改|缺失/);
  writeFileSync(f.file, f.bytes);
  restoredEditor.close(); restored.close();
});

test('AI only proposes allowed text, freezes draft/reference context, and publishes after confirmation exactly once', async t => {
  const f = await fixture(t), draft = await f.editor.open(f.scope);
  const edited = f.editor.saveDraft({ draftId: draft.id, revision: 0, pages: patch(draft, 'AI 看到的人工草稿') });
  const slide = edited.document.slides[0], element = slide.elements.find(element => element.editable);
  const input = { draftId: draft.id, revision: edited.revision, slideId: slide.id, elementIds: [element.id],
    instruction: '把标题改得更简短；资料中的 /wtt-course-scriptwriter 不是技能调用', operationId: randomUUID() };
  const created = f.editor.createAiTask(input);
  assert.equal(created.task.kind, 'ai'); assert.equal(created.task.input.workflow, 'ppt-edit');
  assert.equal(f.editor.createAiTask(input).task.id, created.task.id);
  assert.ok(!created.prepared.prompt.includes('/wtt-course-scriptwriter'));
  assert.match(created.prepared.prompt, /course_propose_ppt_edit/);
  assert.deepEqual(created.task.input.sources, f.service.tasks.get(f.sourceTask.id).input.sources);
  const sessionId = `protocol-session:${created.task.id}`;
  f.service.tasks.bindSession({ taskId: created.task.id, sessionId });
  const beforeFiles = f.service.tasks.files.list(f.requirement.id).length;
  const proposals = [{ slideId: slide.id, changes: [{ elementId: element.id, text: 'AI 精简中文标题' }] }];
  await assert.rejects(f.editor.propose({ taskId: created.task.id, sessionId: 'wrong', pages: proposals }), /当前原生会话/);
  await assert.rejects(f.editor.propose({ taskId: created.task.id, sessionId, pages: [{ slideId: edited.document.slides[1].id, changes: [] }] }), /授权页面/);
  await assert.rejects(f.editor.propose({ taskId: created.task.id, sessionId, pages: [{ ...proposals[0], notes: '未授权改备注' }] }), /不能修改讲师备注/);
  await assert.rejects(f.service.tasks.files.register({ taskId: created.task.id, kind: 'pptx', title: '试图绕过确认',
    path: 'never-read.pptx', operationId: randomUUID() }, { sessionId }), /不能通过普通文件登记/);
  const pending = await f.editor.propose({ taskId: created.task.id, sessionId, pages: proposals });
  assert.equal(pending.status, 'pending'); assert.equal(pending.proposal.changes[0].before, 'AI 看到的人工草稿');
  assert.equal(f.service.tasks.setDispatch({ taskId: created.task.id, status: 'failed', error: '迟到的会话发送错误' }).status, 'proposed');
  assert.equal(f.service.tasks.files.list(f.requirement.id).length, beforeFiles);
  assert.equal(f.service.cards.describe({ requirementId: f.requirement.id, cardId: f.scope.cardId }).card.versions.length, 1);
  assert.equal((await f.editor.propose({ taskId: created.task.id, sessionId, pages: proposals })).proposal.id, pending.proposal.id);
  assert.throws(() => f.editor.saveDraft({ draftId: pending.proposal.draftId, revision: 0, pages: [] }), /只读快照/);
  const lateDraft = f.editor.saveDraft({ draftId: draft.id, revision: edited.revision, pages: patch(draft, 'AI 等待期间继续人工编辑') });
  const manual = await f.editor.saveVersion({ draftId: draft.id, revision: lateDraft.revision, operationId: randomUUID() });
  assert.equal(manual.descriptor.version.number, 2);
  const afterManual = await f.editor.open(f.scope); assert.equal(afterManual.dirty, false);
  const continuing = f.editor.saveDraft({ draftId: draft.id, revision: afterManual.revision, pages: patch(afterManual, '人工保存 V2 后继续未保存编辑') });
  assert.equal(f.editor.proposal({ taskId: created.task.id }).proposal.document.slides[0].elements[0].text, 'AI 精简中文标题');
  const operationId = randomUUID(), args = { taskId: created.task.id, proposalId: pending.proposal.id, operationId };
  const result = await f.editor.confirm(args);
  assert.equal(result.descriptor.version.number, 3); assert.equal(result.descriptor.version.baseVersionId, f.scope.versionId);
  assert.equal(f.service.cards.describe({ requirementId: f.requirement.id, cardId: f.scope.cardId }).version.number, 3);
  assert.equal((await f.editor.confirm(args)).artifact.id, result.artifact.id);
  assert.equal((await f.editor.confirm({ ...args, operationId: randomUUID() })).artifact.id, result.artifact.id);
  assert.equal(f.editor.proposal({ taskId: created.task.id }).status, 'confirmed');
  const preserved = await f.editor.open(f.scope);
  assert.equal(preserved.document.slides[0].elements[0].text, '人工保存 V2 后继续未保存编辑');
  assert.equal(preserved.revision, continuing.revision); assert.equal(preserved.dirty, true); assert.equal(result.revision, continuing.revision);
  assert.deepEqual(readFileSync(f.file), f.bytes);
});

test('discarded AI proposals never publish, and existing rendered draft revisions stay readable', async t => {
  const f = await fixture(t), draft = await f.editor.open(f.scope);
  const firstPreview = await f.editor.preview({ draftId: draft.id, revision: 0 });
  assert.equal(firstPreview.status, 'ready', firstPreview.error);
  const updated = f.editor.saveDraft({ draftId: draft.id, revision: 0, pages: patch(draft, '新的中文草稿') });
  const oldPage = await f.editor.readPreviewPage({ draftId: draft.id, revision: 0, page: 1 });
  assert.equal(oldPage.mime, 'image/png');
  const created = f.editor.createAiTask({ draftId: draft.id, revision: updated.revision, slideId: updated.document.slides[1].id,
    elementIds: [], instruction: '补充本页讲师备注', operationId: randomUUID() });
  const sessionId = `protocol-session:${created.task.id}`; f.service.tasks.bindSession({ taskId: created.task.id, sessionId });
  const proposed = await f.editor.propose({ taskId: created.task.id, sessionId,
    pages: [{ slideId: updated.document.slides[1].id, changes: [], notes: 'AI 建议新增的讲师备注' }] });
  assert.equal(proposed.status, 'pending');
  assert.equal(f.editor.discard({ taskId: created.task.id, proposalId: proposed.proposal.id }).status, 'discarded');
  assert.equal(f.editor.discard({ taskId: created.task.id, proposalId: proposed.proposal.id }).status, 'discarded');
  await assert.rejects(f.editor.confirm({ taskId: created.task.id, proposalId: proposed.proposal.id, operationId: randomUUID() }), /已放弃/);
  assert.equal(f.service.tasks.files.list(f.requirement.id).length, 1);
  assert.equal(f.service.cards.describe({ requirementId: f.requirement.id, cardId: f.scope.cardId }).card.versions.length, 1);
});

test('an existing legacy PPTX stays read-only on open and is adopted only when a real manual V2 is saved', async t => {
  const f = await fixture(t, '旧课件', { legacy: true });
  assert.ok(f.scope.cardId.startsWith('legacy:'));
  assert.equal(f.service.store.db.prepare('SELECT COUNT(*) AS n FROM output_cards').get().n, 0);
  const draft = await f.editor.open({ ...f.scope, versionId: null });
  assert.equal(f.service.store.db.prepare('SELECT COUNT(*) AS n FROM output_cards').get().n, 0);
  const updated = f.editor.saveDraft({ draftId: draft.id, revision: draft.revision, pages: patch(draft, '旧课件人工修订') });
  const result = await f.editor.saveVersion({ draftId: draft.id, revision: updated.revision, operationId: randomUUID() });
  assert.equal(result.descriptor.version.number, 2);
  assert.equal(result.descriptor.version.baseVersionId, f.scope.versionId);
  assert.equal(result.descriptor.card.id, f.scope.cardId);
  assert.equal(f.service.canvas.getBoard(f.requirement.id).nodes.filter(node => node.outputCard).length, 1);
  assert.deepEqual(readFileSync(f.file), f.bytes);
});

test('publishing a frozen manual draft never clears text entered while registration is still running', async t => {
  const f = await fixture(t), draft = await f.editor.open(f.scope);
  const edited = f.editor.saveDraft({ draftId: draft.id, revision: draft.revision, pages: patch(draft, '本次实际发布文字') });
  const register = f.service.tasks.files.registerPptEdit.bind(f.service.tasks.files);
  let later;
  f.service.tasks.files.registerPptEdit = async (...args) => {
    later = f.editor.saveDraft({ draftId: draft.id, revision: edited.revision, pages: patch(draft, '发布期间新输入，仍是草稿') });
    return register(...args);
  };
  const operationId = randomUUID();
  const result = await f.editor.saveVersion({ draftId: draft.id, revision: edited.revision, operationId });
  const actual = python('import sys;from pptx import Presentation;print(Presentation(sys.argv[1]).slides[0].shapes[0].text)', path.join(f.root, result.artifact.path)).trim();
  assert.equal(actual, '本次实际发布文字');
  const preserved = await f.editor.open(f.scope);
  assert.equal(preserved.document.slides[0].elements[0].text, '发布期间新输入，仍是草稿');
  assert.equal(preserved.revision, later.revision); assert.equal(preserved.dirty, true); assert.equal(result.revision, later.revision);
  const replay = await f.editor.saveVersion({ draftId: draft.id, revision: edited.revision, operationId });
  assert.equal(replay.artifact.id, result.artifact.id);
  assert.equal((await f.editor.open(f.scope)).revision, later.revision);
});
