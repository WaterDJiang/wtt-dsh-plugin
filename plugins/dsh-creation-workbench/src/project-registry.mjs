import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchService } from './service.mjs';

const projectId = directory => createHash('sha256').update(directory).digest('hex');
const validId = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function directoryOf(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 4096 || !path.isAbsolute(value)) {
    throw new Error('请选择现有文件夹，或粘贴文件夹的绝对路径');
  }
  let canonical;
  try {
    canonical = realpathSync(value);
    if (!statSync(canonical).isDirectory()) throw new Error('所选路径不是文件夹');
    accessSync(canonical, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (error) {
    throw new Error(`项目目录不可用：${value}（${error.message}）`, { cause: error });
  }
  return canonical;
}

function atomicWrite(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.pending-${randomUUID()}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/** A browser selection changes navigation, never the service receiving an existing request. */
export class ProjectRegistry {
  constructor(config = {}) {
    this.config = config;
    this.closed = false;
    this.services = new Map();
    this.records = new Map();
    this.identities = new Map();
    const dataDir = () => { const base = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), next = path.join(base, 'wtt-creation-workbench'), previous = path.join(base, 'wtt-course-workbench'); if (!existsSync(next) && existsSync(previous)) { mkdirSync(next, { recursive: true }); writeFileSync(path.join(next, 'projects.json'), readFileSync(path.join(previous, 'projects.json'))); } return next; };
    this.registryFile = config.registryFile || path.join(dataDir(), 'projects.json');
    const service = new WorkbenchService(config);
    const root = service.workspaceRoot;
    this.defaultProjectId = projectId(root);
    this.activeProjectId = this.defaultProjectId;
    this.#load();
    const stored = this.records.get(this.defaultProjectId);
    this.records.set(this.defaultProjectId, stored || this.#record(root));
    this.#retain(this.defaultProjectId, service);
  }

  #assertOpen() { if (this.closed) throw new Error('项目工作台已关闭'); }

  #record(directory) {
    return { id: projectId(directory), name: path.basename(directory) || directory, path: directory, lastOpenedAt: new Date().toISOString() };
  }

  #load() {
    if (!existsSync(this.registryFile)) return;
    try {
      const saved = JSON.parse(readFileSync(this.registryFile, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.projects)) throw new Error('项目列表格式无效');
      for (const item of saved.projects) {
        if (!item || !validId(item.id) || typeof item.path !== 'string' || !path.isAbsolute(item.path)
          || item.path.includes('\0') || projectId(item.path) !== item.id || typeof item.lastOpenedAt !== 'string') {
          throw new Error('项目列表中存在无效目录记录');
        }
        this.records.set(item.id, { id: item.id, name: path.basename(item.path) || item.path, path: item.path, lastOpenedAt: item.lastOpenedAt });
      }
      if (validId(saved.activeProjectId) && this.records.has(saved.activeProjectId)) this.activeProjectId = saved.activeProjectId;
    } catch (error) {
      this.records.clear();
      this.registryError = `最近项目读取失败：${error.message}`;
    }
  }

  #retain(id, service) {
    const info = statSync(service.workspaceRoot);
    this.identities.set(id, { dev: info.dev, ino: info.ino });
    this.services.set(id, service);
    service.beforeFileInventory = relative => this.#quiesceWithin(service, path.join(service.workspaceRoot, relative));
  }

  #quiesceWithin(owner, target) {
    const matches = [...this.services].filter(([,candidate]) => candidate !== owner && candidate.workspaceRoot.startsWith(owner.workspaceRoot + path.sep) &&
      (candidate.workspaceRoot === target || candidate.workspaceRoot.startsWith(target + path.sep) ||
        target === path.join(candidate.workspaceRoot,'.wtt-workbench') || target.startsWith(path.join(candidate.workspaceRoot,'.wtt-workbench') + path.sep)));
    for (const [,candidate] of matches) for (const req of candidate.store.listRequirements()) for (const task of candidate.tasks.list(req.id)) {
      const phase = task.runtimeState?.phase;
      if ((task.mediaJob && !['succeeded','failed'].includes(task.mediaJob.status)) || (phase && !['idle','failed','cancelled','unknown'].includes(phase)) ||
        (['submitting','accepted','unknown'].includes(task.dispatchStatus) && !['idle','failed','cancelled'].includes(phase))) {
        throw new Error(`子项目「${path.basename(candidate.workspaceRoot)}」仍有任务可能运行，请先核对并停止原任务，再删除目录`);
      }
    }
    for (const [id,candidate] of matches) {
      const checkpoint = candidate.store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (checkpoint?.busy) throw new Error(`子项目「${path.basename(candidate.workspaceRoot)}」正在保存，请稍后重试`);
      candidate.close();
      this.services.delete(id);
      this.identities.delete(id);
    }
  }

  #directory(record) {
    const canonical = directoryOf(record.path);
    if (canonical !== record.path) throw new Error(`项目目录已改变，请重新打开：${record.path}`);
    const identity = this.identities.get(record.id);
    const info = statSync(canonical);
    if (identity && (identity.dev !== info.dev || identity.ino !== info.ino)) throw new Error(`项目目录已被替换，请重启后重新打开：${record.path}`);
    return canonical;
  }

  list() {
    this.#assertOpen();
    let activeProjectId = this.activeProjectId;
    let error = this.registryError;
    const active = this.records.get(activeProjectId);
    try { if (active) this.#directory(active); }
    catch (cause) { activeProjectId = this.defaultProjectId; error = `上次打开的项目不可用：${cause.message}`; }
    return { projects: [...this.records.values()].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt) || a.path.localeCompare(b.path)),
      activeProjectId, defaultProjectId: this.defaultProjectId, ...(error ? { error } : {}) };
  }

  open(value) {
    this.#assertOpen();
    const canonical = directoryOf(value);
    const record = this.#record(canonical);
    if (this.records.has(record.id)) this.#directory(this.records.get(record.id));
    let candidate = this.services.get(record.id);
    const created = !candidate;
    if (created) candidate = new WorkbenchService({ ...this.config, workspaceRoot: canonical });
    const next = new Map(this.records);
    next.set(record.id, record);
    // Synchronous publication serializes concurrent HTTP opens and only advances memory after durable success.
    try { atomicWrite(this.registryFile, { version: 1, activeProjectId: record.id, projects: [...next.values()] }); }
    catch (error) {
      if (created) candidate.close();
      throw new Error(`保存项目列表失败，当前项目未切换：${error.message}`, { cause: error });
    }
    this.records = next;
    this.activeProjectId = record.id;
    this.registryError = undefined;
    if (created) this.#retain(record.id, candidate);
    return record;
  }

  get(id) {
    this.#assertOpen();
    if (id === undefined) id = this.defaultProjectId;
    if (!validId(id)) throw new Error('项目标识无效，请重新选择项目目录');
    const record = this.records.get(id);
    if (!record) throw new Error('项目尚未打开，请先在创作工作台选择项目目录');
    const canonical = this.#directory(record);
    if (!this.services.has(id)) this.#retain(id, new WorkbenchService({ ...this.config, workspaceRoot: canonical }));
    return this.services.get(id);
  }

  forExecution(id, execution) {
    this.#assertOpen();
    if (id !== undefined && !validId(id)) throw new Error('项目标识无效');
    const cwd = execution?.agent?.session?.header?.cwd;
    if (cwd === undefined) {
      if (id !== undefined && id !== this.defaultProjectId) throw new Error('无法核对会话项目目录，不能访问其他项目');
      return this.get(this.defaultProjectId);
    }
    const actualId = projectId(directoryOf(cwd));
    if (!this.records.has(actualId)) throw new Error('会话所属项目尚未打开，请先在创作工作台选择该目录');
    if (id !== undefined && id !== actualId) throw new Error('工具的项目标识与当前会话目录不一致');
    return this.get(actualId);
  }

  idOf(service) { return projectId(service.workspaceRoot); }

  snapshot(service, value) { return { ...value, projectId: this.idOf(service) }; }

  prepared(service, value) {
    const id = this.idOf(service);
    const scope = value.contextVersion === 1 ? `工具项目：projectId=${id}`
      : `当前项目 projectId：${id}\n当前项目目录：${service.workspaceRoot}\n调用创作工作台工具时，必须原样传入 projectId=${id}；不要因界面切换而改用其他项目。`;
    return { ...value, projectId: id, prompt: `${value.prompt}\n\n${scope}` };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const service of this.services.values()) service.close();
    this.services.clear();
  }
}
