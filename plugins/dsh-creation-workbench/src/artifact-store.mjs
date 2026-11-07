import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { artifactFormat, validateArtifact, GENERATED_MEDIA_MAX_BYTES } from './artifact-validation.mjs';

const MAX_BYTES = GENERATED_MEDIA_MAX_BYTES;
const sha = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const id = (value, name) => { if (!uuid(value)) throw new Error(`${name}无效`); return value.toLowerCase(); };

export class ArtifactStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.cache = new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_files (
      id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL REFERENCES canvas_spaces(id), task_id TEXT NOT NULL REFERENCES course_tasks(id),
      kind TEXT NOT NULL, title TEXT NOT NULL, path TEXT NOT NULL UNIQUE, hash TEXT NOT NULL,
      byte_size INTEGER NOT NULL, mime TEXT NOT NULL, validation_json TEXT NOT NULL, source_card_ids_json TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
  }

  #task(taskId, sessionId) {
    const task = this.db.prepare('SELECT * FROM course_tasks WHERE id=?').get(id(taskId, '任务标识'));
    if (!task || task.kind !== 'ai') throw new Error('文件产物必须属于已有 AI 创作任务');
    if (typeof sessionId !== 'string' || !sessionId || !task.session_id || task.session_id !== sessionId) throw new Error('任务未绑定当前会话，不能登记文件产物');
    return { ...task, input: JSON.parse(task.input_json) };
  }

  #relative(value, requirementId, taskId, kind) {
    if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || value.includes('\\') || value.split('/').includes('..')) throw new Error('产物路径无效');
    const file = path.resolve(this.store.workspaceRoot, value);
    const relative = path.relative(this.store.workspaceRoot, file).split(path.sep).join('/');
    const prefix = `courses/${requirementId}/tasks/${taskId}/`;
    if (!relative.startsWith(prefix)) throw new Error('产物必须位于本任务的 courses/<需求ID>/tasks/<任务ID>/ 目录内');
    if (!['storyboard', 'support'].includes(kind) && !relative.startsWith(prefix + 'delivery/')) throw new Error('正式产物必须位于本任务的 delivery/ 目录内');
    return relative;
  }

  #inspect(relative) {
    const file = path.resolve(this.store.workspaceRoot, relative);
    if (!file.startsWith(this.store.workspaceRoot + path.sep) || realpathSync(file) !== file) throw new Error('产物路径不能使用符号链接或越出项目目录');
    const info = statSync(file);
    if (!info.isFile() || !info.size || info.size > MAX_BYTES) throw new Error('产物必须是非空且不超过 200 MB 的真实文件');
    return { file, info, signature: [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':') };
  }

  #hash(file) {
    const fd = openSync(file, 'r');
    try {
      const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(1_048_576);
      let count;
      while ((count = readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, count));
      return digest.digest('hex');
    } finally { closeSync(fd); }
  }

  #state(row) {
    try {
      const inspected = this.#inspect(row.path);
      if (inspected.info.size !== row.byte_size) return 'changed';
      const cached = this.cache.get(row.id);
      if (cached?.signature === inspected.signature) return cached.status;
      const status = this.#hash(inspected.file) === row.hash ? 'ready' : 'changed';
      this.cache.set(row.id, { signature: inspected.signature, status });
      return status;
    } catch (error) { return error.code === 'ENOENT' ? 'missing' : 'unavailable'; }
  }

  #value(row) {
    return { id: row.id, requirementId: row.requirement_id, taskId: row.task_id, kind: row.kind, title: row.title,
      path: row.path, hash: row.hash, byteSize: row.byte_size, mime: row.mime, validation: JSON.parse(row.validation_json),
      createdAt: row.created_at, sourceCardIds: JSON.parse(row.source_card_ids_json), status: this.#state(row), ...(this.store.deliverables?.info(`artifact:${row.id}`) ? { delivery: this.store.deliverables.info(`artifact:${row.id}`) } : {}) };
  }

  get(artifactId) {
    if (this.store.closed) throw new Error('工作台已关闭');
    const row = this.db.prepare('SELECT * FROM task_files WHERE id=?').get(id(artifactId, '文件产物标识'));
    if (!row) throw new Error('文件产物不存在');
    return this.#value(row);
  }

  list(requirementId, taskId) {
    if (this.store.closed) throw new Error('工作台已关闭');
    const rows = taskId
      ? this.db.prepare('SELECT * FROM task_files WHERE requirement_id=? AND task_id=? ORDER BY created_at,id').all(id(requirementId, '需求标识'), id(taskId, '任务标识'))
      : this.db.prepare('SELECT * FROM task_files WHERE requirement_id=? ORDER BY created_at,id').all(id(requirementId, '需求标识'));
    return rows.map(row => this.#value(row));
  }

  read(artifactId) {
    const artifact = this.get(artifactId);
    if (artifact.status !== 'ready') throw new Error('产物文件缺失、外改或路径不可用，请核对后重新生产');
    const { file } = this.#inspect(artifact.path);
    const bytes = readFileSync(file);
    this.#inspect(artifact.path);
    if (sha(bytes) !== artifact.hash) throw new Error('产物文件已被外部修改，不能继续使用旧登记');
    return { artifact, bytes };
  }

  async download(artifactId) {
    const { artifact, bytes } = this.read(artifactId);
    return { bytes, name: path.basename(artifact.path), mime: artifact.mime };
  }

  #saved(artifactId, deferSync = false) {
    const artifact = this.get(artifactId);
    if (!deferSync) this.store.outputSaved?.(artifact.requirementId);
    return this.get(artifactId);
  }

  async register(input, { sessionId, deferSync = false, ...validationOptions } = {}) {
    if (this.store.closed) throw new Error('工作台已关闭');
    if (input?.primary !== undefined && typeof input.primary !== 'boolean') throw new Error('主产物标识必须是布尔值');
    const task = this.#task(input?.taskId, sessionId);
    if (input.kind === 'pptx' && task.input.pptEngine === 'baoyu') throw new Error('宝玉课件请在右栏导出保存，必须绑定准确工程快照');
    if (task.input.workflow === 'ppt-edit') throw new Error('PPT 局部修改只能提交待确认方案，不能通过普通文件登记发布；请使用 course_propose_ppt_edit');
    if (['image', 'video'].includes(input.kind)) throw new Error('生成媒体只能由受管媒体任务内部登记，不能通过原生会话工具登记');
    const operationId = id(input.operationId, '产物登记操作标识');
    if (typeof input.title !== 'string' || !input.title.trim() || Buffer.byteLength(input.title) > 600 || input.title.includes('\0')) throw new Error('请填写不超过 600 字节的产物标题');
    const kind = input.kind;
    const outputType = task.input.outputType || 'outline';
    const textDelivery = outputType === 'text' && ['text', 'script', 'exercise'].includes(kind);
    if (kind !== 'support' && !(kind === 'storyboard' && outputType === 'pptx') && kind !== outputType && !textDelivery) throw new Error('正式产物类型必须匹配任务的输出类型；分镜仅用于 PPT 任务。附属资料请使用 kind=support、primary=false');
    const relative = this.#relative(input.path, task.requirement_id, task.id, kind);
    artifactFormat(kind, relative);
    const title = input.title.trim();
    const fingerprint = sha(JSON.stringify({ taskId: task.id, kind, title, path: relative,
      ...(input.primary === undefined ? {} : { primary: input.primary }) }));
    const replay = () => {
      const previous = this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId);
      if (!previous) return null;
      if (previous.kind !== 'register-artifact' || previous.input_hash !== fingerprint) throw new Error('产物操作标识已用于不同内容');
      return previous.result_id;
    };
    const replayed = replay();
    if (replayed) return this.#saved(replayed, deferSync);
    if (this.db.prepare('SELECT id FROM task_files WHERE path=?').get(relative)) throw new Error('该路径已登记产物，不能覆盖旧记录，请使用新文件名');
    const inspected = this.#inspect(relative);
    const bytes = readFileSync(inspected.file);
    const hash = sha(bytes);
    const { mime, validation } = await validateArtifact(kind, relative, bytes, validationOptions);
    if (this.store.closed) throw new Error('工作台已关闭，未登记产物');
    const after = this.#inspect(relative);
    if (this.#hash(after.file) !== hash) throw new Error('验证期间产物文件发生变化，未登记');
    const sourceCardIds = [...new Set((task.input.sources || []).map(source => source.cardId))];
    this.db.exec('BEGIN IMMEDIATE');
    let artifactId;
    try {
      this.#task(task.id, sessionId);
      artifactId = replay();
      if (!artifactId) {
        if (this.db.prepare('SELECT id FROM task_files WHERE path=?').get(relative)) throw new Error('该路径已登记产物，不能覆盖旧记录，请使用新文件名');
        artifactId = randomUUID();
        const now = new Date().toISOString();
        this.db.prepare('INSERT INTO task_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(artifactId, task.requirement_id, task.id, kind, title, relative,
          hash, bytes.length, mime, JSON.stringify(validation), JSON.stringify(sourceCardIds), now);
        this.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(operationId, 'register-artifact', fingerprint, artifactId);
        this.store.cards.recordOutput(task.id, `artifact:${artifactId}`, { primary: input.primary });
        this.db.prepare("UPDATE course_tasks SET status='output',error=NULL,updated_at=? WHERE id=?").run(now, task.id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.#saved(artifactId, deferSync);
  }

  async registerBatch({ taskId, files }, { sessionId, signal, ...validationOptions } = {}) {
    if (this.store.closed) throw new Error('工作台已关闭');
    const task = this.#task(taskId, sessionId);
    if (!Array.isArray(files) || !files.length || files.length > 100) throw new Error('每批必须登记 1–100 个文件');
    const results = [];
    let saved = false, syncError;
    try {
      for (let index = 0; index < files.length; index++) {
        const input = files[index];
        const entry = { index, ...(typeof input?.operationId === 'string' ? { operationId: input.operationId } : {}) };
        if (signal?.aborted) { results.push({ ...entry, ok: false, skipped: true, error: '任务已取消，未执行此项登记' }); continue; }
        try {
          if (!input || typeof input !== 'object' || (input.taskId !== undefined && input.taskId !== task.id)) throw new Error('批量文件必须属于同一个任务');
          const file = await this.register({ ...input, taskId: task.id }, { ...validationOptions, sessionId, deferSync: true });
          saved = true;
          results.push({ ...entry, ok: file.status === 'ready', id: file.id, path: file.path, hash: file.hash,
            status: file.status, ...(file.status === 'ready' ? {} : { error: '已登记文件缺失、外改或不可用，请核对原文件；未覆盖旧登记' }) });
        } catch (error) { results.push({ ...entry, ok: false, error: error.message || String(error) }); }
      }
    } finally {
      if (saved) {
        try {
          const sync = this.store.outputSaved?.(task.requirement_id);
          syncError = this.store.deliverables?.lastError || (sync?.failed ? `产物已登记，但目录整理有 ${sync.failed} 项失败；原文件与登记保留，请查看文件详情后重试整理` : undefined);
        } catch (error) { syncError = error.message || String(error); }
      }
    }
    for (const entry of results) {
      if (!entry.id) continue;
      const delivery = this.store.deliverables?.info(`artifact:${entry.id}`);
      if (delivery) entry.delivery = { path: delivery.path, status: delivery.status, ...(delivery.error ? { error: delivery.error } : {}) };
    }
    const succeeded = results.filter(item => item.ok).length;
    return { taskId: task.id, ok: succeeded === files.length && !syncError, total: files.length,
      succeeded, failed: files.length - succeeded, results, ...(syncError ? { syncError } : {}) };
  }

  /** Internal editor publication. No browser/Agent may use the general
   * registration tool to turn an unconfirmed proposal into a formal version. */
  async registerPptEdit(input, validationOptions = {}) {
    if (this.store.closed) throw new Error('工作台已关闭');
    const taskId = id(input?.taskId, 'PPT 编辑任务标识');
    const operationId = id(input.operationId, 'PPT 编辑登记标识');
    const checkTask = () => {
      const row = this.db.prepare('SELECT * FROM course_tasks WHERE id=?').get(taskId);
      if (!row) throw new Error('PPT 编辑任务不存在');
      const snapshot = JSON.parse(row.input_json);
      if (!(row.kind === 'manual' && snapshot.workflow === 'ppt-edit-manual')
        && !(row.kind === 'ai' && snapshot.workflow === 'ppt-edit')) throw new Error('该任务不是受管 PPT 编辑任务');
      const scope = snapshot.pptEdit?.scope;
      if (!scope || scope.requirementId !== row.requirement_id) throw new Error('PPT 编辑基准无效');
      let proposal = null;
      if (row.kind === 'ai') {
        proposal = this.db.prepare('SELECT * FROM ppt_editor_proposals WHERE id=? AND task_id=?').get(id(input.proposalId, 'PPT 候选标识'), taskId);
        if (!proposal || !['pending', 'confirmed'].includes(proposal.status)) throw new Error('AI 修改没有可确认的候选结果');
      }
      return { ...row, snapshot, scope, proposal };
    };
    const task = checkTask();
    if (task.proposal?.status === 'confirmed') return this.#saved(task.proposal.artifact_id);
    if (typeof input.title !== 'string' || !input.title.trim() || Buffer.byteLength(input.title) > 600) throw new Error('PPT 产物标题无效');
    const relative = this.#relative(input.path, task.requirement_id, task.id, 'pptx');
    artifactFormat('pptx', relative);
    const fingerprint = sha(JSON.stringify({ taskId, path: relative, title: input.title.trim(), proposalId: input.proposalId || null }));
    const replay = () => {
      const previous = this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId);
      if (!previous) return null;
      if (previous.kind !== 'register-ppt-edit' || previous.input_hash !== fingerprint) throw new Error('PPT 编辑登记操作已用于不同内容');
      return previous.result_id;
    };
    const replayed = replay();
    if (replayed) return this.#saved(replayed);
    if (this.db.prepare('SELECT id FROM task_files WHERE path=?').get(relative)) throw new Error('PPT 编辑产物路径已登记，不能覆盖');
    const inspected = this.#inspect(relative), bytes = readFileSync(inspected.file), hash = sha(bytes);
    const expectedHash = task.proposal?.hash || task.snapshot.pptEdit.resultHash;
    if (!expectedHash || hash !== expectedHash) throw new Error('PPT 编辑结果与受管草稿／候选不匹配');
    const { mime, validation } = await validateArtifact('pptx', relative, bytes, validationOptions);
    if (this.store.closed) throw new Error('工作台已关闭，未登记 PPT 编辑结果');
    if (this.#hash(this.#inspect(relative).file) !== hash) throw new Error('验证期间 PPT 编辑结果发生变化');
    this.db.exec('BEGIN IMMEDIATE');
    let artifactId;
    try {
      const current = checkTask();
      if (current.proposal?.status === 'confirmed') artifactId = current.proposal.artifact_id;
      else artifactId = replay();
      if (!artifactId) {
        const base = this.read(current.scope.artifactId).artifact;
        if (base.requirementId !== current.requirement_id || base.hash !== current.scope.hash) throw new Error('PPT 编辑原文件已变化或不属于当前需求');
        let plan;
        if (current.scope.outcome === true && !current.scope.versionId) {
          const selected = this.store.outcomes.manifest({ requirementId: current.requirement_id, cardId: current.scope.cardId,
            sourceRef: `artifact:${current.scope.artifactId}` });
          if (selected.versionId || !selected.files.some(file => file.artifactId === base.id && file.format === 'pptx' && file.hash === base.hash)) throw new Error('PPT附件的卡片基准已变化，未登记新版本');
          plan = { id: current.scope.cardId, requirementId: current.requirement_id, type: 'pptx', title: input.title.trim(), baseVersionId: null };
        } else plan = this.store.cards.prepare({ requirementId: current.requirement_id, outputType: 'pptx', instruction: current.instruction,
          generation: { mode: 'revise', cardId: current.scope.cardId, baseVersionId: current.scope.versionId } });
        if (!this.store.cards.binding(taskId)) this.store.cards.attach(taskId, plan);
        if (this.db.prepare('SELECT id FROM task_files WHERE path=?').get(relative)) throw new Error('PPT 编辑产物路径已登记，不能覆盖');
        artifactId = randomUUID();
        const now = new Date().toISOString();
        const sources = [...new Set((current.snapshot.sources || []).map(source => source.cardId))];
        this.db.prepare('INSERT INTO task_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(artifactId, current.requirement_id,
          taskId, 'pptx', input.title.trim(), relative, hash, bytes.length, mime, JSON.stringify(validation), JSON.stringify(sources), now);
        this.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(operationId, 'register-ppt-edit', fingerprint, artifactId);
        this.store.cards.recordOutput(taskId, `artifact:${artifactId}`, { primary: true });
        if(current.scope.svgSourceId) this.store.svgDecks.recordPublication(artifactId,current.scope,validationOptions.svgExport);
        this.db.prepare("UPDATE course_tasks SET status='output',error=NULL,updated_at=? WHERE id=?").run(now, taskId);
        if (current.proposal) this.db.prepare("UPDATE ppt_editor_proposals SET status='confirmed',artifact_id=?,updated_at=? WHERE id=?")
          .run(artifactId, now, current.proposal.id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.#saved(artifactId);
  }

  /** Internal provider path. The Agent tool above still requires its original bound native session. */
  async registerGeneratedMedia(input, validationOptions = {}) {
    if (this.store.closed) throw new Error('工作台已关闭');
    const taskId = id(input?.taskId, '媒体任务标识');
    const mediaTask = () => {
      const task = this.db.prepare('SELECT * FROM course_tasks WHERE id=?').get(taskId);
      const job = this.db.prepare('SELECT * FROM media_jobs WHERE task_id=?').get(taskId);
      if (!task || task.kind !== 'media' || !job || !['image', 'video'].includes(job.output_type)) throw new Error('媒体产物必须属于内部生成任务');
      if (!job.downloaded_path || !job.downloaded_hash || job.downloaded_path !== input.path
        || job.artifact_operation_id !== input.operationId) throw new Error('媒体产物没有匹配的内部下载记录');
      return { task, job, snapshot: JSON.parse(task.input_json) };
    };
    const { task, job, snapshot } = mediaTask();
    if (job.artifact_id) return this.#saved(job.artifact_id);
    if (!['registering', 'registration_failed'].includes(job.status)) throw new Error('媒体任务尚未进入验证登记阶段');
    const kind = job.output_type;
    if (snapshot.outputType !== kind) throw new Error('媒体文件类型与任务不匹配');
    if (typeof input.title !== 'string' || !input.title.trim() || Buffer.byteLength(input.title) > 600 || input.title.includes('\0')) throw new Error('媒体产物标题无效');
    const relative = this.#relative(input.path, task.requirement_id, task.id, kind);
    artifactFormat(kind, relative);
    const inspected = this.#inspect(relative), bytes = readFileSync(inspected.file), hash = sha(bytes);
    if (hash !== job.downloaded_hash) throw new Error('生成媒体在下载后发生变化，未登记');
    const { mime, validation } = await validateArtifact(kind, relative, bytes, validationOptions);
    if (this.store.closed) throw new Error('工作台已关闭，未登记媒体产物');
    if (this.#hash(this.#inspect(relative).file) !== hash) throw new Error('验证期间生成媒体文件发生变化，未登记');
    const sourceCardIds = [...new Set((snapshot.sources || []).map(source => source.cardId))];
    const fingerprint = sha(JSON.stringify({ taskId, kind, title: input.title.trim(), path: relative }));
    this.db.exec('BEGIN IMMEDIATE');
    let artifactId;
    try {
      const current = mediaTask();
      if (current.job.downloaded_hash !== hash || !['registering', 'registration_failed'].includes(current.job.status)) throw new Error('媒体下载记录已变化，未登记');
      const previous = this.db.prepare('SELECT * FROM operations WHERE id=?').get(input.operationId);
      if (previous) {
        if (previous.kind !== 'register-generated-media' || previous.input_hash !== fingerprint) throw new Error('媒体产物登记操作已用于不同内容');
        artifactId = previous.result_id;
      } else {
        if (this.db.prepare('SELECT id FROM task_files WHERE path=?').get(relative)) throw new Error('媒体路径已登记，不能覆盖旧产物');
        artifactId = randomUUID();
        const now = new Date().toISOString();
        this.db.prepare('INSERT INTO task_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(artifactId, task.requirement_id, taskId,
          kind, input.title.trim(), relative, hash, bytes.length, mime, JSON.stringify(validation), JSON.stringify(sourceCardIds), now);
        this.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(input.operationId, 'register-generated-media', fingerprint, artifactId);
      }
      const now = new Date().toISOString();
      this.db.prepare("UPDATE course_tasks SET status='output',error=NULL,updated_at=? WHERE id=?").run(now, taskId);
      this.db.prepare("UPDATE media_jobs SET status='succeeded',artifact_id=?,error=NULL,error_code=NULL,updated_at=? WHERE task_id=?")
        .run(artifactId, now, taskId);
      this.store.cards.recordOutput(taskId, `artifact:${artifactId}`, { primary: true });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.#saved(artifactId);
  }
}
