const LABELS = {
  composing: '待填写', draft: '待发送', submitting: '提交中', generating: '内容正在生成',
  'awaiting-input': '等待你确认', 'awaiting-approval': '等待你授权',
  idle: '本轮已结束', failed: '生成失败', unknown: '状态待核对', cancelled: '已取消',
};

export function pendingLabel(pending) {
  if (pending?.published && pending.phase === 'generating') return '任务仍在运行';
  if (pending?.phase === 'idle') {
    if (pending.message?.startsWith('本轮执行已取消') || pending.message?.startsWith('本轮执行已停止')) return '本轮已中断';
    if (pending.message?.startsWith('本轮达到输出上限')) return '已达输出上限';
  }
  return pending?.nativeLabel || LABELS[pending?.phase] || '状态待核对';
}

export function pendingCardTitle(card) {
  if (card?.kind !== 'generation') return card?.title || '';
  const title = String(card.title || '').trim().split(/[。！？!?\r\n]/u)[0].trim();
  const characters = Array.from(title);
  return characters.length > 36 ? `${characters.slice(0, 35).join('')}…` : title || '创作任务';
}

export function nativePendingState(pending, status) {
  if (!pending || !status || pending.mediaJob || (pending.phase === 'failed' && pendingRetryAllowed(pending))) return pending;
  const interaction = status.pendingInteraction?.kind;
  if (interaction === 'approval') return { ...pending, phase: 'awaiting-approval', nativeLabel: '等待你授权' };
  if (interaction === 'question') return { ...pending, phase: 'awaiting-input', nativeLabel: '等待你回答' };
  if (interaction === 'plan-review') return { ...pending, phase: 'awaiting-input', nativeLabel: '等待你确认方案' };
  if (status.running === true) return { ...pending, phase: 'generating' };
  if (status.running === false && pending.status !== 'unknown' && !['draft', 'submitting', 'failed'].includes(pending.phase)) return { ...pending, phase: 'idle' };
  return pending;
}

export function pendingRetryAllowed(taskOrPending) {
  return ['draft', 'failed'].includes(taskOrPending?.dispatchStatus || taskOrPending?.status);
}

export function pendingContinueAllowed(pending) {
  return Boolean(pending?.sessionId && !pending.mediaJob && ['accepted', 'output'].includes(pending.status)
    && ['idle', 'failed'].includes(pending.phase));
}

export function isActiveTaskPhase(phase) {
  return ['generating', 'awaiting-input', 'awaiting-approval'].includes(phase);
}

export function publishedTaskGeneration(task, status) {
  if (task?.kind !== 'ai' || !task.cardVersionId || !task.sessionId) return;
  const pending = nativePendingState({ taskId: task.id, sessionId: task.sessionId, status: task.dispatchStatus || task.status,
    phase: task.runtimeState?.phase || 'unknown', message: task.runtimeState?.message, published: true }, status);
  return isActiveTaskPhase(pending.phase) ? pending : undefined;
}

// The comparison includes real runtime events and failures, not only successful files.
export function generationStateSignature(tasks = []) {
  return JSON.stringify(tasks.filter(task => task.outputCardId).map(task => [task.id,
    task.dispatchStatus || task.status, task.cardVersionId, task.sessionId, task.error,
    task.runtimeState, task.mediaJob?.status, task.mediaJob?.error, task.mediaJob?.updatedAt]).sort((a, b) => a[0].localeCompare(b[0])));
}

export function createPendingContext({ projectId, projectName, projectPath, requirement, descriptor }) {
  const { card, node, task, pendingGeneration } = descriptor || {};
  if (!projectId || !requirement?.id || !card?.id || !node?.id || !task?.id
    || task.requirementId !== requirement.id || task.outputCardId !== card.id) throw new Error('待完成卡片与原任务不匹配，请重新加载。');
  const input = JSON.parse(JSON.stringify(task.input || {}));
  const references = (input.sources || []).map(source => ({ ...source, id: source.cardId, refId: source.refId || source.cardId?.split(':')[1],
    sourceHash: source.hash, ...(source.noteTruncated ? { referenceNote: source.noteTruncated } : {}) }));
  return {
    key: `${projectId}:${requirement.id}:pending:${card.id}:${task.id}`,
    projectId, projectName, projectPath, requirementId: requirement.id, requirementTitle: requirement.title,
    requirement: input.requirement || requirement, anchor: JSON.parse(JSON.stringify(node)), targetCard: JSON.parse(JSON.stringify(node)),
    intent: 'pending', pendingTaskId: task.id, taskId: task.id, sessionId: task.sessionId || null,
    pendingGeneration: pendingGeneration || node.pendingGeneration,
    outputType: card.type, ...(card.type === 'pptx' ? { pptEngine: input.pptEngine || 'native' } : {}), instruction: input.instruction || task.instruction || '', references,
    selectedSkills: [...(input.selectedSkills || [])], modelSelection: input.modelSelection || null,
    generation: input.generation, outputPosition: { ...node.position },
    ...(input.selection ? { selection: input.selection } : {}),
    generationMethod: input.generationMethod || (task.kind === 'media' ? 'legacy' : 'skill'),
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.media ? { mediaOptions: input.media } : {}),
    ...(task.mediaJob ? { mediaJob: task.mediaJob } : {}),
    originalInput: { instruction: input.instruction || task.instruction || '', references: JSON.parse(JSON.stringify(references)), taskId: task.id, sessionId: task.sessionId || null },
  };
}
