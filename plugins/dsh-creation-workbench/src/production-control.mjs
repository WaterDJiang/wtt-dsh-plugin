import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULTS = { contextMode: 'economy', maxSteps: 200, maxInputTokens: 20_000_000, maxOutputTokens: 300_000 };
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
export function normalizePolicy(input) {
  if (!input || !['economy', 'host'].includes(input.contextMode)) throw new Error('请选择课程节省上下文或宿主预设');
  const result = { contextMode: input.contextMode };
  for (const [key, maximum] of [['maxSteps', 10000], ['maxInputTokens', 2_000_000_000], ['maxOutputTokens', 10_000_000]]) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 1 || input[key] > maximum) throw new Error(`生产预算 ${key} 无效`);
    result[key] = input[key];
  }
  return result;
}

export class ProductionControl {
  constructor(service, config = {}) {
    this.service = service; this.db = service.store.db; this.config = config;
    this.db.exec(`CREATE TABLE IF NOT EXISTS production_settings(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS production_usage(task_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS production_aux_usage(task_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(task_id,seq));
      CREATE TABLE IF NOT EXISTS production_checkpoints(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, title TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL);`);
  }
  policy() { const row = this.db.prepare("SELECT value FROM production_settings WHERE id='policy'").get(); return row ? JSON.parse(row.value) : { ...DEFAULTS }; }
  savePolicy(input) {
    const next = normalizePolicy(input);
    this.db.prepare("INSERT INTO production_settings VALUES('policy',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(JSON.stringify(next));
    return next;
  }
  taskRow(taskId) {
    const row = this.db.prepare('SELECT id,requirement_id,session_id,input_json FROM course_tasks WHERE id=?').get(taskId);
    if (!row) throw new Error('生产任务不存在');
    return row;
  }
  sample(taskId, values, time = Date.now()) {
    this.taskRow(taskId);
    const usage = values?.tokenUsage, stats = values?.sessionStats, context = values?.contextPressure;
    if (!usage && !stats) return this.usage(taskId);
    const previous = this.usage(taskId);
    const data = { available: Boolean(usage), steps: number(stats?.steps), llmMs: number(stats?.llmMs), toolMs: number(stats?.toolMs),
      uncachedInputTokens: number(usage?.uncachedInputTokens), cacheReadTokens: number(usage?.cacheReadTokens),
      cacheWriteTokens: number(usage?.cacheWriteTokens), outputTokens: number(usage?.outputTokens),
      contextTokens: number(context?.projectedTokens ?? context?.pressureTokens), contextWindow: number(context?.contextWindow),
      source: 'DSH 官方全日志投影', lastUpdatedAt: new Date(time).toISOString(),
      ...(previous.budgetStop ? { budgetStop: previous.budgetStop } : {}) };
    if (data.available) { data.inputTokens = data.uncachedInputTokens + data.cacheReadTokens + data.cacheWriteTokens; data.mainInputTokens = data.inputTokens; data.mainOutputTokens = data.outputTokens; }
    this.db.prepare('INSERT INTO production_usage VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at')
      .run(taskId, JSON.stringify(data), data.lastUpdatedAt);
    return data;
  }
  usage(taskId) {
    this.taskRow(taskId);
    const row = this.db.prepare('SELECT data FROM production_usage WHERE task_id=?').get(taskId);
    if (!row) return { available: false, source: '尚未取得原生用量，不按零消耗计算' };
    const data = JSON.parse(row.data), auxiliary = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    const failures = { settlements: 0, knownUsage: 0, inputTokens: 0, outputTokens: 0 }, starts = { steps: 0, retries: 0 };
    for (const item of this.db.prepare('SELECT data FROM production_aux_usage WHERE task_id=?').all(taskId)) {
      const value = JSON.parse(item.data);
      if (value.kind === 'step') { starts.steps++; continue; }
      if (value.kind === 'retry') { starts.retries++; continue; }
      if (value.kind === 'failure') { failures.settlements++; if (value.inputTokens != null) { failures.knownUsage++; failures.inputTokens += value.inputTokens; failures.outputTokens += value.outputTokens; } continue; }
      auxiliary.requests++; auxiliary.inputTokens += value.inputTokens; auxiliary.outputTokens += value.outputTokens; auxiliary.cacheReadTokens += value.cacheReadTokens;
    }
    data.modelRequests = data.steps == null && !starts.steps ? null : Math.max(data.steps || 0, starts.steps) + starts.retries + auxiliary.requests;
    if (data.available) {
      data.inputTokens = (data.mainInputTokens ?? data.inputTokens) + auxiliary.inputTokens;
      data.outputTokens = (data.mainOutputTokens ?? data.outputTokens) + auxiliary.outputTokens;
    }
    return { ...data, auxiliary, failures, retries: starts.retries };
  }
  auxiliary(taskId, event) {
    if (!Number.isSafeInteger(event.seq)) return;
    if (['step/start', 'llm/retry-started', 'assistant/attempt'].includes(event.type)) {
      const usage = event.data?.stream?.filter(item => item.type === 'chunk' && item.chunk?.type === 'usage').at(-1)?.chunk.usage;
      const data = event.type === 'assistant/attempt' ? { kind: 'failure',
        inputTokens: usage && number(usage.inputTokens) !== null ? usage.inputTokens + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0) : null,
        outputTokens: usage && number(usage.outputTokens) !== null ? usage.outputTokens : null } : { kind: event.type === 'step/start' ? 'step' : 'retry' };
      this.db.prepare('INSERT OR IGNORE INTO production_aux_usage VALUES(?,?,?)').run(taskId, event.seq, JSON.stringify(data)); return;
    }
    if (event.type !== 'compaction/summary' || !event.data?.usage) return;
    const usage = event.data.usage;
    if ([usage.inputTokens, usage.outputTokens].some(value => number(value) === null)) return;
    this.db.prepare('INSERT OR IGNORE INTO production_aux_usage VALUES(?,?,?)').run(taskId, event.seq, JSON.stringify({ inputTokens: usage.inputTokens + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0), outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens || 0 }));
  }
  inspect(taskId) {
    const row = this.taskRow(taskId);
    this.config.readProductionUsage?.(this.service, row);
    const usage = this.usage(taskId), frozen = JSON.parse(row.input_json);
    const override = this.db.prepare('SELECT value FROM production_settings WHERE id=?').get(`task:${taskId}`);
    const policy = override ? JSON.parse(override.value) : frozen.productionPolicy;
    const ratios = policy ? [usage.modelRequests / policy.maxSteps, usage.inputTokens / policy.maxInputTokens, usage.outputTokens / policy.maxOutputTokens].filter(Number.isFinite) : [];
    return { taskId, usage, policy: policy || null, warning: ratios.some(value => value >= .8),
      checkpoints: this.db.prepare('SELECT * FROM production_checkpoints WHERE task_id=? ORDER BY created_at DESC').all(taskId) };
  }
  async refresh(taskId) {
    const row = this.taskRow(taskId);
    if (row.session_id) await this.config.refreshProductionUsage?.(this.service, row);
    return this.inspect(taskId);
  }
  setTaskBudget({ taskId, ...policy }) {
    this.taskRow(taskId); const next = normalizePolicy(policy);
    this.db.prepare('INSERT INTO production_settings VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(`task:${taskId}`, JSON.stringify(next));
    const usage = this.usage(taskId); delete usage.budgetStop;
    this.db.prepare('UPDATE production_usage SET data=? WHERE task_id=?').run(JSON.stringify(usage), taskId);
    return this.inspect(taskId);
  }
  check(taskId) {
    const result = this.inspect(taskId), { policy, usage } = result;
    if (!policy) return null;
    const exceeded = [['modelRequests', 'maxSteps', '模型回合'], ['inputTokens', 'maxInputTokens', '累计输入'], ['outputTokens', 'maxOutputTokens', '输出']]
      .find(([key, limit]) => number(usage[key]) !== null && usage[key] >= policy[limit]);
    if (!exceeded) return null;
    const message = `达到${exceeded[2]}预算，已在下一次模型请求前停止。文件和原任务保留；调整本任务预算后从原会话继续。`;
    const value = { ...usage, budgetStop: message };
    this.db.prepare('INSERT INTO production_usage VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data').run(taskId, JSON.stringify(value), new Date().toISOString());
    return message;
  }
  checkpoint({ taskId, title, decisions = '', pending = '', operationId }) {
    if (operationId) return this.service.assets.mutate({ taskId, title, decisions, pending, operationId }, 'production-checkpoint', () => this.checkpoint({ taskId, title, decisions, pending }));
    const task = this.service.tasks.get(taskId);
    if (typeof title !== 'string' || !title.trim() || title.length > 200 || [decisions, pending].some(value => typeof value !== 'string' || value.length > 12000)) throw new Error('请填写有效交接标题和说明');
    const id = randomUUID(), createdAt = new Date().toISOString();
    const relative = path.posix.join('courses', task.requirementId, 'tasks', taskId, 'checkpoints', id);
    let directory = this.service.workspaceRoot;
    for (const part of relative.split('/')) { directory = path.join(directory, part); mkdirSync(directory, { recursive: true }); if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) throw new Error('交接目录不能为链接'); }
    const record = { id, taskId, requirementId: task.requirementId, title: title.trim(), createdAt, decisions, pending,
      authorization: '说明不代替真实用户批准，继续依原任务确认记录', sources: task.input.sources || [],
      files: task.files.map(file => ({ id: file.id, path: file.path, hash: file.hash, status: file.status })), productionRoute: task.input.productionRoute || null };
    const bytes = JSON.stringify(record, null, 2), hash = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(path.join(directory, 'handoff.json'), bytes, { flag: 'wx', mode: 0o600 });
    writeFileSync(path.join(directory, '交接摘要.md'), `# ${record.title}\n\n${createdAt}\n\n## 决策说明\n${decisions}\n\n## 待处理\n${pending}\n\n${record.authorization}\n\n准确文件见 handoff.json；任务 ${taskId}。\n`, { flag: 'wx', mode: 0o600 });
    this.db.prepare('INSERT INTO production_checkpoints VALUES(?,?,?,?,?,?)').run(id, taskId, record.title, `${relative}/handoff.json`, hash, createdAt);
    return { ...record, path: `${relative}/handoff.json`, hash };
  }
}

export function createProductionObserver(ctx) {
  const services = new Set(), stops = [], hydrated = new Set();
  const lookup = name => { try { return ctx.get?.(name) || ctx[name]; } catch { return null; } };
  function read(service, row, session) {
    const agent = lookup('agents')?.get(row.session_id);
    const actual = session || agent?.session;
    if (!actual || actual.header?.cwd !== service.workspaceRoot || actual.id !== row.session_id) return;
    const snapshot = lookup('sessionProjections')?.snapshot(actual, ['tokenUsage', 'sessionStats', 'contextPressure']);
    if (snapshot?.values) service.production.sample(row.id, snapshot.values);
  }
  if (ctx.on) {
    stops.push(ctx.on('session/event', (session, event) => {
      if (!['assistant/message', 'assistant/attempt', 'step/start', 'step/end', 'llm/retry-started', 'turn/end', 'compaction/summary'].includes(event.type)) return;
      for (const service of services) if (!service.store.closed && session.header?.cwd === service.workspaceRoot) {
        for (const row of service.store.db.prepare('SELECT id,session_id FROM course_tasks WHERE session_id=?').all(session.id)) { service.production.auxiliary(row.id, event); read(service, row, session); }
      }
    }));
    stops.push(ctx.on('agent/pre-step', async ({ agent }, next) => {
      for (const service of services) if (!service.store.closed && agent.session.header?.cwd === service.workspaceRoot) {
        for (const row of service.store.db.prepare('SELECT id,session_id FROM course_tasks WHERE session_id=?').all(agent.id)) {
          read(service, row, agent.session);
          if (service.production.check(row.id)) return { kind: 'reject' };
        }
      }
      return next();
    }));
  }
  return { attach: service => services.add(service), read,
    async refresh(service, row) {
      const query = lookup('sessionQuery');
      if (!query?.observeSession) return;
      const observation = await query.observeSession(row.session_id, { projectionMode: 'all' });
      try {
        if (observation.header?.id !== row.session_id || observation.header.cwd !== service.workspaceRoot) throw new Error('用量会话与项目不一致');
        if (!hydrated.has(row.session_id)) {
          for (const event of observation.events || []) service.production.auxiliary(row.id, event);
          hydrated.add(row.session_id);
        }
        if (observation.projections?.values) service.production.sample(row.id, observation.projections.values);
      } finally { observation[Symbol.dispose](); }
    },
    close() { for (const stop of stops) if (typeof stop === 'function') stop(); services.clear(); } };
}
