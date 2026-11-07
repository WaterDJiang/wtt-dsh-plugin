import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { TaskStore } from './task-store.mjs';
import { OutputCardStore } from './output-card-store.mjs';
import { initializeCanvasSchema } from './canvas-schema.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (value) => createHash('sha256').update(value).digest('hex');

function text(value, name, max = 20_000) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) {
    throw new Error(`${name}必须是长度不超过 ${max} 的文本`);
  }
  return value;
}

function entityId(value, name) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${name}无效`);
  return value.toLowerCase();
}

function managedDirectory(directory) {
  try {
    mkdirSync(directory);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`工作台目录不可用：${directory}`);
}

function versionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id, requirementId: row.requirement_id, number: row.number,
    markdown: row.markdown, markdownPath: row.markdown_path,
    hash: row.hash, wordPath: row.word_path, createdAt: row.created_at,
    sourceCardIds: JSON.parse(row.source_card_ids || '[]'),
  };
}

/** One selected folder owns one business database and its versioned artifacts. */
export class WorkbenchStore {
  constructor(workspaceRoot) {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) throw new Error('请指定工作目录');
    mkdirSync(path.resolve(workspaceRoot), { recursive: true });
    this.workspaceRoot = realpathSync(path.resolve(workspaceRoot));
    const metadata = path.join(this.workspaceRoot, '.wtt-workbench');
    managedDirectory(metadata);
    this.databasePath = path.join(metadata, 'workbench.sqlite');
    if (existsSync(this.databasePath) && lstatSync(this.databasePath).isSymbolicLink()) {
      throw new Error('工作台数据库不能是符号链接');
    }
    this.db = new DatabaseSync(this.databasePath);
    this.closed = false;
    try {
      this.db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = 5000;
      `);
      initializeCanvasSchema(this.db, metadata);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS outline_versions (
          id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL REFERENCES canvas_spaces(id),
          number INTEGER NOT NULL CHECK(number > 0), markdown TEXT NOT NULL,
          markdown_path TEXT NOT NULL UNIQUE, hash TEXT NOT NULL,
          word_path TEXT, created_at TEXT NOT NULL,
          UNIQUE(requirement_id, number)
        );
        CREATE TABLE IF NOT EXISTS operations (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, input_hash TEXT NOT NULL, result_id TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS requirement_entry_modes (
          requirement_id TEXT PRIMARY KEY REFERENCES canvas_spaces(id), mode TEXT NOT NULL
        );
      `);
      if (!this.db.prepare('PRAGMA table_info(outline_versions)').all().some((column) => column.name === 'source_card_ids')) {
        this.db.exec("ALTER TABLE outline_versions ADD COLUMN source_card_ids TEXT NOT NULL DEFAULT '[]'");
      }
      this.tasks = new TaskStore(this);
      this.cards = new OutputCardStore(this);
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  #transaction(action) {
    if (this.closed) throw new Error('工作台已关闭');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  #replay(operationId, kind, inputHash) {
    const old = this.db.prepare('SELECT * FROM operations WHERE id = ?').get(operationId);
    if (old && (old.kind !== kind || old.input_hash !== inputHash)) {
      throw new Error('操作标识已用于不同内容，请保留输入后重新提交');
    }
    return old?.result_id;
  }

  #record(operationId, kind, inputHash, resultId) {
    this.db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?)').run(operationId, kind, inputHash, resultId);
  }

  createCanvas(input = {}) {
    const operationId = entityId(input.operationId, '操作标识');
    const title = text(input.title, '画布名称', 200).trim();
    const inputHash = hash(JSON.stringify({ title }));
    const id = this.#transaction(() => {
      const replayed = this.#replay(operationId, 'create-canvas', inputHash);
      if (replayed) return replayed;
      const id = this.#insertCanvas(title);
      this.#record(operationId, 'create-canvas', inputHash, id);
      return id;
    });
    return this.getCanvas(id);
  }

  #insertCanvas(title) {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM canvas_spaces').get().count;
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare('INSERT INTO canvas_spaces VALUES (?,?,?,?,?,?,?,?)')
      .run(id, title || (count ? `画布 ${count + 1}` : '主画布'), '', '', '', '', now, now);
    this.db.prepare("INSERT INTO canvas_metadata VALUES (?,'canvas')").run(id);
    return id;
  }

  ensureDefaultCanvas() {
    const id = this.#transaction(() => this.db.prepare('SELECT id FROM canvas_spaces ORDER BY updated_at DESC,id LIMIT 1').get()?.id || this.#insertCanvas('主画布'));
    return this.getCanvas(id);
  }

  getCanvas(id) { return this.getRequirement(id); }
  listCanvases() { return this.listRequirements(); }
  renameCanvas(input) { return this.renameRequirement({ ...input, requirementId: input.canvasId }); }

  saveCanvasBackground(input) {
    const id = entityId(input?.canvasId, '画布标识');
    const operationId = entityId(input.operationId, '操作标识');
    const background = text(input.background, '背景信息', 30_000);
    const expected = text(input.expectedBackground, '原背景信息', 30_000);
    const inputHash = hash(JSON.stringify({ id, background, expected }));
    this.#transaction(() => {
      if (this.#replay(operationId, 'save-canvas-background', inputHash)) return;
      const current = this.getCanvas(id);
      if (!current) throw new Error('画布不存在');
      if (current.background !== expected) throw new Error('背景信息已变化，请重新打开后修改');
      this.db.prepare('UPDATE canvas_spaces SET background=?,updated_at=? WHERE id=?').run(background,new Date().toISOString(),id);
      this.#record(operationId, 'save-canvas-background', inputHash, id);
    });
    return this.getCanvas(id);
  }

  createRequirement(input) {
    const operationId = entityId(input?.operationId, '操作标识');
    const backgroundOnly = input.title === undefined;
    const background = text(input.background, '需求背景', backgroundOnly ? 30_000 : 20_000);
    if (backgroundOnly && !background.trim()) throw new Error('请填写背景信息');
    const firstSentence = background.trim().split(/[。！？!?\r\n]|[.](?=\s|$)/u)[0].trim() || background.trim();
    const data = {
      title: backgroundOnly ? [...firstSentence].slice(0, 40).join('') : text(input.title, '需求标题', 200).trim(),
      customer: text(input.customer, '客户名称', 500),
      audience: text(input.audience, '学员背景'),
      background,
      objectives: text(input.objectives, '课程目标'),
    };
    if (!data.title) throw new Error('请填写需求标题');
    const inputHash = hash(JSON.stringify({ ...data, ...(backgroundOnly ? { backgroundOnly: true } : {}) }));
    const id = this.#transaction(() => {
      const replayed = this.#replay(operationId, 'create-requirement', inputHash);
      if (replayed) return replayed;
      const newId = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO requirements VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(newId, data.title, data.customer, data.audience, data.background, data.objectives, now, now);
      if (backgroundOnly) this.db.prepare("INSERT INTO requirement_entry_modes VALUES (?,'background-only')").run(newId);
      this.#record(operationId, 'create-requirement', inputHash, newId);
      return newId;
    });
    return this.getRequirement(id);
  }

  renameRequirement(input) {
    const requirementId = entityId(input?.requirementId, '需求标识');
    const operationId = entityId(input.operationId, '操作标识');
    const title = text(input.title, '需求标题', 200).trim();
    if (!title) throw new Error('请填写需求标题');
    const inputHash = hash(JSON.stringify({ requirementId, title }));
    const result = this.#transaction(() => {
      const replayed = this.#replay(operationId, 'rename-requirement', inputHash);
      if (replayed) return replayed;
      if (!this.db.prepare('SELECT id FROM requirements WHERE id=?').get(requirementId)) throw new Error('需求不存在');
      this.db.prepare('UPDATE requirements SET title=?,updated_at=? WHERE id=?').run(title, new Date().toISOString(), requirementId);
      this.#record(operationId, 'rename-requirement', inputHash, requirementId);
      return requirementId;
    });
    return this.getRequirement(result);
  }

  listRequirements() {
    if (this.closed) throw new Error('工作台已关闭');
    return this.db.prepare('SELECT id FROM requirements ORDER BY updated_at DESC, id').all()
      .map(({ id }) => this.getRequirement(id));
  }

  getRequirement(id) {
    id = entityId(id, '需求标识');
    if (this.closed) throw new Error('工作台已关闭');
    const row = this.db.prepare('SELECT * FROM requirements WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: row.id, canvasId: row.id, scopeKind: 'canvas', origin: this.db.prepare('SELECT origin FROM canvas_metadata WHERE canvas_id=?').get(id)?.origin || 'legacy-requirement', title: row.title, customer: row.customer, audience: row.audience,
      background: row.background, objectives: row.objectives,
      ...(this.db.prepare("SELECT 1 FROM requirement_entry_modes WHERE requirement_id=? AND mode='background-only'").get(id) ? { backgroundOnly: true } : {}),
      createdAt: row.created_at, updatedAt: row.updated_at,
      versions: this.db.prepare('SELECT * FROM outline_versions WHERE requirement_id = ? ORDER BY number DESC')
        .all(id).map(versionFromRow),
    };
  }

  saveOutline(input) {
    if (input?.primary !== undefined && typeof input.primary !== 'boolean') throw new Error('主产物标识必须是布尔值');
    const requirementId = entityId(input?.requirementId, '需求标识');
    const operationId = entityId(input.operationId, '操作标识');
    const markdown = text(input.markdown, '大纲正文', 1_048_576);
    if (!markdown.trim()) throw new Error('请填写大纲正文');
    if (Buffer.byteLength(markdown, 'utf8') > 1_048_576) throw new Error('大纲正文不能超过 1 MB');
    const contentHash = hash(markdown);
    if (input.sourceCardIds !== undefined && (!Array.isArray(input.sourceCardIds) || input.sourceCardIds.length > 200)) {
      throw new Error('来源卡片必须是至多 200 项的数组');
    }
    const sourceCardIds = [...new Set(input.sourceCardIds || [])].sort();
    const taskId = input.taskId === undefined ? null : entityId(input.taskId, '任务标识');
    const baseVersionId = input.baseVersionId === undefined ? null : entityId(input.baseVersionId, '基准版本标识');
    if (input.manualGeneration && !baseVersionId) throw new Error('同卡人工修订必须指定大纲基准版本');
    if (taskId && baseVersionId) throw new Error('AI 创作任务与人工修订基准不能同时提交');
    const inputHash = hash(JSON.stringify({ requirementId, markdown, ...(sourceCardIds.length ? { sourceCardIds } : {}),
      ...(taskId ? { taskId } : {}), ...(baseVersionId ? { baseVersionId } : {}),
      ...(input.primary === undefined ? {} : { primary: input.primary }),
      ...(input.manualGeneration ? { manualGeneration: input.manualGeneration } : {}) }));
    let createdFile;
    let createdDirectory;
    let committed = false;
    try {
      const resultId = this.#transaction(() => {
        const replayed = this.#replay(operationId, 'save-outline', inputHash);
        if (replayed) return replayed;
        if (!this.db.prepare('SELECT id FROM requirements WHERE id = ?').get(requirementId)) {
          throw new Error('需求不存在');
        }
        const baseVersion = baseVersionId ? this.getVersion(baseVersionId) : null;
        if (baseVersionId && baseVersion?.requirementId !== requirementId) throw new Error('基准版本不存在或不属于当前需求');
        if (taskId) this.tasks.validateOutline(taskId, requirementId, sourceCardIds, input.executionSessionId);
        for (const source of sourceCardIds) {
          if (typeof source !== 'string' || !/^(requirement|material|outline|word|artifact):[0-9a-f-]+$/i.test(source)) throw new Error('来源卡片标识无效');
          const [kind, id] = source.split(':');
          entityId(id, '来源卡片标识');
          let belongs = kind === 'requirement' && id === requirementId;
          if (kind === 'outline' || kind === 'word') {
            const row = this.db.prepare('SELECT requirement_id, word_path FROM outline_versions WHERE id = ?').get(id);
            belongs = row?.requirement_id === requirementId && (kind !== 'word' || Boolean(row.word_path));
          }
          if (kind === 'material' && this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canvas_materials'").get()) {
            belongs = this.db.prepare('SELECT requirement_id FROM canvas_materials WHERE id = ?').get(id)?.requirement_id === requirementId;
          }
          if (kind === 'artifact') belongs = this.db.prepare('SELECT requirement_id FROM task_files WHERE id=?').get(id)?.requirement_id === requirementId;
          if (!belongs) throw new Error('来源卡片不存在或不属于当前需求');
        }
        managedDirectory(path.join(this.workspaceRoot, 'courses'));
        const courseDirectory = path.join(this.workspaceRoot, 'courses', requirementId);
        managedDirectory(courseDirectory);
        const latest = this.db.prepare('SELECT MAX(number) AS number FROM outline_versions WHERE requirement_id = ?')
          .get(requirementId).number ?? 0;
        let number = latest + 1;
        let directory;
        // A crash can leave an unregistered artifact; preserve it and allocate another number.
        do {
          directory = path.join(courseDirectory, `v${String(number).padStart(3, '0')}`);
          if (!existsSync(directory)) break;
          number += 1;
        } while (number < 1_000_000);
        if (number >= 1_000_000) throw new Error('版本数量超过工作台上限');
        mkdirSync(directory);
        createdDirectory = directory;
        const file = path.join(directory, 'outline.md');
        const descriptor = openSync(file, 'wx', 0o600);
        createdFile = file;
        try {
          writeFileSync(descriptor, markdown, 'utf8');
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        const id = randomUUID();
        const now = new Date().toISOString();
        const relativePath = path.relative(this.workspaceRoot, file).split(path.sep).join('/');
        this.db.prepare('INSERT INTO outline_versions (id, requirement_id, number, markdown, markdown_path, hash, word_path, created_at, source_card_ids) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)')
          .run(id, requirementId, number, markdown, relativePath, contentHash, now, JSON.stringify(sourceCardIds));
        this.db.prepare('UPDATE requirements SET updated_at = ? WHERE id = ?').run(now, requirementId);
        if (taskId) this.tasks.attachOutline(taskId, id, { primary: input.primary });
        if (baseVersion) this.tasks.createManual(this.getRequirement(requirementId), baseVersion, id, number, input.manualGeneration);
        this.#record(operationId, 'save-outline', inputHash, id);
        return id;
      });
      committed = true;
      this.outputSaved?.(requirementId);
      return this.getVersion(resultId);
    } finally {
      if (!committed) {
        if (createdFile) unlinkSync(createdFile);
        if (createdDirectory) rmdirSync(createdDirectory);
      }
    }
  }

  getVersion(id) {
    id = entityId(id, '版本标识');
    if (this.closed) throw new Error('工作台已关闭');
    return versionFromRow(this.db.prepare('SELECT * FROM outline_versions WHERE id = ?').get(id));
  }

  markWordExport({ versionId, relativePath }) {
    versionId = entityId(versionId, '版本标识');
    const version = this.getVersion(versionId);
    if (!version) throw new Error('大纲版本不存在');
    if (typeof relativePath !== 'string' || relativePath.includes('\\') || path.isAbsolute(relativePath)
      || relativePath.split('/').includes('..') || path.extname(relativePath).toLowerCase() !== '.docx') {
      throw new Error('Word 文件路径无效');
    }
    const target = path.resolve(this.workspaceRoot, relativePath);
    const expectedParent = path.dirname(path.resolve(this.workspaceRoot, version.markdownPath));
    if (path.dirname(target) !== expectedParent || !existsSync(target) || lstatSync(target).isSymbolicLink()) {
      throw new Error('Word 文件必须是当前版本目录中的真实文件');
    }
    const actual = realpathSync(target);
    if (realpathSync(expectedParent) !== expectedParent || actual !== target
      || path.dirname(actual) !== expectedParent || !actual.startsWith(`${this.workspaceRoot}${path.sep}`)
      || !statSync(actual).isFile() || statSync(actual).size === 0) {
      throw new Error('Word 文件必须位于当前工作目录且非空');
    }
    const normalized = path.relative(this.workspaceRoot, actual).split(path.sep).join('/');
    this.#transaction(() => {
      const current = this.getVersion(versionId);
      if (current.wordPath && current.wordPath !== normalized) throw new Error('该版本已登记另一份 Word 文件');
      this.db.prepare('UPDATE outline_versions SET word_path = ? WHERE id = ?').run(normalized, versionId);
    });
    this.outputSaved?.(version.requirementId);
    return this.getVersion(versionId);
  }

  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
