export const MAX_CONVERSATION_FILES = 24;
export const MAX_CONVERSATION_FILE_BYTES = 20 * 1024 * 1024;
const locked = phase => ['adjudicating', 'submitting'].includes(phase);
export const conversationAttachmentsLocked = input => locked(input.phase) || Boolean(input.claim && input.claim.attachments !== true);

function attachmentName(card, sourcePath) {
  const extension = /\.[a-z0-9]{1,12}$/i.exec(sourcePath || '')?.[0] || '.md';
  const title = Array.from(String(card.displayTitle || card.title || '画布资料').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')).slice(0, 48).join('').trim() || '画布资料';
  return title.toLowerCase().endsWith(extension.toLowerCase()) ? title : title + extension;
}

export async function loadConversationReferenceFiles(cards, { endpoint, isCurrent, currentCard, signal, fetchFile = fetch, FileType = File }) {
  const files = new Array(cards.length), controller = new AbortController();
  const cancelled = () => controller.abort(signal.reason);
  if (signal?.aborted) cancelled();
  signal?.addEventListener('abort', cancelled, { once: true });
  const readSignal = controller.signal;
  async function read(card) {
    readSignal.throwIfAborted();
    if (!isCurrent()) throw new Error('对话或画布已切换，请重新选择资产。');
    const current = currentCard(card);
    if (['missing', 'changed', 'modified', 'unavailable'].includes(current?.status) || ['missing', 'changed', 'modified', 'unavailable'].includes(current?.sourceStatus)) throw new Error('原文件已缺失或变化，请重新选择资产。');
    if (!current || current.id !== card.id || current.sourceHash !== card.sourceHash
      || card.kind === 'whiteboard' && current.content !== card.content) throw new Error('卡片内容已变化，请重新选择资产。');
    if (['whiteboard', 'requirement'].includes(card.kind)) {
      const text = String(card.requirementBackground ?? card.content ?? '');
      if (!text.trim()) throw new Error('此卡片没有可添加的内容。');
      const file = new FileType([text], attachmentName(card, '.md'), { type: 'text/markdown' });
      if (file.size > MAX_CONVERSATION_FILE_BYTES) throw new Error('单个附件不能超过20MiB。');
      return file;
    }
    const source = card.importedFile || card.generatedFile || card.defaultOutcome;
    const sourcePath = source?.path || card.path;
    if (!sourcePath) throw new Error('此卡片尚无可添加的已保存文件。');
    let hash = source?.hash || source?.sha256 || (card.kind === 'word' ? undefined : card.sourceHash);
    if (!hash) {
      const result = await fetchFile(endpoint({ projectFilePreview: sourcePath }), { signal: readSignal });
      if (!result.ok) throw new Error('文件信息暂不可用，请重试。');
      hash = (await result.json()).hash;
    }
    if (!/^[a-f0-9]{64}$/i.test(hash || '')) throw new Error('文件缺少准确版本信息，请刷新后重试。');
    const response = await fetchFile(endpoint({ projectFileDownload: sourcePath, hash }), { signal: readSignal });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.error?.message || detail?.error || '文件已缺失或变化，请刷新后重新选择。');
    }
    if (Number(response.headers.get('content-length') || 0) > MAX_CONVERSATION_FILE_BYTES) throw new Error('单个附件不能超过20MiB。');
    const blob = await response.blob();
    if (blob.size > MAX_CONVERSATION_FILE_BYTES) throw new Error('单个附件不能超过20MiB。');
    const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== hash) throw new Error('文件内容与所选版本不一致，请重新选择。');
    return new FileType([blob], attachmentName(card, sourcePath), { type: source?.mime || blob.type || 'application/octet-stream' });
  }
  let next = 0, failure;
  async function worker() {
    while (next < cards.length && !readSignal.aborted) {
      const index = next++;
      try { files[index] = await read(cards[index]); }
      catch (error) { if (!failure) { failure = error; controller.abort(error); } throw error; }
    }
  }
  try {
    const results = await Promise.allSettled(Array.from({ length: Math.min(3, cards.length) }, worker));
    if (failure) throw failure;
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    readSignal.throwIfAborted();
    if (!isCurrent()) throw new Error('对话或画布已切换，请重新选择资产。');
    return files;
  } finally { signal?.removeEventListener('abort', cancelled); }
}

// Only stage drafts. The resident native composer still owns send, queue and upload errors.
export function stageConversationReferenceFiles({ service, inputActions, sessionId, files, readInput, isCurrent }) {
  if (!service?.createDrafts || !service?.releaseDraftAttachments || !inputActions?.addAttachments) throw new Error('当前DSH没有提供对话附件接口，请更新宿主后重试。');
  const input = readInput();
  if (!isCurrent() || conversationAttachmentsLocked(input)) throw new Error('对话正在提交，请稍后重新添加。');
  if ((input.attachmentIds?.length || 0) + files.length > MAX_CONVERSATION_FILES) throw new Error('一条消息最多添加24份附件，请先移除部分附件。');
  const drafts = service.createDrafts(sessionId, files);
  try {
    if (!isCurrent() || !inputActions.addAttachments(drafts.map(draft => draft.id))) throw new Error('对话正在提交或已切换，原输入和附件已保留。');
  } catch (error) { service.releaseDraftAttachments(drafts); throw error; }
}
