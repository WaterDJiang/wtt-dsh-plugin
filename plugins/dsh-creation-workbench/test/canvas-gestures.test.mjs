import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scaleViewport, wheelViewport, touchGeometry, touchViewport } from '../src/canvas-gestures.mjs';
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const world = (v, p) => ({ x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom });

test('普通水平、垂直和斜向滚动只平移，Meta 也不把滚动改为缩放', () => {
  const v = { x: 30, y: -20, zoom: 0.7 };
  assert.deepEqual(wheelViewport(v, { deltaX: 120, deltaY: -80, metaKey: true }, { x: 200, y: 100 }), { x: -90, y: 60, zoom: 0.7 });
  assert.deepEqual(wheelViewport(v, { deltaX: 0, deltaY: 0 }, {}), v);
  assert.deepEqual(v, { x: 30, y: -20, zoom: 0.7 });
});

test('行／页滚动正规化，坏数据不污染视口', () => {
  assert.deepEqual(wheelViewport({ x: 0, y: 0, zoom: 1 }, { deltaY: 2, deltaX: 1, deltaMode: 1 }, {}), { x: -20, y: -40, zoom: 1 });
  assert.deepEqual(wheelViewport({ x: 0, y: 0, zoom: 1 }, { deltaY: 1, deltaMode: 2 }, {}, 600), { x: 0, y: -600, zoom: 1 });
  assert.deepEqual(wheelViewport({ x: 1, y: 2, zoom: 1 }, { deltaY: NaN, deltaX: Infinity }, {}), { x: 1, y: 2, zoom: 1 });
});

test('Ctrl wheel 捏合围绕指针缩放，往返后锚点画布坐标不漂移', () => {
  const before = { x: -400, y: 85, zoom: 0.5 }, anchor = { x: 530, y: 220 };
  const after = wheelViewport(before, { deltaY: -15, ctrlKey: true }, anchor);
  assert.ok(after.zoom > before.zoom);
  const a = world(before, anchor), b = world(after, anchor);
  close(a.x, b.x); close(a.y, b.y);
  const restored = wheelViewport(after, { deltaY: 15, ctrlKey: true }, anchor);
  close(restored.zoom, before.zoom); close(restored.x, before.x); close(restored.y, before.y);
});

test('缩放上下限仍围绕同一锚点，不出现 NaN 或负缩放', () => {
  const v = { x: 20, y: -40, zoom: 1 }, anchor = { x: 200, y: 100 };
  for (const [scale, expected] of [[1e20, 3], [1e-20, 0.1]]) {
    const after = scaleViewport(v, anchor, scale);
    assert.equal(after.zoom, expected);
    close(world(after, anchor).x, world(v, anchor).x);
  }
  assert.deepEqual(scaleViewport(v, anchor, NaN), v);
  assert.deepEqual(scaleViewport(v, anchor, -1), v);
});

test('双指同向移动不缩放，不依赖触点顺序', () => {
  const start = touchGeometry([{ x: 100, y: 100 }, { x: 300, y: 100 }]);
  const current = touchGeometry([{ x: 380, y: 160 }, { x: 180, y: 160 }]);
  assert.deepEqual(touchViewport({ x: 0, y: 0, zoom: 1 }, start, current), { x: 80, y: 60, zoom: 1 });
  assert.equal(touchGeometry([{ x: 0, y: 0 }]), null);
});

test('双指平移与缩放同时进行时，初始中心的画布点仍落在当前中心', () => {
  const v = { x: -90, y: 40, zoom: 0.6 };
  const start = touchGeometry([{ x: 100, y: 100 }, { x: 300, y: 100 }]);
  const current = touchGeometry([{ x: 80, y: 200 }, { x: 480, y: 200 }]);
  const after = touchViewport(v, start, current);
  close(after.zoom, 1.2);
  const a = world(v, start), b = world(after, current);
  close(a.x, b.x); close(a.y, b.y);
});
