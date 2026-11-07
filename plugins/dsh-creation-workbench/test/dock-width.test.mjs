import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dockGeometry, dockKeyboardWidth } from '../src/dock-width.mjs'

test('desktop split reserves usable canvas space across width limits and restores the user preference', () => {
  const preferred = 820
  for (const total of [760, 900, 1024, 1280, 1920]) {
    const layout = dockGeometry(total, preferred)
    assert.equal(layout.mobile, false)
    assert.ok(layout.width >= 320 && layout.width <= 900)
    assert.ok(total - layout.width >= 320)
  }
  assert.equal(dockGeometry(900, preferred).width, 580)
  assert.equal(dockGeometry(1280, preferred).width, 820)
  assert.equal(dockGeometry(1280, NaN).width, 480)
})

test('phone uses a full content page without destroying the saved desktop width', () => {
  for (const total of [334, 390, 702, 759]) {
    assert.equal(dockGeometry(total, 640).mobile, true)
    assert.equal(dockGeometry(total, 640).width, total)
  }
  assert.equal(dockGeometry(1280, 640).width, 640)
})

test('keyboard separator follows left edge direction and respects both bounds', () => {
  const layout = dockGeometry(1024, 480)
  assert.equal(dockKeyboardWidth('ArrowLeft', 480, layout), 496)
  assert.equal(dockKeyboardWidth('ArrowRight', 480, layout, true), 430)
  assert.equal(dockKeyboardWidth('Home', 480, layout), 320)
  assert.equal(dockKeyboardWidth('End', 480, layout), 704)
  assert.equal(dockKeyboardWidth('ArrowLeft', 704, layout), 704)
  assert.equal(dockKeyboardWidth('ArrowRight', 320, layout), 320)
  assert.equal(dockKeyboardWidth('Enter', 480, layout), null)
})

test('editing can shrink to a real sidebar in a 716px workspace while phones keep a content page',()=>{assert.equal(dockGeometry(716,680,true).mobile,false);assert.equal(dockGeometry(716,680,true).width,396);assert.equal(dockGeometry(716,680).mobile,true);assert.equal(dockGeometry(390,680,true).mobile,true);assert.equal(dockGeometry(1280,680,true).width,680)});
