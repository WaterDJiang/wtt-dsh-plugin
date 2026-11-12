import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARD_WIDTH, CARD_HEIGHT, createCardContext, updateCreationReferences, creationTaskInput, adjacentCreationPosition, creationPositionFree } from '../src/creation-context.mjs';
const card = (id, content = '原正文') => ({ id, kind: 'outline', refId: id, title: id, sourceHash: 'a'.repeat(64), content, position: { x: 40, y: 60 } });
const context = anchor => createCardContext({ projectId: '项目A', projectPath: '/A', requirement: { id: '需求A', title: '课程A' }, anchor, outputPosition: { x: 378, y: 60 } });

test('opening a card freezes its body, project, version and source hash despite later selection or file snapshots', () => {
  const source = card('outline:v1');
  const pinned = context(source);
  source.content = '后来正文'; source.sourceHash = 'b'.repeat(64); source.refId = 'v2';
  pinned.instruction = '修改原版本';
  const input = creationTaskInput(pinned);
  assert.equal(pinned.projectPath, '/A');
  assert.equal(pinned.anchor.content, '原正文');
  assert.equal(pinned.anchor.refId, 'outline:v1');
  assert.deepEqual(input.selectedCardIds, ['outline:v1']);
  assert.equal(input.sourceRefs[0].hash, 'a'.repeat(64));
});

test('extra references can be removed while the operation anchor and previous reference snapshots remain pinned', () => {
  const original = context(card('one'));
  const extra = card('two');
  const added = updateCreationReferences(original, [extra]);
  extra.content = '外部变化';
  const retained = updateCreationReferences(added, [extra, card('three')]);
  assert.equal(retained.references[1].content, '原正文');
  assert.deepEqual(updateCreationReferences(retained, []).references.map(item => item.id), ['one']);
  assert.throws(() => updateCreationReferences(original, Array.from({ length: 24 }, (_, i) => card(`extra${i}`))), /最多引用 24/);
});

test('unfrozen whiteboard and modified sources cannot become creation anchors', () => {
  assert.throws(() => context({ ...card('note'), kind: 'whiteboard' }), /已保存来源/);
  assert.throws(() => context({ ...card('old'), status: 'modified' }), /已保存来源/);
});

test('imported file and whiteboard snapshot metadata stay frozen with their original reference', () => {
  const original = { ...card('material:one'), kind: 'material', importedFile: { name: '参考.pdf', hash: 'b'.repeat(64) },
    whiteboardSource: { elementId: 'whiteboard:one', contentHash: 'c'.repeat(64) } };
  const pinned = context(original);
  original.importedFile.name = '后来.pdf';
  original.whiteboardSource.elementId = 'whiteboard:other';
  assert.equal(pinned.anchor.importedFile.name, '参考.pdf');
  assert.equal(pinned.references[0].whiteboardSource.elementId, 'whiteboard:one');
});

test('new products start beside the original anchor and avoid existing cards', () => {
  const anchor = card('base');
  const crowded = { ...card('occupied'), position: { x: 40 + CARD_WIDTH + 80, y: 60 } };
  const result = adjacentCreationPosition(anchor, [anchor, crowded]);
  assert.equal(result.x, crowded.position.x);
  assert.ok(result.y > crowded.position.y + CARD_HEIGHT);
});

test('a selected passage has a separate draft from whole-source creation and carries its exact range', () => {
  const anchor = card('outline:v1', '第一段\n第二段');
  const whole = context(anchor);
  const selected = createCardContext({ ...whole, requirement: { id: '需求A' }, anchor,
    selection: { sourceCardId: anchor.id, sourceHash: anchor.sourceHash, start: 4, end: 7, quote: '第二段' } });
  assert.notEqual(selected.key, whole.key);
  assert.deepEqual(creationTaskInput(selected).selection, selected.selection);
  assert.equal(creationTaskInput(whole).selection, undefined);
});


test('crowded placement has no forty-slot or giant-obstacle overlap fallback and remains local', () => {
 const anchor=card('source'),barrier={position:{x:440,y:-20000},width:600,height:40000};
 const position=adjacentCreationPosition(anchor,[anchor,barrier]);
 assert(creationPositionFree(position,[anchor,barrier]));
 assert(Math.hypot(position.x-anchor.position.x,position.y-anchor.position.y)<2000);
 const occupied=[anchor];
 for(let i=0;i<90;i++){const next=adjacentCreationPosition(anchor,occupied);assert(creationPositionFree(next,occupied));occupied.push({position:next});}
 assert.equal(new Set(occupied.map(node=>JSON.stringify(node.position))).size,91);
});
