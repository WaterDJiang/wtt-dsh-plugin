const INLINE_LIMIT = 2000;
const PAGE_SIZE = 4000;

function sourceDetails(source) {
  const identity = { cardId: source.cardId, title: source.title, kind: source.kind };
  if (source.rangeLabel) return { ...identity, rangeLabel: source.rangeLabel };
  const file = source.importedFile || source.generatedFile;
  return {
    ...identity,
    ...(source.path ? { path: source.path, hash: source.hash } : {}),
    ...(file?.path && file.byteSize !== 0 ? { file: { path: file.path, hash: file.hash, mime: file.mime } }
      : !file && source.sourcePath ? { sourcePath: source.sourcePath } : {}),
    ...(source.projectRelativePath && { projectRelativePath: source.projectRelativePath }),
    ...(source.relatedFiles?.length ? { relatedFileCount: source.relatedFiles.length } : {}),
    ...(source.sourceStatus && source.sourceStatus !== 'ready' ? { sourceStatus: source.sourceStatus } : {}),
    ...(source.note || source.extractionNote ? { note: source.note || source.extractionNote } : {}),
    ...(source.noteTruncated || source.importedFile?.truncated ? { snapshotTruncated: true } : {}),
  };
}

export function taskPromptContext({ sources, selection, revision }) {
  let remaining = INLINE_LIMIT;
  const selectText = (source, priority = false) => {
    const { content, annotation } = source;
    const text = {};
    for (const [key, value] of Object.entries({ content, annotation })) {
      if (!value) continue;
      if ((priority && key === 'content') || value.length <= remaining) {
        text[key] = value;
        if (!(priority && key === 'content')) remaining -= value.length;
      } else text[key === 'content' ? 'contentLength' : 'annotationLength'] = value.length;
    }
    return text;
  };
  const references = sources.map(source => ({
    ...sourceDetails(source), ...selectText(source, source.cardId === selection?.sourceCardId),
  }));
  const base = revision && {
    cardId: 'revision', number: revision.number, path: revision.path, hash: revision.hash,
    status: revision.status, engineering: revision.engineering, ...selectText(revision),
    ...(revision.noteTruncated ? { snapshotTruncated: true } : {}),
  };
  const hasDeferred = [...references, ...(base ? [base] : [])].some(source => source.contentLength || source.annotationLength);
  return { references, base, hasDeferred };
}

export function readTaskSource(input, { cardId, field = 'content', offset = 0 }) {
  const source = cardId === 'revision' ? input.revision : input.sources.find(item => item.cardId === cardId);
  if (!source) throw new Error('此引用不在当前任务的冻结资料中。');
  if (field === 'files') {
    const files = source.relatedFiles || [];
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > files.length) throw new Error('读取位置无效，请使用上次返回的 nextOffset。');
    const end = Math.min(files.length, offset + 20);
    return { cardId, field, files: files.slice(offset, end), length: files.length, nextOffset: end < files.length ? end : null };
  }
  if (!['content', 'annotation'].includes(field)) throw new Error('请选择正文、注释或配套文件。');
  const value = source[field] || '';
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.length || /[\uDC00-\uDFFF]/.test(value.charAt(offset))) {
    throw new Error('读取位置无效，请使用上次返回的 nextOffset。');
  }
  let end = Math.min(offset + PAGE_SIZE, value.length);
  if (/[\uDC00-\uDFFF]/.test(value.charAt(end))) end -= 1;
  return { ...sourceDetails(source), cardId, field, offset, text: value.slice(offset, end),
    length: value.length, nextOffset: end < value.length ? end : null };
}
