import test from 'node:test';
import assert from 'node:assert/strict';
import { arrangeCardBlocks } from '../src/canvas-arrangement.mjs';

test('arrangement keeps reading order, accommodates uneven sizes and leaves fixed boxes clear', () => {
  const blocks = [
    { id: 'group', x: 20, y: 30, width: 540, height: 260 },
    { id: 'last', x: 100, y: 130, width: 340, height: 160 },
    { id: 'first-row', x: 50, y: 30, width: 258, height: 208 },
    { id: 'second-row', x: 12, y: 130, width: 200, height: 180 },
  ];
  const fixed = [{ x: 530, y: 45, width: 240, height: 160 }];
  const positions = arrangeCardBlocks(blocks, fixed);
  assert.deepEqual([...positions], [
    ['group', { x: 818, y: 30 }], ['first-row', { x: 1406, y: 30 }],
    ['second-row', { x: 12, y: 338 }], ['last', { x: 260, y: 338 }],
  ]);
  assert.deepEqual(arrangeCardBlocks(blocks.map(block => ({ ...block, ...positions.get(block.id) })), fixed), positions);
});

test('arrangement shifts inward near the coordinate limit and rejects a group wider than the canvas', () => {
  const block = { id: 'one', x: 999_900, y: 999_900, width: 200, height: 160 };
  const positions = arrangeCardBlocks([block, { ...block, id: 'two' }], []);
  assert.deepEqual([...positions.values()], [{ x: 999_552, y: 999_840 }, { x: 999_800, y: 999_840 }]);
  assert.throws(() => arrangeCardBlocks([{ ...block, width: 2_000_001 }], []), /坐标范围/);
});
