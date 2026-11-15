import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creationSource } from '../src/creation-context.mjs';
import { sameReference, pinnedReference, referencePickReason, togglePickedReference, addPickedReferences } from '../src/canvas-reference-picker.mjs';
const card = id => ({ id, kind: 'material', title: id, sourceHash: id.padEnd(64, 'a') });

test('picking stages a new array, preserves frozen references, and never mutates the original on cancel', () => {
  const old = card('old'), original = [old], context = { blank: true };
  const staged = togglePickedReference(original, card('new'), context).references;
  assert.deepEqual(original, [old]);
  assert.equal(staged[0], old);
  assert.equal(staged.length, 2);
  assert.deepEqual(togglePickedReference(staged, card('new'), context).references, original);
});

test('anchor cannot be toggled off; revision and blank contexts can remove it', () => {
  const anchor = card('anchor');
  assert.equal(pinnedReference(anchor, { anchor }), true);
  assert.deepEqual(togglePickedReference([anchor], anchor, { anchor }).references, [anchor]);
  assert.deepEqual(togglePickedReference([anchor], anchor, { anchor, intent: 'revise' }).references, []);
  assert.deepEqual(togglePickedReference([anchor], anchor, { anchor, blank: true }).references, []);
  assert.equal(pinnedReference(card('other'), { pendingTaskId: 'task', blank: true }), true);
});

test('rectangle recalculation uses the gesture baseline, excludes duplicates, and enforces 24 sources', () => {
  const base = [card('anchor')], a = card('a'), b = card('b');
  assert.equal(addPickedReferences(base, [a, b, a], {}).references.length, 3);
  assert.deepEqual(addPickedReferences(base, [a], {}).references, [...base, a], 'shrinking the current rectangle must remove b');
  assert.deepEqual(base, [card('anchor')]);
  const full = Array.from({ length: 24 }, (_, i) => card(String(i)));
  const result = addPickedReferences(full, [card('extra')], {});
  assert.equal(result.references.length, 24);
  assert.match(result.error, /24/);
});

test('unavailable sources cannot be added but an existing unpinned source can be removed', () => {
  const missing = { ...card('missing'), status: 'missing' };
  assert.match(togglePickedReference([], missing, { blank: true }).error, /缺失/);
  assert.deepEqual(addPickedReferences([], [missing], {}).references, []);
  assert.deepEqual(togglePickedReference([missing], missing, { blank: true }).references, []);
});

test('currently displayed historical version keeps its physical source and hash', () => {
  const old = creationSource({ ...card('logical'), sourceId: 'physical-v1', sourceHash: '1'.repeat(64) });
  const latest = creationSource({ ...card('logical'), sourceId: 'physical-v2', sourceHash: '2'.repeat(64) });
  assert.equal(old.nodeId, 'logical');
  assert.equal(sameReference(old, latest), false);
  const staged = addPickedReferences([old], [latest], { blank: true }).references;
  assert.deepEqual(staged.map(c => c.id), ['physical-v1', 'physical-v2']);
  assert.equal(staged[0].sourceHash, '1'.repeat(64));
});

test('whiteboard snapshot identity compares text/hash and media API keeps its video limit', () => {
  const element = { id: 'element', kind: 'whiteboard', content: 'Hello\r\nWorld' };
  const saved = { ...card('snapshot'), content: 'Hello\nWorld', whiteboardSource: { elementId: 'element', contentHash: 'sha' } };
  assert.equal(sameReference(saved, element), true);
  assert.equal(sameReference(saved, { ...element, content: 'Changed' }), false);
  assert.equal(addPickedReferences([saved], [element], {}).references.length, 1);
  const video = { ...card('video'), importedFile: { mime: 'video/mp4' } };
  assert.match(referencePickReason(video, { outputType: 'image', generationMethod: 'api' }), /视频引用/);
  assert.equal(referencePickReason(video, { outputType: 'image', generationMethod: 'skill' }), '');
});

test('unextracted attachment needs its original file; extracted text keeps its saved snapshot', () => {
  const source = { ...card('file'), status: 'ready', sourceStatus: 'missing' };
  assert.match(referencePickReason({ ...source, extracted: false }, {}), /缺失/);
  assert.equal(referencePickReason({ ...source, extracted: true }, {}), '');
});
