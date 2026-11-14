import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { WorkbenchService } from '../src/service.mjs';

const run = promisify(execFile), repo = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(repo, '.runtime/host/node_modules/@deepseek-ai/dsh/lib/bin.js');
const playwright = ['.runtime/canvas-smoke', '.runtime/jimeng-backend'].map(dir => path.join(repo, dir, 'node_modules/playwright-core/index.mjs')).find(existsSync);
assert(playwright && existsSync(cli), '按README准备隔离DSH和Playwright运行时');
const { chromium } = await import(pathToFileURL(playwright).href);
const temporary = await mkdtemp(path.join(tmpdir(), 'wtt-chat-files-')), workspace = path.join(await realpath(temporary), 'workspace');
const artifacts = process.env.WTT_SMOKE_ARTIFACTS || temporary;
let host, browser;

async function fixture(ctx) {
  const { readFileSync } = await import('node:fs');
  const { createAssistantMessage, createUserMessage, createToolResultMessage } = await import(process.env.WTT_SMOKE_LLM_URL);
  const root = process.env.WTT_COURSE_WORKSPACE, f = JSON.parse(readFileSync(root + '/fixture.json', 'utf8'));
  const s = ctx.sessions.create(f.sessionId, { meta: { cwd: root } }), turn = 1, step = 0;
  const text = '仅合成验收，无模型调用。\n\n| 文件 | 审核 |\n| --- | --- |\n| [V2 双人中全景](working/image.png) | 合成图片 |\n| [视频片段](working/video.mp4) | 合成视频 |\n| [导演文档](working/document.md) | 合成文档 |';
  const args = JSON.stringify({ questions: [{ id: 'review', header: '合成审核', question: '是否采用这份合成内容？',
    options: [{ label: '采用', description: '仅明确提交才采用。' }, { label: '保留候选', description: '保留未提交选择。' }] }], timeout: 600 });
  s.append('turn/start', { turn }); s.append('step/start', { turn, step });
  s.append('request/header', { reason: 'initial', header: { config: { provider: 'manual-fixture', model: 'none' },
    tools: [{ name: 'ask_user_question', description: '合成问题', parameters: { type: 'object', properties: { questions: { type: 'array' }, timeout: { type: 'number' } } } }] } });
  s.append('user/message', createUserMessage({ content: [{ type: 'text', text: '仅查看合成文件。' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  s.append('assistant/message', { turn, step, message: createAssistantMessage({ content: [{ type: 'text', text }, { type: 'tool-call', id: f.callId, name: 'ask_user_question', arguments: args }], source: { provider: 'manual-fixture', model: 'none' } }),
    stream: [{ type: 'text-chunks', time0: Date.now(), index: 0, dt: [], texts: [text] }, { type: 'tool-call-chunks', time0: Date.now(), index: 1, dt: [], id: f.callId, name: 'ask_user_question', args: [args] }] }, { surfaceOp: 'append' });
  const call = s.append('tool/call', { turn, step, callId: f.callId, name: 'ask_user_question', arguments: args });
  s.append('tool/result', { turn, step, message: createToolResultMessage({ callId: f.callId, content: [{ type: 'text', text: JSON.stringify({ pending: true }) }], isError: false }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] });
  s.append('step/end', { turn, step }); s.append('step/start', { turn, step: 1 });
  s.append('assistant/message', { turn, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'manual-fixture', model: 'none' } }),
    stream: [{ type: 'text-chunks', time0: Date.now(), index: 0, dt: [], texts: [text] }] }, { surfaceOp: 'append' });
  s.append('step/end', { turn, step: 1 }); s.append('turn/end', { turn, reason: { kind: 'completed' } }); await ctx.sessions.flush(s);
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/wtt-chat-file-fixture', methods: ['GET'], requestBody: 'buffered',
    fetch: async () => Response.json({ sessionId: s.id, seq: s.seq, callId: f.callId }) }));
}

async function loginUrl(child) {
  let output = '';
  const { promise, resolve, reject } = Promise.withResolvers();
  const timer = setTimeout(() => reject(new Error('DSH启动超时：' + output.slice(-1200))), 15000);
  const read = chunk => { output += chunk; const url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/)?.[0]; if (url) resolve(url); };
  child.stdout.on('data', read); child.stderr.on('data', read); child.once('exit', code => reject(new Error('DSH退出：' + code)));
  try { return await promise; } finally { clearTimeout(timer); }
}

try {
  await mkdir(path.join(workspace, 'working'), { recursive: true }); await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(workspace, 'working/document.md'), '# 合成文档\n\n导演文档唯一正文。');
  await run('python3', ['-c', 'from PIL import Image;import sys;Image.new("RGB",(41,27),"blue").save(sys.argv[1])', path.join(workspace, 'working/image.png')]);
  await run('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x24:d=0.3', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(workspace, 'working/video.mp4')]);
  const service = new WorkbenchService({ workspaceRoot: workspace });
  let f;
  try {
    const canvas = service.store.createCanvas({ title: '对话媒体链接冒烟', operationId: randomUUID() });
    const task = service.createTask({ requirementId: canvas.id, outputType: 'text', selectedCardIds: [], selectedSkills: [], sourceRefs: [], generation: { mode: 'new' }, instruction: '合成媒体审核任务', operationId: randomUUID() }).task;
    f = { requirementId: canvas.id, sessionId: 'file-smoke-' + randomUUID(), callId: randomUUID() };
    service.tasks.bindSession({ taskId: task.id, sessionId: f.sessionId });
    await writeFile(path.join(workspace, 'fixture.json'), JSON.stringify(f));
  } finally { service.close(); }
  const plugin = path.join(temporary, 'fixture'); await mkdir(plugin);
  await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ name: 'wtt-chat-file-fixture', version: '1.0.0', type: 'module', exports: { '.': './index.mjs' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  await writeFile(path.join(plugin, 'index.mjs'), `export const name='wtt-chat-file-fixture';export const inject=['connection','sessions'];export const apply=${fixture.toString()};`);
  await writeFile(path.join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: wtt-chat-file-fixture\n      name: wtt-chat-file-fixture\n');
  const env = { ...process.env, DSH_HOME: path.join(temporary, 'dsh'), WTT_COURSE_WORKSPACE: workspace,
    WTT_SMOKE_LLM_URL: pathToFileURL(path.join(repo, '.runtime/host/node_modules/@deepseek-ai/dsh-llm/lib/index.js')).href,
    PATH: path.dirname(process.execPath) + ':' + process.env.PATH, npm_config_offline: 'true' };
  await run(process.execPath, ['scripts/build.mjs'], { cwd: repo, timeout: 30000 });
  const candidate = process.env.WTT_SMOKE_PACKAGE || repo;
  await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', candidate], { cwd: workspace, env, timeout: 30000 });
  await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', plugin], { cwd: workspace, env, timeout: 30000 });
  for (const file of ['src/embedded-conversation.jsx', 'src/client.jsx', 'dist/client.js']) assert.deepEqual(await readFile(path.join(candidate, file)), await readFile(path.join(env.DSH_HOME, 'profiles/web/node_modules/@wtt/dsh-creation-workbench', file)));
  host = spawn(process.execPath, [cli, 'web', '--port', '0', '--no-open'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const login = await loginUrl(host);
  browser = await chromium.launch({ executablePath: process.env.WTT_SMOKE_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10000);
  const errors = [], logs = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (['error', 'warning'].includes(message.type())) logs.push(message.text()); });
  try {
    await page.goto(login);
    const intro = page.getByRole('button', { name: '继续', exact: true }); if (await intro.waitFor({ timeout: 1800 }).then(() => true, () => false)) await intro.click();
    const account = page.getByRole('dialog').filter({ hasText: '开始使用' }).getByRole('button', { name: '关闭', exact: true }); if (await account.waitFor({ timeout: 1800 }).then(() => true, () => false)) await account.click();
    await page.getByRole('button', { name: 'WTT 创作工作台', exact: true }).click(); await page.getByRole('combobox', { name: '当前画布', exact: true }).selectOption(f.requirementId);
    const canvas = page.locator('.wtt-course-canvas:visible'); await canvas.locator('.wcc-skill-todo').first().click();
    const review = page.getByRole('dialog', { name: '任务待确认', exact: true }), chat = review.locator('.wtt-native-editor-conversation');
    await chat.getByRole('button', { name: 'V2 双人中全景', exact: true }).waitFor();
    await review.getByText('保留候选', { exact: true }).click(); assert(await review.getByRole('button', { name: '提交', exact: true }).isEnabled());
    const readState = () => page.request.get(new URL('/api/wtt-chat-file-fixture', login).href).then(reply => reply.json());
    const before = await readState();
    const close = async () => { await canvas.getByRole('button', { name: '关闭成果预览', exact: true }).click(); await review.waitFor({ state: 'visible' }); assert(await review.getByRole('button', { name: '提交', exact: true }).isEnabled()); };
    await chat.getByRole('button', { name: 'V2 双人中全景', exact: true }).click();
    const image = canvas.locator('.wtt-outcome-viewer img'); await image.waitFor(); await image.evaluate(async img => { await img.decode(); if (img.naturalWidth !== 41 || img.naturalHeight !== 27) throw new Error('图片内容不匹配'); });
    assert.equal(await review.isVisible(), false); await page.screenshot({ path: path.join(artifacts, 'image.png') }); await close();
    await chat.getByRole('button', { name: '视频片段', exact: true }).click();
    const video = canvas.locator('.wtt-outcome-viewer video'); await video.waitFor(); await video.evaluate(async item => { await item.play(); item.pause(); if (item.videoWidth !== 32) throw new Error('视频未正确解码'); }); await close();
    await chat.getByRole('button', { name: '导演文档', exact: true }).click(); await canvas.getByText('导演文档唯一正文。', { exact: false }).waitFor(); await close();
    assert.deepEqual(await readState(), before, '查看文件不能回答问题或改写原session');
    await review.getByRole('button', { name: '回到卡片对话', exact: true }).click();
    const main = canvas.locator('.wtt-native-conversation:visible');
    await main.getByRole('button', { name: 'V2 双人中全景', exact: true }).click(); await image.waitFor();
    await canvas.getByRole('button', { name: '关闭成果预览', exact: true }).click();
    assert.equal(await page.getByRole('dialog', { name: '无法打开文件' }).count(), 0); assert.deepEqual(errors, []); assert.deepEqual(logs, []);
    console.log('PASS 表格图片／视频／文档、真实解码播放、审核返回与未提交选择、原卡片chat');
    console.log('PAGE', new URL(page.url()).origin, await page.title());
  } catch (error) {
    await page.screenshot({ path: path.join(artifacts, 'failure.png') }); console.error('BODY', (await page.locator('body').innerText()).slice(-3500)); console.error('ERRORS', errors, 'CONSOLE', logs); throw error;
  }
} finally {
  await browser?.close();
  if (host?.pid && host.exitCode === null && host.signalCode === null) {
    const ended = once(host, 'exit'); host.kill('SIGTERM'); const timer = setTimeout(() => host.kill('SIGKILL'), 3000);
    try { await ended; } finally { clearTimeout(timer); }
  }
  await rm(temporary, { recursive: true, force: true });
}
