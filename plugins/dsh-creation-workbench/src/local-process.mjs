import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';

// Document converters and preview tools need the desktop session and its fonts.
const desktopVariables = [
  'PATH','HOME','USER','LOGNAME','LANG','LANGUAGE','LC_ALL','LC_CTYPE','LC_MESSAGES','TZ',
  'TMPDIR','TMP','TEMP','SystemRoot','WINDIR','USERPROFILE','HOMEDRIVE','HOMEPATH',
  'LOCALAPPDATA','APPDATA','ProgramFiles','ProgramFiles(x86)','ProgramW6432','COMSPEC','PATHEXT',
  'XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_RUNTIME_DIR','FONTCONFIG_PATH','FONTCONFIG_FILE',
  'DISPLAY','WAYLAND_DISPLAY','DBUS_SESSION_BUS_ADDRESS','VIRTUAL_ENV',
];

function optionsWithDesktopEnvironment(options) {
  const env = {};
  for (const name of desktopVariables) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { ...options, env: { ...env, ...options?.env } };
}

export function spawn(command, args, options) {
  return nodeSpawn(command, args, optionsWithDesktopEnvironment(options));
}

export function spawnSync(command, args, options) {
  return nodeSpawnSync(command, args, optionsWithDesktopEnvironment(options));
}
