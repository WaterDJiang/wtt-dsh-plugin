import { randomUUID } from 'node:crypto';
import { OutputDraftStore } from './output-draft-store.mjs';

const REF = /^(artifact|outline|word|material):[0-9a-f-]{36}$/;
const typeOf = type => type === 'pptx' ? 'pptx' : ['image', 'video'].includes(type) ? type : 'text';
const legacyId = ref => `legacy:${ref}`;
const legacyVersion = ref => `legacy-v1:${ref}`;

export function normalizeGeneration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('产物卡生成目标无效');
  if (value.mode === 'new' && Object.keys(value).every(key => ['mode','cardId'].includes(key)) && (value.cardId === undefined || typeof value.cardId === 'string' && /^[0-9a-f-]{36}$/i.test(value.cardId))) return { mode: 'new', ...(value.cardId ? {cardId:value.cardId} : {}) };
  if (value.mode === 'revise' && Object.keys(value).every(key => ['mode', 'cardId', 'baseVersionId'].includes(key))
    && typeof value.cardId === 'string' && value.cardId.length < 200 && value.cardId
    && typeof value.baseVersionId === 'string' && value.baseVersionId.length < 200 && value.baseVersionId) {
    return { mode: 'revise', cardId: value.cardId, baseVersionId: value.baseVersionId };
  }
  throw new Error('产物卡生成目标必须是新卡或明确的原卡／基准版本');
}

export class OutputCardStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS output_cards (
      id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL REFERENCES canvas_spaces(id), type TEXT NOT NULL,
      title TEXT NOT NULL, node_id TEXT, head_version_id TEXT, head_sequence INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS output_card_versions (
      id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES output_cards(id), number INTEGER NOT NULL,
      task_id TEXT REFERENCES course_tasks(id), base_version_id TEXT, primary_ref TEXT NOT NULL,
      request_sequence INTEGER NOT NULL, legacy INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      UNIQUE(card_id,number)
    );
    CREATE TABLE IF NOT EXISTS output_card_tasks (
      task_id TEXT PRIMARY KEY REFERENCES course_tasks(id), card_id TEXT NOT NULL REFERENCES output_cards(id),
      base_version_id TEXT, request_sequence INTEGER NOT NULL, UNIQUE(card_id,request_sequence)
    );
    CREATE TABLE IF NOT EXISTS output_card_outputs (
      source_ref TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES output_cards(id),
      task_id TEXT REFERENCES course_tasks(id), version_id TEXT REFERENCES output_card_versions(id), role TEXT NOT NULL
    )`);
    this.drafts = new OutputDraftStore(store);
  }

  #check() { if (this.store.closed) throw new Error('工作台已关闭'); }
  #raw(requirementId) {
    this.#check();
    if (!this.canvas) throw new Error('产物卡来源尚未就绪');
    return this.canvas.getRawBoard(requirementId);
  }
  #source(requirementId, ref, raw) {
    if (!REF.test(ref || '')) throw new Error('产物版本来源标识无效');
    const node = (raw || this.#raw(requirementId)).nodes.find(node => node.id === ref);
    if (!node) throw new Error('产物卡不存在或不属于当前需求');
    return node;
  }
  #originalTask(ref) {
    const [kind, id] = ref.split(':');
    return kind === 'artifact' ? this.db.prepare('SELECT task_id FROM task_files WHERE id=?').get(id)?.task_id
      : this.db.prepare('SELECT task_id FROM task_artifacts WHERE version_id=?').get(id)?.task_id;
  }
  #virtual(requirementId, cardId, raw) {
    const ref = cardId.startsWith('legacy:') ? cardId.slice(7) : cardId;
    const node = this.#source(requirementId, ref, raw);
    const version = { id: legacyVersion(ref), cardId: legacyId(ref), number: 1, taskId: this.#originalTask(ref) || null,
      baseVersionId: null, primaryRef: ref, requestSequence: 0, legacy: true, createdAt: node.createdAt || null };
    return { card: { id: legacyId(ref), requirementId, type: typeOf(node.artifactKind), title: node.title, nodeId: ref,
      latestVersionId: version.id, versions: [version], legacy: true }, version, node };
  }
  #version(row) {
    return { id: row.id, cardId: row.card_id, number: row.number, taskId: row.task_id, baseVersionId: row.base_version_id,
      primaryRef: row.primary_ref, requestSequence: row.request_sequence, legacy: Boolean(row.legacy), createdAt: row.created_at,
      outputs: this.db.prepare('SELECT source_ref AS sourceId,role FROM output_card_outputs WHERE version_id=? ORDER BY rowid').all(row.id).map(value => ({ ...value })) };
  }
  #card(row) {
    return { id: row.id, requirementId: row.requirement_id, type: row.type, title: row.title, nodeId: row.node_id || `output:${row.id}`,
      latestVersionId: row.head_version_id, versions: this.db.prepare('SELECT * FROM output_card_versions WHERE card_id=? ORDER BY number').all(row.id).map(value => this.#version(value)), legacy: false };
  }

  binding(taskId) {
    this.#check();
    const binding = this.db.prepare('SELECT * FROM output_card_tasks WHERE task_id=?').get(taskId);
    if (!binding) return null;
    const version = this.db.prepare('SELECT id FROM output_card_versions WHERE task_id=? AND card_id=? AND legacy=0').get(taskId, binding.card_id);
    return { outputCardId: binding.card_id, baseCardVersionId: binding.base_version_id,
      ...(version ? { cardVersionId: version.id } : {}) };
  }

  prepare(input) {
    if (input.generation === undefined) return null;
    const generation = normalizeGeneration(input.generation);
    if (!this.store.getRequirement(input.requirementId)) throw new Error('需求不存在');
    const type = typeOf(input.outputType || 'outline');
    if (generation.mode === 'new' && generation.cardId) {
      const draft=this.drafts.get(input.requirementId,generation.cardId);
      if (!draft.editable) throw new Error('此卡已创建任务，请打开原任务继续');
      if (draft.outputType !== type) throw new Error('草稿卡类型不匹配，请新建对应类型');
      return {id:draft.cardId,requirementId:input.requirementId,type,title:input.instruction.trim().slice(0,80),baseVersionId:null,composition:true};
    }
    if (generation.mode === 'new') return { id: randomUUID(), requirementId: input.requirementId, type,
      title: input.instruction.trim().slice(0, 80), baseVersionId: null };
    const described = this.describe({ requirementId: input.requirementId, cardId: generation.cardId, versionId: generation.baseVersionId });
    if (described.card.type !== type) throw new Error('同卡修订必须保持原产物类型；不同类型请新建卡片');
    return { id: described.card.id, requirementId: input.requirementId, type, title: described.card.title,
      baseVersionId: described.version.id, ...(described.card.legacy ? { adoption: described } : {}) };
  }

  /** Task creation already owns the transaction. Never adopt or create on a mere read. */
  attach(taskId, plan) {
    if (!plan) return;
    const now = new Date().toISOString();
    if(plan.composition&&!this.drafts.get(plan.requirementId,plan.id).editable)throw new Error('此卡已创建任务，请打开原任务继续');
    if(plan.composition)this.db.prepare('UPDATE output_cards SET title=? WHERE id=?').run(plan.title,plan.id);
    let card = this.db.prepare('SELECT * FROM output_cards WHERE id=?').get(plan.id);
    if (!card) {
      this.db.prepare('INSERT INTO output_cards (id,requirement_id,type,title,node_id,head_version_id,head_sequence,created_at) VALUES (?,?,?,?,?,NULL,0,?)')
        .run(plan.id, plan.requirementId, plan.type, plan.title, plan.adoption?.card.nodeId || `output:${plan.id}`, now);
      if (plan.adoption) {
        const base = plan.adoption.version;
        this.#source(plan.requirementId, base.primaryRef);
        this.db.prepare('INSERT INTO output_card_versions VALUES (?,?,?,?,?,?,?,?,?)')
          .run(base.id, plan.id, 1, base.taskId, null, base.primaryRef, 0, 1, base.createdAt || now);
        this.db.prepare("INSERT INTO output_card_outputs VALUES (?,?,NULL,?,'primary')").run(base.primaryRef, plan.id, base.id);
        this.db.prepare('UPDATE output_cards SET head_version_id=? WHERE id=?').run(base.id, plan.id);
      }
      card = this.db.prepare('SELECT * FROM output_cards WHERE id=?').get(plan.id);
    }
    if (card.requirement_id !== plan.requirementId || card.type !== plan.type) throw new Error('目标产物卡不属于当前需求或类型');
    if (plan.baseVersionId && !this.db.prepare('SELECT id FROM output_card_versions WHERE id=? AND card_id=?').get(plan.baseVersionId, card.id)) throw new Error('修订基准不属于目标卡');
    const sequence = this.db.prepare('SELECT COALESCE(MAX(request_sequence),0)+1 AS n FROM output_card_tasks WHERE card_id=?').get(card.id).n;
    this.db.prepare('INSERT INTO output_card_tasks VALUES (?,?,?,?)').run(taskId, card.id, plan.baseVersionId, sequence);
  }

  /** Called only after real output validation, inside its existing registration transaction. */
  recordOutput(taskId, sourceRef, { primary } = {}) {
    const binding = this.db.prepare('SELECT * FROM output_card_tasks WHERE task_id=?').get(taskId);
    if (!binding) return;
    const card = this.db.prepare('SELECT * FROM output_cards WHERE id=?').get(binding.card_id);
    const [kind, id] = sourceRef.split(':');
    let match = false;
    if (kind === 'artifact') {
      const artifact = this.db.prepare('SELECT * FROM task_files WHERE id=? AND task_id=? AND requirement_id=?').get(id, taskId, card.requirement_id);
      if (!artifact) throw new Error('版本产物不属于当前任务');
      match = card.type === 'text' ? ['text', 'script', 'exercise'].includes(artifact.kind)
        : artifact.kind === card.type;
    } else if (kind === 'outline') {
      if (!this.db.prepare('SELECT version_id FROM task_artifacts WHERE task_id=? AND version_id=?').get(taskId, id)) throw new Error('大纲不属于当前任务');
      match = card.type === 'text';
    } else throw new Error('不支持此卡片主产物类型');
    if (primary !== undefined && typeof primary !== 'boolean') throw new Error('主产物标识必须是布尔值');
    if (primary === true && !match) throw new Error('主产物必须匹配逻辑卡类型，制作资料不能发布正式版本');
    let version = this.db.prepare('SELECT * FROM output_card_versions WHERE task_id=? AND card_id=? AND legacy=0').get(taskId, card.id);
    this.db.prepare('INSERT OR IGNORE INTO output_card_outputs VALUES (?,?,?,?,?)')
      .run(sourceRef, card.id, taskId, version?.id || null, match ? 'attachment' : 'intermediate');
    if (!version && match && primary !== false) {
      const versionId = randomUUID(), now = new Date().toISOString();
      const number = this.db.prepare('SELECT COALESCE(MAX(number),0)+1 AS n FROM output_card_versions WHERE card_id=?').get(card.id).n;
      this.db.prepare('INSERT INTO output_card_versions VALUES (?,?,?,?,?,?,?,?,?)')
        .run(versionId, card.id, number, taskId, binding.base_version_id, sourceRef, binding.request_sequence, 0, now);
      this.db.prepare('UPDATE output_card_outputs SET version_id=? WHERE task_id=? AND card_id=?').run(versionId, taskId, card.id);
      this.db.prepare("UPDATE output_card_outputs SET role='primary' WHERE source_ref=?").run(sourceRef);
      this.db.prepare('UPDATE output_cards SET node_id=COALESCE(node_id,?),head_version_id=?,head_sequence=? WHERE id=? AND head_sequence<=?')
        .run(`output:${card.id}`, versionId, binding.request_sequence, card.id, binding.request_sequence);
    }
  }

  #editor(version, raw) {
    const task = version.taskId ? this.store.tasks.get(version.taskId) : null;
    const input = task?.input;
    const recorded = (['ai', 'media'].includes(task?.kind) || ['slides-publish', 'text-edit', 'document-edit'].includes(input?.workflow)) && Boolean(input?.instruction);
    const nodes = new Map(raw.nodes.map(node => [node.id, node]));
    const references = (input?.sources || []).map(source => {
      const live = nodes.get(source.cardId);
      const ownerRef = source.cardId.startsWith('word:') ? source.cardId.replace('word:', 'outline:') : source.cardId;
      const owner = this.db.prepare('SELECT c.node_id FROM output_card_outputs o JOIN output_cards c ON c.id=o.card_id WHERE o.source_ref=?').get(ownerRef);
      const status = !live ? 'missing' : live.sourceHash !== source.hash ? 'changed'
        : ['missing', 'changed', 'unavailable'].includes(live.status) ? live.status
          : live.sourceStatus && live.sourceStatus !== 'ready' ? live.sourceStatus : 'ready';
      return { ...source, id: source.cardId, sourceId: source.cardId, refId: source.cardId.split(':')[1],
        nodeId: owner?.node_id || source.cardId, sourceHash: source.hash, status, sourceStatus: status, unavailable: status !== 'ready',
        ...(status !== 'ready' ? { referenceNote: '原引用已变化或不可用，冻结正文保留；请显式更换引用，未换成最新版' } : {}) };
    });
    return { instruction: recorded ? input.instruction : '', references, recorded,
      outputType: input?.outputType || (task ? 'outline' : 'text'),
      ...(input?.outputType === 'pptx' ? { pptEngine: input.pptEngine || 'native' } : {}),
      ...(input?.modelSelection ? { modelSelection: { ...input.modelSelection } } : {}),
      selectedSkills: [...(input?.selectedSkills || input?.skills || (input?.skill ? [input.skill] : []))],
      media: input?.media || null, taskId: task?.id || null, sessionId: task?.sessionId || null,
      ...(input?.effectivePrompt ? { effectivePrompt: input.effectivePrompt } : {}),
      ...(!recorded ? { note: '未记录生成提示词' } : {}) };
  }

  #node(card, version, raw) {
    const actual = this.#source(card.requirementId, version.primaryRef, raw);
    const original = raw.nodes.find(node => node.id === card.nodeId);
    const firstTask = this.db.prepare(`SELECT t.input_json FROM output_card_tasks b
      JOIN course_tasks t ON t.id=b.task_id WHERE b.card_id=? ORDER BY b.request_sequence LIMIT 1`).get(card.id);
    const initialPosition = firstTask && JSON.parse(firstTask.input_json).outputPosition;
    const node = { ...actual, id: card.nodeId, sourceId: version.primaryRef,
      position: raw.layoutPositions?.[card.nodeId] || original?.position || initialPosition || actual.position, ...(raw.sizes?.[card.nodeId] || {}), outputCard: { ...card, versionId: version.id, number: version.number } };
    const pending = this.#pendingTask(card.id);
    if (pending) node.pendingGeneration = this.#pendingGeneration(pending);
    if (version.primaryRef.startsWith('outline:')) node.wordPath = this.store.getVersion(actual.refId)?.wordPath || null;
    const annotated = this.store.slides?.annotate(node) || node;
    return this.store.outcomes?.annotate(annotated, version, pending) || annotated;
  }

  #pendingTask(cardId) {
    const binding = this.db.prepare(`SELECT b.task_id FROM output_card_tasks b
      JOIN output_cards c ON c.id=b.card_id
      LEFT JOIN output_card_versions v ON v.task_id=b.task_id AND v.card_id=b.card_id AND v.legacy=0
      WHERE b.card_id=? AND b.request_sequence>c.head_sequence AND v.id IS NULL
      ORDER BY b.request_sequence DESC LIMIT 1`).get(cardId);
    return binding ? this.store.tasks.get(binding.task_id) : null;
  }

  #pendingGeneration(task) {
    const status = task.dispatchStatus || task.status;
    const mediaJob = task.mediaJob;
    let phase = 'unknown', message;
    if (task.kind === 'media' && mediaJob) {
      if (['queued', 'submitting'].includes(mediaJob.status)) phase = 'submitting';
      else if (['accepted', 'processing', 'polling', 'downloading', 'downloaded', 'registering'].includes(mediaJob.status)) phase = 'generating';
      else if (['failed', 'download_failed', 'registration_failed'].includes(mediaJob.status)) phase = 'failed';
      message = mediaJob.error;
    } else if (['draft', 'submitting', 'failed'].includes(status)) phase = status;
    else if (task.runtimeState) ({ phase, message } = task.runtimeState);
    const messages = { draft: '任务已创建，等待发送', submitting: '正在提交生成任务', generating: '内容正在生成',
      'awaiting-input': '等待你确认或补充信息', 'awaiting-approval': '等待授权', idle: '等待继续，请查看执行',
      failed: '生成失败，请查看原任务', unknown: '状态待核对，请查看执行' };
    return { taskId: task.id, outputType: task.input.outputType || 'outline', status, phase,
      message: message || messages[phase], sessionId: task.sessionId,
      ...(task.error || mediaJob?.error ? { error: mediaJob?.error || task.error } : {}),
      ...(mediaJob ? { mediaJob, canResume: Boolean(mediaJob.canResume) } : {}) };
  }

  #pendingNode(card, task, raw) {
    const position = raw.layoutPositions?.[card.nodeId] || task.input.outputPosition || { x: 410, y: 60 };
    const node = { id: card.nodeId, kind: 'generation', title: card.title, position, ...(raw.sizes?.[card.nodeId] || {}),
      outputCard: { ...card, versionId: null }, pendingGeneration: this.#pendingGeneration(task) };
    const annotated = this.store.slides?.annotate(node) || node;
    return this.store.outcomes?.annotate(annotated, null, task) || annotated;
  }

  describeDraft({ requirementId, cardId } = {}) {
    const raw=this.#raw(requirementId), composition=this.drafts.get(requirementId,cardId);
    if(!composition.editable)throw new Error('此草稿已提交，请打开原任务');
    const card=this.#card(this.db.prepare('SELECT * FROM output_cards WHERE id=?').get(cardId));
    return {card,composition,node:this.#draftNode(card,composition,raw)};
  }

  #draftNode(card,composition,raw){
    return {id:card.nodeId,kind:'generation',title:card.title,position:raw.layoutPositions?.[card.nodeId]||composition.position,
      ...(raw.sizes?.[card.nodeId]||{}),outputCard:{...card,versionId:null},composition,
      pendingGeneration:{phase:'composing',message:'填写创作要求后开始生成',outputType:card.type}};
  }

  describePending({ requirementId, cardId } = {}) {
    const raw = this.#raw(requirementId);
    if (typeof cardId !== 'string') throw new Error('产物卡标识无效');
    const row = this.db.prepare('SELECT * FROM output_cards WHERE id=? AND requirement_id=?').get(cardId, requirementId);
    if (!row) throw new Error('产物卡不存在或不属于当前需求');
    const card = this.#card(row), task = this.#pendingTask(card.id);
    if (!task) throw new Error('此卡没有未完成的生成任务，请刷新画布');
    const version = card.versions.find(value => value.id === card.latestVersionId);
    const node = version ? this.#node(card, version, raw) : this.#pendingNode(card, task, raw);
    return { card, node, task, pendingGeneration: node.pendingGeneration };
  }

  describe({ requirementId, cardId, versionId } = {}) {
    const raw = this.#raw(requirementId);
    if (typeof cardId !== 'string') throw new Error('产物卡标识无效');
    const row = this.db.prepare('SELECT * FROM output_cards WHERE id=? AND requirement_id=?').get(cardId, requirementId);
    let card, version;
    if (!row) {
      const virtual = this.#virtual(requirementId, cardId, raw);
      ({ card, version } = virtual);
      if (versionId && versionId !== version.id) throw new Error('历史版本不存在或不属于当前卡');
    } else {
      card = this.#card(row);
      version = card.versions.find(value => value.id === (versionId || card.latestVersionId));
      if (!version) throw new Error('此卡尚无成功产物或所选历史版本不存在');
    }
    return { card, version, node: this.#node(card, version, raw), editor: this.#editor(version, raw),
      provenanceEdges: raw.edges.filter(edge => edge.provenance && edge.target === version.primaryRef) };
  }

  project(raw) {
    const cards = this.db.prepare('SELECT * FROM output_cards WHERE requirement_id=?').all(raw.requirementId);
    const outputs = this.db.prepare('SELECT o.* FROM output_card_outputs o JOIN output_cards c ON c.id=o.card_id WHERE c.requirement_id=?').all(raw.requirementId);
    const hidden = new Set(outputs.map(output => output.source_ref));
    for (const output of outputs) if (output.source_ref.startsWith('outline:')) {
      const version = output.version_id && this.db.prepare('SELECT legacy FROM output_card_versions WHERE id=?').get(output.version_id);
      if (!version?.legacy) hidden.add(output.source_ref.replace('outline:', 'word:'));
    }
    const nodes = raw.nodes.filter(node => !hidden.has(node.id)).map(node => {
      if (node.kind === 'material' && !/\.(csv|docx|pdf)$/i.test(node.importedFile?.name || '')) return node;
      if (!REF.test(node.id)) return node;
      const { card, version } = this.#virtual(raw.requirementId, legacyId(node.id), raw);
      return { ...node, sourceId: node.id, outputCard: { ...card, versionId: version.id, number: 1 } };
    });
    const visible = new Map();
    for (const row of cards) {
      const card = this.#card(row), version = card.versions.find(value => value.id === row.head_version_id);
      if (version) nodes.push(this.#node(card, version, raw));
      else {
        const task = this.#pendingTask(card.id);
        if (!task) {
          if(!this.db.prepare('SELECT 1 FROM output_card_drafts WHERE card_id=?').get(card.id))continue;
          nodes.push(this.#draftNode(card,this.drafts.get(raw.requirementId,card.id),raw));
        } else nodes.push(this.#pendingNode(card, task, raw));
      }
      visible.set(card.id, card);
    }
    const owners = new Map(outputs.map(output => [output.source_ref, output]));
    const known = new Set(nodes.map(node => node.id)), edges = [];
    for (const edge of raw.edges) {
      const targetOwner = owners.get(edge.target), sourceOwner = owners.get(edge.source);
      const targetCard = targetOwner && visible.get(targetOwner.card_id), sourceCard = sourceOwner && visible.get(sourceOwner.card_id);
      if (edge.provenance && targetOwner && targetOwner.version_id !== targetCard?.latestVersionId) continue;
      const source = sourceCard?.nodeId || edge.source, target = targetCard?.nodeId || edge.target;
      if (source === target || !known.has(source) || !known.has(target)) continue;
      edges.push({ ...edge, source, target, ...(source !== edge.source || target !== edge.target ? { sourceRef: edge.source, targetRef: edge.target } : {}) });
    }
    for(const node of nodes){
      if(node.outputCard?.latestVersionId || node.kind!=='generation')continue;
      const task=node.pendingGeneration?.taskId&&this.store.tasks.get(node.pendingGeneration.taskId);
      const refs=task?.input?.sources?.map(source=>source.cardId)||node.composition?.references.map(source=>source.id)||[];
      for(const ref of refs){const source=owners.get(ref);const sourceId=source&&visible.get(source.card_id)?.nodeId||ref;
        if(sourceId===node.id||!known.has(sourceId)||edges.some(edge=>edge.source===sourceId&&edge.target===node.id))continue;
        edges.push({id:`draft-source:${ref}:${node.id}`,source:sourceId,target:node.id,sourceRef:ref,provenance:true});
      }
    }
    const { layoutPositions: _positions, ...board } = raw;
    return { ...board, nodes, edges };
  }
}
