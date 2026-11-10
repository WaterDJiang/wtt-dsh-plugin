import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sourceDigest, verifySourceRange } from './source-range.mjs';
import { extractMaterialImport, inspectMaterialImport, IMPORT_MAX_BYTES } from './material-import.mjs';
import { adjacentCreationPosition } from './creation-context.mjs';
import { editableCardText, cardWriteBack } from './card-capabilities.mjs';
import { extractSkillNames } from './skill-commands.mjs';
import { deliverableName } from './deliverable-files.mjs';

const MAX_BYTES = 1_048_576;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(value);
const parse = (value, fallback) => value ? JSON.parse(value) : fallback;
const defaultViewport = { x: 30, y: 30, zoom: 0.8 };
const whiteboardPrefix = 'whiteboard:';
const elementKinds = new Set(['text', 'note', 'shape']);
const elementColours = new Set(['cream', 'blue', 'green', 'rose', 'white']);
const elementShapes = new Set(['rectangle', 'ellipse']);

function whiteboardElements(value) {
  if (!Array.isArray(value) || value.length > 500) throw new Error('白板元素必须是至多 500 项的数组');
  const ids = new Set();
  let bytes = 0;
  return value.map((element) => {
    if (!element || typeof element !== 'object' || Array.isArray(element)
      || typeof element.id !== 'string' || !element.id.startsWith(whiteboardPrefix)
      || element.id !== element.id.toLowerCase() || !uuid(element.id.slice(whiteboardPrefix.length))
      || ids.has(element.id)) throw new Error('白板元素标识无效或重复');
    ids.add(element.id);
    if (!elementKinds.has(element.kind)) throw new Error('白板元素类型无效');
    if (typeof element.text !== 'string' || element.text.length > 30_000 || element.text.includes('\0')) throw new Error('白板文字必须是不超过 30000 字符的文本');
    bytes += Buffer.byteLength(element.text);
    if (bytes > MAX_BYTES) throw new Error('白板文字总量不能超过 1 MB');
    if (!Number.isFinite(element.width) || element.width < 100 || element.width > 1200
      || !Number.isFinite(element.height) || element.height < 60 || element.height > 1200) throw new Error('白板元素尺寸无效');
    if (!elementColours.has(element.colour)) throw new Error('白板元素颜色无效');
    if (element.shape !== undefined && !elementShapes.has(element.shape)) throw new Error('白板图形无效');
    return { id: element.id, kind: element.kind, text: element.text, width: element.width, height: element.height,
      colour: element.colour, ...(element.kind === 'shape' ? { shape: element.shape || 'rectangle' } : {}) };
  });
}

function text(value, label, max = MAX_BYTES) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > max) throw new Error(`${label}格式或长度无效`);
  return value;
}

function coordinate(position) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || Math.abs(position.x) > 1_000_000 || Math.abs(position.y) > 1_000_000) throw new Error('卡片坐标无效');
  return { x: position.x, y: position.y };
}

function canvasViewport(viewport) {
  const position = coordinate(viewport);
  if (!Number.isFinite(viewport.zoom) || viewport.zoom < 0.1 || viewport.zoom > 3) throw new Error('画布缩放无效');
  return { ...position, zoom: viewport.zoom };
}

function directory(target) { try { mkdirSync(target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (lstatSync(target).isSymbolicLink() || !statSync(target).isDirectory()) throw new Error('素材目录不可用');
}

// 素材 markdown 文件名取自标题的安全字符（文件树直接可见）；导入卡标题自带 .md/.txt 时去尾避免双扩展名，极端情况退回素材 id
function materialFileBase(title, materialId) {
  const stem = title.normalize('NFC').replace(/\.(md|markdown|txt)$/i, '').replace(/[<>:"|?*/\\]/g, '_').replace(/[\u0000-\u001f]/g, ' ').trim();
  const base = [...stem].slice(0, 80).join('').trim().replace(/[. ]+$/, '');
  return base || materialId;
}

function materialValue(row) {
  return {
    id: row.id, requirementId: row.requirement_id, title: row.title, content: row.content,
    path: row.markdown_path, sourcePath: row.source_path, extracted: Boolean(row.extracted),
    hash: row.hash, createdAt: row.created_at,
  };
}

function sourceRefs(value) {
  if (!Array.isArray(value) || value.length > 200) throw new Error('来源引用必须是至多 200 项的数组');
  const seen = new Set();
  return value.map(ref => {
    if (!ref || typeof ref.cardId !== 'string' || !/^(requirement|material|outline|word|artifact):[0-9a-f-]+$/.test(ref.cardId)
      || !uuid(ref.cardId.split(':')[1]) || typeof ref.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(ref.hash) || seen.has(ref.cardId)) throw new Error('来源卡片或 hash 无效／重复');
    seen.add(ref.cardId);
    return { cardId: ref.cardId, hash: ref.hash.toLowerCase() };
  }).sort((a, b) => a.cardId.localeCompare(b.cardId));
}

export class CanvasStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.workspaceRoot = store.workspaceRoot;
    this.#pruneEmptyImportDirs();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS canvas_boards (
        requirement_id TEXT PRIMARY KEY REFERENCES canvas_spaces(id), revision INTEGER NOT NULL,
        positions_json TEXT NOT NULL, edges_json TEXT NOT NULL, groups_json TEXT NOT NULL,
        viewport_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS canvas_materials (
        id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL REFERENCES canvas_spaces(id),
        title TEXT NOT NULL, content TEXT NOT NULL, markdown_path TEXT NOT NULL UNIQUE,
        source_path TEXT, extracted INTEGER NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS canvas_material_versions (
        id TEXT PRIMARY KEY, material_id TEXT NOT NULL REFERENCES canvas_materials(id),
        number INTEGER NOT NULL, content TEXT NOT NULL, hash TEXT NOT NULL,
        markdown_path TEXT NOT NULL, origin TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(material_id, number)
      );
      CREATE TABLE IF NOT EXISTS canvas_sessions (
        reqid TEXT PRIMARY KEY REFERENCES canvas_spaces(id), session_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS canvas_excerpts (
        material_id TEXT PRIMARY KEY REFERENCES canvas_materials(id), source_card_id TEXT NOT NULL,
        source_hash TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
        quote TEXT NOT NULL, annotation TEXT NOT NULL, source_title TEXT NOT NULL, range_label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS canvas_material_sources (
        material_id TEXT NOT NULL REFERENCES canvas_materials(id), source_card_id TEXT NOT NULL,
        source_hash TEXT NOT NULL, source_title TEXT NOT NULL, source_kind TEXT NOT NULL,
        PRIMARY KEY(material_id,source_card_id)
      );
      CREATE TABLE IF NOT EXISTS canvas_imports (
        material_id TEXT PRIMARY KEY REFERENCES canvas_materials(id), operation_id TEXT NOT NULL,
        original_name TEXT NOT NULL, file_path TEXT NOT NULL UNIQUE, file_hash TEXT NOT NULL,
        byte_size INTEGER NOT NULL, mime TEXT NOT NULL, extraction_status TEXT NOT NULL,
        truncated INTEGER NOT NULL, extraction_error TEXT
      );
      CREATE TABLE IF NOT EXISTS canvas_whiteboard_snapshots (
        material_id TEXT PRIMARY KEY REFERENCES canvas_materials(id), requirement_id TEXT NOT NULL,
        element_id TEXT NOT NULL, content_hash TEXT NOT NULL, source_revision INTEGER NOT NULL,
        element_kind TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS canvas_project_references (
        material_id TEXT PRIMARY KEY REFERENCES canvas_materials(id), requirement_id TEXT NOT NULL, source_path TEXT NOT NULL, source_hash TEXT NOT NULL, UNIQUE(requirement_id,source_path,source_hash)
      );
      CREATE TABLE IF NOT EXISTS canvas_import_media (
        material_id TEXT PRIMARY KEY REFERENCES canvas_materials(id), media_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS canvas_material_associations (
        material_id TEXT PRIMARY KEY REFERENCES canvas_materials(id), source_card_id TEXT NOT NULL,
        source_hash TEXT NOT NULL, source_title TEXT NOT NULL
      );
    `);
    if (!this.db.prepare('PRAGMA table_info(canvas_boards)').all().some(column => column.name === 'sizes_json')) this.db.exec("ALTER TABLE canvas_boards ADD COLUMN sizes_json TEXT NOT NULL DEFAULT '{}'");
    if (!this.db.prepare('PRAGMA table_info(canvas_boards)').all().some((column) => column.name === 'elements_json')) {
      this.db.exec("ALTER TABLE canvas_boards ADD COLUMN elements_json TEXT NOT NULL DEFAULT '[]'");
    }
    // 一次性回填：统一能力上线前创建的素材补录 V001 导入基线（新素材由 #addMaterial 直接写入）
    this.db.exec(`INSERT INTO canvas_material_versions (id, material_id, number, content, hash, markdown_path, origin, created_at)
      SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' ||
        substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
        m.id, 1, m.content, m.hash, m.markdown_path, 'import', m.created_at
      FROM canvas_materials m
      WHERE NOT EXISTS (SELECT 1 FROM canvas_material_versions v WHERE v.material_id = m.id)`);
  }

  #requirement(id) {
    const requirement = this.store.getRequirement(id);
    if (!requirement) throw new Error('需求不存在');
    return requirement;
  }

  #layout(id) {
    const row = this.db.prepare('SELECT * FROM canvas_boards WHERE requirement_id=?').get(id);
    return row ? { revision: row.revision, positions: parse(row.positions_json, {}), edges: parse(row.edges_json, []), groups: parse(row.groups_json, []), viewport: parse(row.viewport_json, defaultViewport), elements: parse(row.elements_json, []), sizes: parse(row.sizes_json, {}) }
      : { revision: 0, positions: {}, edges: [], groups: [], viewport: { ...defaultViewport }, elements: [], sizes: {} };
  }

  #write(id, layout, revision) {
    const sizes = layout.sizes ?? this.#layout(id).sizes;
    this.db.prepare(`INSERT INTO canvas_boards (requirement_id, revision, positions_json, edges_json, groups_json, viewport_json, elements_json, sizes_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(requirement_id) DO UPDATE SET revision=excluded.revision, positions_json=excluded.positions_json,
      edges_json=excluded.edges_json, groups_json=excluded.groups_json, viewport_json=excluded.viewport_json, elements_json=excluded.elements_json, sizes_json=excluded.sizes_json`)
      .run(id, revision, JSON.stringify(layout.positions), JSON.stringify(layout.edges), JSON.stringify(layout.groups), JSON.stringify(layout.viewport), JSON.stringify(layout.elements || []), JSON.stringify(sizes));
  }

  // 导入副本被外部删除后遗留的空操作目录，在启动时清理（目录非空一律不动）
  #pruneEmptyImportDirs() {
    try {
      const importsRoot = path.join(this.workspaceRoot, 'courses');
      for (const requirement of readdirSync(importsRoot)) {
        const importsDir = path.join(importsRoot, requirement, 'imports');
        let operations;
        try { operations = readdirSync(importsDir); } catch { continue; }
        for (const operation of operations) {
          const dir = path.join(importsDir, operation);
          try { if (readdirSync(dir).length === 0) rmdirSync(dir); } catch { /* 非空或占用则保留 */ }
        }
      }
    } catch { /* courses 不存在或不可读时忽略 */ }
  }

  #transaction(action) {
    if (this.store.closed) throw new Error('工作台已关闭');
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  #fileState(relativePath, hash, maxBytes = MAX_BYTES) {
    try {
      const file = path.resolve(this.workspaceRoot, relativePath);
      if (realpathSync(file) !== file || !file.startsWith(this.workspaceRoot + path.sep) || !statSync(file).isFile()) return 'unavailable';
      if (hash && statSync(file).size > maxBytes) return 'changed';
      if (hash && sha(readFileSync(file)) !== hash) return 'changed';
      return 'ready';
    } catch { return 'missing'; }
  }

  // 素材版本历史：追加式（append-only），当前快照文件恒为最新版内容；调用方必须已在 #transaction 内
  #appendMaterialVersion(materialId, markdownPath, content, hash, origin, now) {
    const number = Number(this.db.prepare('SELECT COALESCE(MAX(number),0)+1 AS n FROM canvas_material_versions WHERE material_id=?').get(materialId).n);
    this.db.prepare('INSERT INTO canvas_material_versions VALUES (?,?,?,?,?,?,?,?)')
      .run(randomUUID(), materialId, number, content, hash, markdownPath, origin, now);
  }

  materialVersion({ requirementId, materialId, versionId }) {
    if (!uuid(requirementId) || !uuid(materialId) || !uuid(versionId)) throw new Error('素材版本标识无效');
    const row = this.db.prepare('SELECT id,title,requirement_id FROM canvas_materials WHERE id=?').get(materialId);
    if (!row || row.requirement_id !== requirementId) throw new Error('素材版本不存在或不属于当前需求');
    const version = this.db.prepare('SELECT id,number,content,hash,origin,created_at FROM canvas_material_versions WHERE id=? AND material_id=?').get(versionId, materialId);
    if (!version) throw new Error('素材版本不存在');
    return { materialId, versionId: version.id, number: version.number, content: version.content, hash: version.hash, origin: version.origin, createdAt: version.created_at, title: row.title };
  }

  // 源文件被外部删除后的恢复：从卡片快照内容重建项目源文件并恢复链接；位置已被占用或非文本格式时拒绝
  restoreMaterialProjectFile({ requirementId, materialId }) {
    if (!uuid(requirementId) || !uuid(materialId)) throw new Error('素材标识无效');
    const row = this.db.prepare('SELECT * FROM canvas_materials WHERE id=? AND requirement_id=?').get(materialId, requirementId);
    if (!row) throw new Error('素材卡不存在或不属于当前需求');
    const reference = this.db.prepare('SELECT source_path,source_hash FROM canvas_project_references WHERE material_id=?').get(materialId);
    if (!reference) throw new Error('此卡片没有绑定的项目源文件，请重新拖入文件');
    if (!/\.(md|markdown|txt)$/i.test(reference.source_path)) throw new Error('此格式无法从卡片内容重建，请重新拖入文件');
    const content = row.content;
    if (!row.extracted || !String(content).trim() || /^已导入文件：/.test(String(content))) throw new Error('卡片没有可用正文，无法重建源文件，请重新拖入文件');
    const file = path.resolve(this.workspaceRoot, reference.source_path);
    if (file === this.workspaceRoot || !file.startsWith(this.workspaceRoot + path.sep)) throw new Error('引用文件路径越界');
    if (existsSync(file)) throw new Error('源文件位置已存在文件，为避免覆盖请核对后重新拖入该文件');
    mkdirSync(path.dirname(file), { recursive: true });
    const nextHash = sha(Buffer.from(content, 'utf8'));
    this.#transaction(() => {
      const descriptor = openSync(file, 'wx', 0o600);
      try { writeFileSync(descriptor, content, 'utf8'); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      const copy = path.resolve(this.workspaceRoot, row.markdown_path);
      if (copy !== file && copy.startsWith(this.workspaceRoot + path.sep)) {
        const copyDescriptor = openSync(copy, 'w', 0o600);
        try { writeFileSync(copyDescriptor, content, 'utf8'); fsyncSync(copyDescriptor); } finally { closeSync(copyDescriptor); }
      }
      this.db.prepare('UPDATE canvas_materials SET extracted=1 WHERE id=?').run(materialId);
      this.db.prepare('UPDATE canvas_project_references SET source_hash=? WHERE material_id=?').run(nextHash, materialId);
    });
    return { restored: true, path: reference.source_path, fileName: path.basename(file) };
  }

  // 项目文件引用卡的卡内编辑直接写回原文件（IDE 式所见即所得）；外改核验失败时拒绝，不覆盖外部修改
  #writeBackProjectReference(node, reference, content, operationId, fingerprint) {
    const file = path.resolve(this.workspaceRoot, reference.source_path);
    if (file === this.workspaceRoot || !file.startsWith(this.workspaceRoot + path.sep)) throw new Error('引用文件路径越界');
    let stat;
    try { stat = lstatSync(file); }
    catch { throw new Error('源文件已被删除。可在卡片菜单选择「重新生成源文件」恢复，或重新拖入文件。'); }
    if (stat.isSymbolicLink() || realpathSync(file) !== file || !stat.isFile()) throw new Error('引用文件已被移动或替换，请重新拖入后再编辑');
    if (sha(readFileSync(file)) !== reference.source_hash) throw new Error('文件已被外部修改，请核对或重新拖入后再编辑，本次未写入');
    const nextHash = sha(Buffer.from(content, 'utf8'));
    this.#transaction(() => {
      const descriptor = openSync(file, 'w', 0o600);
      try { writeFileSync(descriptor, content, 'utf8'); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      const copy = path.resolve(this.workspaceRoot, node.path);
      if (copy === file || !copy.startsWith(this.workspaceRoot + path.sep)) throw new Error('素材快照路径越界');
      const copyDescriptor = openSync(copy, 'w', 0o600);
      try { writeFileSync(copyDescriptor, content, 'utf8'); fsyncSync(copyDescriptor); } finally { closeSync(copyDescriptor); }
      this.db.prepare('UPDATE canvas_materials SET content=?, hash=?, extracted=1 WHERE id=?').run(content, nextHash, node.refId);
      this.#appendMaterialVersion(node.refId, node.path, content, nextHash, 'card-edit', new Date().toISOString());
      this.db.prepare('UPDATE canvas_project_references SET source_hash=? WHERE material_id=?').run(nextHash, node.refId);
      this.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(operationId, 'save-card-text', fingerprint, JSON.stringify({ nodeId: node.id, savedTo: path.basename(file) }));
    });
    return { nodeId: node.id, savedTo: path.basename(file) };
  }

  // 普通素材卡写回自身 markdown 快照；外部修改拒绝，快照被外部删除时以卡片内容自愈重建
  #writeBackMaterialSnapshot(node, content, operationId, fingerprint) {
    const file = path.resolve(this.workspaceRoot, node.path);
    if (file === this.workspaceRoot || !file.startsWith(this.workspaceRoot + path.sep)) throw new Error('素材文件路径越界');
    let stat = null;
    try { stat = lstatSync(file); } catch { stat = null; }
    if (stat) {
      if (stat.isSymbolicLink() || realpathSync(file) !== file || !stat.isFile()) throw new Error('素材文件已被移动或替换，请核对后再编辑');
      if (sha(readFileSync(file)) !== node.sourceHash) throw new Error('素材文件已被外部修改，请核对后再编辑，本次未写入');
    }
    const nextHash = sha(Buffer.from(content, 'utf8'));
    this.#transaction(() => {
      const descriptor = openSync(file, 'w', 0o600);
      try { writeFileSync(descriptor, content, 'utf8'); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      this.db.prepare('UPDATE canvas_materials SET content=?, hash=?, extracted=1 WHERE id=?').run(content, nextHash, node.refId);
      this.#appendMaterialVersion(node.refId, node.path, content, nextHash, 'card-edit', new Date().toISOString());
      this.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(operationId, 'save-card-text', fingerprint, JSON.stringify({ nodeId: node.id, savedTo: path.basename(file) }));
    });
    return { nodeId: node.id, savedTo: path.basename(file) };
  }

  resolveTextSource(requirementId, sourceCardId, verifyFile = true, { allowUnextracted = false } = {}) {
    this.#requirement(requirementId);
    if (typeof sourceCardId !== 'string' || sourceCardId !== sourceCardId.toLowerCase()
      || !/^(material|outline|artifact):[0-9a-f-]+$/.test(sourceCardId) || !uuid(sourceCardId.split(':')[1])) throw new Error('请选择已提取文本的素材、脚本文件或已保存大纲作为来源');
    const [kind, id] = sourceCardId.split(':');
    let source;
    if (kind === 'outline') {
      const version = this.store.getVersion(id);
      if (version?.requirementId === requirementId) source = { cardId: sourceCardId, title: `大纲 v${version.number}`, kind,
        content: version.markdown, hash: version.hash, path: version.markdownPath };
    } else if (kind === 'artifact') {
      const artifact = this.store.tasks.files.get(id);
      if (artifact.requirementId !== requirementId) throw new Error('来源卡片不存在或不属于当前需求');
      if (!['.md', '.txt', '.json', '.jsonl', '.csv'].includes(path.extname(artifact.path).toLowerCase()) || artifact.byteSize > MAX_BYTES) throw new Error('该产物未提取完整正文，不能保存摘录');
      const content = this.store.tasks.files.read(id).bytes.toString('utf8');
      source = { cardId: sourceCardId, title: artifact.title, kind: 'artifact', content, hash: artifact.hash, path: artifact.path };
    } else {
      const row = this.db.prepare('SELECT * FROM canvas_materials WHERE id=? AND requirement_id=?').get(id, requirementId);
      if (row) {
        // 选段／摘录必须基于已提取正文；卡内文本编辑对纯文本文件放行空正文（editableCardText 已判定可编辑）
        if (!row.extracted && !allowUnextracted) throw new Error('该文件未提取正文，不能选段或保存摘录');
        const excerpt = this.db.prepare('SELECT annotation FROM canvas_excerpts WHERE material_id=?').get(id);
        source = { cardId: sourceCardId, title: row.title, kind: excerpt ? 'excerpt' : 'material', content: row.content,
          hash: row.hash, path: row.markdown_path, ...(excerpt ? { annotation: excerpt.annotation } : {}) };
      }
    }
    if (!source) throw new Error('来源卡片不存在或不属于当前需求');
    if (sourceDigest(source.content) !== source.hash || (verifyFile && this.#fileState(source.path, source.hash) !== 'ready')) throw new Error('来源文件不可用或已被外部修改，请核对后重新选择');
    return source;
  }

  #excerptSourceState(requirementId, excerpt) {
    try {
      const source = this.resolveTextSource(requirementId, excerpt.source_card_id, false);
      return source.hash === excerpt.source_hash ? this.#fileState(source.path, excerpt.source_hash) : 'changed';
    } catch { return 'unavailable'; }
  }

  getBoard(requirementId) { const board=this.store.cards.project(this.getRawBoard(requirementId));return this.store.recycle?.filter(board)||board; }

  getRawBoard(requirementId) {
    const requirement = this.#requirement(requirementId);
    const layout = this.#layout(requirement.id);
    const deliveryInfo = sourceRef => {
      const delivery = this.store.deliverables?.info(sourceRef);
      return delivery ? { delivery } : {};
    };
    const reqId = `requirement:${requirement.id}`;
    const brief = requirement.origin === 'canvas' || requirement.backgroundOnly ? requirement.background
      : [`客户：${requirement.customer || '待补充'}`, `受众：${requirement.audience || '待补充'}`, `背景：${requirement.background || '待补充'}`, `目标：${requirement.objectives || '待补充'}`].join('\n\n');
    const placements = this.store.tasks.artifactPlacements(requirement.id);
    const nodes = requirement.origin !== 'canvas' || requirement.background.trim() ? [{ id: reqId, kind: 'requirement', refId: requirement.id, title: requirement.title, content: brief, excerpt: brief.slice(0, 160), requirementBackground: requirement.background, sourceHash: sourceDigest(brief), position: { x: 40, y: 60 } }] : [];
    const edges = [];
    const materialRows = this.db.prepare('SELECT * FROM canvas_materials WHERE requirement_id=? ORDER BY created_at,id').all(requirement.id);
    materialRows.forEach((row, index) => {
      const material = this.#materialResult(row);
      const excerpt = this.db.prepare('SELECT * FROM canvas_excerpts WHERE material_id=?').get(row.id);
      const refs = this.#materialSources(row.id);
      const projectFile = this.db.prepare('SELECT source_path,source_hash FROM canvas_project_references WHERE material_id=?').get(row.id);
      nodes.push({ ...material, id: `material:${row.id}`, kind: excerpt ? 'excerpt' : 'material', refId: row.id, excerpt: row.content.slice(0, 180), sourceHash: row.hash,
        position: { x: 40, y: 350 + index * 240 }, status: this.#fileState(row.markdown_path, row.hash),
        sourceStatus: material.importedFile ? this.#importState(material.id) : row.source_path ? this.#fileState(row.source_path) : null,
        ...(projectFile ? { projectFile: { path: projectFile.source_path, hash: projectFile.source_hash, status: this.#fileState(projectFile.source_path,projectFile.source_hash,IMPORT_MAX_BYTES) } } : {}),
        ...(refs.length ? { sourceRefs: refs, sourceCardIds: refs.map(ref => ref.cardId) } : {}),
        ...(excerpt ? { excerptInfo: { sourceCardId: excerpt.source_card_id, sourceHash: excerpt.source_hash,
          start: excerpt.start_offset, end: excerpt.end_offset, quote: excerpt.quote, annotation: excerpt.annotation,
          sourceTitle: excerpt.source_title, sourceStatus: this.#excerptSourceState(requirement.id, excerpt), rangeLabel: excerpt.range_label } } : {}) });
      if (excerpt) edges.push({ id: `excerpt:${row.id}`, source: excerpt.source_card_id, target: `material:${row.id}`, provenance: true });
      for (const ref of refs) edges.push({ id: `material-source:${ref.cardId}:${row.id}`, source: ref.cardId, target: `material:${row.id}`, provenance: true });
    });
    for (const version of [...requirement.versions].sort((a, b) => a.number - b.number)) {
      const id = `outline:${version.id}`;
      const x = 410 + (version.number - 1) * 350;
      nodes.push({ ...deliveryInfo(id), id, kind: 'outline', refId: version.id, title: `大纲 v${version.number}`, number: version.number,
        createdAt: version.createdAt,
        content: version.markdown, excerpt: version.markdown.slice(0, 180), path: version.markdownPath,
        sourceCardIds: version.sourceCardIds, sourceHash: version.hash, position: placements.get(id) || { x, y: 60 }, status: this.#fileState(version.markdownPath, version.hash) });
      const taskId = this.db.prepare('SELECT task_id FROM task_artifacts WHERE version_id=?').get(version.id)?.task_id;
      for (const source of version.sourceCardIds.length ? version.sourceCardIds : taskId && this.store.cards.binding(taskId) ? [] : [reqId]) {
        edges.push({ id: `source:${source}:${version.id}`, source, target: id, provenance: true });
      }
      if (version.wordPath) {
        const wordId = `word:${version.id}`;
        nodes.push({ ...deliveryInfo(wordId), id: wordId, kind: 'word', refId: version.id, title: `Word · 大纲 v${version.number}`, number: version.number,
          createdAt: version.createdAt,
          content: version.markdown, excerpt: version.wordPath, path: version.wordPath, sourceHash: version.hash,
          position: placements.get(wordId) || { x, y: 380 }, status: this.#fileState(version.wordPath) });
        edges.push({ id: `word:${version.id}`, source: id, target: wordId, provenance: true });
      }
    }
    this.store.tasks.files.list(requirement.id).forEach((file, index) => {
      const isText = ['.md', '.txt', '.json', '.jsonl', '.csv'].includes(path.extname(file.path).toLowerCase()) && file.byteSize <= MAX_BYTES;
      let content = `已登记 ${file.kind} 文件：${file.path}\n\n二进制或超出预览范围的文件未提取正文，请下载原文件阅读。`;
      let extracted = false;
      let status = file.status;
      if (file.status === 'ready' && isText) {
        try { content = this.store.tasks.files.read(file.id).bytes.toString('utf8'); extracted = true; }
        catch { status = this.store.tasks.files.get(file.id).status; }
      }
      const cardId = `artifact:${file.id}`;
      nodes.push({ ...file, id: cardId, refId: file.id, kind: 'artifact', artifactKind: file.kind, sourceHash: file.hash,
        content, excerpt: extracted ? content.slice(0, 180) : file.path, extracted, status,
        ...(['image', 'video'].includes(file.kind) ? { generatedFile: { name: path.basename(file.path), path: file.path,
          mime: file.mime, hash: file.hash, sha256: file.hash, byteSize: file.byteSize, status,
          media: file.validation.media }, sourceStatus: status } : {}),
        position: placements.get(cardId) || { x: 410 + index % 3 * 350, y: 780 + Math.floor(index / 3) * 260 } });
      for (const source of file.sourceCardIds.length ? file.sourceCardIds : this.store.cards.binding(file.taskId) ? [] : [reqId]) edges.push({ id: `file-source:${source}:${file.id}`, source, target: cardId, provenance: true });
    });
    layout.elements.forEach((element, index) => {
      const label = element.kind === 'shape' ? (element.shape === 'ellipse' ? '椭圆' : '矩形') : element.kind === 'note' ? '便签' : '文字';
      nodes.push({ ...element, id: element.id, kind: 'whiteboard', elementKind: element.kind,
        refId: element.id.slice(whiteboardPrefix.length), title: element.text.trim().split(/\r?\n/)[0].slice(0, 80) || label,
        content: element.text, excerpt: element.text.slice(0, 180), position: { x: 40 + index * 280, y: 700 } });
    });
    for (const node of nodes) { node.position = layout.positions[node.id] || node.position; if (layout.sizes[node.id]) Object.assign(node, layout.sizes[node.id]); }
    const known = new Set(nodes.map((node) => node.id));
    for (const card of this.db.prepare('SELECT id,node_id FROM output_cards WHERE requirement_id=?').all(requirement.id)) known.add(card.node_id || `output:${card.id}`);
    const generatedPairs = new Set(edges.map((edge) => `${edge.source}\0${edge.target}`));
    const userEdges = layout.edges.filter((edge) => known.has(edge.source) && known.has(edge.target) && !generatedPairs.has(`${edge.source}\0${edge.target}`));
    const sessionId = this.db.prepare('SELECT session_id FROM canvas_sessions WHERE reqid=?').get(requirement.id)?.session_id || null;
    return { requirementId: requirement.id, revision: layout.revision, sessionId, nodes, elements: layout.elements, layoutPositions: layout.positions, sizes: layout.sizes, edges: [...edges.filter((edge) => known.has(edge.source)), ...userEdges], groups: layout.groups, viewport: layout.viewport,
      tasks: this.store.tasks.list(requirement.id) };
  }

  setSession({ requirementId, sessionId }) {
    const requirement = this.#requirement(requirementId);
    if (sessionId !== null && (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200 || sessionId.includes('\0'))) throw new Error('会话标识必须是非空且不超过 200 字符的文本，或 null');
    return this.#transaction(() => {
      if (sessionId === null) this.db.prepare('DELETE FROM canvas_sessions WHERE reqid=?').run(requirement.id);
      else this.db.prepare('INSERT INTO canvas_sessions VALUES (?,?) ON CONFLICT(reqid) DO UPDATE SET session_id=excluded.session_id').run(requirement.id, sessionId);
      return { sessionId };
    });
  }

  validateSources(requirementId, sourceCardIds) {
    const known = new Set(this.getRawBoard(requirementId).nodes.map((node) => node.id));
    if (sourceCardIds === undefined) return [];
    if (!Array.isArray(sourceCardIds) || sourceCardIds.length > 200) throw new Error('来源卡片数组无效');
    const ids = [...new Set(sourceCardIds)];
    if (ids.some((id) => typeof id === 'string' && id.startsWith(whiteboardPrefix))) throw new Error('白板元素可继续编辑，请先保存为素材再交给 AI');
    if (ids.some((id) => typeof id !== 'string' || !known.has(id))) throw new Error('来源卡片不存在或不属于当前需求');
    return ids;
  }

  validateSourceRefs(requirementId, refs, { selectedCardIds } = {}) {
    const normalized = sourceRefs(refs);
    const board = this.getRawBoard(requirementId);
    if (selectedCardIds !== undefined) {
      const selected = this.validateSources(requirementId, selectedCardIds).sort();
      if (JSON.stringify(selected) !== JSON.stringify(normalized.map(ref => ref.cardId))) throw new Error('冻结来源必须与本次引用卡片一致');
    }
    return normalized.map(ref => {
      const card = board.nodes.find(node => node.id === ref.cardId);
      if (!card || card.kind === 'whiteboard') throw new Error('来源卡片不存在、未保存或不属于当前需求');
      if (['missing', 'changed', 'unavailable'].includes(card.status) || card.sourceStatus && card.sourceStatus !== 'ready') throw new Error(`「${card.title}」的来源文件不可用或已外改`);
      if (!card.sourceHash || card.sourceHash !== ref.hash) throw new Error(`「${card.title}」的来源 hash 已变化，请重新选择`);
      return { ...ref, title: card.title, kind: card.kind };
    });
  }

  #materialSources(materialId) {
    return this.db.prepare('SELECT source_card_id AS cardId,source_hash AS hash,source_title AS title,source_kind AS kind FROM canvas_material_sources WHERE material_id=? ORDER BY source_card_id').all(materialId).map(ref => ({ ...ref }));
  }

  #materialResult(row) {
    const refs = this.#materialSources(row.id);
      const projectFile = this.db.prepare('SELECT source_path,source_hash FROM canvas_project_references WHERE material_id=?').get(row.id);
    const imported = this.db.prepare('SELECT * FROM canvas_imports WHERE material_id=?').get(row.id);
    const whiteboard = this.db.prepare('SELECT * FROM canvas_whiteboard_snapshots WHERE material_id=?').get(row.id);
    const media = this.db.prepare('SELECT media_json FROM canvas_import_media WHERE material_id=?').get(row.id);
    const association = this.db.prepare('SELECT * FROM canvas_material_associations WHERE material_id=?').get(row.id);
    const versions = this.db.prepare('SELECT id,number,origin,created_at FROM canvas_material_versions WHERE material_id=? ORDER BY number').all(row.id);
    return { ...materialValue(row), ...(refs.length ? { sourceRefs: refs } : {}),
      ...(versions.length ? { materialVersions: versions.map(version => ({ id: version.id, number: version.number, origin: version.origin, createdAt: version.created_at })), currentMaterialVersionId: versions.at(-1).id } : {}),
      ...(imported ? { importedFile: { name: imported.original_name, path: imported.file_path, hash: imported.file_hash,
        byteSize: imported.byte_size, mime: imported.mime, extractionStatus: imported.extraction_status,
        truncated: Boolean(imported.truncated), ...(imported.extraction_error ? { extractionError: imported.extraction_error } : {}),
        ...(media ? { media: JSON.parse(media.media_json) } : {}) } } : {}),
      ...(association ? { association: { cardId: association.source_card_id, hash: association.source_hash, title: association.source_title } } : {}),
      ...(whiteboard ? { whiteboardSource: { elementId: whiteboard.element_id, contentHash: whiteboard.content_hash,
        revision: whiteboard.source_revision, elementKind: whiteboard.element_kind } } : {}) };
  }

  #importState(materialId) {
    try { this.readImportedFile(materialId); return 'ready'; }
    catch (error) { return error.code === 'ENOENT' ? 'missing' : error.code === 'IMPORT_CHANGED' ? 'changed' : 'unavailable'; }
  }

  readImportedFile(materialId, { preview = false } = {}) {
    if (!uuid(materialId)) throw new Error('导入素材标识无效');
    const row = this.db.prepare(`SELECT i.*,m.requirement_id FROM canvas_imports i JOIN canvas_materials m ON m.id=i.material_id WHERE i.material_id=?`).get(materialId.toLowerCase());
    if (!row) throw new Error('导入素材不存在或不属于当前项目');
    const expectedPrefix = `courses/${row.requirement_id}/imports/${row.operation_id}/`;
    if (!row.file_path.startsWith(expectedPrefix) || row.file_path.slice(expectedPrefix.length).includes('/')
      || row.file_path.includes('\\') || row.file_path.split('/').includes('..')) throw new Error('导入原件路径不属于受管目录');
    const file = path.resolve(this.workspaceRoot, row.file_path);
    if (!file.startsWith(this.workspaceRoot + path.sep) || realpathSync(file) !== file || !lstatSync(file).isFile()) throw new Error('导入原件路径已被替换或不可用');
    if (statSync(file).size !== row.byte_size || row.byte_size > IMPORT_MAX_BYTES) throw Object.assign(new Error('导入原件已被外部修改，不能沿用原登记下载'), { code: 'IMPORT_CHANGED' });
    const bytes = readFileSync(file);
    if (sha(bytes) !== row.file_hash) throw Object.assign(new Error('导入原件 hash 已变化，不能沿用原登记下载'), { code: 'IMPORT_CHANGED' });
    const media = this.db.prepare('SELECT media_json FROM canvas_import_media WHERE material_id=?').get(row.material_id);
    const validVideo = row.mime.startsWith('video/') && media && JSON.parse(media.media_json).validated === true;
    if (preview && !row.mime.startsWith('image/') && !validVideo) throw new Error('只有已核对格式的图片或视频可预览');
    return { bytes, name: row.original_name, mime: row.mime };
  }

  async importMaterial(input, { python = 'python3', ffprobe = 'ffprobe', signal, projectReference } = {}) {
    const requirement = this.#requirement(input?.requirementId);
    if (!uuid(input.operationId)) throw new Error('导入操作标识无效');
    const metadata = inspectMaterialImport({ filename: input.filename, bytes: input.bytes });
    const association = input.association === undefined ? undefined : sourceRefs([input.association])[0];
    const operationId = input.operationId.toLowerCase();
    const fingerprint = sha(JSON.stringify({ requirementId: requirement.id, name: metadata.name, byteSize: metadata.byteSize, hash: metadata.hash,
      ...(association ? { association } : {}), ...(projectReference ? { projectReference } : {}) }));
    const replayed = this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId);
    if (replayed) {
      if (replayed.kind !== 'import-material' || replayed.input_hash !== fingerprint) throw new Error('导入操作标识已用于不同文件或内容');
      return { material: this.#materialResult(this.db.prepare('SELECT * FROM canvas_materials WHERE id=?').get(replayed.result_id)), board: this.getBoard(requirement.id) };
    }
    const bytes = Buffer.from(input.bytes);
    const extracted = await extractMaterialImport(bytes, metadata, { python, ffprobe, signal });
    signal?.throwIfAborted();
    const relative = path.posix.join('courses', requirement.id, 'imports', operationId, metadata.safeName);
    const importedFile = { ...metadata, path: relative, ...extracted };
    const content = extracted.extractionStatus === 'extracted' ? extracted.content
      : `已导入文件：${metadata.name}\n\n未提取正文：${extracted.extractionError || '无可用正文'}。`;
    const materialInput = { requirementId: requirement.id, title: metadata.name, content, sourcePath: relative, operationId,
      ...(input.position ? { position: input.position } : {}) };
    const verifiedAssociation = {};
    return this.#addMaterial(materialInput, undefined, fingerprint, { operationKind: 'import-material', importedFile, rawBytes: bytes,
      ...(projectReference ? { projectReference, beforeCreate: () => this.db.prepare('SELECT material_id FROM canvas_project_references WHERE requirement_id=? AND source_path=? AND source_hash=?').get(requirement.id,projectReference.path,projectReference.hash)?.material_id } : {}),
      ...(association ? { association: verifiedAssociation, beforeCreate: () => {
        Object.assign(verifiedAssociation, this.validateSourceRefs(requirement.id, [association])[0]);
        if (!materialInput.position) {
          const cards = this.getRawBoard(requirement.id).nodes;
          const anchor = cards.find(card => card.id === association.cardId);
          materialInput.position = adjacentCreationPosition(anchor, cards);
        }
      } } : {}),
    });
  }

  snapshotWhiteboard(input) {
    const requirement = this.#requirement(input?.requirementId);
    if (!uuid(input.operationId)) throw new Error('白板快照操作标识无效');
    if (typeof input.elementId !== 'string' || !input.elementId.startsWith(whiteboardPrefix) || !uuid(input.elementId.slice(whiteboardPrefix.length))) throw new Error('白板元素标识无效');
    const expectedContent = text(input.expectedContent, '期望白板正文');
    if (!expectedContent.trim()) throw new Error('无文字的白板元素不能作为内容引用');
    const fingerprint = sha(JSON.stringify({ requirementId: requirement.id, elementId: input.elementId, expectedContent }));
    const operationId = input.operationId.toLowerCase();
    const replayed = this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId);
    if (replayed) {
      if (replayed.kind !== 'snapshot-whiteboard' || replayed.input_hash !== fingerprint) throw new Error('白板快照操作标识已用于不同正文');
      return { material: this.#materialResult(this.db.prepare('SELECT * FROM canvas_materials WHERE id=?').get(replayed.result_id)), board: this.getBoard(requirement.id) };
    }
    const metadata = { elementId: input.elementId, contentHash: sha(expectedContent) };
    return this.#addMaterial({ requirementId: requirement.id, title: `白板 · ${expectedContent.trim().split(/\r?\n/)[0].slice(0, 80)}`, content: expectedContent, operationId,
      ...(input.position ? { position: input.position } : {}) }, undefined, fingerprint, {
      operationKind: 'snapshot-whiteboard', whiteboardSource: metadata,
      beforeCreate: () => {
        const layout = this.#layout(requirement.id);
        const element = layout.elements.find(value => value.id === input.elementId);
        if (!element) throw new Error('白板元素不存在或不属于当前需求');
        if (element.text !== expectedContent) throw new Error('白板正文已变化，请先保存并重新选择引用');
        metadata.revision = layout.revision; metadata.elementKind = element.kind;
        const latest = this.db.prepare(`SELECT s.material_id,m.markdown_path,m.hash FROM canvas_whiteboard_snapshots s JOIN canvas_materials m ON m.id=s.material_id
          WHERE s.requirement_id=? AND s.element_id=? ORDER BY s.source_revision DESC,s.rowid DESC LIMIT 1`).get(requirement.id, input.elementId);
        if (latest && this.db.prepare('SELECT content_hash FROM canvas_whiteboard_snapshots WHERE material_id=?').get(latest.material_id).content_hash === metadata.contentHash
          && this.#fileState(latest.markdown_path, latest.hash) === 'ready') return latest.material_id;
      },
    });
  }

  saveViewport({ requirementId, expectedRevision, viewport }) {
    const next = canvasViewport(viewport);
    return this.#transaction(() => {
      const row = this.db.prepare(`SELECT b.revision FROM canvas_spaces c
        LEFT JOIN canvas_boards b ON b.requirement_id=c.id WHERE c.id=?`).get(requirementId);
      if (!row) throw new Error('需求不存在');
      const revision = row.revision ?? 0;
      if (expectedRevision !== revision) throw new Error('画布已被其他操作修改，请保留当前布局并重新加载');
      this.db.prepare(`INSERT INTO canvas_boards
        (requirement_id, revision, positions_json, edges_json, groups_json, viewport_json)
        VALUES (?, ?, '{}', '[]', '[]', ?)
        ON CONFLICT(requirement_id) DO UPDATE SET revision=excluded.revision, viewport_json=excluded.viewport_json`)
        .run(requirementId, revision + 1, JSON.stringify(next));
      return { revision: revision + 1, viewport: next };
    });
  }

  saveBoard({ requirementId, expectedRevision, positions = {}, edges = [], groups = [], viewport, elements, sizes }) {
    const result = this.#transaction(() => {
      const board = this.store.cards.project(this.getRawBoard(requirementId));
      const hidden=this.store.recycle?.hiddenIds(requirementId)||new Set();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || board.revision !== expectedRevision) throw new Error('画布已被其他操作修改，请保留当前布局并重新加载');
      const previousElements = board.elements;
      const nextElements = elements === undefined ? previousElements : whiteboardElements([...whiteboardElements(elements).filter(e=>!hidden.has(e.id)),...previousElements.filter(e=>hidden.has(e.id))]);
      const nextElementIds = new Set(nextElements.map((element) => element.id));
      const removed = new Set(previousElements.map((element) => element.id).filter((id) => !nextElementIds.has(id)));
      const known = new Set([...board.nodes.filter((node) => node.kind !== 'whiteboard').map((node) => node.id), ...nextElementIds]);
      if (elements !== undefined && nextElements.length) {
        for (const other of this.db.prepare('SELECT elements_json FROM canvas_boards WHERE requirement_id<>?').all(board.requirementId)) {
          if (parse(other.elements_json, []).some((element) => nextElementIds.has(element.id))) throw new Error('白板元素已属于其他需求，不能跨需求复用标识');
        }
      }
      if (!positions || Array.isArray(positions) || typeof positions !== 'object' || Object.keys(positions).length > 2000) throw new Error('画布位置数据无效');
      const normalizedPositions = Object.fromEntries(Object.entries(this.#layout(requirementId).positions).filter(([id])=>hidden.has(id)));
      // Legacy Clients do not know the new element collection; retain their positions too.
      if (elements === undefined) {
        const layout = this.#layout(board.requirementId);
        for (const element of previousElements) if (layout.positions[element.id]) normalizedPositions[element.id] = layout.positions[element.id];
      }
      for (const [id, value] of Object.entries(positions)) {
        if (!known.has(id) && !removed.has(id)) throw new Error('画布包含未知卡片');
        const position = coordinate(value);
        if (!removed.has(id)) normalizedPositions[id] = position;
      }
      const nextSizes = { ...this.#layout(board.requirementId).sizes };
      if (sizes !== undefined) {
        if (!sizes || typeof sizes !== 'object' || Array.isArray(sizes) || Object.keys(sizes).length > 2000) throw new Error('卡片尺寸数据无效');
        for (const key of Object.keys(nextSizes)) if (known.has(key)&&!hidden.has(key)) delete nextSizes[key];
        for (const [key, value] of Object.entries(sizes)) {
          if (!known.has(key) || key.startsWith(whiteboardPrefix) || !value || !Number.isFinite(value.width) || !Number.isFinite(value.height)
            || value.width < 200 || value.width > 1200 || value.height < 160 || value.height > 1200) throw new Error('卡片尺寸无效或不属于当前需求');
          nextSizes[key] = { width: value.width, height: value.height };
        }
      }
      if (!Array.isArray(edges) || edges.length > 4000) throw new Error('关联线数据无效');
      const usedEdges = new Set();
      const provenancePairs = new Set(board.edges.filter((edge) => edge.provenance).map((edge) => `${edge.source}\0${edge.target}`));
      const provenanceIds = new Set(board.edges.filter((edge) => edge.provenance).map((edge) => edge.id));
      const normalizedEdges = [];
      for (const edge of edges) {
        if (!edge || !identifier(edge.id) || usedEdges.has(edge.id)
          || (!known.has(edge.source) && !removed.has(edge.source)) || (!known.has(edge.target) && !removed.has(edge.target))
          || edge.source === edge.target) throw new Error('关联线包含未知卡片、重复或无效标识');
        usedEdges.add(edge.id);
        if (provenancePairs.has(`${edge.source}\0${edge.target}`)) continue;
        if (edge.provenance || provenanceIds.has(edge.id)) throw new Error('来源关系必须来自真实产物');
        if (removed.has(edge.source) || removed.has(edge.target)) continue;
        normalizedEdges.push({ id: edge.id, source: edge.source, target: edge.target });
      }
      if (!Array.isArray(groups) || groups.length > 200) throw new Error('分组数据无效');
      const usedGroups = new Set(), groupedNodes = new Set();
      const normalizedGroups = groups.map((group) => {
        if (!group || typeof group !== 'object') throw new Error('分组信息无效');
        const title = text(group.title, '分组标题', 240).trim();
        if (!identifier(group.id) || usedGroups.has(group.id) || known.has(group.id) || removed.has(group.id) || !title || !Array.isArray(group.nodeIds) || group.nodeIds.length > 200) throw new Error('分组信息无效');
        usedGroups.add(group.id);
        const withinGroup = new Set();
        for (const id of group.nodeIds) {
          if ((!known.has(id) && !removed.has(id)) || withinGroup.has(id)) throw new Error('分组包含未知或重复卡片');
          withinGroup.add(id);
        }
        const nodeIds = group.nodeIds.filter((id) => !removed.has(id));
        if (nodeIds.length < 2) {
          const oldGroup = board.groups.find((old) => old.id === group.id);
          if (group.nodeIds.some((id) => removed.has(id)) || oldGroup?.nodeIds.some((id) => removed.has(id))) return null;
          throw new Error('分组信息无效');
        }
        for (const id of nodeIds) {
          if (groupedNodes.has(id)) throw new Error('分组包含未知或重复卡片');
          groupedNodes.add(id);
        }
        return { id: group.id, title, nodeIds };
      }).filter(Boolean);
      const nextViewport = canvasViewport(viewport || board.viewport);
      this.#write(board.requirementId, { positions: normalizedPositions, edges: normalizedEdges, groups: normalizedGroups, viewport: nextViewport, elements: nextElements, sizes: nextSizes }, board.revision + 1);
      return board.requirementId;
    });
    return this.getBoard(result);
  }

  addMaterial(input) { return this.#addMaterial(input); }

  saveCardText(input) {
    const requirement = this.#requirement(input?.requirementId);
    if (!uuid(input.operationId)) throw new Error('编辑操作标识无效');
    const content = text(input.content, '卡片正文');
    if (!content.trim()) throw new Error('请填写卡片正文');
    const fingerprint = sha(JSON.stringify({ requirementId: requirement.id, cardId: input.cardId,
      versionId: input.versionId || null, sourceHash: input.sourceHash, content }));
    const previous = this.db.prepare('SELECT * FROM operations WHERE id=?').get(input.operationId);
    if (previous?.kind === 'save-card-text') {
      if (previous.input_hash !== fingerprint) throw new Error('编辑操作标识已用于不同内容');
      return JSON.parse(previous.result_id);
    }
    const described = input.versionId ? this.store.cards.describe({ requirementId: requirement.id,
      cardId: input.cardId, versionId: input.versionId }) : null;
    const draft = input.versionId === null && uuid(input.cardId)
      ? this.store.cards.describeDraft({ requirementId: requirement.id, cardId: input.cardId }) : null;
    const node = described?.node || draft?.node || this.getBoard(requirement.id).nodes.find(node => node.id === input.cardId);
    const writeBack = cardWriteBack(node);
    // 来源文件被外部删除时：普通素材快照可自愈重建放行；其余形态仍拦截
    if (node && (/^(changed|modified|unavailable)$/.test(node.status || '')
      || (node.status === 'missing' && !(node.kind === 'material' && writeBack.mode === 'snapshot')))) throw new Error('来源文件不可用或已被外部修改，请保留草稿并核对原文件');
    if (!node || editableCardText(node) === null || node.kind === 'whiteboard') throw new Error('此卡片不能直接编辑文本，请使用对应文件编辑器');
    if (node.sourceHash !== input.sourceHash) throw new Error('来源内容已变化，请保留草稿并重新加载');
    if (!draft && node.kind !== 'requirement') this.resolveTextSource(requirement.id, node.sourceId || node.id, writeBack.mode !== 'snapshot', { allowUnextracted: editableCardText(node) !== null });
    // 写回分发与客户端共用同一能力判定（cardWriteBack）：project-file→原文件、snapshot→素材快照；none 落到下方另存素材
    if (writeBack.mode === 'project-file') {
      const reference = this.db.prepare('SELECT source_path,source_hash FROM canvas_project_references WHERE material_id=?').get(node.refId);
      return this.#writeBackProjectReference(node, reference, content, input.operationId, fingerprint);
    }
    if (writeBack.mode === 'snapshot') return this.#writeBackMaterialSnapshot(node, content, input.operationId, fingerprint);
    if (node.kind === 'outline') {
      const version = this.store.saveOutline({ requirementId: requirement.id, operationId: input.operationId,
        markdown: content, baseVersionId: node.refId, sourceCardIds: [node.sourceId || node.id],
        ...(described ? { manualGeneration: { mode: 'revise', cardId: described.card.id, baseVersionId: described.version.id } } : {}) });
      return { nodeId: described?.card.nodeId || `outline:${version.id}`, sourceId: `outline:${version.id}`,
        cardId: described?.card.id, versionId: this.store.cards.binding(this.db.prepare('SELECT task_id FROM task_artifacts WHERE version_id=?').get(version.id)?.task_id)?.cardVersionId };
    }
    if (['material', 'excerpt'].includes(node.kind)) {
      const result = this.#addMaterial({ requirementId: requirement.id, operationId: input.operationId,
        title: node.title, content, sourceRefs: [{ cardId: node.id, hash: node.sourceHash }],
        position: { x: node.position.x + (node.width || 258) + 50, y: node.position.y } });
      return { nodeId: `material:${result.material.id}` };
    }
    if (previous) throw new Error('编辑操作标识已用于不同内容');
    if (node.kind === 'requirement') return this.#transaction(() => {
      if (content.length > 30_000) throw new Error('背景信息不能超过 30000 字符');
      this.db.prepare('UPDATE requirements SET background=?,updated_at=? WHERE id=?').run(content, new Date().toISOString(), requirement.id);
      const result = { nodeId: node.id };
      this.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(input.operationId, 'save-card-text', fingerprint, JSON.stringify(result));
      return result;
    });
    const card = described?.card || draft?.card;
    if (card?.type !== 'text') throw new Error('文本产物必须指定准确卡片及版本');
    const title = draft ? content.trim().split(/\r?\n/,1)[0].replace(/^#{1,6}\s+/, '').trim().slice(0,80) || node.title : node.title;
    const plan = this.store.cards.prepare({ requirementId: requirement.id, outputType: 'text', instruction: draft ? title : '人工修订',
      generation: draft ? { mode: 'new', cardId: card.id } : { mode: 'revise', cardId: card.id, baseVersionId: described.version.id } });
    const instruction = draft?.composition.instruction || described?.editor.instruction || '';
    const sources = draft ? draft.composition.references.map(({id,sourceHash,...source}) => ({...source,cardId:id,hash:sourceHash})) : described.editor.references;
    const sourceIds = draft ? sources.map(source => source.cardId) : [node.sourceId || node.id];
    const label = draft ? '手写正文' : '人工修订';
    const taskId = randomUUID(), artifactId = randomUUID(), now = new Date().toISOString();
    const dirs = ['courses', `courses/${requirement.id}`, `courses/${requirement.id}/tasks`,
      `courses/${requirement.id}/tasks/${taskId}`, `courses/${requirement.id}/tasks/${taskId}/delivery`];
    for (const dir of dirs) directory(path.join(this.workspaceRoot, dir));
    const filename = draft ? `${deliverableName(title)}.md` : path.posix.basename(node.path);
    const relative = `${dirs.at(-1)}/${filename}`;
    const file = path.join(this.workspaceRoot, relative);
    let committed = false, createdFile = false;
    try {
      const descriptor = openSync(file, 'wx', 0o600);
      createdFile = true;
      try { writeFileSync(descriptor, content, 'utf8'); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      const result = this.#transaction(() => {
        const editor = described?.editor;
        const snapshot = { requirement: Object.fromEntries(['id', 'title', 'customer', 'audience', 'background', 'objectives'].map(key => [key, requirement[key]])), workflow: 'text-edit', outputType: 'text',
          instruction, sources, selectedSkills: editor?.selectedSkills || extractSkillNames(instruction),
          ...(editor?.modelSelection ? { modelSelection: editor.modelSelection } : {}),
          ...(draft ? { outputPosition: node.position } : { revision: { cardId: card.id, versionId: described.version.id } }), manualEdit: true };
        this.db.prepare("INSERT INTO course_tasks VALUES (?,?,?,?,?,?,NULL,NULL,'output',NULL,?,?)")
          .run(taskId, requirement.id, 'manual', `${label} · ${title}`, '卡内编辑', JSON.stringify(snapshot), now, now);
        this.store.cards.attach(taskId, plan);
        this.db.prepare('INSERT INTO task_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(artifactId, requirement.id, taskId,
          ['text', 'script', 'exercise'].includes(node.artifactKind) ? node.artifactKind : 'text', title, relative,
          sha(content), Buffer.byteLength(content), path.extname(filename).toLowerCase() === '.md' ? 'text/markdown' : 'text/plain',
          JSON.stringify({ format: path.extname(filename).slice(1).toLowerCase(), manualEdit: true }), JSON.stringify(sourceIds), now);
        this.store.cards.recordOutput(taskId, `artifact:${artifactId}`, { primary: true });
        const versionId = this.store.cards.binding(taskId).cardVersionId;
        const result = { nodeId: card.nodeId, cardId: card.id, versionId, sourceId: `artifact:${artifactId}` };
        this.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(input.operationId, 'save-card-text', fingerprint, JSON.stringify(result));
        return result;
      });
      committed = true;
      this.store.outputSaved?.(requirement.id);
      return result;
    } finally {
      if (!committed && createdFile) {
        try { unlinkSync(file); } catch {}
        for (const dir of dirs.slice(-2).reverse()) { try { rmdirSync(path.join(this.workspaceRoot, dir)); } catch {} }
      }
    }
  }

  addExcerpt(input) {
    const requirement = this.#requirement(input?.requirementId);
    if (!uuid(input.operationId)) throw new Error('摘录操作标识无效');
    const title = text(input.title, '摘录标题', 600).trim();
    if (!title) throw new Error('请填写摘录标题');
    const annotation = text(input.annotation, '注释', 20_000);
    const quote = text(input.quote, '摘录原文');
    const values = { requirementId: requirement.id, title, sourceCardId: input.sourceCardId, sourceHash: input.sourceHash,
      start: input.start, end: input.end, quote, annotation };
    const fingerprint = sha(JSON.stringify(values));
    const replayed = this.db.prepare('SELECT * FROM operations WHERE id=?').get(input.operationId.toLowerCase());
    if (replayed) {
      if (replayed.kind !== 'add-excerpt' || replayed.input_hash !== fingerprint) throw new Error('摘录操作标识已用于不同内容');
      return { material: this.#materialResult(this.db.prepare('SELECT * FROM canvas_materials WHERE id=?').get(replayed.result_id)), board: this.getBoard(requirement.id) };
    }
    const source = this.resolveTextSource(requirement.id, input.sourceCardId);
    const range = verifySourceRange(source.content, values);
    return this.#addMaterial({ requirementId: requirement.id, title, content: range.quote, operationId: input.operationId,
      ...(input.position ? { position: input.position } : {}) }, { ...values, ...range, sourceTitle: source.title }, fingerprint);
  }

  #addMaterial(input, excerptInfo, suppliedFingerprint, internal = {}) {
    const requirement = this.#requirement(input?.requirementId);
    if (!uuid(input.operationId)) throw new Error('素材操作标识无效');
    const operationId = input.operationId.toLowerCase();
    const title = text(input.title, '素材标题', 600).trim();
    if (!title) throw new Error('请填写素材标题');
    const supplied = text(input.content, '素材正文');
    const sourcePath = input.sourcePath ? text(input.sourcePath, '素材路径', 4096) : null;
    let extracted = internal.importedFile ? internal.importedFile.extractionStatus === 'extracted' : !sourcePath && Boolean(supplied.trim()), sourceText = '', normalizedSource = null;
    if (sourcePath) {
      if (path.isAbsolute(sourcePath) || sourcePath.includes('\\') || sourcePath.split('/').includes('..')) throw new Error('素材路径必须位于当前工作目录');
      const file = path.resolve(this.workspaceRoot, sourcePath);
      normalizedSource = path.relative(this.workspaceRoot, file).split(path.sep).join('/');
      if (!file.startsWith(this.workspaceRoot + path.sep)) throw new Error('素材文件路径越界');
    }
    const operationKind = internal.operationKind || (excerptInfo ? 'add-excerpt' : 'add-material');
    const refs = input.sourceRefs === undefined ? undefined : sourceRefs(input.sourceRefs);
    const fingerprint = suppliedFingerprint || sha(JSON.stringify({ requirementId: requirement.id, title, content: supplied, sourcePath: normalizedSource,
      ...(refs !== undefined ? { sourceRefs: refs } : {}) }));
    const replayed = this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId);
    if (replayed) {
      if (replayed.kind !== operationKind || replayed.input_hash !== fingerprint) throw new Error('素材操作标识已用于不同内容');
      return { material: this.#materialResult(this.db.prepare('SELECT * FROM canvas_materials WHERE id=?').get(replayed.result_id)), board: this.getBoard(requirement.id) };
    }
    if (normalizedSource && !internal.importedFile) {
      const file = path.resolve(this.workspaceRoot, normalizedSource);
      if (!existsSync(file)) throw new Error('素材文件不存在');
      if (realpathSync(file) !== file || !statSync(file).isFile()) throw new Error('素材不能引用符号链接或非文件');
      if (['.md', '.markdown', '.txt'].includes(path.extname(file).toLowerCase())) {
        if (statSync(file).size > MAX_BYTES) throw new Error('文本素材不能超过 1 MB');
        try { sourceText = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file)); }
        catch { throw new Error('文本素材必须是有效 UTF-8 编码'); }
        extracted = true;
      }
    }
    if (!supplied.trim() && !normalizedSource) throw new Error('请粘贴素材内容或关联一个文件');
    const content = text([supplied, sourceText].filter(Boolean).join('\n\n'), '素材正文');
    const storedContent = content || `已关联文件：${normalizedSource}\n\n未自动提取正文，请在阅读原文件后使用。`;
    const contentHash = sha(storedContent);
    let createdFile, createdOriginal, committed = false;
    try {
      const id = this.#transaction(() => {
        const old = this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId);
        if (old) {
          if (old.kind !== operationKind || old.input_hash !== fingerprint) throw new Error('素材操作标识已用于不同内容');
          return old.result_id;
        }
        const reused = internal.beforeCreate?.();
        if (reused) {
          this.db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?)').run(operationId, operationKind, fingerprint, reused);
          return reused;
        }
        const verified = refs === undefined ? [] : this.validateSourceRefs(requirement.id, refs);
        const materialId = randomUUID();
        directory(path.join(this.workspaceRoot, 'courses'));
        directory(path.join(this.workspaceRoot, 'courses', requirement.id));
        if (internal.importedFile) {
          const imports = path.join(this.workspaceRoot, 'courses', requirement.id, 'imports');
          directory(imports);
          directory(path.join(imports, operationId));
          const original = path.join(this.workspaceRoot, internal.importedFile.path);
          const descriptor = openSync(original, 'wx', 0o600);
          createdOriginal = original;
          try { writeFileSync(descriptor, internal.rawBytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
        }
        const targetDirectory = path.join(this.workspaceRoot, 'courses', requirement.id, 'materials');
        directory(targetDirectory);
        const base = materialFileBase(title, materialId);
        let file = path.join(targetDirectory, `${base}.md`), written = false;
        for (let attempt = 2; attempt <= 200 && !written; attempt += 1) {
          try {
            const descriptor = openSync(file, 'wx', 0o600);
            createdFile = file;
            try { writeFileSync(descriptor, storedContent, 'utf8'); fsyncSync(descriptor); } finally { closeSync(descriptor); }
            written = true;
          } catch (cause) {
            if (cause.code !== 'EEXIST') throw cause;
            file = path.join(targetDirectory, `${base}-${attempt}.md`);
          }
        }
        if (!written) {
          file = path.join(targetDirectory, `${materialId}.md`);
          const descriptor = openSync(file, 'wx', 0o600);
          createdFile = file;
          try { writeFileSync(descriptor, storedContent, 'utf8'); fsyncSync(descriptor); } finally { closeSync(descriptor); }
        }
        const relative = path.relative(this.workspaceRoot, file).split(path.sep).join('/');
        const now = new Date().toISOString();
        this.db.prepare('INSERT INTO canvas_materials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(materialId, requirement.id, title, storedContent, relative, normalizedSource, extracted ? 1 : 0, contentHash, now);
        this.db.prepare('INSERT INTO canvas_material_versions VALUES (?,?,?,?,?,?,?,?)')
          .run(randomUUID(), materialId, 1, storedContent, contentHash, relative, 'import', now);
        if (internal.importedFile) {
          const value = internal.importedFile;
          this.db.prepare('INSERT INTO canvas_imports VALUES (?,?,?,?,?,?,?,?,?,?)').run(materialId, operationId, value.name,
            value.path, value.hash, value.byteSize, value.mime, value.extractionStatus, value.truncated ? 1 : 0, value.extractionError || null);
          if (value.media) this.db.prepare('INSERT INTO canvas_import_media VALUES (?,?)').run(materialId, JSON.stringify(value.media));
        }
        if (internal.projectReference) this.db.prepare('INSERT INTO canvas_project_references VALUES (?,?,?,?)').run(materialId,requirement.id,internal.projectReference.path,internal.projectReference.hash);
        if (internal.association) this.db.prepare('INSERT INTO canvas_material_associations VALUES (?,?,?,?)').run(materialId,
          internal.association.cardId, internal.association.hash, internal.association.title);
        if (internal.whiteboardSource) {
          const value = internal.whiteboardSource;
          this.db.prepare('INSERT INTO canvas_whiteboard_snapshots VALUES (?,?,?,?,?,?)').run(materialId, requirement.id, value.elementId,
            value.contentHash, value.revision, value.elementKind);
        }
        if (excerptInfo) this.db.prepare('INSERT INTO canvas_excerpts VALUES (?,?,?,?,?,?,?,?,?)').run(materialId,
          excerptInfo.sourceCardId, excerptInfo.sourceHash, excerptInfo.start, excerptInfo.end, excerptInfo.quote,
          excerptInfo.annotation, excerptInfo.sourceTitle, excerptInfo.rangeLabel);
        for (const ref of verified) this.db.prepare('INSERT INTO canvas_material_sources VALUES (?,?,?,?,?)').run(materialId, ref.cardId, ref.hash, ref.title, ref.kind);
        this.db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?)').run(operationId, operationKind, fingerprint, materialId);
        const layout = this.#layout(requirement.id);
        if (internal.association) layout.edges.push({ id: `manual-association:${materialId}`, source: internal.association.cardId, target: `material:${materialId}` });
        if (input.position) layout.positions[`material:${materialId}`] = coordinate(input.position);
        this.#write(requirement.id, layout, layout.revision + 1);
        return materialId;
      });
      committed = true;
      const material = this.#materialResult(this.db.prepare('SELECT * FROM canvas_materials WHERE id=?').get(id));
      return { material, board: this.getBoard(requirement.id) };
    } finally {
      if (!committed && createdFile) unlinkSync(createdFile);
      if (!committed && createdOriginal) unlinkSync(createdOriginal);
    }
  }
}
