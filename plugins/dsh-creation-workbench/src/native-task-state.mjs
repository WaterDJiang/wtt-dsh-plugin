export function readNativeTaskState(ctx, task) {
  if (task?.kind !== 'ai' || typeof task.sessionId !== 'string' || !task.sessionId.trim()) return null;
  try {
    const agents = (typeof ctx?.get === 'function' ? ctx.get('agents') : undefined) || ctx?.agents;
    if (typeof agents?.get !== 'function') return null;
    const agent = agents.get(task.sessionId);
    if (!agent || agent.id !== task.sessionId) return null;
    if (agent.status === 'running') return { phase: 'generating', message: '内容正在生成' };
    if (agent.status === 'idle') return { phase: 'idle', message: IDLE_MESSAGE };
    return null;
  } catch { return null; }
}

const IDLE_MESSAGE = '本轮执行已结束；文件与版本见任务记录';
const UNKNOWN_MESSAGE = '尚无法核对本轮执行状态，请打开原任务核对';

function compactText(value, limit = 1200) {
  return String(value || '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ')
    .replace(/<[^>]*>/gu, ' ').replace(/&(?:nbsp|lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);/giu, ' ')
    .replace(/\bBearer\s+[a-z\d._~+/=-]+/giu, 'Bearer [已隐藏]')
    .replace(/((?:["']?)(?:x[-_])?api[-_]?key["']?\s*[:=]\s*["']?)[^\s"'<>;,]+/giu, '$1[已隐藏]')
    .replace(/((?:authorization|access[-_]?token|refresh[-_]?token)["']?\s*[:=]\s*["']?)[^\s"'<>;,]+/giu, '$1[已隐藏]')
    .replace(/([?&](?:key|api_key|token)=)[^\s&#"']+/giu, '$1[已隐藏]')
    .replace(/\bsk-[a-z\d_-]{8,}/giu, '[已隐藏]')
    .replace(/[\u0000-\u001f\u007f\s]+/gu, ' ').trim().slice(0, limit);
}

function eventState(event) {
  if (!event || !Number.isSafeInteger(event.seq) || event.seq < 0 || !Number.isSafeInteger(event.time) || event.time < 0
    || !Number.isSafeInteger(event.data?.turn) || event.data.turn < 0) return null;
  const base = { turn: event.data.turn, seq: event.seq, time: event.time, code: null, status: null };
  if (event.type === 'turn/start') return { ...base, phase: 'generating', message: '内容正在生成' };
  if (event.type !== 'turn/end') return null;
  const reason = event.data.reason;
  if (reason?.kind === 'error') {
    const message = compactText(reason.error?.message) || '本轮执行失败，请打开原任务查看';
    const code = compactText(reason.error?.code, 100) || 'UNKNOWN';
    const status = Number.isInteger(reason.error?.status) && reason.error.status >= 100 && reason.error.status <= 599 ? reason.error.status : null;
    return { ...base, phase: 'failed', message, code, status };
  }
  if (reason?.kind === 'completed') return { ...base, phase: 'idle', message: IDLE_MESSAGE };
  if (reason?.kind === 'aborted') return { ...base, phase: 'idle', message: '本轮执行已取消；文件与版本见任务记录' };
  if (reason?.kind === 'max-tokens') return { ...base, phase: 'idle', message: '本轮达到输出上限；文件与版本见任务记录，打开原任务继续' };
  if (reason?.kind === 'blocked') return { ...base, phase: 'idle', message: '本轮执行已停止；文件与版本见任务记录' };
  return { ...base, phase: 'unknown', message: UNKNOWN_MESSAGE };
}

export function createNativeTaskStateTracker(ctx) {
  const services = new Map();
  let closed = false;
  let stop;

  function serviceOf(name) {
    try { return (typeof ctx?.get === 'function' ? ctx.get(name) : undefined) || ctx?.[name]; }
    catch { return null; }
  }

  function open(record) { return !closed && !record.service.store.closed && record.service.store.db === record.db; }

  function warn(error) {
    try { ctx?.logger?.warn?.(`任务运行状态核对失败：${compactText(error?.message || error, 300)}`); }
    catch { /* Diagnostic transport must not affect a committed Session event. */ }
  }

  function register(service) {
    if (closed || !service?.store?.db || service.store.closed || typeof service.workspaceRoot !== 'string' || !service.workspaceRoot.startsWith('/')) return null;
    let record = services.get(service);
    if (record && record.db === service.store.db) return record;
    const db = service.store.db;
    db.exec(`CREATE TABLE IF NOT EXISTS task_runtime_states (
      task_id TEXT PRIMARY KEY REFERENCES course_tasks(id), session_id TEXT NOT NULL,
      phase TEXT NOT NULL, turn INTEGER NOT NULL, seq INTEGER NOT NULL, time INTEGER NOT NULL,
      message TEXT NOT NULL, code TEXT, status INTEGER
    )`);
    record = { service, db, hydrating: new Set(), hydrated: new Set() };
    services.set(service, record);
    return record;
  }

  function bound(record, task) {
    if (!open(record)) return false;
    const row = record.db.prepare('SELECT kind,session_id FROM course_tasks WHERE id=?').get(task.id);
    return row?.kind === 'ai' && row.session_id === task.sessionId;
  }

  function matchingHeader(record, sessionId, header) {
    return header?.id === sessionId && header.cwd === record.service.workspaceRoot;
  }

  function write(record, task, state) {
    if (!state || !open(record) || !bound(record, task)) return;
    record.db.prepare(`INSERT INTO task_runtime_states(task_id,session_id,phase,turn,seq,time,message,code,status)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET
      session_id=excluded.session_id,phase=excluded.phase,turn=excluded.turn,seq=excluded.seq,time=excluded.time,
      message=excluded.message,code=excluded.code,status=excluded.status
      WHERE task_runtime_states.session_id<>excluded.session_id OR excluded.seq>task_runtime_states.seq`)
      .run(task.id, task.sessionId, state.phase, state.turn, state.seq, state.time, state.message, state.code, state.status);
  }

  function hydrate(record, task) {
    const query = serviceOf('sessionQuery');
    if (typeof query?.listEvents !== 'function' || typeof query?.readEvent !== 'function') return;
    const key = `${task.id}:${task.sessionId}`;
    if (record.hydrating.has(key) || record.hydrated.has(key)) return;
    record.hydrating.add(key);
    void (async () => {
      try {
        const records = await query.listEvents(task.sessionId);
        if (!open(record) || !bound(record, task) || !Array.isArray(records)) return;
        const latest = records.filter(event => event?.sessionId === task.sessionId && ['turn/start', 'turn/end'].includes(event.type)
          && Number.isSafeInteger(event.seq) && event.seq >= 0).sort((a, b) => b.seq - a.seq)[0];
        // An open turn is never replaced by an older completed or failed one.
        if (latest?.type !== 'turn/end') return;
        const result = await query.readEvent({ sessionId: task.sessionId, seq: latest.seq, before: 0, after: 0 });
        if (!open(record) || !matchingHeader(record, task.sessionId, result?.session)
          || result?.target?.type !== 'turn/end' || result.target.seq !== latest.seq) return;
        write(record, task, eventState(result.target));
      } catch (error) { if (open(record)) warn(error); }
      finally { record.hydrating.delete(key); record.hydrated.add(key); }
    })();
  }

  function observe(session, event) {
    if (closed || !['turn/start', 'turn/end'].includes(event?.type)) return;
    const state = eventState(event);
    if (!state || typeof session?.id !== 'string') return;
    for (const [service, record] of services) {
      if (!open(record)) { services.delete(service); continue; }
      if (!matchingHeader(record, session.id, session.header)) continue;
      try {
        const tasks = record.db.prepare("SELECT id FROM course_tasks WHERE kind='ai' AND session_id=?").all(session.id);
        for (const task of tasks) write(record, { id: task.id, sessionId: session.id }, state);
      } catch (error) { warn(error); }
    }
  }

  try { if (typeof ctx?.on === 'function') stop = ctx.on('session/event', observe); }
  catch (error) { warn(error); }

  return {
    read(task, service) {
      if (closed || task?.kind !== 'ai' || typeof task.id !== 'string' || typeof task.sessionId !== 'string' || !task.sessionId.trim()) return null;
      try {
        const record = register(service);
        if (!record || !bound(record, task)) return null;
        hydrate(record, { id: task.id, sessionId: task.sessionId });
        const live = readNativeTaskState(ctx, task);
        if (live?.phase === 'generating') return live;
        const state = record.db.prepare('SELECT phase,turn,seq,time,message,code,status FROM task_runtime_states WHERE task_id=? AND session_id=?')
          .get(task.id, task.sessionId);
        if (state?.phase === 'generating') return live || { phase: 'unknown', message: UNKNOWN_MESSAGE };
        if (state) return { ...state,
          ...(state.phase === 'idle' ? { message: state.message.replace(/，尚未登记正式产物/gu, '') } : {}),
          ...(state.code === null ? { code: undefined } : {}), ...(state.status === null ? { status: undefined } : {}) };
        return live;
      } catch (error) { if (!closed) warn(error); return null; }
    },
    close() {
      if (closed) return;
      closed = true;
      if (typeof stop === 'function') stop();
      services.clear();
    },
  };
}
