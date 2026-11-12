import { createHash } from 'node:crypto';

export function createTaskControl(ctx, runtime) {
  const serviceOf = name => typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
  function bound(service, { requirementId, taskId } = {}) {
    const task = service.tasks.get(taskId);
    if (task.requirementId !== requirementId) throw new Error('任务不属于当前画布');
    return task;
  }
  function scope(service, task) {
    const related = task.sessionId ? service.store.db.prepare('SELECT id,requirement_id,title FROM course_tasks WHERE session_id=? ORDER BY id').all(task.sessionId)
      : [{ id: task.id, requirement_id: task.requirementId, title: task.title }];
    const token = createHash('sha256').update(JSON.stringify([service.workspaceRoot, task.id, task.requirementId, task.kind, task.sessionId, related.map(row => row.id)])).digest('hex');
    return { token, relatedCount: related.length, relatedTasks: related.slice(0, 20).map(row => ({ id: row.id, requirementId: row.requirement_id, title: row.title })) };
  }
  async function inspect(service, input, refresh = true) {
    let task = bound(service, input);
    if (task.kind === 'ai' && refresh) {
      await runtime.refresh(task, service);
      task = bound(service, input);
    }
    const common = { taskId: task.id, requirementId: task.requirementId, title: task.title, ...scope(service, task) };
    if (task.kind === 'media') {
      const job = service.media.job(task.id);
      if (!job) throw new Error('媒体任务不存在');
      return { ...common, kind: 'media', state: job.status, job,
        canStop: !['succeeded', 'failed', 'unknown', 'paused', 'cancelled'].includes(job.status),
        stopLabel: job.status === 'queued' ? '取消排队' : '停止本地跟进',
        message: job.status === 'cancelled' ? '已取消排队，未向服务商提交。' : job.status === 'paused' ? job.error : ['succeeded','failed'].includes(job.status) ? '本地任务已结束，已保存文件和记录保留。' : job.status === 'queued' ? '尚未提交，可以直接取消排队。' : ['paused', 'unknown'].includes(job.status)
          ? '外部生成结果尚需核对。仅移除卡片不会停止服务端生成，也不会重新提交。' : '停止本地查询和取回。外部生成可能继续，费用和结果需在服务商核对。' };
    }
    if (task.kind !== 'ai') return { ...common, state: 'unavailable', canStop: false, message: '此操作没有可停止的原生会话。' };
    if (!task.sessionId && ['draft', 'cancelled'].includes(task.dispatchStatus)) return { ...common, kind: 'native', state: task.dispatchStatus,
      canStop: task.dispatchStatus === 'draft', stopLabel: '取消未发送任务', message: task.dispatchStatus === 'draft' ? '尚未发送，可取消此任务。' : '已取消未发送任务，文件和记录保留。' };

    const agent = task.sessionId && serviceOf('agents')?.get(task.sessionId);
    if (agent && (agent.id !== task.sessionId || agent.session?.header?.id !== task.sessionId || agent.session?.header?.cwd !== service.workspaceRoot)) throw new Error('原任务会话不属于当前项目，不能停止');
    const activity = agent && typeof ctx.waterfall === 'function'
      ? await ctx.waterfall('workspace/session-activity', { sessionId: task.sessionId }, () => Promise.resolve([])) : [];
    const state = agent?.status === 'running' || activity.length ? 'running' : task.runtimeState?.phase || 'unknown';
    const queued = Boolean(agent?.inbox?.nextTurn?.length || agent?.inbox?.nextStep?.length);
    return { ...common, kind: 'native', state, canStop: Boolean(agent && typeof agent.cancel === 'function' && (state === 'running' || agent.inbox?.nextTurn?.length || agent.inbox?.nextStep?.length)),
      stopLabel: common.relatedCount > 1 ? '停止这组任务' : '停止任务',
      message: agent ? state === 'running' || queued ? '停止当前对话、待执行内容及关联活动，已保存成果保留。' : '当前会话已不在执行，任务记录和已保存成果保留。'
        : ['idle', 'failed'].includes(state) ? '已核对到本轮结束记录，已保存成果保留。' : '当前没有找到可停止的原生会话。可再次核对，或仅移除卡片；不能确认外部执行已停止。' };
  }
  return {
    inspect,
    async stop(service, input) {
      const current = await inspect(service, input, false);
      if (input.token !== current.token) throw new Error('关联任务或会话已变化，请重新核对停止范围');
      if (!current.canStop) return current;
      const task = bound(service, input);
      // Activity lookup above awaits Host listeners. Recheck the binding after it.
      if (input.token !== scope(service, task).token) throw new Error('关联任务或会话已变化，请重新核对停止范围');
      if (task.kind === 'media') {
        service.media.pause(task.id);
        return inspect(service, input, false);
      }
      if (!task.sessionId && task.dispatchStatus === 'draft') { service.tasks.cancelDraft(task.id); return inspect(service, input, false); }
      const agent = serviceOf('agents')?.get(task.sessionId);
      if (!agent || agent.session?.header?.cwd !== service.workspaceRoot) throw new Error('原任务会话已变化，请重新核对');
      // Official cancellation clears pending inbox work. Never archive the Session.
      agent.cancel({ kind: 'user' });
      let timer;
      const settled = Promise.all([
        typeof ctx.parallel === 'function' ? ctx.parallel('workspace/session-stop', { sessionId: task.sessionId }) : undefined,
        typeof agent.whenIdle === 'function' ? agent.whenIdle() : undefined,
      ]).then(() => true);
      const done = await Promise.race([settled, new Promise(resolve => { timer = setTimeout(() => resolve(false), 750); })]).finally(() => clearTimeout(timer));
      const result = await inspect(service, input, false);
      return { ...result, stopping: !done || result.state === 'running',
        message: !done || result.state === 'running' ? '已请求停止，仍在等待退出。请重新核对后再移除卡片。' : '已停止当前执行，已保存成果和任务记录保留。' };
    },
  };
}
