import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WorkbenchService } from '../src/service.mjs';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const [scenario = 'all', ...extra] = process.argv.slice(2);
assert(!extra.length && ['all', 'delete', 'refresh'].includes(scenario), '用法：node scripts/smoke-canvas.mjs [all|delete|refresh]');
const cli = path.join(repo, '.runtime/host/node_modules/@deepseek-ai/dsh/lib/bin.js');
assert(existsSync(cli), '按 README 准备隔离 DSH 运行时');
const playwright = ['.runtime/canvas-smoke', '.runtime/jimeng-backend'].map(dir =>
  new URL(`../${dir}/node_modules/playwright-core/index.mjs`, import.meta.url)).find(file => existsSync(file));
assert(playwright, '缺少 Playwright Core，按 README 安装画布冒烟依赖');
const { chromium } = await import(playwright.href);
const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.WTT_SMOKE_CHROME || (existsSync(macChrome) ? macChrome : chromium.executablePath());
assert(existsSync(executablePath), '请安装 Chrome，或设置 WTT_SMOKE_CHROME 指向 Chromium 可执行文件');

async function seed(workspace) {
  const service = new WorkbenchService({ workspaceRoot: workspace });
  try {
    const { id } = service.store.createCanvas({ title: '冒烟验收画布', operationId: randomUUID() });
    const { material } = await service.importMaterial({ requirementId: id, filename: '验收素材.md',
      bytes: Buffer.from('# 合成验收素材'), operationId: randomUUID() });
    const nodeId = `material:${material.id}`;
    service.canvas.saveBoard({ requirementId: id, expectedRevision: service.canvas.getBoard(id).revision,
      positions: { [nodeId]: { x: 80, y: 150 } }, viewport: { x: 0, y: 0, zoom: 0.8 } });
    return { id, nodeId };
  } finally { service.close(); }
}

async function loginUrl(host) {
  let output = '';
  const { promise, resolve, reject } = Promise.withResolvers();
  const timeout = setTimeout(() => reject(new Error('隔离 DSH 启动超时')), 15_000);
  const read = chunk => {
    output = (output + chunk).slice(-8000);
    const url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/)?.[0];
    if (url) resolve(url);
  };
  host.stdout.on('data', read);
  host.stderr.on('data', read);
  host.once('error', reject);
  host.once('exit', code => reject(new Error(`隔离 DSH 提前退出，退出码 ${code}`)));
  try { return await promise; }
  catch (error) {
    throw new Error(`${error.message}\n${output.replace(/token=[\w-]+/g, 'token=[已隐藏]').trim()}`, { cause: error });
  } finally { clearTimeout(timeout); }
}

async function checkDelete(page, canvas, card, apiPath) {
  await card.getByRole('heading').click();
  const button = canvas.getByRole('button', { name: '删除节点', exact: true });
  const dialog = page.getByRole('dialog', { name: '删除节点', exact: true });
  const { promise: captured, resolve: capture } = Promise.withResolvers();
  const { promise: held, resolve: release } = Promise.withResolvers();
  const isPlan = reply => new URL(reply.url()).pathname === apiPath
    && reply.request().method() === 'POST' && reply.request().postDataJSON()?.action === 'canvas-recycle-plan';
  const intercept = async route => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON()?.action !== 'canvas-recycle-plan') return route.continue();
    capture();
    await held;
    return route.continue();
  };
  await page.route(url => url.pathname === apiPath, intercept);
  try {
    await button.click();
    await captured;
    await dialog.getByRole('status').waitFor();
    assert(await dialog.getByRole('button', { name: '正在核对…', exact: true }).isDisabled());
    await dialog.locator('form').evaluate(form => form.requestSubmit());
    assert.equal(await dialog.getByRole('radio').count(), 0, '未核对完成不能选择或提交删除');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const reply = page.waitForResponse(isPlan);
    release();
    assert((await reply).ok());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await dialog.count(), 0, '取消后迟到的响应不能重开弹窗');
    await card.waitFor();
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
  const [response] = await Promise.all([page.waitForResponse(isPlan), button.click()]);
  assert(response.ok(), `删除确认计划失败，HTTP ${response.status()}`);
  await dialog.waitFor();
  assert(await dialog.getByRole('radio', { name: '只移除画布节点' }).isChecked());
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await card.waitFor();
  await canvas.locator('.react-flow__viewport').evaluate(el => { el.dataset.deleteMarker = 'retained'; });
  await button.click();
  await dialog.getByRole('radio', { name: '只移除画布节点' }).waitFor();
  await dialog.getByRole('button', { name: '移除节点', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await card.waitFor({ state: 'hidden' });
  assert.equal(await canvas.locator('.react-flow__viewport').getAttribute('data-delete-marker'), 'retained', '移除节点应复用画布视口');
  await page.getByRole('button', { name: /^打开文件栏/ }).click();
  await page.getByRole('button', { name: '项目回收站', exact: true }).click();
  const recycle = page.getByRole('dialog', { name: '项目回收站', exact: true });
  await recycle.getByRole('button', { name: '恢复', exact: true }).click();
  await card.waitFor();
  await recycle.getByRole('button', { name: '关闭项目回收站', exact: true }).click();
  await recycle.waitFor({ state: 'hidden' });
}

async function checkRefresh(page, canvas, card, api, { id, nodeId }) {
  const boardUrl = new URL(api);
  boardUrl.searchParams.set('canvas', id);
  const board = async () => {
    const reply = await page.request.get(boardUrl.href);
    assert(reply.ok(), `读取画布失败，HTTP ${reply.status()}`);
    return reply.json();
  };
  const send = async (action, data) => {
    const reply = await page.request.post(api.href, { data: { action, data } });
    assert(reply.ok(), `${action} 失败，HTTP ${reply.status()} ${await reply.text()}`);
    return reply.json();
  };
  async function drag(dx, dy) {
    const box = await card.getByRole('heading').boundingBox();
    assert(box, '卡片标题应可见且可拖动');
    const x = box.x + Math.min(box.width / 2, 24), y = box.y + box.height / 2;
    const saved = page.waitForResponse(reply => new URL(reply.url()).pathname === api.pathname
      && reply.request().method() === 'POST' && reply.request().postDataJSON()?.action === 'save-canvas');
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 8 });
    await page.mouse.up();
    const reply = await saved;
    assert(reply.ok(), `保存布局失败，HTTP ${reply.status()}`);
    return (await reply.json()).nodes.find(node => node.id === nodeId).position;
  }

  const source = (await board()).nodes.find(node => node.id === nodeId);
  const sourceId = source.sourceId || source.id;
  const { task } = await send('create-task', { requirementId: id, outputType: 'text', instruction: '合成任务状态',
    selectedCardIds: [sourceId], sourceRefs: [{ cardId: sourceId, hash: source.sourceHash }],
    selectedSkills: [], generation: { mode: 'new' }, operationId: randomUUID(), outputPosition: { x: 420, y: 220 } });
  await send('set-task-dispatch', { taskId: task.id, status: 'unknown' });

  const viewport = canvas.locator('.react-flow__viewport');
  await viewport.evaluate(el => { el.dataset.smokeMarker = 'mounted'; });
  const routeBoard = url => url.pathname === api.pathname && url.searchParams.get('canvas') === id;
  const { promise: captured, resolve: capture, reject } = Promise.withResolvers();
  const { promise: paused, resolve: resume } = Promise.withResolvers();
  let intercept = true;
  await page.route(routeBoard, async route => {
    if (!intercept) return route.continue();
    intercept = false;
    try {
      const response = await route.fetch();
      assert(response.ok(), `后台读取失败，HTTP ${response.status()}`);
      capture();
      await paused;
      await route.fulfill({ response });
    } catch (error) { reject(error); await route.abort().catch(() => {}); }
  });
  const timeout = setTimeout(() => reject(new Error('没有收到后台画布读取')), 12_000);
  try {
    const [before] = await Promise.all([drag(28, 22), captured]);
    assert(await card.isVisible(), '后台读取期间，卡片应保持显示');
    assert.equal(await canvas.locator('.wcc-loading').count(), 0, '后台读取不应进入首次加载');
    const after = await drag(47, 13);
    assert.notDeepEqual(after, before, '后台读取期间的新拖动应能保存');
    resume();
    await canvas.locator(`article[data-card-id="output:${task.outputCardId}"]`).waitFor();
    assert.equal(await viewport.getAttribute('data-smoke-marker'), 'mounted', '后台更新不应卸载视口');
    assert.deepEqual((await board()).nodes.find(node => node.id === nodeId).position, after);
    const actual = await card.evaluate(el => {
      const transform = new DOMMatrix(getComputedStyle(el.closest('.react-flow__node')).transform);
      return { x: transform.e, y: transform.f };
    });
    assert(Math.abs(actual.x - after.x) < 1 && Math.abs(actual.y - after.y) < 1, '过时响应不应覆盖卡片新坐标');
  } finally {
    clearTimeout(timeout);
    resume();
    await page.unrouteAll({ behavior: 'wait' });
  }
  const beforeFit = await board();
  const savedView = page.waitForResponse(reply => new URL(reply.url()).pathname === api.pathname
    && reply.request().method() === 'POST' && ['save-canvas-viewport', 'save-canvas'].includes(reply.request().postDataJSON()?.action));
  await canvas.getByRole('button', { name: '查看全部卡片', exact: true }).click();
  const fitted = await savedView;
  assert(fitted.ok(), `保存适应全部后的视口失败，HTTP ${fitted.status()}`);
  assert.notDeepEqual((await fitted.json()).viewport, beforeFit.viewport, '查看全部必须实际改变视口');
  assert.deepEqual((await board()).nodes.find(node => node.id === nodeId).position,
    beforeFit.nodes.find(node => node.id === nodeId).position, '适应全部不能修改卡片坐标');
}

const start = performance.now();
const temporary = await mkdtemp(path.join(tmpdir(), 'wtt-canvas-smoke-'));
let host, browser;
try {
  await run(process.execPath, ['scripts/build.mjs'], { cwd: repo, timeout: 30_000 });
  const workspace = path.join(temporary, 'workspace');
  await mkdir(workspace);
  const fixture = await seed(workspace);
  const env = { ...process.env, DSH_HOME: path.join(temporary, 'dsh'), WTT_COURSE_WORKSPACE: workspace,
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}`, npm_config_offline: 'true',
    npm_config_store_dir: path.join(repo, '.runtime/pnpm-store') };
  await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', repo], { cwd: workspace, env, timeout: 30_000 });
  host = spawn(process.execPath, [cli, 'web', '--port', '0', '--no-open'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const login = await loginUrl(host);
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 940 } });
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(login);
  const intro = page.getByRole('button', { name: '继续', exact: true });
  if (await intro.waitFor({ timeout: 1800 }).then(() => true, () => false)) await intro.click();
  const account = page.getByRole('dialog').filter({ hasText: '开始使用' }).getByRole('button', { name: '关闭', exact: true });
  if (await account.waitFor({ timeout: 1800 }).then(() => true, () => false)) await account.click();
  await page.getByRole('button', { name: 'WTT 创作工作台', exact: true }).click();
  const canvas = page.locator('.wtt-course-canvas:visible');
  const card = canvas.locator(`article[data-card-id="${fixture.nodeId}"]`);
  await card.waitFor();
  const api = new URL('/api/wtt-creation-workbench', login);
  api.searchParams.set('projectId', createHash('sha256').update(await realpath(workspace)).digest('hex'));
  try {
    if (scenario !== 'refresh') {
      await checkDelete(page, canvas, card, api.pathname);
      console.log('PASS 删除核对、取消、移除后视口复用和回收站恢复');
    }
    if (scenario !== 'delete') {
      await checkRefresh(page, canvas, card, api, fixture);
      console.log('PASS 后台刷新期间拖动与保存');
    }
    assert.deepEqual(errors, [], '页面不应抛出运行错误');
    console.log(`画布冒烟通过，用时 ${((performance.now() - start) / 1000).toFixed(1)} 秒`);
  } catch (error) {
    if (errors.length) console.error(errors.join('\n'));
    throw error;
  }
} finally {
  try { await browser?.close(); }
  finally {
    if (host?.pid && host.exitCode === null && host.signalCode === null) {
      const exited = once(host, 'exit');
      host.kill('SIGTERM');
      const force = setTimeout(() => host.kill('SIGKILL'), 3000);
      try { await exited; } finally { clearTimeout(force); }
    }
    await rm(temporary, { recursive: true, force: true });
  }
}
