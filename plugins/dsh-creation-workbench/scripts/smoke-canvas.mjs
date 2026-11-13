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
assert(!extra.length && ['all', 'delete', 'refresh', 'selection'].includes(scenario), '用法：node scripts/smoke-canvas.mjs [all|delete|refresh|selection]');
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

async function seedSelection(workspace) {
  const service = new WorkbenchService({ workspaceRoot: workspace });
  try {
    const cases = [];
    for (const [title, viewport] of [['平移缩放', { x: 55, y: -60, zoom: 0.7 }], ['缩小', { x: 110, y: 40, zoom: 0.5 }],
      ['放大', { x: 20, y: -160, zoom: 1.2 }], ['分组', { x: 70, y: -40, zoom: 0.65 }]]) {
      const { id } = service.store.createCanvas({ title, operationId: randomUUID() });
      const ids = {};
      for (const label of ['A', 'C', 'D']) {
        const { material } = service.canvas.addMaterial({ requirementId: id, title: `${label} 卡片`, content: '合成框选正文', operationId: randomUUID() });
        ids[label] = `material:${material.id}`;
      }
      ids.B = service.createOutputDraft({ requirementId: id, outputType: 'text', selectedCardIds: [], sourceRefs: [],
        position: { x: 470, y: 250 }, operationId: randomUUID() }).node.id;
      const group = title === '分组' ? `group:${randomUUID()}` : null;
      const linked = `edge:${randomUUID()}`, outside = `edge:${randomUUID()}`;
      service.canvas.saveBoard({ requirementId: id, expectedRevision: service.canvas.getBoard(id).revision,
        positions: { [ids.A]: { x: 100, y: 250 }, [ids.B]: { x: 470, y: 250 }, [ids.C]: { x: 1250, y: 850 }, [ids.D]: { x: 1900, y: 1400 } },
        edges: [{ id: linked, source: ids.A, target: ids.B }, { id: outside, source: ids.C, target: ids.D }],
        groups: group ? [{ id: group, title: '关联分组', nodeIds: [ids.A, ids.B] }] : [], viewport });
      cases.push({ id, ids, group, viewport, linked });
    }
    const { id } = service.store.createCanvas({ title: '300卡屏外框选', operationId: randomUUID() });
    const all = [];
    for (let i = 0; i < 300; i++) {
      const { material } = service.canvas.addMaterial({ requirementId: id, title: `性能 ${i}`, content: '合成正文。'.repeat(100), operationId: randomUUID() });
      all.push(`material:${material.id}`);
    }
    service.canvas.saveBoard({ requirementId: id, expectedRevision: service.canvas.getBoard(id).revision,
      positions: Object.fromEntries(all.map((node, i) => [node, { x: 100 + i % 15 * 350, y: 600 + Math.floor(i / 15) * 300 }])),
      viewport: { x: 40, y: -220, zoom: 0.5 } });
    cases.push({ id, ids: { A: all[0], B: all[1], C: all[2], D: all[3] }, group: null, linked: null });
    return cases;
  } finally { service.close(); }
}

async function checkSelection(page, canvas, cases, api) {
  const choose = page.getByRole('combobox', { name: '当前画布', exact: true });
  const card = id => canvas.locator(`article[data-card-id="${id}"]`);
  const selected = () => canvas.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => node.dataset.id).sort());
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const view = () => canvas.locator('.react-flow__viewport').getAttribute('style');
  const board = async id => {
    const url = new URL(api); url.searchParams.set('canvas', id);
    const reply = await page.request.get(url.href); assert(reply.ok()); return reply.json();
  };
  async function open(entry) {
    await choose.selectOption(entry.id);
    await card(entry.ids.A).waitFor();
    await frame();
    if (entry.linked) await canvas.locator(`.react-flow__edge[data-id="${entry.linked}"]`).waitFor({ state: 'attached' });
  }
  async function box(start, end, { shift = false, reverse = false, hold = 0 } = {}) {
    if (reverse) [start, end] = [end, start];
    await canvas.focus();
    if (shift) { await page.keyboard.down('Shift'); await frame(); }
    try {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 8 });
      if (hold) await page.waitForTimeout(hold);
      await frame();
    } finally {
      await page.mouse.up();
      if (shift) await page.keyboard.up('Shift');
    }
    await frame();
  }
  for (const entry of cases) {
    await open(entry);
    const before = await board(entry.id), viewport = await view();
    const a = await card(entry.ids.A).boundingBox(), b = await card(entry.ids.B).boundingBox();
    await box({ x: a.x - 14, y: a.y - 14 }, { x: b.x + 12, y: a.y + a.height + 14 }, { shift: !!entry.group });
    assert.deepEqual(await selected(), [entry.ids.A], '只擦到大卡边缘不能选中，框外未测量节点不能入选');
    if (entry.linked) await canvas.locator(`.react-flow__edge.selected[data-id="${entry.linked}"]`).waitFor({ state: 'attached' });
    assert.deepEqual(await canvas.locator('.react-flow__edge.selected').evaluateAll(edges => edges.map(edge => edge.dataset.id)), entry.linked ? [entry.linked] : [], '只选择实际框中卡片关联的连线');
    await box({ x: a.x - 10, y: a.y - 10 }, { x: a.x + a.width + 10, y: a.y + a.height + 10 }, { shift: !!entry.group, reverse: true });
    assert.deepEqual(await selected(), [entry.ids.A], '反向框选也必须完整包含');
    assert.equal(await view(), viewport, '框选不能移动视口');
    assert.deepEqual((await board(entry.id)).nodes.map(node => [node.id, node.position]), before.nodes.map(node => [node.id, node.position]), '框选不能改变卡片位置');
  }
  await open(cases[0]);
  const area = await canvas.locator('.react-flow').boundingBox(), viewport = await view();
  await box({ x: area.x + 45, y: area.y + 180 }, { x: area.x + area.width - 2, y: area.y + area.height - 3 }, { hold: 650 });
  assert.equal(await view(), viewport, '边缘停留不能让框选范围漂移');
  await open(cases[1]);
  const large = await card(cases[1].ids.B).boundingBox();
  await box({ x: large.x - 8, y: large.y - 8 }, { x: large.x + large.width + 8, y: large.y + large.height + 8 });
  assert.deepEqual(await selected(), [cases[1].ids.B], '完整框住640×512卡且清除旧选择');
  await open(cases[2]);
  await card(cases[2].ids.A).getByRole('heading').click();
  await page.keyboard.down('Meta');
  await card(cases[2].ids.B).getByRole('heading').click();
  await page.keyboard.up('Meta');
  assert.deepEqual(await selected(), [cases[2].ids.A, cases[2].ids.B].sort(), '原修饰键多选继续可用');
  const group = cases[3];
  await open(group);
  const p = await card(group.ids.A).boundingBox();
  await box({ x: p.x - 8, y: p.y - 8 }, { x: p.x + p.width + 8, y: p.y + p.height + 8 }, { shift: true });
  assert.deepEqual(await selected(), [group.ids.A]);
  const before = await board(group.id), heading = await card(group.ids.A).getByRole('heading').boundingBox();
  const saved = page.waitForResponse(reply => new URL(reply.url()).pathname === api.pathname
    && reply.request().method() === 'POST' && reply.request().postDataJSON()?.action === 'save-canvas');
  await page.mouse.move(heading.x + 20, heading.y + 8);
  await page.mouse.down();
  await page.mouse.move(heading.x + 70, heading.y + 38, { steps: 10 });
  await page.mouse.up();
  assert((await saved).ok());
  const after = await board(group.id);
  assert.notDeepEqual(after.nodes.find(node => node.id === group.ids.A).position, before.nodes.find(node => node.id === group.ids.A).position);
  assert.deepEqual(after.nodes.find(node => node.id === group.ids.B).position, before.nodes.find(node => node.id === group.ids.B).position, '拖动框中子卡不移动框外兄弟卡');
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
  const selectionCases = ['all', 'selection'].includes(scenario) ? await seedSelection(workspace) : null;
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
  await page.getByRole('combobox', { name: '当前画布', exact: true }).selectOption(fixture.id);
  const canvas = page.locator('.wtt-course-canvas:visible');
  const card = canvas.locator(`article[data-card-id="${fixture.nodeId}"]`);
  await card.waitFor();
  const api = new URL('/api/wtt-creation-workbench', login);
  api.searchParams.set('projectId', createHash('sha256').update(await realpath(workspace)).digest('hex'));
  try {
    if (['all', 'delete'].includes(scenario)) {
      await checkDelete(page, canvas, card, api.pathname);
      console.log('PASS 删除核对、取消、移除后视口复用和回收站恢复');
    }
    if (['all', 'refresh'].includes(scenario)) {
      await checkRefresh(page, canvas, card, api, fixture);
      console.log('PASS 后台刷新期间拖动与保存');
    }
    if (selectionCases) {
      await checkSelection(page, canvas, selectionCases, api);
      console.log('PASS 完整框选、反向、分组、缩放、大卡及边缘停留');
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
