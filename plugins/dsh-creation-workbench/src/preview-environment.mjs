import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const unixFonts = ['/usr/share/fonts', '/usr/local/share/fonts'];
const macFonts = [
  '/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts',
  '/System/Library/AssetsV2/com_apple_MobileAsset_Font8',
];
const windowsAbsolute = value => typeof value === 'string' && /^(?:[A-Z]:[\\/]|\\\\)/i.test(value);

export function defaultPreviewFontCandidates(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return platform === 'darwin' ? [...macFonts, ...unixFonts] : [...unixFonts];
  const root = [env.SystemRoot, env.WINDIR].find(windowsAbsolute) || 'C:\\Windows';
  const directories = [path.win32.join(root, 'Fonts')];
  if (windowsAbsolute(env.LOCALAPPDATA)) directories.push(path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  return directories;
}

export function resolvePreviewFontDirectories(override) {
  if (override === undefined || override === null) {
    const discovered = defaultPreviewFontCandidates().flatMap(directory => {
      try { return statSync(directory).isDirectory() ? [realpathSync(directory)] : []; }
      catch { return []; }
    });
    if (!discovered.length) throw new Error('预览字体目录无效：未找到可读取的系统或用户字体目录');
    return [...new Set(discovered)];
  }
  if (!Array.isArray(override) || !override.length || override.length > 20) throw new Error('预览字体目录无效：fontDirectories 需要 1–20 个本机绝对目录');
  return [...new Set(override.map(directory => {
    if (typeof directory === 'string' && path.isAbsolute(directory) && (process.platform !== 'win32' || windowsAbsolute(directory))) {
      try { if (lstatSync(directory).isDirectory()) return realpathSync(directory); }
      catch { /* Report the unusable directory below. */ }
    }
    throw new Error('预览字体目录必须是可读取的本机实际目录');
  }))];
}

function existingFile(candidate) {
  try { return statSync(candidate).isFile(); }
  catch { return false; }
}

export function windowsOfficeExecutable(platform = process.platform, env = process.env, isFile = existingFile) {
  if (platform !== 'win32') return undefined;
  const fromPath = (env.PATH || env.Path || '').split(';').map(directory => directory.replace(/^"(.*)"$/, '$1')).filter(windowsAbsolute);
  const installed = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']].filter(windowsAbsolute)
    .map(root => path.win32.join(root, 'LibreOffice', 'program'));
  // LibreOffice's Windows console launcher supplies the version and conversion output.
  for (const name of ['soffice.com', 'soffice.exe']) {
    const executable = [...fromPath, ...installed].map(directory => path.win32.join(directory, name)).find(isFile);
    if (executable) return executable;
  }
  return undefined;
}
