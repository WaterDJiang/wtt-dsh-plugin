import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPptDocument, patchPptText, pptDocumentChanges, pptObjectStyle, reconcilePublishedPptDraft, recoverPptLocalEdits, retainLaterPptEdits } from '../src/ppt-editor-state.mjs';

const fixture = () => ({ width: 1920, height: 1080, slides: [
  { id: 'slide-one', number: 1, title: '第一页', notes: '原讲师备注', elements: [
    { id: 'shape-title', name: '标题', type: 'text', text: '原课程标题', editable: true, bounds: { x: 192, y: 108, width: 960, height: 216 } },
    { id: 'group-1/shape-body', name: '分组正文', type: 'text', text: '分组正文', editable: true, bounds: { x: 384, y: 432, width: 1152, height: 324 } },
    { id: 'dynamic-field', name: '动态字段', type: 'text', text: '第 1 页', editable: false, reason: '动态字段不能安全修改', bounds: { x: 1700, y: 1000, width: 100, height: 40 } },
  ] },
  { id: 'slide-two', number: 2, title: '第二页', notes: '', elements: [{ id: 'another-title', text: '其他页保留', editable: true }] },
] });

test('PPT edits address actual stable page/object ids and submit only changed text/notes', () => {
  const original = fixture();
  let draft = patchPptText(original, 'slide-one', 'group-1/shape-body', '分组中的新正文');
  draft = patchPptText(draft, 'slide-one', null, '新增讲师备注\r\n下一行');
  assert.deepEqual(pptDocumentChanges(original, draft), [{ slideId: 'slide-one', changes: [{ elementId: 'group-1/shape-body', text: '分组中的新正文' }], notes: '新增讲师备注\n下一行' }]);
  assert.equal(original.slides[0].elements[1].text, '分组正文');
  assert.deepEqual(draft.slides[1], original.slides[1]);
});

test('reverting to the original value removes the mutation rather than submitting an empty replacement', () => {
  const original = fixture();
  const changed = patchPptText(original, 'slide-one', 'shape-title', '临时修改');
  const reverted = patchPptText(changed, 'slide-one', 'shape-title', '原课程标题');
  assert.deepEqual(pptDocumentChanges(original, reverted), []);
  const blank = patchPptText(original, 'slide-one', 'shape-title', '');
  assert.deepEqual(pptDocumentChanges(original, blank)[0].changes, [{ elementId: 'shape-title', text: '' }]);
});

test('late save responses retain keystrokes typed while the request was in flight', () => {
  const base = fixture();
  const submitted = patchPptText(base, 'slide-one', 'shape-title', '已提交的标题');
  const local = patchPptText(submitted, 'slide-one', null, '保存请求期间继续输入');
  const saved = structuredClone(submitted);
  saved.slides[0].elements[0].name = '服务端更新的对象名称';
  const retained = retainLaterPptEdits(submitted, local, saved);
  assert.equal(retained.slides[0].notes, '保存请求期间继续输入');
  assert.equal(retained.slides[0].elements[0].text, '已提交的标题');
  assert.equal(retained.slides[0].elements[0].name, '服务端更新的对象名称');
  assert.deepEqual(pptDocumentChanges(saved, retained), [{ slideId: 'slide-one', changes: [], notes: '保存请求期间继续输入' }]);
});

test('recovering unsaved local fields preserves remote changes elsewhere and identifies overlapping writes', () => {
  const previous = fixture(), local = patchPptText(previous, 'slide-one', 'shape-title', '本地标题');
  const remote = patchPptText(previous, 'slide-one', null, '其他窗口新增的备注');
  const restored = recoverPptLocalEdits(previous, local, remote);
  assert.deepEqual(restored.conflicts, []);
  assert.equal(restored.document.slides[0].notes, '其他窗口新增的备注');
  assert.equal(restored.document.slides[0].elements[0].text, '本地标题');
  const overlapping = patchPptText(remote, 'slide-one', 'shape-title', '另一窗口的标题');
  const conflict = recoverPptLocalEdits(previous, local, overlapping);
  assert.deepEqual(conflict.conflicts, [{ slideId: 'slide-one', elementId: 'shape-title', kind: 'text' }]);
  assert.equal(conflict.document.slides[0].notes, '其他窗口新增的备注');
});

test('readonly objects, unknown ids, deleted objects and reordered pages cannot become edit patches', () => {
  const original = fixture();
  assert.throws(() => patchPptText(original, 'slide-one', 'dynamic-field', '冒充可编辑'), /动态字段/);
  assert.throws(() => patchPptText(original, 'foreign-page', null, '越界'), /页面已不存在/);
  assert.throws(() => patchPptText(original, 'slide-one', 'foreign-object', '越界'), /文字对象已不存在/);
  const tampered = structuredClone(original); tampered.slides[0].elements[2].text = '伪造更新';
  assert.throws(() => pptDocumentChanges(original, tampered), /动态字段/);
  const reordered = structuredClone(original); reordered.slides.reverse();
  assert.throws(() => pptDocumentChanges(original, reordered), /页序/);
  const removed = structuredClone(original); removed.slides[0].elements.pop();
  assert.throws(() => pptDocumentChanges(original, removed), /增删/);
  const wrongIds = structuredClone(original); wrongIds.slides[0].elements[0].id = 'changed-id';
  assert.throws(() => pptDocumentChanges(original, wrongIds), /定位发生变化/);
});

test('invalid source dimensions and duplicate page/object ids fail before drawing or editing', () => {
  const zero = fixture(); zero.width = 0;
  assert.throws(() => checkPptDocument(zero), /页面信息不完整/);
  const duplicatePage = fixture(); duplicatePage.slides[1].id = 'slide-one';
  assert.throws(() => checkPptDocument(duplicatePage), /页标识/);
  const duplicateObject = fixture(); duplicateObject.slides[0].elements[1].id = 'shape-title';
  assert.throws(() => checkPptDocument(duplicateObject), /文字对象标识/);
});

test('unsafe speaker notes remain readonly while the page text can still be edited', () => {
  const original = fixture(); original.slides[0].notesEditable = false; original.slides[0].notesReason = '备注含动态字段';
  assert.throws(() => patchPptText(original, 'slide-one', null, '不安全替换'), /备注含动态字段/);
  const tampered = structuredClone(original); tampered.slides[0].notes = '伪造修改';
  assert.throws(() => pptDocumentChanges(original, tampered), /备注含动态字段/);
  const textOnly = patchPptText(original, 'slide-one', 'shape-title', '仍可修改标题');
  assert.deepEqual(pptDocumentChanges(original, textOnly), [{ slideId: 'slide-one', changes: [{ elementId: 'shape-title', text: '仍可修改标题' }] }]);
});

test('native bounds map to the displayed page, retain rotation and reject invalid geometry', () => {
  const document = fixture(), element = document.slides[0].elements[0];
  assert.deepEqual(pptObjectStyle(document, element), { left: '10%', top: '10%', width: '50%', height: '20%' });
  assert.equal(pptObjectStyle(document, { ...element, rotation: 30 }).transform, 'rotate(30deg)');
  assert.equal(pptObjectStyle(document, { ...element, bounds: { ...element.bounds, width: Infinity } }), null);
  assert.equal(pptObjectStyle(document, { ...element, bounds: { ...element.bounds, height: 0 } }), null);
  assert.equal(pptObjectStyle(document, { ...element, bounds: null }), null);
});

test('publishing clears the already-published old-scope fields and removes stale dirty state', () => {
  const base = fixture(), submitted = patchPptText(base, 'slide-one', 'shape-title', '已发布标题');
  const latest = { revision: 3, dirty: false, document: base };
  const result = reconcilePublishedPptDraft(submitted, submitted, latest, { revision: 3 });
  assert.deepEqual(result.document, base);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.unsaved, false);
});

test('a clean publication retains only input entered after the published snapshot was frozen', () => {
  const base = fixture(), submitted = patchPptText(base, 'slide-one', 'shape-title', '已发布标题');
  const later = patchPptText(submitted, 'slide-one', null, '发布期间新输入的备注');
  const result = reconcilePublishedPptDraft(submitted, later, { revision: 3, dirty: false, document: base }, { revision: 3 });
  assert.equal(result.document.slides[0].elements[0].text, '原课程标题');
  assert.equal(result.document.slides[0].notes, '发布期间新输入的备注');
  assert.deepEqual(pptDocumentChanges(base, result.document), [{ slideId: 'slide-one', changes: [], notes: '发布期间新输入的备注' }]);
  assert.equal(result.unsaved, true);
});

test('an AI confirmation reconciles against its original draft, retaining later manual input', () => {
  const base = fixture();
  const originalDraft = patchPptText(base, 'slide-one', 'shape-title', 'AI 开始前手工草稿');
  const later = patchPptText(originalDraft, 'slide-two', 'another-title', '随后在另一页输入');
  const result = reconcilePublishedPptDraft(originalDraft, later, { revision: 4, dirty: false, document: base }, { revision: 4 });
  assert.equal(result.document.slides[0].elements[0].text, '原课程标题');
  assert.equal(result.document.slides[1].elements[0].text, '随后在另一页输入');
  assert.deepEqual(result.conflicts, []);
});

test('a newer remote draft survives publication reconciliation and gains nonoverlapping local edits', () => {
  const base = fixture(), submitted = patchPptText(base, 'slide-one', 'shape-title', '已提交标题');
  const later = patchPptText(submitted, 'slide-one', null, '本地晚输入备注');
  const remote = patchPptText(submitted, 'slide-two', 'another-title', '其他窗口晚输入');
  const result = reconcilePublishedPptDraft(submitted, later, { revision: 8, dirty: true, document: remote }, { revision: 7 });
  assert.equal(result.document.slides[0].elements[0].text, '已提交标题');
  assert.equal(result.document.slides[0].notes, '本地晚输入备注');
  assert.equal(result.document.slides[1].elements[0].text, '其他窗口晚输入');
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.unsaved, true);
});

test('overlapping remote edits after publication require an explicit conflict decision', () => {
  const submitted = fixture(), later = patchPptText(submitted, 'slide-one', 'shape-title', '本地晚输入标题');
  const remote = patchPptText(submitted, 'slide-one', 'shape-title', '其他窗口晚输入标题');
  const result = reconcilePublishedPptDraft(submitted, later, { revision: 10, dirty: true, document: remote }, { revision: 9 });
  assert.deepEqual(result.conflicts, [{ slideId: 'slide-one', elementId: 'shape-title', kind: 'text' }]);
  assert.equal(result.document.slides[0].elements[0].text, '本地晚输入标题');
  assert.equal(result.unsaved, true);
});

test('a stale or malformed post-publication draft is rejected instead of restoring stale state', () => {
  const submitted = fixture();
  assert.throws(() => reconcilePublishedPptDraft(submitted, submitted, { revision: 2, dirty: false, document: fixture() }, { revision: 3 }), /旧修订/);
  assert.throws(() => reconcilePublishedPptDraft(submitted, submitted, { revision: null, dirty: false, document: fixture() }, { revision: 3 }), /修订号无效/);
});
