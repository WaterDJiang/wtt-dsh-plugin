export function normalizeLineEndings(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

function isCodePointBoundary(text, offset) {
  const previous = text.charCodeAt(offset - 1), next = text.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

// Textarea offsets and the source contract both use LF-normalized UTF-16.
export function savedPassage(markdown, value, start, end) {
  const source = normalizeLineEndings(markdown);
  if (normalizeLineEndings(value) !== source || !Number.isInteger(start) || !Number.isInteger(end)
    || start < 0 || end <= start || end > source.length
    || !isCodePointBoundary(source, start) || !isCodePointBoundary(source, end)) return null;
  const quote = source.slice(start, end);
  return quote.trim() ? { start, end, quote } : null;
}

/** Full line diff with a bounded LCS table. Large changes retain complete blocks. */
export function diffLines(before, after, { maxCells = 180000, maxLineRows = 4000 } = {}) {
  const oldLines = normalizeLineEndings(before).split('\n');
  const newLines = normalizeLineEndings(after).split('\n');
  let prefix = 0, suffix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  const oldEnd = oldLines.length - suffix, newEnd = newLines.length - suffix;
  const oldCount = oldEnd - prefix, newCount = newEnd - prefix;
  const large = (oldCount + 1) * (newCount + 1) > maxCells || oldLines.length + newLines.length > maxLineRows;
  const blocks = [];
  let oldLine = 1, newLine = 1;
  function append(type, lines) {
    if (!lines.length) return;
    const last = blocks.at(-1);
    if (last?.type === type) last.lines.push(...lines);
    else blocks.push({ type, lines: [...lines], oldStart: oldLine, newStart: newLine });
    if (type !== 'add') oldLine += lines.length;
    if (type !== 'delete') newLine += lines.length;
  }
  append('equal', oldLines.slice(0, prefix));
  if (large) {
    append('delete', oldLines.slice(prefix, oldEnd));
    append('add', newLines.slice(prefix, newEnd));
  } else if (!oldCount) append('add', newLines.slice(prefix, newEnd));
  else if (!newCount) append('delete', oldLines.slice(prefix, oldEnd));
  else {
    const width = newCount + 1;
    const lengths = new Uint32Array((oldCount + 1) * width);
    for (let i = oldCount - 1; i >= 0; i--) {
      for (let j = newCount - 1; j >= 0; j--) {
        lengths[i * width + j] = oldLines[prefix + i] === newLines[prefix + j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < oldCount || j < newCount) {
      if (i < oldCount && j < newCount && oldLines[prefix + i] === newLines[prefix + j]) {
        append('equal', [oldLines[prefix + i]]); i++; j++;
      } else if (i < oldCount && (j >= newCount || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
        append('delete', [oldLines[prefix + i++]]);
      } else append('add', [newLines[prefix + j++]]);
    }
  }
  append('equal', oldLines.slice(oldEnd));
  return {
    mode: large ? 'blocks' : 'lines', blocks,
    oldLineCount: oldLines.length, newLineCount: newLines.length,
    removed: blocks.filter(block => block.type === 'delete').reduce((sum, block) => sum + block.lines.length, 0),
    added: blocks.filter(block => block.type === 'add').reduce((sum, block) => sum + block.lines.length, 0),
  };
}
