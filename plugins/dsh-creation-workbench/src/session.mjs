import { normalizeModelSelection } from './model-selection.mjs';
import { queuedQuestionCalls } from './skill-interactions.mjs';

// Read durable questions even when their native composer is not mounted.
// Retention never prompts, answers, or changes the active workspace.
export function watchCourseTaskSessions(ctx, { sessionIds, cwd, projectId }, onChange, onError) {
  let disposed = false;
  const references = [], stops = [], bindings = new Map(), fallback = new Map();
  const publish = () => {
    if (disposed) return;
    const native = ctx.uiSession.sessionStatus.getSnapshot();
    const statuses = new Map();
    for (const [sessionId, binding] of bindings) {
      const status = native.get(sessionId) || {};
      const questions = binding.session.projections.faceOf('userQuestions').getSnapshot();
      const queued = queuedQuestionCalls(binding.session.projections.faceOf('inbox').getSnapshot());
      const rows = (questions?.active || []).filter(row => !queued.has(row.callId));
      let pending = status.pendingInteraction;
      if (['question', 'plan-review'].includes(pending?.kind) && pending.callId && !rows.some(row => row.callId === pending.callId)) pending = undefined;
      if (!pending && rows.length) {
        const row = rows[0], key = `question:${sessionId}:${row.callId}`;
        let carrier = fallback.get(key);
        if (!carrier) {
          const snapshot = { state: row.state, channel: row.state === 'continued' ? 'rpc' : 'none', closed: false };
          carrier = { kind: row.questions.some(item => item.intent?.kind === 'plan-review') ? 'plan-review' : 'question',
            key, sessionId, callId: row.callId, questions: row.questions, getSnapshot: () => snapshot,
            answer: async answer => {
              if (disposed) throw new Error('项目已切换，请重新打开待办。');
              const current = binding.session.projections.faceOf('userQuestions').getSnapshot()?.active?.find(item => item.callId === row.callId);
              const queued = queuedQuestionCalls(binding.session.projections.faceOf('inbox').getSnapshot());
              if (!current || current.state !== 'continued' || queued.has(row.callId) || JSON.stringify(current.questions) !== JSON.stringify(carrier.questions)) throw new Error('此问题已变化或回答已排队，请核对原任务。');
              if (!valueOf(await ctx.remote.userQuestions.answer(sessionId, row.callId, answer))) throw new Error('此问题已结束，请核对原任务。');
            } };
          fallback.set(key, carrier);
        }
        pending = carrier;
        // A fresh carrier on state change preserves stable snapshots for React.
        if (carrier.getSnapshot().state !== row.state) { fallback.delete(key); publish(); return; }
      }
      statuses.set(sessionId, { ...status, pendingInteraction: pending });
    }
    onChange(statuses);
  };
  void (async () => {
    try {
      if (!projectId || !cwd?.startsWith('/')) throw new Error('缺少项目目录，无法恢复 Skill 待办。');
      const listing = valueOf(await ctx.remote.session.list({}));
      const known = new Map((listing?.items || []).map(item => [item.sessionId, item]));
      for (const sessionId of [...new Set(sessionIds)]) {
        if (disposed) break;
        try {
          if (known.get(sessionId)?.cwd !== cwd) throw new Error('会话不存在或属于其他项目，已阻止读取。');
          const reference = ctx.sessions.retain(sessionId, { source: 'wttCourseConfirmations' });
          references.push(reference);
          const binding = await reference.ready;
          if (disposed) { reference.release(); break; }
          if (binding.session.getSnapshot().openState === 'error') throw new Error('原生会话历史加载失败。');
          bindings.set(sessionId, binding);
          stops.push(binding.session.projections.faceOf('userQuestions').subscribe(publish));
          stops.push(binding.session.projections.faceOf('inbox').subscribe(publish));
          publish();
        } catch (error) { if (!disposed) onError?.(`Skill 待办恢复失败（${sessionId}）：${error.message || String(error)}`); }
      }
      if (!disposed) { stops.push(ctx.uiSession.sessionStatus.subscribe(publish)); publish(); }
    } catch (error) { if (!disposed) onError?.(`Skill 待办恢复失败：${error.message || String(error)}`); }
  })();
  return () => { disposed = true; for (const stop of stops) stop(); for (const reference of references) reference.release(); };
}

function valueOf(result) {
  if (!result?.ok) throw new Error(result?.error?.message || 'DSH 未接受操作，请保留需求后重试');
  return result.value;
}

async function availableSession(ctx, { cwd, agentPreset }, existingSessionId) {
  const catalog = valueOf(await ctx.remote.session.modelCatalog());
  if (!catalog.routableProviders.length) {
    throw new Error('尚未配置模型。请先在 DSH 中添加 API Key 或登录，再开始制课；需求和文件已保留。');
  }
  if (existingSessionId !== undefined) return existingSessionId;
  const createdWorkspace = valueOf(await ctx.remote.workspace.create({ path: cwd }));
  const workspaceId = createdWorkspace?.workspace?.workspaceId;
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
    throw new Error('DSH 未返回有效工作区，请保留需求后重试');
  }
  const { sessionId } = valueOf(await ctx.remote.session.create({ workspaceId, ...(agentPreset ? { agentPreset } : {}) }));
  return sessionId;
}

async function verifySessionProject(ctx, { cwd, projectId }, sessionId) {
  // Old callers have no project identity; their original session contract stays valid.
  if (projectId === undefined) return;
  if (typeof projectId !== 'string' || !projectId.trim() || typeof cwd !== 'string' || !cwd.startsWith('/')) {
    throw new Error('当前项目目录信息不完整，无法核对原生会话，请重新打开项目。');
  }
  let listing;
  try {
    if (typeof ctx.remote?.session?.list !== 'function') throw new Error('DSH 未提供会话目录查询');
    listing = valueOf(await ctx.remote.session.list({}));
  } catch (cause) {
    throw new Error(`无法核对原生会话的项目目录：${cause.message || String(cause)}`, { cause });
  }
  // The public Host summary projects immutable SessionHeader.cwd, not the UI's active workspace.
  const session = Array.isArray(listing?.items) ? listing.items.find(item => item?.sessionId === sessionId) : null;
  if (typeof session?.cwd !== 'string' || !session.cwd.startsWith('/')) {
    throw new Error('无法核对原生会话的原始项目目录，请在当前项目新建会话。');
  }
  if (session.cwd !== cwd) {
    throw new Error('该原生会话属于另一个项目目录，已阻止复用。请在当前项目新建会话。');
  }
}

export async function restoreCourseConversation(ctx, { sessionId, cwd, projectId }) {
  let reference;
  try {
    reference = ctx.sessions.retain(sessionId, { source: 'wttCourseCanvas' });
    const binding = await reference.ready;
    const snapshot = binding?.session?.getSnapshot?.();
    if (snapshot?.openState === 'error') throw new Error(snapshot.openError?.message || '原生会话历史加载失败');
    await verifySessionProject(ctx, { cwd, projectId }, sessionId);
    return reference;
  } catch (error) {
    reference?.release();
    throw error;
  }
}

/** A file-view Session grants the host its normal workspace filesystem context;
 * it never selects a chat, submits a prompt or requires a routable model. */
export function createPreviewSessionAcquirer(ctx) {
  const projects = new Map();
  return async (project, preferredSessionId) => {
    if (!project?.id || !project.path?.startsWith('/')) throw new Error('请先打开项目文件夹。');
    let sessionId = preferredSessionId;
    if (!sessionId) {
      if (!projects.has(project.id)) projects.set(project.id, (async () => {
        const created = valueOf(await ctx.remote.workspace.create({ path: project.path }));
        const workspaceId = created?.workspace?.workspaceId;
        if (!workspaceId) throw new Error('DSH 未返回预览工作区。');
        const result = valueOf(await ctx.remote.session.create({ workspaceId }));
        if (!result?.sessionId) throw new Error('DSH 未返回预览会话。');
        return result.sessionId;
      })().catch(error => { projects.delete(project.id); throw error; }));
      sessionId = await projects.get(project.id);
    }
    return restoreCourseConversation(ctx, { sessionId, cwd: project.path, projectId: project.id });
  };
}

function submissionFailure(error, state) {
  if (error?.submissionState) return error;
  return Object.assign(new Error(error?.message || String(error), { cause: error }), { submissionState: state });
}

async function submitPrompt(ctx, sessionId, prompt, requestId, explicitSkills = [], skillRefs = []) {
  if (explicitSkills.length) {
    try {
      if (typeof ctx.remote?.skills?.list !== 'function') throw new Error('宿主未提供会话 Skill 目录');
      const catalog = valueOf(await ctx.remote.skills.list({ sessionId }));
      const names = new Set((catalog.skills || []).map(skill => skill.name));
      const missing = explicitSkills.filter(name => !names.has(name));
      if (missing.length) throw new Error(`当前会话不能调用：${missing.map(name => `/${name}`).join('、')}。请核对 Skill 设置或会话预设。`);
      const shadowed = skillRefs.filter(ref => (catalog.skills.find(skill => skill.name === ref.name)?.path || null) !== (ref.path || null));
      if (shadowed.length) throw new Error(`当前会话替换了同名 Skill：${shadowed.map(ref => `/${ref.name}（冻结：${ref.path || '虚拟技能'}；会话：${catalog.skills.find(skill => skill.name === ref.name)?.path || '虚拟技能'}）`).join('、')}。请核对会话预设后重新选择。`);
    } catch (error) { throw submissionFailure(error, 'not-sent'); }
  }
  let response;
  try {
    response = await ctx.remote.session.prompt({
      requestId: requestId || crypto.randomUUID(), sessionId, mode: 'queue',
      content: [{ type: 'text', text: prompt }], clientTimeZone: 'Asia/Shanghai',
    });
  } catch (error) { throw submissionFailure(error, 'unknown'); }
  if (typeof response?.ok !== 'boolean' || (response.ok && response.value?.accepted !== true)) {
    throw submissionFailure(new Error('DSH 未返回有效受理回执，请先核对原生会话。'), 'unknown');
  }
  try { valueOf(response); }
  catch (error) {
    const preAdmissionErrors = new Set(['session/not-found', 'session/writer-held', 'session/invalid-time-zone', 'session/attachment-invalid']);
    throw submissionFailure(error, preAdmissionErrors.has(response.error?.code) ? 'rejected' : 'unknown');
  }
}

async function selectTaskModel(ctx, sessionId, selection) {
  if (selection === undefined || selection === null) return;
  try {
    const requested = normalizeModelSelection(selection);
    if (typeof ctx.remote?.session?.selectModel !== 'function') throw new Error('DSH 未提供模型选择服务，请更新宿主或保留当前任务后重试。');
    const result = valueOf(await ctx.remote.session.selectModel({ sessionId, ...requested }));
    const selected = normalizeModelSelection(result?.selected);
    if (!selected || selected.provider !== requested.provider || selected.model !== requested.model ||
      (requested.reasoningEffort !== undefined && selected.reasoningEffort !== requested.reasoningEffort)) {
      throw new Error('DSH 未确认任务指定的模型，已停止发送；请核对模型设置。');
    }
  } catch (error) { throw submissionFailure(error, 'not-sent'); }
}

export async function promptCourseSession(ctx, prepared, existingSessionId) {
  const sessionId = await availableSession(ctx, prepared, existingSessionId);
  await verifySessionProject(ctx, prepared, sessionId);
  await selectTaskModel(ctx, sessionId, prepared.modelSelection);
  await submitPrompt(ctx, sessionId, prepared.prompt, prepared.requestId, prepared.explicitSkills, prepared.explicitSkillRefs);
  return sessionId;
}

// Acquire the visible Client generation before submitting, so a failed attach
// cannot accept an unseen prompt that a user might accidentally submit twice.
export async function acquireCourseConversation(ctx, prepared, existingSessionId, lifecycle = {}) {
  let reference;
  try {
    const sessionId = await availableSession(ctx, prepared, existingSessionId);
    reference = await restoreCourseConversation(ctx, { sessionId, cwd: prepared.cwd, projectId: prepared.projectId });
    await selectTaskModel(ctx, sessionId, prepared.modelSelection);
    await lifecycle.beforePrompt?.({ sessionId, requestId: prepared.requestId });
    await submitPrompt(ctx, sessionId, prepared.prompt, prepared.requestId, prepared.explicitSkills, prepared.explicitSkillRefs);
    return reference;
  } catch (error) {
    reference?.release();
    throw submissionFailure(error, 'not-sent');
  }
}

export async function startCourseSession(ctx, prepared, shouldOpen = () => true) {
  const sessionId = await promptCourseSession(ctx, prepared);
  if (shouldOpen()) ctx.uiWorkspace.openSession(sessionId);
  return sessionId;
}

/** Empty editing conversations are project-bound and never send a model request. */
export function createEditorSessionAcquirer(ctx){
  const pending=new Map();
  return async(project,sessionId,identity)=>{
    if(!project?.id||!project.path?.startsWith('/')||!identity)throw new Error('课件编辑会话缺少项目或版本身份');
    if(!sessionId){const key=JSON.stringify([project.id,identity]);if(!pending.has(key))pending.set(key,(async()=>{const workspace=valueOf(await ctx.remote.workspace.create({path:project.path}));const workspaceId=workspace?.workspace?.workspaceId;if(!workspaceId)throw new Error('DSH未返回编辑工作区');const created=valueOf(await ctx.remote.session.create({workspaceId}));if(!created?.sessionId)throw new Error('DSH未返回编辑会话');return created.sessionId})().catch(error=>{pending.delete(key);throw error}));sessionId=await pending.get(key)}
    return restoreCourseConversation(ctx,{sessionId,cwd:project.path,projectId:project.id});
  };
}
