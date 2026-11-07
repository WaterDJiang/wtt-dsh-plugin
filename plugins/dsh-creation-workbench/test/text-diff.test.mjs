import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, normalizeLineEndings, savedPassage } from '../src/text-diff.mjs';

function reconstructed(diff, side) {
  return diff.blocks.filter(block => block.type !== (side === 'old' ? 'add' : 'delete')).flatMap(block => block.lines).join('\n');
}

function assertFullDiff(before, after, options) {
  const result = diffLines(before, after, options);
  assert.equal(reconstructed(result, 'old'), normalizeLineEndings(before));
  assert.equal(reconstructed(result, 'new'), normalizeLineEndings(after));
  let oldLine = 1, newLine = 1;
  for (const block of result.blocks) {
    assert.equal(block.oldStart, oldLine);
    assert.equal(block.newStart, newLine);
    if (block.type !== 'add') oldLine += block.lines.length;
    if (block.type !== 'delete') newLine += block.lines.length;
  }
  return result;
}

test('full diff preserves Chinese, duplicate lines, HTML text, blank lines and terminal newlines', () => {
  const result = assertFullDiff('# 课程\r\n\r\n重复\r\n重复\r\n<script>x()</script>\r\n', '# 课程\n\n重复\n新增😀\n重复\n<script>x()</script>\n');
  assert.equal(result.mode, 'lines');
  assert.equal(result.added, 1);
  assert.equal(result.removed, 0);
  assert.equal(result.blocks.find(block => block.type === 'add').newStart, 4);
});

test('empty documents, single newlines, additions and removals remain lossless', () => {
  for (const [before, after] of [['', ''], ['', '\n'], ['\n', ''], ['一\n二', ''], ['', '一\n二'], ['一\n二\n', '一\n二'], ['a\nb\nc', 'c\nb\na']]) assertFullDiff(before, after);
});

test('large disjoint changes use complete blocks with common edges and no truncation', () => {
  const before = `共同开始\n${Array.from({ length: 6000 }, (_, i) => `原始-${i}😀`).join('\n')}\n\n共同结尾\n`;
  const after = `共同开始\n${Array.from({ length: 6000 }, (_, i) => `修订-${i}中文`).join('\n')}\n\n共同结尾\n`;
  const result = assertFullDiff(before, after);
  assert.equal(result.mode, 'blocks');
  assert.equal(result.blocks.length, 4);
  assert.equal(result.removed, 6000);
  assert.equal(result.added, 6000);
});

test('complexity budget and very long unchanged documents avoid a large line matrix', () => {
  assert.equal(assertFullDiff('a\nb\nc', 'd\ne\nf', { maxCells: 4 }).mode, 'blocks');
  const source = Array.from({ length: 10000 }, (_, i) => `章节 ${i}`).join('\n');
  const result = assertFullDiff(source, source);
  assert.equal(result.mode, 'blocks');
  assert.equal(result.blocks.length, 1);
  assert.equal(result.added + result.removed, 0);
});

test('small deterministic combinations reconstruct exactly', () => {
  const texts = ['', 'a', 'b', '\n', 'a\na', 'a\nb', 'b\na', 'a\n\n', '😀\n中文'];
  for (const before of texts) for (const after of texts) assertFullDiff(before, after);
});

test('saved passage uses normalized UTF-16 offsets and distinct duplicate occurrences', () => {
  const text = '开头\r\n重复😀\r重复😀\n';
  const normalized = normalizeLineEndings(text);
  const start = normalized.lastIndexOf('重复');
  assert.deepEqual(savedPassage(text, normalized, start, start + 4), { start, end: start + 4, quote: '重复😀' });
  assert.equal(savedPassage(text, `${normalized}改动`, start, start + 4), null);
});

test('saved passage refuses empty, out of bounds, whitespace and split surrogate pairs', () => {
  const text = '甲😀乙\n';
  for (const [start, end] of [[0, 0], [-1, 2], [0, 99], [1, 2], [2, 3], [4, 5], [0.5, 2], [0, NaN]]) assert.equal(savedPassage(text, text, start, end), null);
  assert.deepEqual(savedPassage(text, text, 1, 3), { start: 1, end: 3, quote: '😀' });
});
