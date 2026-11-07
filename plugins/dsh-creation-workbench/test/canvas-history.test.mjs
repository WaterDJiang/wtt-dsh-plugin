import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayoutHistory } from '../src/canvas-history.mjs';
const layout = x => ({ positions: { card: { x, y: 0 } }, edges: [], groups: [], elements: [], viewport: { x, y: 0, zoom: 1 }, versions: ['immutable'] });

test('undo restores editable state without touching view navigation or business versions', () => {
  const history = createLayoutHistory();
  const a = layout(0), b = layout(20);
  history.record(a, b);
  a.positions.card.x = 999;
  const restored = history.undo(b);
  assert.equal(restored.positions.card.x, 0);
  assert.equal(restored.viewport, undefined);
  assert.equal(restored.versions, undefined);
  assert.equal(history.redo(restored).positions.card.x, 20);
});

test('viewport-only changes are ignored; a new edit clears redo and bounded history ages out', () => {
  const history = createLayoutHistory(2);
  const a = layout(0), panned = { ...a, viewport: { x: 600, y: 0, zoom: 0.4 } };
  assert.equal(history.record(a, panned), false);
  history.record(a, layout(1)); history.record(layout(1), layout(2)); history.record(layout(2), layout(3));
  assert.equal(history.undo(layout(3)).positions.card.x, 2);
  assert.equal(history.undo(layout(2)).positions.card.x, 1);
  assert.equal(history.undo(layout(1)), null);
  history.record(layout(1), layout(5));
  assert.equal(history.canRedo, false);
});
