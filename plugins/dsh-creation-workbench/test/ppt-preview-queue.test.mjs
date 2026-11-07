import test from 'node:test';
import assert from 'node:assert/strict';
import { createPptPreviewQueue } from '../src/ppt-preview-queue.mjs';

function clock() {
  let sequence = 0; const timers = new Map();
  return { setTimer: fn => { timers.set(++sequence, fn); return sequence }, clearTimer: id => timers.delete(id),
    fire() { for (const [id, fn] of [...timers]) { timers.delete(id); fn() } }, get size() { return timers.size } };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } };

test('rapid blur events coalesce to one latest render after the idle window', async () => {
  const time = clock(), rendered = [], queue = createPptPreviewQueue(async value => { rendered.push(value); return value }, time);
  const first = queue.schedule(1), second = queue.schedule(2), last = queue.schedule(3);
  assert.deepEqual(rendered, []); assert.equal(time.size, 1);
  assert.equal(await first, null); assert.equal(await second, null);
  time.fire(); assert.equal(await last, 3); assert.deepEqual(rendered, [3]); queue.close();
});

test('an executing render is never duplicated and only the latest pending revision survives', async () => {
  const time = clock(), rendered = [], gates = [deferred(), deferred()];
  const queue = createPptPreviewQueue(async value => { const index = rendered.length; rendered.push(value); await gates[index].promise; return value }, time);
  const first = queue.schedule(1, { immediate: true });
  const second = queue.schedule(2); time.fire(); const last = queue.schedule(3); time.fire();
  assert.deepEqual(rendered, [1]); assert.equal(await second, null);
  gates[0].resolve(); assert.equal(await first, 1); assert.deepEqual(rendered, [1, 3]);
  gates[1].resolve(); assert.equal(await last, 3); queue.close();
});

test('typing pauses a queued preview, and cancellation/close never start expensive work', async () => {
  const time = clock(), rendered = [], queue = createPptPreviewQueue(async value => rendered.push(value), time);
  const first = queue.schedule(1); queue.pause(); time.fire(); assert.deepEqual(rendered, []);
  const second = queue.schedule(2); assert.equal(await first, null); queue.cancel(); assert.equal(await second, null);
  const third = queue.schedule(3); queue.close(); time.fire(); assert.equal(await third, null);
  assert.equal(await queue.schedule(4), null); assert.deepEqual(rendered, []);
});

test('a failed render reports its failure and the next render still runs', async () => {
  const queue = createPptPreviewQueue(async value => { if (value === 1) throw new Error('真实转换失败'); return value });
  await assert.rejects(queue.schedule(1, { immediate: true }), /真实转换失败/);
  assert.equal(await queue.schedule(2, { immediate: true }), 2); queue.close();
});

test('cancelling the next text edit resumes the previous saved edit waiting for its preview', async () => {
  const time = clock(), rendered = [], queue = createPptPreviewQueue(async value => { rendered.push(value); return value }, time);
  const saved = queue.schedule('前一处已保存的修改'); queue.pause(); time.fire();
  assert.deepEqual(rendered, []);
  queue.resume(); time.fire(); assert.equal(await saved, '前一处已保存的修改');
  assert.deepEqual(rendered, ['前一处已保存的修改']); queue.close(); queue.resume(); assert.equal(time.size, 0);
});
