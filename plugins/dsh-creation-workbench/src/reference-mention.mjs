const QUERY_CHARACTER = /[^\s@＠「」“”"'，。！？；：、,!?;()[\]{}<>]/u;

export function referenceQueryAtCursor(text, cursor) {
  if (typeof text !== 'string' || !Number.isInteger(cursor) || cursor < 0 || cursor > text.length) return null;
  let start = cursor;
  while (start > 0 && QUERY_CHARACTER.test(text[start - 1])) start--;
  if (!/[@＠]/.test(text[start - 1] || '') || /[A-Za-z0-9_.+\-/@＠]/.test(text[start - 2] || '') || text[start] === '「') return null;
  let end = cursor;
  while (end < text.length && QUERY_CHARACTER.test(text[end])) end++;
  return { start: start - 1, end, query: text.slice(start, cursor) };
}

export function insertReferenceMention(text, range, label) {
  const title = label.replace(/[\r\n「」]/g, ' ').trim();
  const after = text.slice(range.end);
  const token = `@「${title}」${!after || QUERY_CHARACTER.test(after[0]) ? ' ' : ''}`;
  return { text: text.slice(0, range.start) + token + after, cursor: range.start + token.length };
}
