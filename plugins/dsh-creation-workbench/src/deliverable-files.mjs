import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, linkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const short = value => hash(String(value)).slice(0, 8);
const MAX_BYTES = 200 * 1024 * 1024;

export function deliverableName(value, limit = 120) {
  let name = String(value || '未命名产物').normalize('NFC').replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '') || '未命名产物';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  if (Buffer.byteLength(name) > limit) {
    const suffix = '--' + short(name);
    let text = '';
    for (const c of name) { if (Buffer.byteLength(text + c + suffix) > limit) break; text += c; }
    name = text + suffix;
  }
  return name;
}

/** Human-readable copies of registered outputs. Original paths and business rows stay authoritative. */
export class DeliverableFiles {
  constructor(store, { reveal } = {}) {
    this.store = store; this.db = store.db; this.cache = new Map(); this.reveal = reveal;
    this.db.exec(`CREATE TABLE IF NOT EXISTS deliverable_files (
      source_ref TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, source_path TEXT NOT NULL,
      title TEXT NOT NULL, relative_path TEXT NOT NULL, hash TEXT NOT NULL, version_number INTEGER NOT NULL,
      status TEXT NOT NULL, error TEXT, history_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL,
      mirrors_json TEXT NOT NULL DEFAULT '[]'
    )`);
    if (!this.db.prepare('PRAGMA table_info(deliverable_files)').all().some(column => column.name === 'mirrors_json')) this.db.exec("ALTER TABLE deliverable_files ADD COLUMN mirrors_json TEXT NOT NULL DEFAULT '[]'");
  }

  #file(relative) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0') || relative.split('/').includes('..')) throw new Error('产物路径无效');
    const file = path.resolve(this.store.workspaceRoot, relative);
    if (!file.startsWith(this.store.workspaceRoot + path.sep) || realpathSync(file) !== file) throw new Error('产物路径越界或使用了符号链接');
    const stat = lstatSync(file);
    if (!stat.isFile() || !stat.size || stat.size > MAX_BYTES) throw new Error('产物不是有效的真实文件');
    return { file, stat };
  }

  #digest(relative) {
    const { file, stat } = this.#file(relative);
    const signature = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
    const old = this.cache.get(file);
    if (old?.signature === signature) return old.hash;
    const digest = hash(readFileSync(file));
    this.cache.set(file, { signature, hash: digest });
    return digest;
  }

  #directory(relative) {
    let dir = this.store.workspaceRoot;
    for (const part of relative.split('/')) {
      if (!part || part === '.' || part === '..' || part.includes('\\')) throw new Error('整理目录无效');
      dir = path.join(dir, part);
      try { mkdirSync(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(dir) !== dir) throw new Error('整理目录不可使用符号链接或其他文件');
    }
    return dir;
  }

  #sources(requirementId) {
    const requirements = this.store.listRequirements();
    if (requirementId && !requirements.some(item => item.id === requirementId)) throw new Error('需求不存在');
    const result = [];
    for (const requirement of requirements.filter(item => !requirementId || item.id === requirementId)) {
      const sources = [];
      for (const v of this.db.prepare('SELECT * FROM outline_versions WHERE requirement_id=? ORDER BY number').all(requirement.id)) {
        sources.push({ ref: `outline:${v.id}`, path: v.markdown_path, hash: v.hash, title: `大纲 v${v.number}` });
        if (v.word_path) sources.push({ ref: `word:${v.id}`, path: v.word_path, title: `Word · 大纲 v${v.number}` });
      }
      for (const f of this.db.prepare('SELECT * FROM task_files WHERE requirement_id=? ORDER BY created_at,id').all(requirement.id)) {
        sources.push({ ref: `artifact:${f.id}`, path: f.path, hash: f.hash, title: f.title, kind: f.kind });
      }
      const byRef = new Map(sources.map(item => [item.ref, item]));
      const bindings = new Map(this.db.prepare(`SELECT o.source_ref,o.card_id,v.number FROM output_card_outputs o
        LEFT JOIN output_card_versions v ON v.id=o.version_id JOIN output_cards c ON c.id=o.card_id WHERE c.requirement_id=?`).all(requirement.id).map(row => [row.source_ref, row]));
      const heads = new Map(this.db.prepare(`SELECT c.id,v.primary_ref FROM output_cards c LEFT JOIN output_card_versions v ON v.id=c.head_version_id
        WHERE c.requirement_id=?`).all(requirement.id).map(row => [row.id, byRef.get(row.primary_ref)?.title]));
      for (const source of sources) {
        const binding = bindings.get(source.ref) || (source.ref.startsWith('word:') ? bindings.get(source.ref.replace('word:', 'outline:')) : null);
        source.requirementId = requirement.id;
        source.group = binding?.card_id || source.ref;
        source.cardTitle = heads.get(binding?.card_id) || (binding && !binding.number ? '制作资料' : source.title);
        source.version = binding ? binding.number || 0 : 1;
      }
      const groups = new Map(sources.map(item => [item.group, deliverableName(item.cardTitle)]));
      const courseName = deliverableName(requirement.title, 104);
      const courseCollision = requirements.some(item => item.id !== requirement.id && deliverableName(item.title, 104).toLowerCase() === courseName.toLowerCase());
      for (const source of sources) {
        const card = groups.get(source.group);
        const collision = [...groups].some(([key, name]) => key !== source.group && name.toLowerCase() === card.toLowerCase());
        const extension = path.extname(source.path);
        const title = source.title.toLowerCase().endsWith(extension.toLowerCase()) ? source.title.slice(0, -extension.length) : source.title;
        source.target = path.posix.join('产物', courseName + (courseCollision ? '--' + short(requirement.id) : ''),
          card + (collision ? '--' + short(source.group) : ''), source.version ? `V${String(source.version).padStart(3, '0')}` : '制作中',
          deliverableName(title, 180) + extension);
        result.push(source);
      }
    }
    // Retain registered local Markdown dependencies at their original relative names.
    // This copies no unregistered working files and never rewrites the document bytes.
    const byPath = new Map(result.map(source => [source.path, source]));
    for (const document of result.filter(source => path.extname(source.path).toLowerCase() === '.md')) {
      let content;
      try { const file = this.#file(document.path); if (file.stat.size > 1_048_576) continue; content = readFileSync(file.file, 'utf8'); }
      catch { continue; } // The primary copy reports the actual missing/unsafe source error.
      for (const match of content.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))/g)) {
        let relative;
        try { relative = decodeURIComponent((match[1] || match[2]).split(/[?#]/)[0]); } catch { continue; }
        if (!relative || /^[a-z][a-z\d+.-]*:/i.test(relative) || path.posix.isAbsolute(relative)) continue;
        const dependency = byPath.get(path.posix.normalize(path.posix.join(path.posix.dirname(document.path), relative)));
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(document.target), relative));
        if (dependency && target.startsWith(path.posix.dirname(document.target) + '/') && target !== dependency.target) {
          dependency.mirrors = [...new Set([...(dependency.mirrors || []), target])];
        }
      }
    }
    return result;
  }

  #copy(source, previous) {
    if (!source.path.startsWith(`courses/${source.requirementId}/`)) throw new Error('登记文件不在当前课程目录');
    const digest = this.#digest(source.path);
    if (digest !== (source.hash || previous?.hash || digest)) throw new Error('原产物已被外部修改，不能按旧版本整理');
    let target = source.target;
    if (previous?.relative_path && existsSync(path.join(this.store.workspaceRoot, previous.relative_path)) && this.#digest(previous.relative_path) !== previous.hash) throw new Error('整理副本已被修改，已保留；请核对后另存版本，不会覆盖');
    const owner = this.db.prepare('SELECT source_ref FROM deliverable_files WHERE relative_path=? AND source_ref<>?').get(target, source.ref);
    if (source.fixedTarget && owner && (!existsSync(path.join(this.store.workspaceRoot, target)) || this.#digest(target) !== digest)) throw new Error('相对引用的附件路径冲突，已有文件保留');
    if (!source.fixedTarget && (owner || existsSync(path.join(this.store.workspaceRoot, target)) && this.#digest(target) !== digest)) {
      const extension = path.extname(target);
      target = target.slice(0, -extension.length) + '--' + short(source.ref) + extension;
    }
    const directory = this.#directory(path.posix.dirname(target));
    if (existsSync(path.join(this.store.workspaceRoot, target))) {
      if (this.#digest(target) !== digest) throw new Error('整理目标已存在且内容不同，原文件已保留');
    } else {
      const temporary = path.join(directory, `.wtt-copy-${randomUUID()}.pending`);
      let temporaryCreated = false;
      try {
        copyFileSync(this.#file(source.path).file, temporary, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
        temporaryCreated = true;
        if (hash(readFileSync(temporary)) !== digest || this.#digest(source.path) !== digest) throw new Error('复制期间原产物发生变化，未发布整理文件');
        this.#directory(path.posix.dirname(target));
        try { linkSync(temporary, path.join(this.store.workspaceRoot, target)); }
        catch (error) { if (error.code !== 'EEXIST' || this.#digest(target) !== digest) throw error; }
      } finally { if (temporaryCreated && existsSync(temporary)) unlinkSync(temporary); }
    }
    return { target, digest };
  }

  sync(requirementId) {
    const files = [];
    for (const source of this.#sources(requirementId)) {
      const previous = this.db.prepare('SELECT * FROM deliverable_files WHERE source_ref=?').get(source.ref);
      let target = previous?.relative_path || source.target, digest = source.hash || previous?.hash || '', error = null;
      try {
        for (const mirror of JSON.parse(previous?.mirrors_json || '[]')) if (existsSync(path.join(this.store.workspaceRoot, mirror)) && this.#digest(mirror) !== previous.hash) throw new Error('相对引用附件的副本已被修改，已保留，不会覆盖');
        const copied = this.#copy(source, previous); target = copied.target; digest = copied.digest;
        for (const mirror of source.mirrors || []) this.#copy({ ...source, target: mirror, fixedTarget: true }, null);
      }
      catch (cause) { error = cause.code === 'ENOENT' ? '原产物或整理路径已缺失，未创建伪文件' : cause.message || String(cause); }
      const history = JSON.parse(previous?.history_json || '[]');
      if (previous?.relative_path && previous.relative_path !== target && !history.includes(previous.relative_path)) history.push(previous.relative_path);
      this.db.prepare(`INSERT INTO deliverable_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_ref) DO UPDATE SET
        source_path=excluded.source_path,title=excluded.title,relative_path=excluded.relative_path,hash=excluded.hash,
        version_number=excluded.version_number,status=excluded.status,error=excluded.error,history_json=excluded.history_json,updated_at=excluded.updated_at,mirrors_json=excluded.mirrors_json`)
        .run(source.ref, source.requirementId, source.path, source.title, target, digest, source.version, error ? 'failed' : 'ready', error, JSON.stringify(history), new Date().toISOString(), JSON.stringify(source.mirrors || []));
      if (!error && source.ref.startsWith('artifact:') && this.store.slides) {
        try { this.store.slides.syncEngineering(source.ref.slice(9)); }
        catch (cause) { this.db.prepare("UPDATE deliverable_files SET status='failed',error=? WHERE source_ref=?").run(`PPT 已保存，课件工程整理失败：${cause.message}`, source.ref); }
      }
      files.push(this.info(source.ref));
    }
    return { total: files.length, ready: files.filter(item => item.status === 'ready').length, failed: files.filter(item => item.status !== 'ready').length, files };
  }

  info(sourceRef) {
    const row = this.db.prepare('SELECT * FROM deliverable_files WHERE source_ref=?').get(sourceRef);
    if (!row) {
      if (!this.lastError) return null;
      const [kind, id] = String(sourceRef).split(':');
      const source = this.db.prepare(kind === 'artifact' ? 'SELECT requirement_id FROM task_files WHERE id=?' : 'SELECT requirement_id FROM outline_versions WHERE id=?').get(id);
      return source ? { sourceRef, requirementId: source.requirement_id, status: 'failed', error: this.lastError } : null;
    }
    let error = row.error;
    if (!error) try {
      if (this.#digest(row.source_path) !== row.hash) error = '原产物已被修改，定位已暂停';
      else if (this.#digest(row.relative_path) !== row.hash) error = '整理副本已被修改，原件保留';
      else for (const mirror of JSON.parse(row.mirrors_json || '[]')) if (this.#digest(mirror) !== row.hash) { error = '相对引用附件的副本已被修改，原件保留'; break; }
    } catch (cause) { error = cause.code === 'ENOENT' ? '产物或整理副本已缺失，请重新整理' : cause.message; }
    return { sourceRef: row.source_ref, requirementId: row.requirement_id, fileName: path.posix.basename(row.relative_path),
      path: row.relative_path, originalPath: row.source_path, version: row.version_number, hash: row.hash,
      status: error ? 'failed' : row.status, ...(error ? { error } : {}) };
  }

  async open({ sourceRef, requirementId }) {
    if (typeof sourceRef !== 'string' || !/^(artifact|outline|word):[0-9a-f-]{36}$/.test(sourceRef)) throw new Error('产物引用无效');
    if (!this.store.getRequirement(requirementId)) throw new Error('需求不存在');
    const [kind, id] = sourceRef.split(':');
    const source = this.db.prepare(kind === 'artifact' ? 'SELECT requirement_id FROM task_files WHERE id=?' : 'SELECT requirement_id,word_path FROM outline_versions WHERE id=?').get(id);
    if (source?.requirement_id !== requirementId || kind === 'word' && !source.word_path) throw new Error('产物不属于当前需求或没有对应文件');
    let file = this.info(sourceRef);
    if (!file) { this.sync(requirementId); file = this.info(sourceRef); }
    if (!file || file.requirementId !== requirementId) throw new Error('产物不属于当前需求');
    if (file.status !== 'ready') throw new Error(file.error || '整理尚未完成');
    const absolute = this.#file(file.path).file;
    if (this.reveal) await this.reveal(absolute);
    else {
      if (process.platform !== 'darwin') throw new Error('此环境暂不支持 Finder 定位，请使用显示的文件路径');
      await new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/open', ['-R', absolute], { stdio: 'ignore' });
        child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`Finder 定位失败：${code}`)));
      });
    }
    return file;
  }
}
