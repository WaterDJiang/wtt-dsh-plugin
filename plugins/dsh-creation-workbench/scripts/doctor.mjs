import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { WorkbenchService } from '../src/service.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(path.join(os.tmpdir(), 'wtt-dsh-doctor-'));
let service;
try {
  service = new WorkbenchService({ workspaceRoot: temporary });
  const result = service.environment();
  const checks = [{ name: 'Node >=24', available: Number(process.versions.node.split('.')[0]) >= 24 },
    { name: 'DSH 0.2.1-rc.5 隔离运行时', available: existsSync(path.join(root, '.runtime/host/node_modules/@deepseek-ai/dsh/lib/bin.js')) },
    { name: '插件前端', available: existsSync(path.join(root, 'dist/client.js')) }, ...result.checks];
  for (const item of checks) console.log(`${item.available ? 'PASS' : 'FAIL'} ${item.name}${item.message ? `：${item.message}` : ''}`);
  console.log(`环境指纹：${result.fingerprint}`);
  console.log('媒体账号与宝玉插件需在工作台单独检查；未调用模型或读取课程业务。');
  process.exitCode = checks.every(item => item.available) ? 0 : 1;
} finally { service?.close(); rmSync(temporary, { recursive: true, force: true }); }
