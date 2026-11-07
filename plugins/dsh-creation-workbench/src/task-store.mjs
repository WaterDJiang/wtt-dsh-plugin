import { randomUUID } from 'node:crypto';
import { sourceDigest } from './source-range.mjs';
import { ArtifactStore } from './artifact-store.mjs';
import { normalizeGeneration } from './output-card-store.mjs';
import { normalizeModelSelection } from './model-selection.mjs';

const validId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const id = (value, label) => { if (!validId(value)) throw new Error(`${label}无效`); return value.toLowerCase(); };

export class TaskStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS course_tasks (
      id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL REFERENCES canvas_spaces(id),
      kind TEXT NOT NULL, title TEXT NOT NULL, instruction TEXT NOT NULL, input_json TEXT NOT NULL,
      request_id TEXT UNIQUE, session_id TEXT, status TEXT NOT NULL, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_artifacts (
      task_id TEXT NOT NULL REFERENCES course_tasks(id), version_id TEXT NOT NULL UNIQUE REFERENCES outline_versions(id),
      PRIMARY KEY(task_id, version_id)
    );`);
    this.files = new ArtifactStore(store);
    this.db.prepare("UPDATE course_tasks SET status='unknown',error=COALESCE(error,'上次提交未得到确定回执，请打开原生会话核对'),updated_at=? WHERE status='submitting' AND kind='ai'")
      .run(new Date().toISOString());
  }

  #transaction(action) {
    if (this.store.closed) throw new Error('工作台已关闭');
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  #row(taskId) {
    if (this.store.closed) throw new Error('工作台已关闭');
    const row = this.db.prepare('SELECT * FROM course_tasks WHERE id=?').get(id(taskId, '任务标识'));
    if (!row) throw new Error('任务不存在');
    return row;
  }

  #value(row, detail = false) {
    const snapshot = JSON.parse(row.input_json);
    const artifacts = this.db.prepare(`SELECT v.id AS versionId,v.number,v.markdown_path AS markdownPath,v.word_path AS wordPath
      FROM task_artifacts a JOIN outline_versions v ON v.id=a.version_id WHERE a.task_id=? ORDER BY v.number`).all(row.id).map(value => ({ ...value }));
    const files = this.files.list(row.requirement_id, row.id);
    const task = { id: row.id, requirementId: row.requirement_id, kind: row.kind, title: row.title,
      instruction: row.instruction, status: artifacts.length || files.length ? 'output' : row.status, dispatchStatus: row.status, requestId: row.request_id,
      sessionId: row.session_id, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at,
      artifacts, files, ...(this.store.cards?.binding(row.id) || {}),
      ...(['ppt-edit', 'ppt-edit-manual'].includes(snapshot.workflow) ? { workflow: snapshot.workflow,
        pptEdit: { draftId: snapshot.pptEdit?.draftId, revision: snapshot.pptEdit?.revision,
          slideId: snapshot.pptEdit?.slideId, elementIds: snapshot.pptEdit?.elementIds || [] } } : {}),
      ...(row.kind === 'media' && this.mediaController ? { mediaJob: this.mediaController.job(row.id) } : {}),
      ...(detail ? { input: snapshot } : {}) };
    if (row.kind === 'ai' && typeof this.runtimeStateReader === 'function') {
      try {
        const state = this.runtimeStateReader(task);
        if (state && ['generating', 'awaiting-input', 'awaiting-approval', 'idle', 'failed', 'unknown'].includes(state.phase)) {
          task.runtimeState = { phase: state.phase, ...(typeof state.message === 'string' && state.message ? { message: state.message } : {}) };
        }
      } catch (error) { task.runtimeState = { phase: 'unknown', message: `运行状态读取失败：${error.message || String(error)}` }; }
    }
    return task;
  }

  get(taskId) { return this.#value(this.#row(taskId), true); }

  list(requirementId) {
    requirementId = id(requirementId, '需求标识');
    if (!this.store.getRequirement(requirementId)) throw new Error('需求不存在');
    return this.db.prepare('SELECT * FROM course_tasks WHERE requirement_id=? ORDER BY created_at DESC,id DESC')
      .all(requirementId).map(row => this.#value(row));
  }

  fingerprint(input) {
    const requirementId = id(input?.requirementId, '需求标识');
    const operationId = id(input.operationId, '操作标识');
    if (typeof input.instruction !== 'string' || !input.instruction.trim() || input.instruction.length > 8000) throw new Error('请填写本次制课意图（最多 8000 字）');
    const generation = input.generation === undefined ? undefined : normalizeGeneration(input.generation);
    if (!Array.isArray(input.selectedCardIds) || input.selectedCardIds.length < (generation ? 0 : 1) || input.selectedCardIds.length > 24
      || input.selectedCardIds.some(value => typeof value !== 'string')) throw new Error('请选中 1–24 张卡片作为本次上下文');
    const selection = input.selection === undefined || input.selection === null ? null : {
      sourceCardId: input.selection.sourceCardId, sourceHash: input.selection.sourceHash,
      start: input.selection.start, end: input.selection.end, quote: input.selection.quote,
    };
    const additional = {};
    const modelSelection = normalizeModelSelection(input.modelSelection);
    if (modelSelection) additional.modelSelection = modelSelection;
    if (generation) additional.generation = generation;
    if (input.pptEngine !== undefined) {
      if (input.outputType !== 'pptx' || !['baoyu', 'native'].includes(input.pptEngine)) throw new Error('课件引擎无效');
      additional.pptEngine = input.pptEngine;
    }
    if (input.pptStage !== undefined) {
      if (input.outputType !== 'pptx' || input.pptEngine === 'baoyu' || !['create', 'build', 'edit'].includes(input.pptStage)) throw new Error('原生 PPT 阶段无效');
      additional.pptStage = input.pptStage;
    }
    if (input.outputType !== undefined) {
      if (!['outline', 'pptx', 'exercise', 'script', 'text', 'image', 'video'].includes(input.outputType)) throw new Error('任务输出类型无效');
      additional.outputType = input.outputType;
    }
    if (['image', 'video'].includes(input.outputType)) {
      const media = input.media;
      if (!media || typeof media.model !== 'string' || typeof media.ratio !== 'string' || typeof media.resolution !== 'string'
        || (input.outputType === 'video' && !Number.isInteger(media.duration))) throw new Error('媒体模型参数无效');
      additional.media = { model: media.model, ratio: media.ratio, resolution: media.resolution,
        ...(input.outputType === 'video' ? { duration: media.duration } : {}) };
    }
    if (input.selectedSkills !== undefined) {
      if (!Array.isArray(input.selectedSkills) || input.selectedSkills.length > 24
        || input.selectedSkills.some(name => typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
        || new Set(input.selectedSkills).size !== input.selectedSkills.length) throw new Error('显式 Skill 必须是不重复的有效名称，最多 24 项');
      additional.selectedSkills = [...input.selectedSkills];
    }
    if (input.outputPosition !== undefined) {
      const position = input.outputPosition;
      if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || Math.abs(position.x) > 1_000_000 || Math.abs(position.y) > 1_000_000) throw new Error('任务产物坐标无效');
      additional.outputPosition = { x: position.x, y: position.y };
    }
    if (input.sourceRefs !== undefined) {
      if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length > 200) throw new Error('冻结来源引用无效');
      const seen = new Set();
      additional.sourceRefs = input.sourceRefs.map(ref => {
        if (!ref || typeof ref.cardId !== 'string' || !/^(requirement|material|outline|word|artifact):[0-9a-f-]+$/.test(ref.cardId)
          || !validId(ref.cardId.split(':')[1]) || typeof ref.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(ref.hash) || seen.has(ref.cardId)) throw new Error('冻结来源标识或 hash 无效');
        seen.add(ref.cardId);
        return { cardId: ref.cardId, hash: ref.hash.toLowerCase() };
      }).sort((a, b) => a.cardId.localeCompare(b.cardId));
      const selected = [...new Set(input.selectedCardIds)].sort();
      if (JSON.stringify(additional.sourceRefs.map(ref => ref.cardId)) !== JSON.stringify(selected)) throw new Error('冻结来源必须与本次引用卡片一致');
    }
    const fingerprint = sourceDigest(JSON.stringify({ requirementId, instruction: input.instruction.trim(),
      selectedCardIds: [...new Set(input.selectedCardIds)].sort(), selection, ...additional }));
    return { requirementId, operationId, fingerprint, additional };
  }

  replay(input) {
    const { operationId, fingerprint } = this.fingerprint(input);
    const row = this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId);
    if (!row) return null;
    if (row.kind !== 'create-task' || row.input_hash !== fingerprint) throw new Error('任务操作标识已用于不同内容');
    return this.get(row.result_id);
  }

  create(input, snapshot, { kind = 'ai', onCreate, cardPlan } = {}) {
    if (!['ai', 'media'].includes(kind)) throw new Error('任务执行类型无效');
    const { operationId, requirementId, fingerprint, additional } = this.fingerprint(input);
    if (additional.generation && !cardPlan) throw new Error('产物卡生成目标尚未由业务服务核验');
    const frozen = { ...snapshot, ...additional,
      // Fingerprints keep the original request; the business service freezes the resolved engine.
      ...(snapshot.skillSelection?.version === 1 && snapshot.outputType === 'pptx' ? { pptEngine: snapshot.pptEngine } : {}),
      ...(cardPlan ? { outputCardId: cardPlan.id, baseCardVersionId: cardPlan.baseVersionId } : {}),
      ...(snapshot.sourceRefs ? { sourceRefs: snapshot.sourceRefs } : {}) };
    const taskId = this.#transaction(() => {
      const replay = this.replay(input);
      if (replay) return replay.id;
      if (!this.store.getRequirement(requirementId)) throw new Error('需求不存在');
      const taskId = randomUUID(), now = new Date().toISOString();
      this.db.prepare(`INSERT INTO course_tasks VALUES (?,?,?,?,?,?,?,NULL,'draft',NULL,?,?)`)
        .run(taskId, requirementId, kind, `AI 创作 · ${input.instruction.trim().slice(0, 100)}`,
          input.instruction.trim(), JSON.stringify(frozen), randomUUID(), now, now);
      this.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(operationId, 'create-task', fingerprint, taskId);
      this.store.cards.attach(taskId, cardPlan);
      onCreate?.(taskId);
      return taskId;
    });
    return this.get(taskId);
  }

  /** Internal PPT editing entry. Card publication is deferred until an actual
   * manual save or the user's confirmation of an AI proposal. */
  createPptEdit({ operationId, requirementId, kind, fingerprint, snapshot, onCreated }) {
    operationId = id(operationId, 'PPT 编辑操作标识');
    requirementId = id(requirementId, '需求标识');
    if (!['manual', 'ai'].includes(kind) || snapshot?.workflow !== (kind === 'ai' ? 'ppt-edit' : 'ppt-edit-manual')
      || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)
      || snapshot?.requirement?.id !== requirementId || !snapshot.pptEdit?.scope
      || typeof snapshot.instruction !== 'string' || !snapshot.instruction.trim()) throw new Error('PPT 编辑任务输入无效');
    const taskId = this.#transaction(() => {
      const previous = this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId);
      if (previous) {
        if (previous.kind !== 'create-ppt-edit' || previous.input_hash !== fingerprint) throw new Error('PPT 编辑操作标识已用于不同内容');
        const task = this.#row(previous.result_id);
        if (task.kind !== kind || task.requirement_id !== requirementId) throw new Error('PPT 编辑任务不匹配');
        return task.id;
      }
      if (!this.store.getRequirement(requirementId)) throw new Error('需求不存在');
      const taskId = randomUUID(), now = new Date().toISOString();
      this.db.prepare("INSERT INTO course_tasks VALUES (?,?,?,?,?,?,?,NULL,'draft',NULL,?,?)")
        .run(taskId, requirementId, kind, `${kind === 'manual' ? '人工修改' : 'AI 局部修改'} · PPT`,
          snapshot.instruction.trim(), JSON.stringify(snapshot), kind === 'ai' ? randomUUID() : null, now, now);
      if(typeof onCreated==='function')onCreated(taskId);
      this.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(operationId, 'create-ppt-edit', fingerprint, taskId);
      return taskId;
    });
    return this.get(taskId);
  }

  bindSession({ taskId, sessionId }) {
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200 || sessionId.includes('\0')) throw new Error('会话标识无效');
    return this.#transaction(() => {
      const row = this.#row(taskId);
      if (row.kind !== 'ai') throw new Error('人工修订任务不绑定模型会话');
      if (row.session_id && row.session_id !== sessionId) throw new Error('任务已绑定其他会话，不能替换');
      this.db.prepare('UPDATE course_tasks SET session_id=?,updated_at=? WHERE id=?').run(sessionId, new Date().toISOString(), row.id);
      return this.get(row.id);
    });
  }

  setDispatch({ taskId, status, error }) {
    if (!['submitting', 'accepted', 'failed', 'unknown'].includes(status)) throw new Error('任务发送状态无效');
    if (error !== undefined && (typeof error !== 'string' || error.length > 20_000 || error.includes('\0'))) throw new Error('任务错误信息无效');
    return this.#transaction(() => {
      const row = this.#row(taskId), task = this.get(row.id);
      if (task.artifacts.length || task.files.length || row.status === 'output') return task;
      if (task.input.workflow === 'ppt-edit' && ['proposed', 'discarded', 'applied'].includes(row.status)) return task;
      if (row.kind !== 'ai') throw new Error('人工修订任务不提交模型请求');
      if (status === 'submitting' && ['accepted', 'unknown'].includes(row.status)) throw new Error('任务已受理或状态待核对，请打开原生会话核对，不能直接重发');
      if (status === 'accepted' && !row.session_id) throw new Error('任务尚未绑定会话，不能标记受理');
      this.db.prepare('UPDATE course_tasks SET status=?,error=?,updated_at=? WHERE id=?')
        .run(status, error || null, new Date().toISOString(), row.id);
      return this.get(row.id);
    });
  }

  artifactPlacements(requirementId) {
    requirementId = id(requirementId, '需求标识');
    const rows = this.db.prepare(`SELECT t.id AS task_id,t.input_json,a.version_id AS ref_id,'outline' AS category,v.created_at AS produced_at
      FROM course_tasks t JOIN task_artifacts a ON a.task_id=t.id JOIN outline_versions v ON v.id=a.version_id WHERE t.requirement_id=?
      UNION ALL SELECT t.id AS task_id,t.input_json,f.id AS ref_id,'artifact' AS category,f.created_at AS produced_at
      FROM course_tasks t JOIN task_files f ON f.task_id=t.id WHERE t.requirement_id=? ORDER BY produced_at,ref_id`).all(requirementId, requirementId);
    const placements = new Map(), counters = new Map();
    for (const row of rows) {
      const position = JSON.parse(row.input_json).outputPosition;
      if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
      const count = counters.get(row.task_id) || 0;
      counters.set(row.task_id, count + 1);
      const bounded = value => Math.max(-1_000_000, Math.min(1_000_000, value));
      const next = { x: bounded(position.x + count % 2 * 320), y: bounded(position.y + Math.floor(count / 2) * 280) };
      placements.set(`${row.category}:${row.ref_id}`, next);
      if (row.category === 'outline') placements.set(`word:${row.ref_id}`, { x: next.x, y: bounded(next.y + 320) });
    }
    return placements;
  }

  /** Called inside saveOutline's existing transaction. */
  validateOutline(taskId, requirementId, sourceCardIds, sessionId) {
    const task = this.get(taskId);
    if (task.requirementId !== requirementId || task.kind !== 'ai') throw new Error('任务不存在或不属于当前需求的 AI 创作');
    const allowed = new Set(task.input.sources.map(source => source.cardId));
    if (sourceCardIds.some(source => !allowed.has(source))) throw new Error('大纲来源超出本次任务的输入范围');
    if (sessionId && task.sessionId !== sessionId) throw new Error('任务尚未绑定当前模型会话');
    return task;
  }

  /** Called inside saveOutline's existing transaction. */
  attachOutline(taskId, versionId, { primary } = {}) {
    const row = this.#row(taskId), version = this.store.getVersion(versionId);
    if (!version || version.requirementId !== row.requirement_id) throw new Error('产物不属于当前任务需求');
    this.db.prepare('INSERT INTO task_artifacts VALUES (?,?)').run(row.id, version.id);
    this.store.cards.recordOutput(row.id, `outline:${version.id}`, { primary });
    this.db.prepare("UPDATE course_tasks SET status='output',error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
  }

  /** Manual revision and its actual output share saveOutline's transaction. */
  createManual(requirement, base, versionId, number, generation) {
    const plan = generation ? this.store.cards.prepare({ requirementId: requirement.id, outputType: 'text', instruction: '人工修订', generation }) : null;
    const origin = generation ? this.store.cards.describe({ requirementId: requirement.id, cardId: generation.cardId, versionId: generation.baseVersionId }) : null;
    if (origin && origin.version.primaryRef !== `outline:${base.id}`) throw new Error('人工修订的卡片与大纲基准不一致');
    const taskId = randomUUID(), now = new Date().toISOString();
    const instruction = `基于大纲 v${base.number} 人工修订`;
    const snapshot = { requirement: { id: requirement.id, title: requirement.title, customer: requirement.customer,
      audience: requirement.audience, background: requirement.background, objectives: requirement.objectives },
    sources: [{ cardId: `outline:${base.id}`, kind: 'outline', title: `大纲 v${base.number}`, hash: base.hash, content: base.markdown, path: base.markdownPath }],
    selection: null, instruction, skill: null, baseVersionId: base.id,
    ...(origin ? { workflow: 'text-edit', outputType: 'outline', instruction: origin.editor.instruction,
      sources: origin.editor.references, selectedSkills: origin.editor.selectedSkills,
      ...(origin.editor.modelSelection ? { modelSelection: origin.editor.modelSelection } : {}) } : {}) };
    this.db.prepare("INSERT INTO course_tasks VALUES (?,?,?,?,?,?,NULL,NULL,'output',NULL,?,?)")
      .run(taskId, requirement.id, 'manual', `人工修订 · 大纲 v${number}`, instruction, JSON.stringify(snapshot), now, now);
    if (plan) this.store.cards.attach(taskId, plan);
    this.attachOutline(taskId, versionId);
    return taskId;
  }
}
