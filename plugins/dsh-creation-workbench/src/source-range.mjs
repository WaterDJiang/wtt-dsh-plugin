import { createHash } from 'node:crypto';

export const sourceDigest = value => createHash('sha256').update(value).digest('hex');
export const sourceView = value => value.replace(/\r\n?/g, '\n');

function splitsSurrogate(text, offset) {
  return offset > 0 && offset < text.length
    && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]);
}

/** Selection offsets belong to the LF-normalized UTF-16 reading view. */
export function verifySourceRange(content, selection) {
  if (typeof selection?.sourceHash !== 'string' || selection.sourceHash !== sourceDigest(content)) throw new Error('来源正文已变化，请重新打开原文并选择片段');
  const view = sourceView(content);
  const { start, end, quote } = selection;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > view.length
    || splitsSurrogate(view, start) || splitsSurrogate(view, end)) throw new Error('摘录范围无效，不能为空、越界或切断 emoji');
  const actual = view.slice(start, end);
  if (!actual.trim() || typeof quote !== 'string' || actual !== quote) throw new Error('所选正文与来源范围不一致，请重新选择');
  const first = view.slice(0, start).split('\n').length;
  const last = view.slice(0, end - (actual.endsWith('\n') ? 1 : 0)).split('\n').length;
  return { start, end, quote: actual, rangeLabel: first === last ? `第 ${first} 行` : `第 ${first}–${last} 行` };
}
