import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BaoyuRuntime } from './baoyu-runtime.mjs';
import { validateArtifact } from './artifact-validation.mjs';
import { slideCoverIdentity, renderSlideCover } from './slide-cover.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const requireId = value => { if (!uuid(value)) throw new Error('课件工程标识无效'); return value; };
const titleOf = title => {
  let value = String(title || '课程课件').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '');
  while (Buffer.byteLength(value) > 180) value = Array.from(value).slice(0, -1).join('');
  return value || '课程课件';
};

/** An engineering snapshot excludes the editor's grants, history, comments and server state. */
export function slideTree(root) {
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('课件工程目录不能使用符号链接');
  const files = []; let total = 0;
  function visit(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name, file = path.join(directory, entry.name), info = lstatSync(file);
      if (info.isSymbolicLink()) throw new Error(`课件工程不允许符号链接：${relative}`);
      if (entry.name === '.DS_Store') continue;
      if (info.isDirectory()) visit(file, relative + '/');
      else {
        if (!info.isFile() || (total += info.size) > 200 * 1024 * 1024 || files.length >= 5000) throw new Error('课件工程超限或含特殊文件（最多 5000 文件、200 MiB）');
        files.push({ path: relative, hash: sha(readFileSync(file)), bytes: info.size });
      }
    }
  }
  visit(root);
  const deck = JSON.parse(readFileSync(path.join(root, 'deck.json'), 'utf8'));
  if (deck.v !== 4 || !Array.isArray(deck.order) || !deck.order.length || deck.order.length > 1000
    || new Set(deck.order).size !== deck.order.length || deck.order.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)
      || !files.some(file => file.path === `slides/${id}.html`))) throw new Error('宝玉工程必须包含有效 v4 deck.json 与实际幻灯片');
  return { hash: sha(JSON.stringify(files)), files, title: titleOf(deck.title), pages: deck.order.length };
}
function insideDirectory(workspace, relative, create = false) {
  const target = path.resolve(workspace, relative);
  if (!target.startsWith(workspace + path.sep) || path.relative(workspace, target) !== relative || relative.includes('\\')) throw new Error('课件工程路径越出项目');
  let current = workspace;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (!existsSync(current) && create) mkdirSync(current);
    if (realpathSync(current) !== current || !lstatSync(current).isDirectory()) throw new Error('课件工程目录或父目录不能是链接');
  }
  return target;
}
function copyTree(source, destination, tree) {
  for (const entry of tree.files) {
    const from = path.join(source, entry.path), to = path.join(destination, entry.path);
    // The source can be edited by an external process while a snapshot is copied.
    if (realpathSync(from) !== from || sha(readFileSync(from)) !== entry.hash) throw new Error('复制期间课件工程已变化，未保存版本');
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to, 1);
    if (sha(readFileSync(to)) !== entry.hash) throw new Error('工程快照校验失败');
  }
  if (slideTree(source).hash !== tree.hash || slideTree(destination).hash !== tree.hash) throw new Error('复制期间工程发生变化，未保存版本');
}

export class SlideProjects {
  constructor(service, config = {}) {
    this.service = service; this.store = service.store; this.db = this.store.db;
    this.errors = new Map(); this.publishing = new Map(); this.closed = false;
    this.deliverComments = config.deliverSlideComments;
    this.runtime = new BaoyuRuntime({ ...config,
      recordSlideExport: (root, receipt) => this.recordExport(root, receipt),
      deliverSlideComments: config.deliverSlideComments ? (sessionId, message, root) => this.queueComments(sessionId, message, root) : undefined,
      onSlideCommentError: (root, error) => this.errors.set(root, error) });
    this.db.exec(`CREATE TABLE IF NOT EXISTS slide_projects (
      id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL REFERENCES canvas_spaces(id),
      task_id TEXT NOT NULL REFERENCES course_tasks(id), card_id TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
      base_version_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS slide_project_versions (
      artifact_id TEXT PRIMARY KEY REFERENCES task_files(id), project_id TEXT NOT NULL REFERENCES slide_projects(id),
      snapshot_path TEXT NOT NULL, tree_hash TEXT NOT NULL, files_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS slide_publish_intents (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES slide_projects(id), base_version_id TEXT,
      tree_hash TEXT NOT NULL, baseline_json TEXT NOT NULL, artifact_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS slide_export_receipts (root_path TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(root_path,name));
      CREATE TABLE IF NOT EXISTS slide_comment_outbox (id TEXT PRIMARY KEY, root_path TEXT NOT NULL, session_id TEXT NOT NULL, payload_json TEXT NOT NULL, delivered_at TEXT, error TEXT);`);
  }
  recordExport(root, receipt) {
    const relative = path.relative(this.store.workspaceRoot, root), row = this.db.prepare('SELECT * FROM slide_projects WHERE root_path=?').get(relative);
    if (!row || this.#root(row) !== root || typeof receipt.name !== 'string' || path.basename(receipt.name) !== receipt.name
      || receipt.path !== path.join(root, 'exports', receipt.name) || !receipt.name.toLowerCase().endsWith('.pptx')) throw new Error('导出回执与受管工程不匹配');
    const entry = this.#exports(root).find(item => item.name === receipt.name);
    if (!entry || lstatSync(receipt.path).size !== receipt.bytes) throw new Error('导出文件与完成回执不一致');
    this.db.prepare('INSERT INTO slide_export_receipts VALUES (?,?,?,?) ON CONFLICT(root_path,name) DO UPDATE SET hash=excluded.hash,created_at=excluded.created_at')
      .run(relative, entry.name, entry.hash, new Date().toISOString());
  }
  async queueComments(sessionId, message, root) {
    const relative = path.relative(this.store.workspaceRoot, root), row = this.db.prepare('SELECT * FROM slide_projects WHERE root_path=?').get(relative);
    if (!row || this.service.tasks.get(row.task_id).sessionId !== sessionId) throw new Error('批注不属于绑定课程任务');
    this.db.prepare('INSERT OR IGNORE INTO slide_comment_outbox VALUES (?,?,?,?,NULL,NULL)').run(message.id, relative, sessionId, JSON.stringify(message));
    await this.retryComments({ projectId: row.id, requirementId: row.requirement_id });
  }
  async retryComments({ projectId, requirementId }) {
    const row = this.#row(projectId, requirementId);
    this.errors.delete(this.#root(row));
    this.runtime.watch(this.#root(row), this.service.tasks.get(row.task_id).sessionId);
    for (const pending of this.db.prepare('SELECT * FROM slide_comment_outbox WHERE root_path=? AND delivered_at IS NULL ORDER BY rowid').all(row.root_path)) {
      try {
        if (!this.deliverComments) throw new Error('批注会话连接不可用');
        await this.deliverComments(pending.session_id, JSON.parse(pending.payload_json), this.#root(row));
        if (this.closed) return;
        this.db.prepare('UPDATE slide_comment_outbox SET delivered_at=?,error=NULL WHERE id=?').run(new Date().toISOString(), pending.id);
      } catch (error) {
        if (this.closed) return;
        this.db.prepare('UPDATE slide_comment_outbox SET error=? WHERE id=?').run(error.message, pending.id);
        break;
      }
    }
    return this.status({ projectId, requirementId });
  }
  status({ projectId, requirementId }) {
    const row = this.#row(projectId, requirementId), pending = this.db.prepare('SELECT error FROM slide_comment_outbox WHERE root_path=? AND delivered_at IS NULL ORDER BY rowid').all(row.root_path);
    return { projectId: row.id, pendingComments: pending.length,
      ...(pending.find(item => item.error)?.error || this.errors.get(this.#root(row)) ? { commentError: pending.find(item => item.error)?.error || this.errors.get(this.#root(row)) } : {}) };
  }
  capability() {
    try { const runtime = this.runtime.resolve(); return { available: true, skills: ['claude-slides'], skillPath: runtime.skill }; }
    catch (error) { return { available: false, message: error.message }; }
  }
  rootForTask(task) { return `courses/${task.requirementId}/tasks/${task.id}/working/slides`; }
  #root(row) { return insideDirectory(this.store.workspaceRoot, row.root_path); }
  #row(projectId, requirementId) {
    const row = this.db.prepare('SELECT * FROM slide_projects WHERE id=? AND requirement_id=?').get(requireId(projectId), requireId(requirementId));
    if (!row) throw new Error('课件工程不属于当前需求／项目');
    return row;
  }
  #value(row) {
    const task = this.service.tasks.get(row.task_id);
    return { id: row.id, requirementId: row.requirement_id, taskId: row.task_id, cardId: row.card_id,
      baseVersionId: row.base_version_id, rootPath: row.root_path, sessionId: task.sessionId,
      ...(this.errors.has(this.#root(row)) ? { commentError: this.errors.get(this.#root(row)) } : {}) };
  }
  #base(row, versionId = row.base_version_id) {
    if (!versionId) return null;
    const described = this.service.cards.describe({ requirementId: row.requirement_id, cardId: row.card_id, versionId });
    const artifactId = described.version.primaryRef?.startsWith('artifact:') && described.version.primaryRef.slice(9);
    const saved = artifactId && this.db.prepare('SELECT * FROM slide_project_versions WHERE artifact_id=?').get(artifactId);
    if (!saved) throw new Error('该版本没有宝玉工程；旧 PPTX 请使用原编辑器');
    if (this.service.tasks.files.get(artifactId).status !== 'ready') throw new Error('基础版本 PPTX 已缺失或被外部修改，请核对原文件');
    const source = insideDirectory(this.store.workspaceRoot, saved.snapshot_path), tree = slideTree(source);
    if (tree.hash !== saved.tree_hash) throw new Error('已保存课件工程被外部修改，不能建立编辑草稿');
    return { saved, source, tree };
  }
  sourceForArtifact(artifactId) {
    const saved = this.db.prepare('SELECT * FROM slide_project_versions WHERE artifact_id=?').get(requireId(artifactId));
    if (!saved) return null;
    const version = this.db.prepare('SELECT id FROM output_card_versions WHERE primary_ref=?').get(`artifact:${artifactId}`);
    const row = this.db.prepare('SELECT * FROM slide_projects WHERE id=?').get(saved.project_id);
    if (!version || !row) throw new Error('宝玉工程版本关联已缺失');
    this.#base(row, version.id);
    return { path: saved.snapshot_path, hash: saved.tree_hash };
  }
  async attach({ taskId, sessionId }) {
    const task = this.service.tasks.get(requireId(taskId));
    if (task.kind !== 'ai' || !sessionId || task.sessionId !== sessionId || task.input.pptEngine !== 'baoyu'
      || task.input.outputType !== 'pptx' || !task.outputCardId) throw new Error('工程必须由已绑定的宝玉 PPT 任务原会话登记');
    const relative = this.rootForTask(task), root = insideDirectory(this.store.workspaceRoot, relative);
    const tree = slideTree(path.join(root, 'project'));
    await this.runtime.run(['check', root]);
    if (slideTree(path.join(root, 'project')).hash !== tree.hash) throw new Error('工程检查期间文件已变化');
    let row = this.db.prepare('SELECT * FROM slide_projects WHERE root_path=?').get(relative);
    if (!row) {
      const id = randomUUID();
      this.db.prepare('INSERT INTO slide_projects VALUES (?,?,?,?,?,?,?)').run(id, task.requirementId, task.id, task.outputCardId,
        relative, task.baseCardVersionId || null, new Date().toISOString());
      row = this.#row(id, task.requirementId);
    }
    return { project: this.#value(row), title: tree.title, pages: tree.pages, status: '工程已就绪，待编辑或导出保存' };
  }
  annotate(node) {
    let row;
    if (node.refId && node.kind === 'artifact') {
      const version = this.db.prepare('SELECT * FROM slide_project_versions WHERE artifact_id=?').get(node.refId);
      if (version) row = this.db.prepare('SELECT * FROM slide_projects WHERE id=?').get(version.project_id);
    }
    if (!row && node.pendingGeneration?.taskId) row = this.db.prepare('SELECT * FROM slide_projects WHERE task_id=? ORDER BY created_at LIMIT 1').get(node.pendingGeneration.taskId);
    if (!row) return node;
    let cover;
    try { const identity = slideCoverIdentity(path.join(this.#root(row), 'project')); cover = { coverRevision: identity.revision, pageCount: identity.deck.order.length }; }
    catch (error) { cover = { coverError: error.message }; }
    return { ...node, slideProject: { ...this.#value(row), ...cover, ...(node.kind === 'artifact' ? { artifactId: node.refId, artifactHash: node.sourceHash, versionId: node.outputCard?.versionId } : {}) } };
  }
  cover({ projectId, requirementId, revision }) {
    const row = this.#row(projectId, requirementId), root = path.join(this.#root(row), 'project');
    const tree = slideTree(root), cover = renderSlideCover(root, tree, revision);
    if (slideTree(root).hash !== tree.hash) throw new Error('读取期间工程已变化，请重新读取');
    return { projectId: row.id, ...cover };
  }
  async open({ projectId, requirementId, versionId }, parentOrigin) {
    let row = this.#row(projectId, requirementId);
    const base = versionId ? this.#base(row, versionId) : null;
    if (versionId && row.base_version_id !== versionId) {
      const existing = this.db.prepare('SELECT * FROM slide_projects WHERE card_id=? AND base_version_id=? ORDER BY created_at DESC LIMIT 1').get(row.card_id, versionId);
      if (existing) row = existing;
      else {
        const id = randomUUID(), relative = `courses/${requirementId}/tasks/${row.task_id}/working/slides-${id}`;
        const { source, tree } = base;
        const root = insideDirectory(this.store.workspaceRoot, relative, true);
        const destination = insideDirectory(root, 'project', true);
        copyTree(source, destination, tree);
        this.db.prepare('INSERT INTO slide_projects VALUES (?,?,?,?,?,?,?)').run(id, requirementId, row.task_id, row.card_id, relative, versionId, new Date().toISOString());
        row = this.#row(id, requirementId);
      }
    }
    const root = this.#root(row), tree = slideTree(path.join(root, 'project'));
    const editor = await this.runtime.open(root, parentOrigin, this.service.tasks.get(row.task_id).sessionId);
    return { project: this.#value(row), editor, title: tree.title, pages: tree.pages };
  }
  #exports(root) {
    const directory = path.join(root, 'exports');
    if (!existsSync(directory)) return [];
    if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) throw new Error('导出目录不能使用链接');
    return readdirSync(directory).filter(name => name.toLowerCase().endsWith('.pptx')).map(name => {
      const file = path.join(directory, name), info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 200 * 1024 * 1024 || !info.size) throw new Error('PPTX 导出文件不可用或超过 200 MiB');
      return { name, hash: sha(readFileSync(file)) };
    });
  }
  preparePublish({ projectId, requirementId, operationId }) {
    const row = this.#row(projectId, requirementId); requireId(operationId);
    const existing = this.db.prepare('SELECT * FROM slide_publish_intents WHERE id=?').get(operationId);
    if (existing) {
      if (existing.project_id !== row.id) throw new Error('保存操作标识已用于其他工程');
      return { intentId: operationId, saved: Boolean(existing.artifact_id) };
    }
    this.#base(row);
    const root = this.#root(row), tree = slideTree(path.join(root, 'project'));
    this.db.prepare('INSERT INTO slide_publish_intents VALUES (?,?,?,?,?,NULL,?)').run(operationId, row.id, row.base_version_id, tree.hash,
      JSON.stringify(this.#exports(root)), new Date().toISOString());
    return { intentId: operationId, treeHash: tree.hash };
  }
  async publish(input, { signal, timeout = 120_000 } = {}) {
    const row = this.#row(input.projectId, input.requirementId), intent = this.db.prepare('SELECT * FROM slide_publish_intents WHERE id=? AND project_id=?').get(requireId(input.intentId), row.id);
    if (!intent) throw new Error('请先准备当前工程的导出保存');
    if (intent.artifact_id) return this.#result(intent.artifact_id);
    if (this.publishing.has(intent.id)) return this.publishing.get(intent.id);
    const operation = this.#publish(row, intent, { signal, timeout }).finally(() => this.publishing.delete(intent.id));
    this.publishing.set(intent.id, operation); return operation;
  }
  async #publish(row, intent, { signal, timeout }) {
    this.#base(row, intent.base_version_id);
    const root = this.#root(row), directory = path.join(root, 'project'), started = Date.now(), baseline = JSON.parse(intent.baseline_json);
    const unchanged = () => {
      if (this.closed || this.store.closed) throw new Error('工作台已关闭，未保存课件');
      if (slideTree(directory).hash !== intent.tree_hash || this.#row(row.id, row.requirement_id).base_version_id !== intent.base_version_id) throw new Error('导出期间草稿或基础版本已变化，请重新保存');
    };
    let candidate;
    do {
      signal?.throwIfAborted(); unchanged();
      const fresh = this.#exports(root).filter(file => !baseline.some(old => old.name === file.name && old.hash === file.hash));
      if (fresh.length > 1) throw new Error('检测到多份新导出，无法确定对应关系；请重新导出保存');
      candidate = fresh.find(file => this.db.prepare('SELECT hash FROM slide_export_receipts WHERE root_path=? AND name=?').get(row.root_path, file.name)?.hash === file.hash);
      if (!candidate) await delay(400, undefined, { signal });
    } while (!candidate && Date.now() - started < timeout);
    if (!candidate) throw new Error('等待宝玉导出超时；请确认编辑器已加载且支持 PowerPoint 导出后重试');
    const tree = slideTree(directory), bytes = readFileSync(path.join(root, 'exports', candidate.name));
    if (sha(bytes) !== candidate.hash) throw new Error('导出文件读取期间发生变化');
    const { mime, validation } = await validateArtifact('pptx', candidate.name, bytes, { pythonExecutable: this.service.python, pptSkillDir: this.service.pptSkillDir });
    unchanged(); this.#base(row, intent.base_version_id); signal?.throwIfAborted();
    const taskId = randomUUID(), artifactId = randomUUID(), now = new Date().toISOString();
    const targetRoot = insideDirectory(this.store.workspaceRoot, `courses/${row.requirement_id}/tasks/${taskId}/delivery`, true);
    const engineering = insideDirectory(targetRoot, '课件工程/project', true);
    copyTree(directory, engineering, tree);
    const pptx = path.join(targetRoot, `${tree.title}.pptx`);
    writeFileSync(pptx, bytes, { flag: 'wx', mode: 0o600 });
    writeFileSync(path.join(targetRoot, `${tree.title}.editability.json`), JSON.stringify({ ...validation.editability,
      pptx: path.relative(this.store.workspaceRoot, pptx), sha256: candidate.hash, checkedAt: validation.checkedAt }, null, 2), { flag: 'wx', mode: 0o600 });
    const origin = this.service.tasks.get(row.task_id), fingerprint = sha(JSON.stringify({ project: row.id, intent: intent.id, hash: tree.hash }));
    const snapshot = { ...origin.input, workflow: 'slides-publish', pptEngine: 'baoyu', instruction: origin.instruction,
      slideProject: { id: row.id, originTaskId: row.task_id, treeHash: tree.hash }, baseCardVersionId: intent.base_version_id };
    unchanged();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT artifact_id FROM slide_publish_intents WHERE id=?').get(intent.id).artifact_id) throw new Error('该导出已保存，请刷新版本');
      this.db.prepare("INSERT INTO course_tasks VALUES (?,?,?,?,?,?,?,NULL,'output',NULL,?,?)").run(taskId, row.requirement_id, 'manual', '宝玉课件 · 保存版本', origin.instruction,
        JSON.stringify(snapshot), null, now, now);
      this.store.cards.attach(taskId, { id: row.card_id, requirementId: row.requirement_id, type: 'pptx', title: tree.title, baseVersionId: intent.base_version_id });
      this.db.prepare('INSERT INTO task_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(artifactId, row.requirement_id, taskId, 'pptx', tree.title,
        path.relative(this.store.workspaceRoot, pptx), candidate.hash, bytes.length, mime, JSON.stringify(validation), JSON.stringify((origin.input.sources || []).map(source => source.cardId)), now);
      this.db.prepare('INSERT INTO slide_project_versions VALUES (?,?,?,?,?)').run(artifactId, row.id, path.relative(this.store.workspaceRoot, engineering), tree.hash, JSON.stringify(tree.files));
      this.store.cards.recordOutput(taskId, `artifact:${artifactId}`, { primary: true });
      const binding = this.store.cards.binding(taskId);
      this.db.prepare('UPDATE slide_projects SET base_version_id=? WHERE id=?').run(binding.cardVersionId, row.id);
      this.db.prepare('UPDATE slide_publish_intents SET artifact_id=? WHERE id=?').run(artifactId, intent.id);
      this.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(intent.id, 'publish-slides', fingerprint, artifactId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.#result(artifactId);
  }
  #result(artifactId) {
    const artifact = this.service.tasks.files.get(artifactId);
    this.store.outputSaved?.(artifact.requirementId);
    let deliveryWarning;
    try { this.syncEngineering(artifactId); } catch (error) { deliveryWarning = error.message; }
    const current = this.service.tasks.files.get(artifactId);
    return { artifact: current, binding: this.store.cards.binding(current.taskId),
      descriptor: this.service.cards.describe({ requirementId: current.requirementId, cardId: this.store.cards.binding(current.taskId).outputCardId, versionId: this.store.cards.binding(current.taskId).cardVersionId }),
      ...(deliveryWarning ? { deliveryWarning } : {}), engineeringPath: this.db.prepare('SELECT snapshot_path FROM slide_project_versions WHERE artifact_id=?').get(artifactId).snapshot_path };
  }
  syncEngineering(artifactId) {
    const saved = this.db.prepare('SELECT * FROM slide_project_versions WHERE artifact_id=?').get(artifactId);
    if (!saved) return;
    const delivered = this.service.deliverables.info(`artifact:${artifactId}`);
    if (!delivered || delivered.status !== 'ready') throw new Error('PPT 已保存，但同名产物目录不可用；请先整理产物目录');
    const destination = insideDirectory(this.store.workspaceRoot, path.join(path.dirname(delivered.path), '课件工程/project'), true);
    const source = insideDirectory(this.store.workspaceRoot, saved.snapshot_path), tree = slideTree(source);
    if (tree.hash !== saved.tree_hash) throw new Error('正式工程快照被外部修改，未整理副本');
    if (existsSync(path.join(destination, 'deck.json'))) {
      if (slideTree(destination).hash !== tree.hash) throw new Error('产物目录内课件工程已被外部修改，保留现状');
    } else copyTree(source, destination, tree);
  }
  close() { this.closed = true; this.runtime.close(); }
}
