const KINDS = new Set(['question', 'plan-review', 'approval']);
const answerLocks = new Set();
const submittedAnswers = new Set();
export const SKILL_CONFIRMATION_INSTRUCTIONS = [
  'Skill 沟通契约：默认遵循所选 Skill 的全部人工确认门。只有本任务用户指令明确授权、且 Skill 本身支持的自动模式才可采用；其他任务或历史对话授权不继承，硬门和执行权限不能绕过。',
  '需要补信息、审阅大纲／设计方案／PPT 样章时，先形成可审阅正文或真实文件，再调用 DSH 原生 ask_user_question；不要只在聊天里写“请确认”后结束。',
  '每个问题使用稳定 id；在 question 正文完整写明当前步骤、问题／方案摘要、待审正文或具体文件路径与版本及实际 hash、确认后的下一步。普通提问接口不保留额外 detail/intent 字段，审阅内容必须放入 question。选项清楚区分确认继续与提出修改，用户可自填意见。',
  '返回 pending／超时／取消／无明确同意都不代表确认；立即结束当前轮次，停止所有依赖此决定的生成、保存或发送步骤。收到同一个原生问题的真实答案后才继续原任务。提出修改时先修改再重新请求审阅，不把修改意见当批准。',
  '文件尚未保存、预览不可用或内容有变化时如实说明。已保存产物可先登记以供准确版本预览，但登记、Skill 方案认可、客户确认、发送和收款是独立事实。',
];
export const interactionLabel = interaction => ({ question: '等待你回答', 'plan-review': '等待你确认方案', approval: '等待你授权' }[interaction?.kind] || '需要你处理');
export const questionFingerprint = interaction => JSON.stringify(interaction?.questions || []);

export function taskInteractions(tasks, statuses, requirementId) {
  return tasks.filter(task => task.kind === 'ai' && task.requirementId === requirementId && task.sessionId)
    .flatMap(task => {
      const interaction = statuses?.get(task.sessionId)?.pendingInteraction;
      return KINDS.has(interaction?.kind) && interaction.sessionId === task.sessionId
        ? [{ key: `${task.id}:${interaction.key}`, task, interaction }] : [];
    });
}

export function buildQuestionAnswer(interaction, drafts, mode = 'answer') {
  if (!['question', 'plan-review'].includes(interaction?.kind) || !interaction.questions?.length) throw new Error('此请求请在原生任务中处理。');
  return { answers: interaction.questions.map(question => {
    const draft = drafts[question.id] || {};
    const custom = String(draft.custom || '').trim();
    const labels = new Set((question.options || []).map(option => option.label));
    let selected = [...new Set(draft.selected || [])];
    if (mode === 'approve') {
      if (question.intent?.kind !== 'plan-review' || !labels.has(question.intent.approve)) throw new Error('此问题未提供确认选项。');
      selected = [question.intent.approve];
    }
    if (mode === 'modify') {
      if (!custom) throw new Error('请填写修改意见。');
      // A change request must never carry the approval label.
      selected = question.intent?.kind === 'plan-review' ? (question.options || []).filter(option => option.label !== question.intent.approve).slice(0, 1).map(option => option.label) : [];
    }
    if (selected.some(label => !labels.has(label)) || !question.multiSelect && selected.length > 1) throw new Error('选项已变化，请重新核对问题。');
    if (!selected.length && !custom) throw new Error('请回答每一个问题，或填写补充意见。');
    if (custom.length > 8000) throw new Error('补充意见最多 8000 字。');
    return { id: question.id, selected, ...(custom ? { custom } : {}) };
  }) };
}

export async function answerTaskInteraction(entry, answer, currentEntry) {
  const pending = entry?.interaction;
  const current = currentEntry?.();
  if (!pending || current?.key !== entry.key || current?.task.id !== entry.task.id || current?.task.sessionId !== pending.sessionId
    || current?.interaction !== pending || questionFingerprint(current.interaction) !== questionFingerprint(pending)) throw new Error('问题已结束或发生变化，请重新打开当前待办。');
  const submissionKey = `${pending.sessionId}:${pending.callId || pending.key}:${questionFingerprint(pending)}`;
  if (answerLocks.has(submissionKey)) throw new Error('此回答正在提交，请勿重复发送。');
  if (submittedAnswers.has(submissionKey)) throw new Error('此回答已提交，请等待原任务处理。');
  const snapshot = pending.getSnapshot?.();
  if (snapshot?.closed || snapshot?.channel === 'none' || pending.review || typeof pending.answer !== 'function') throw new Error('此问题暂不可回答，请打开原任务核对。');
  answerLocks.add(submissionKey);
  try { await pending.answer(answer); submittedAnswers.add(submissionKey); }
  finally { answerLocks.delete(submissionKey); }
}

export function queuedQuestionCalls(inbox) {
  return new Set([...(inbox?.['next-step'] || []), ...(inbox?.['next-turn'] || [])]
    .filter(message => message?.source?.kind === 'user-question-reply').map(message => message.source.callId));
}
