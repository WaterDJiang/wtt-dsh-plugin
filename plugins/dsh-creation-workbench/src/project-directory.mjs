import { accessSync, constants, readdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Read-only local folder browsing for Web compositions without the SDK browse capability. */
export function listProjectDirectory(value, { home = os.homedir(), maxEntries = 1000 } = {}) {
  const target = value === undefined || value === '' ? home : value;
  if (typeof target !== 'string' || target.includes('\0') || target.length > 4096 || !path.isAbsolute(target)) {
    throw new Error('目录路径无效，请输入现有文件夹的绝对路径');
  }
  let directory;
  let children;
  try {
    directory = realpathSync(target);
    if (!statSync(directory).isDirectory()) throw new Error('所选路径不是文件夹');
    accessSync(directory, constants.R_OK | constants.X_OK);
    children = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`无法浏览文件夹：${target}（${error.message}）`, { cause: error });
  }
  const entries = [];
  const limit = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : 1000;
  children.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) || a.name.localeCompare(b.name));
  let truncated = false;
  for (const child of children) {
    const childPath = path.join(directory, child.name);
    let isDirectory = child.isDirectory();
    if (!isDirectory && child.isSymbolicLink()) {
      try { isDirectory = statSync(childPath).isDirectory(); } catch { /* Broken or inaccessible links are not selectable directories. */ }
    }
    if (!isDirectory) continue;
    if (entries.length === limit) { truncated = true; break; }
    entries.push({ name: child.name, path: childPath, hidden: child.name.startsWith('.') });
  }
  const root = path.parse(directory).root;
  const crumbs = [{ name: root, path: root }];
  let ancestor = root;
  for (const name of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, name);
    crumbs.push({ name, path: ancestor });
  }
  return { path: directory, home: realpathSync(home), crumbs, entries, truncated };
}
