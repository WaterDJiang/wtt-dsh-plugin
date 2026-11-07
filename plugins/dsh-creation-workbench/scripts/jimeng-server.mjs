#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.runtime/jimeng-backend');
const entry = path.join(directory, 'dist/index.js');
const stateFile = path.join(root, '.runtime/jimeng-server.json');
const marker = `--wtt-jimeng-instance=${root}`;
const action = process.argv[2] || 'status';
const portIndex = process.argv.indexOf('--port');
const port = portIndex < 0 ? 8000 : Number(process.argv[portIndex + 1]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须为 1024–65535');
const baseUrl = `http://127.0.0.1:${port}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
process.umask(0o077);

function record() {
  if (!existsSync(stateFile)) return null;
  try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return null; }
}
function owned(value) {
  if (!value || !Number.isInteger(value.pid) || value.pid < 2 || value.entry !== entry) return false;
  const command = spawnSync('ps', ['-p', String(value.pid), '-o', 'command='], { encoding: 'utf8' });
  return command.status === 0 && command.stdout.includes(entry) && command.stdout.includes(marker);
}
async function health(url) {
  try {
    const ping = await fetch(`${url}/ping`, { signal: AbortSignal.timeout(1500) });
    if (!ping.ok || !(await ping.text()).includes('pong')) return null;
    const models = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(1500) });
    const data = await models.json();
    if (!models.ok || !Array.isArray(data.data) || !data.data.some(item => typeof item.id === 'string' && item.id.startsWith('jimeng'))) return null;
    return data.data.map(item => item.id);
  } catch { return null; }
}
async function available() {
  const probe = net.createServer();
  return new Promise((resolve, reject) => {
    probe.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}
async function status() {
  const saved = record();
  const modelIds = await health(baseUrl);
  return { running: Boolean(modelIds), managed: owned(saved) && saved.baseUrl === baseUrl,
    ...(owned(saved) ? { pid: saved.pid } : {}), baseUrl, ...(modelIds ? { modelIds } : {}) };
}

if (action === 'start') {
  if (!(await available())) {
    const current = await status();
    if (current.running) console.log(JSON.stringify({ ...current, reused: true, message: current.managed ? '复用本脚本服务' : '已有兼容服务；未接管或停止该进程' }));
    else throw new Error(`端口 ${port} 已被其他服务占用，未停止或替换任何进程`);
  } else {
    if (!existsSync(entry)) throw new Error('隔离服务尚未构建；先运行 node scripts/jimeng-server-prepare.mjs');
    const saved = record();
    if (owned(saved)) throw new Error(`已存在本脚本服务 PID ${saved.pid}，请先核对其状态`);
    const privateDirectory = path.join(realpathSync(os.tmpdir()), 'wtt-dsh-jimeng-private');
    mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
    if (lstatSync(privateDirectory).isSymbolicLink() || realpathSync(privateDirectory) !== privateDirectory) throw new Error('即梦私有状态目录不能是符号链接');
    const logFile = path.join(directory, 'server.log');
    const browserExecutable = [process.env.JIMENG_CHROMIUM_EXECUTABLE,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].find(file => file && existsSync(file));
    const log = openSync(logFile, 'a', 0o600);
    const child = spawn(process.execPath, ['--enable-source-maps', '--no-node-snapshot', entry,
      '--host', '127.0.0.1', '--port', String(port), marker], {
      cwd: directory, detached: true, stdio: ['ignore', log, log],
      env: { ...process.env, SERVER_HOST: '127.0.0.1', SERVER_PORT: String(port), WTT_JIMENG_PRIVATE_DIR: privateDirectory,
        ...(browserExecutable ? { JIMENG_CHROMIUM_EXECUTABLE: browserExecutable } : {}) },
    });
    closeSync(log);
    const started = { pid: child.pid, entry, baseUrl, startedAt: new Date().toISOString(), logFile };
    let spawnError;
    child.on('error', error => { spawnError = error; });
    child.unref();
    if (!child.pid) throw new Error('即梦隔离服务未能创建进程');
    writeFileSync(stateFile, JSON.stringify(started, null, 2) + '\n', { mode: 0o600 });
    function abortStart(message) {
      if (owned(started)) process.kill(started.pid, 'SIGTERM');
      if (record()?.pid === started.pid) unlinkSync(stateFile);
      throw new Error(message);
    }
    let ready;
    for (let count = 0; count < 40; count += 1) {
      if (spawnError) break;
      if (!owned(started)) break;
      ready = await health(baseUrl);
      if (ready) break;
      await delay(250);
    }
    if (!ready) abortStart(`服务启动未通过健康检查${spawnError ? `：${spawnError.message}` : ''}；仅检查本项目日志 ${logFile}`);
    const listeners = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    if (!listeners.stdout.trim().split(/\s+/).includes(String(child.pid))) abortStart('健康端口不属于本次创建的进程，未接管其他服务');
    console.log(JSON.stringify({ running: true, managed: true, pid: child.pid, baseUrl, modelIds: ready }));
  }
} else if (action === 'status') {
  console.log(JSON.stringify(await status()));
} else if (action === 'stop') {
  const saved = record();
  if (!owned(saved)) throw new Error('没有可核对的本脚本进程，未停止任何服务');
  process.kill(saved.pid, 'SIGTERM');
  for (let count = 0; count < 40 && owned(saved); count += 1) await delay(100);
  if (owned(saved)) throw new Error(`本脚本进程 ${saved.pid} 尚未退出，未发送强制终止`);
  unlinkSync(stateFile);
  console.log(JSON.stringify({ running: false, stoppedPid: saved.pid, baseUrl: saved.baseUrl }));
} else throw new Error('用法：node scripts/jimeng-server.mjs start|status|stop [--port 8000]');
