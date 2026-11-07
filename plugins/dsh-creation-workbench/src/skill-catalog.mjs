import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { access, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem';

const VALID_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hash = content => createHash('sha256').update(content).digest('hex');
const copySettings = settings => ({ directories: [...settings.directories], favorites: [...settings.favorites], aliases: { ...settings.aliases } });

function skillNames(values, field) {
  if (!Array.isArray(values) || values.length > 100 || values.some(value => typeof value !== 'string' || !VALID_NAME.test(value))) {
    throw new Error(`${field}必须是不超过 100 个合法 Skill 名称的数组`);
  }
  return [...new Set(values)];
}

async function settingsOf(value, { checkDirectories = true } = {}) {
  if (!value || !Array.isArray(value.directories) || value.directories.length > 32) throw new Error('请选择不超过 32 个本机 Skill 目录');
  const directories = [];
  for (const directory of value.directories) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0') || directory.length > 4096) {
      throw new Error('Skill 目录必须是现有文件夹的绝对路径');
    }
    if (!checkDirectories) { if (!directories.includes(directory)) directories.push(directory); continue; }
    try {
      const canonical = await realpath(directory);
      if (!(await stat(canonical)).isDirectory()) throw new Error('所选路径不是文件夹');
      await access(canonical, constants.R_OK | constants.X_OK);
      if (!directories.includes(canonical)) directories.push(canonical);
    } catch (cause) { throw new Error(`Skill 目录不可用：${directory}（${cause.message}）`, { cause }); }
  }
  const favorites = skillNames(value.favorites, '常用技能');
  if (value.aliases != null && (typeof value.aliases !== 'object' || Array.isArray(value.aliases))) throw new Error('快捷名称格式无效');
  const aliases = {};
  for (const [name, label] of Object.entries(value.aliases || {})) {
    if (!VALID_NAME.test(name) || typeof label !== 'string' || label.trim().length > 40 || /[\x00-\x1f\x7f]/.test(label)) throw new Error('快捷名称需为不超过40字的单行文字');
    if (favorites.includes(name) && label.trim()) aliases[name] = label.trim();
  }
  return { directories, favorites, aliases };
}

async function writeSettings(file, settings) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.pending-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ version: 2, ...settings }, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
  } finally {
    await handle?.close();
    try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/** A controller over the Host registry, with one disposable native filesystem provider. */
export async function createWorkbenchSkillCatalog(ctx, config = {}) {
  if (typeof ctx.plugin !== 'function' || typeof ctx.skills?.snapshot !== 'function' || typeof ctx.skills?.get !== 'function') {
    const unavailable = '当前 Host 未提供完整 Skill 目录接口；显式 Skill 调用不可用';
    return {
      async list() { return { skills: [], settings: { directories: [], favorites: [] }, warnings: [unavailable] }; },
      async resolve(_cwd, names) { if (skillNames(names, '调用的 Skill').length) throw new Error(unavailable); return []; },
      async save() { throw new Error(unavailable); },
      async updatePreference() { throw new Error(unavailable); },
      async close() {},
    };
  }
  const dataDir = () => { const base = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), next = path.join(base, 'wtt-creation-workbench'), previous = path.join(base, 'wtt-course-workbench'); if (!existsSync(next) && existsSync(previous)) { mkdirSync(next, { recursive: true }); writeFileSync(path.join(next, 'skill-settings.json'), readFileSync(path.join(previous, 'skill-settings.json'))); } return next; };
  const settingsFile = config.settingsFile || path.join(dataDir(), 'skill-settings.json');
  const startupWarnings = [];
  const automaticDirectories = [];
  const roots = config.skillDirectories === undefined ? (config.autoSkillDirectories || [
    path.join(os.homedir(), '.codex', 'skills'), path.join(os.homedir(), '.agents', 'skills'),
    path.join(os.homedir(), '.claude', 'skills'),
  ]) : [];
  for (const directory of roots) {
    try { const resolved = await realpath(directory); if ((await stat(resolved)).isDirectory() && !automaticDirectories.includes(resolved)) automaticDirectories.push(resolved); }
    catch (error) { if (error.code !== 'ENOENT') startupWarnings.push(`自动技能目录不可用：${directory}（${error.message}）`); }
  }
  const defaults = await settingsOf({ directories: config.skillDirectories || [], favorites: config.favoriteSkills || [], aliases: {} });
  let settings = defaults;
  try {
    const saved = JSON.parse(await readFile(settingsFile, 'utf8'));
    if (![1, 2].includes(saved.version)) throw new Error('不支持的技能设置版本');
    const oldNames = new Set(['wtt-course-eight-steps-dev','wtt-course-pptx-generator','wtt-course-pptx-builder','wtt-course-exercise-builder','wtt-course-scriptwriter','wtt-course-model-architect','wtt-course-game-designer','wtt-course-knowledge-question-answer','wtt-course-pptx-instructor-manual','wtt-course-pptx-student-manual','wtt-markdown-to-docx']);
    const migrate = name => saved.version === 1 && oldNames.has(name.replace(/-builtin$/, '')) ? name.replace(/-builtin$/, '') : name;
    settings = await settingsOf({ ...saved, favorites: [...new Set(saved.favorites.map(migrate))], aliases: saved.aliases || {} }, { checkDirectories: false });
    if (saved.version === 1) startupWarnings.push('已读取原有常用设置；插件内置课程技能已移除，现在使用本机技能。');
  } catch (error) {
    if (error.code !== 'ENOENT') startupWarnings.push(`技能设置读取失败，暂用启动配置；原设置文件保留：${error.message}`);
  }
  const rootsFor = current => [...new Set([...automaticDirectories, ...current.directories])];
  let closed = false;
  let queue = Promise.resolve();
  const run = action => {
    const result = queue.catch(() => {}).then(() => {
      if (closed) throw new Error('Skill 目录已关闭');
      return action();
    });
    queue = result;
    return result;
  };
  const initialCwd = config.workspaceRoot || process.cwd();

  async function mount(next) {
    let provider;
    const providerName = `wtt-course-local-${randomUUID()}`;
    const fork = ctx.plugin({
      name: providerName,
      inject: ['skills'],
      apply(child) {
        child.skills.registerProvider(control => {
          provider = new FileSystemSkillProvider(child, control, { providerName, includeDefaultRoots: false,
            customSkillDirs: rootsFor(next), watch: config.skillWatch !== false });
          return provider;
        });
        child.effect(() => () => provider.dispose());
      },
    });
    try { await fork; return { fork, provider }; }
    catch (error) { await fork.dispose(); throw error; }
  }

  async function observe(cwd, contribution, currentSettings, warnings = []) {
    const snapshot = await ctx.skills.snapshot({ cwd });
    if (!snapshot.complete) throw new Error('部分 Skill 来源发现未完成，请核对目录后重试');
    const visible = snapshot.skills.filter(skill => skill.invocation.userInvocable && skill.name !== 'wtt-creation-workbench');
    const available = new Map(visible.map(skill => [skill.name, skill]));
    const candidateResult = await contribution.provider.list({ cwd });
    if (!Array.isArray(candidateResult) && !candidateResult.complete) throw new Error('本机 Skill 目录发现未完成，请核对权限后重试');
    const candidates = Array.isArray(candidateResult) ? candidateResult : candidateResult.candidates;
    for (const directory of rootsFor(currentSettings)) {
      if (!candidates.some(candidate => candidate.path && path.relative(directory, candidate.path).split(path.sep)[0] !== '..'
        && !path.isAbsolute(path.relative(directory, candidate.path)))) {
        warnings.push(`Skill 目录未发现有效条目：${directory}；仅支持直属 SKILL.md 包或带合法 frontmatter 的 Markdown 文件`);
      }
    }
    const seen = new Map();
    for (const candidate of candidates) {
      const winner = snapshot.skills.find(skill => skill.name === candidate.name);
      if (winner && winner.path !== candidate.path) warnings.push(`Skill「${candidate.name}」存在同名条目，当前使用 ${winner.path || winner.provider}；未覆盖 ${candidate.path || candidate.provider}`);
      const previous = seen.get(candidate.name);
      if (previous && previous !== candidate.path) warnings.push(`额外目录含同名 Skill「${candidate.name}」：${previous}、${candidate.path}`);
      seen.set(candidate.name, candidate.path);
    }
    for (const name of currentSettings.favorites) if (!available.has(name)) warnings.push(`常用 Skill「${name}」当前不存在或不可由用户调用`);
    const favorites = new Set(currentSettings.favorites);
    return { skills: visible.map(skill => ({ name: skill.name, description: skill.description,
      origin: skill.path?.includes('dsh-claude-') ? '已安装插件' : '本机',
      label: currentSettings.aliases[skill.name] || null,
      path: skill.path ?? null, favorite: favorites.has(skill.name), provider: skill.provider, source: skill.source,
      modelInvocable: skill.invocation.modelInvocable, userInvocable: true,
      ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}) })), settings: copySettings(currentSettings), automaticDirectories: [...automaticDirectories],
      ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}) };
  }

  let active = await mount(settings);
  try { await observe(initialCwd, active, settings); }
  catch (error) { await active.fork.dispose(); throw error; }

  async function saveNext(value, cwd) {
    const sameDirectories = JSON.stringify(value.directories) === JSON.stringify(settings.directories);
    const next = await settingsOf(value, { checkDirectories: !sameDirectories });
    if (sameDirectories) {
      const preview = await observe(cwd || initialCwd, active, next);
      const missing = next.favorites.find(name => !settings.favorites.includes(name) && !preview.skills.some(skill => skill.name === name));
      if (missing) throw new Error(`技能「${missing}」当前不可用，请刷新后重新选择`);
      await writeSettings(settingsFile, next);
      settings = next; startupWarnings.length = 0;
      return preview;
    }
    const previous = active;
    let staged;
    let detached = false;
    let preview;
    try {
      staged = await mount(next);
      await observe(cwd || initialCwd, staged, next);
      // Remove the old contribution before validating winners: a lower-ranked
      // Host source may become callable when an extra directory is removed.
      detached = true;
      await previous.fork.dispose();
      preview = await observe(cwd || initialCwd, staged, next);
      const unavailable = next.favorites.find(name => !settings.favorites.includes(name) && !preview.skills.some(skill => skill.name === name));
      if (unavailable) throw new Error(`常用 Skill「${unavailable}」不在保存后的可调用目录内，请先移除或修正目录`);
      await writeSettings(settingsFile, next);
    } catch (error) {
      const rollbackErrors = [];
      try { await staged?.fork.dispose(); } catch (cause) { rollbackErrors.push(cause.message); }
      if (detached) {
        try {
          active = await mount(settings);
          await observe(cwd || initialCwd, active, settings);
        } catch (cause) { rollbackErrors.push(cause.message); }
      }
      if (rollbackErrors.length) throw new Error(`${error.message}；恢复旧 Skill 目录失败：${rollbackErrors.join('；')}`, { cause: error });
      throw error;
    }
    active = staged; settings = next; startupWarnings.length = 0;
    return preview;
  }
  return {
    list(cwd) { return run(() => observe(cwd || initialCwd, active, settings, [...startupWarnings])); },
    resolve(cwd, names) {
      return run(async () => {
        const requested = skillNames(names, '调用的 Skill');
        const result = [];
        for (const name of requested) {
          const skill = await ctx.skills.get(name, { cwd: cwd || initialCwd });
          if (!skill?.invocation.userInvocable) throw new Error(`技能「${name}」不存在或当前不可调用；原任务与文件保留，请重新选择本机技能创建任务。`);
          result.push({ name: skill.name, description: skill.description, path: skill.path ?? null, hash: hash(skill.content) });
        }
        return result;
      });
    },
    save(value, cwd) { return run(() => saveNext(value, cwd)); },
    updatePreference(value, cwd) {
      return run(() => {
        const [name] = skillNames([value?.name], '常用技能');
        if (name === 'wtt-creation-workbench') throw new Error('工作台系统指令不能设置为常用技能');
        if (value.favorite !== undefined && typeof value.favorite !== 'boolean') throw new Error('常用状态无效');
        const favorites = value.favorite === true ? [...new Set([...settings.favorites, name])]
          : value.favorite === false ? settings.favorites.filter(item => item !== name) : [...settings.favorites];
        const aliases = { ...settings.aliases };
        if (value.label !== undefined) aliases[name] = value.label;
        return saveNext({ ...copySettings(settings), favorites, aliases }, cwd);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await queue.catch(() => {});
      await active.fork.dispose();
    },
  };
}
