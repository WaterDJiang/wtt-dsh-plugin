import test from 'node:test';
import assert from 'node:assert/strict';
import { insertReferenceMention, referenceQueryAtCursor } from '../src/reference-mention.mjs';

test('reference mentions replace only the active query and preserve surrounding Chinese punctuation', () => {
  const text = '按＠大纲.pdf，整理练习';
  const range = referenceQueryAtCursor(text, '按＠大'.length);
  assert.deepEqual(range, { start: 1, end: '按＠大纲.pdf'.length, query: '大' });
  assert.deepEqual(insertReferenceMention(text, range, '资料/课前 大纲.pdf'), {
    text: '按@「资料/课前 大纲.pdf」，整理练习', cursor: '按@「资料/课前 大纲.pdf」'.length,
  });
});

test('reference search does not treat an email, URL, existing mention or skill token as a new mention', () => {
  for (const text of ['contact@example.com', 'https://example.com/@profile', '@「已选文件.md」', '/course-builder']) {
    assert.equal(referenceQueryAtCursor(text, text.length), null);
  }
  assert.deepEqual(referenceQueryAtCursor('先看 @', 4), { start: 3, end: 4, query: '' });
  assert.equal(insertReferenceMention('@', { start: 0, end: 1 }, '大纲.md').text, '@「大纲.md」 ');
});
