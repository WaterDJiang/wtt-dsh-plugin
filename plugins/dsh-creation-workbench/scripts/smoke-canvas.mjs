import { seedCanvasStress, checkCanvasStress } from './canvas-stress-smoke.mjs';
import { seedCanvasOverview, checkCanvasOverview } from './canvas-overview-smoke.mjs';
import { seedReadPerformance, checkReadPerformance } from './canvas-read-perf.mjs';
import { seedCanvasReads, checkCanvasReads } from './canvas-read-smoke.mjs';
import { seedReferenceSelection, checkReferenceSelection } from './canvas-reference-smoke.mjs';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WorkbenchService } from '../src/service.mjs';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const [scenario = 'all', ...extra] = process.argv.slice(2);
assert(!extra.length && ['all', 'delete', 'refresh', 'selection', 'send', 'references', 'reads', 'readperf', 'overview', 'stress','agent'].includes(scenario), '用法：node scripts/smoke-canvas.mjs [all|delete|refresh|selection|send|references|reads|readperf|overview|stress|agent]');
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
    const other = scenario==='agent' ? service.store.createCanvas({title:'项目助手目标画布',operationId:randomUUID()}).id : null;
    if(other)service.canvas.addMaterial({requirementId:id,title:'采访乙',content:'验收第二份来源',operationId:randomUUID()});
    const reference=other&&process.env.WTT_AGENT_UI_SMOKE==='1'
      ?service.canvas.addMaterial({requirementId:other,title:'项目资料丙',content:'跨画布引用验收',operationId:randomUUID()}).material:null;
    if(scenario==='agent'&&process.env.WTT_AGENT_AUDIT_PAGES==='1'){
      const {ProjectAgent}=await import('../src/project-agent.mjs');
      const agent=new ProjectAgent(service,{});
      for(let i=1;i<=101;i++){
        const turnId=randomUUID(),turn={mode:'plan',requirementId:id,sources:[],text:'审批样本'};
        agent.db.prepare('INSERT INTO pa_turns VALUES(?,?,?)').run(turnId,'archived',JSON.stringify(turn));
        agent.proposal(turnId,{title:'待办 '+i,steps:[{title:'脚本',instruction:'制作脚本',type:'text'}]},turn);
      }
    }
    return { id, nodeId, other, referenceId:reference&&'material:'+reference.id };
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

async function seedSend(workspace) {
  const service = new WorkbenchService({ workspaceRoot: workspace });
  try {
    return ['text', 'image', 'video'].map(type => {
      const { id } = service.store.createCanvas({ title: `发送刷新 ${type}`, operationId: randomUUID() });
      const { node } = service.createOutputDraft({ requirementId: id, outputType: type, selectedCardIds: [], sourceRefs: [],
        position: { x: 100, y: 160 }, operationId: randomUUID() });
      service.canvas.saveBoard({ requirementId: id, expectedRevision: service.canvas.getBoard(id).revision, viewport: { x: 20, y: 35, zoom: .7 } });
      return { id, nodeId: node.id, type };
    });
  } finally { service.close(); }
}

async function checkSend(page, canvas, cases, api) {
  const send = async (action, data) => {
    const reply = await page.request.post(api.href, { data: { action, data } }); assert(reply.ok(), `${action} HTTP ${reply.status()}: ${await reply.text()}`); return reply.json();
  };
  for (const entry of cases) {
    const closeSidebar = canvas.getByRole('button', { name: '关闭画布侧栏', exact: true });
    if (await closeSidebar.isVisible()) await closeSidebar.click();
    await page.getByRole('combobox', { name: '当前画布', exact: true }).selectOption(entry.id);
    const card = canvas.locator(`article[data-card-id="${entry.nodeId}"]`);
    await card.waitFor(); await card.locator('.wcc-card-body').click({ position: { x: 30, y: 160 } });
    const composer = canvas.locator('.wcc-card-composer:visible');
    await composer.locator('textarea').first().fill('合成发送刷新，不调用模型');
    const viewport = canvas.locator('.react-flow__viewport');
    await viewport.evaluate(node => { node.dataset.sendMarker = 'mounted'; });
    const transform = await viewport.getAttribute('style');
    const { promise: captured, resolve: capture, reject } = Promise.withResolvers();
    void captured.catch(() => {});
    const { promise: paused, resolve: resume } = Promise.withResolvers();
    const isBoard = url => url.pathname === api.pathname && url.searchParams.get('canvas') === entry.id;
    let submitted = false, blocked = false, created;
    const taskRoute = async route => {
      if (route.request().method() !== 'POST' || route.request().postDataJSON()?.action !== 'create-task') return route.continue();
      try {
      const response = await route.fetch(); assert(response.ok()); created = await response.json();
      // Mark the real synthetic task unknown before returning it. sendToAI must
      // stop before onStart, so no model or remote prompt can run in this test.
      await send('set-task-dispatch', { taskId: created.task.id, status: 'unknown' });
      created.task.dispatchStatus = 'unknown'; submitted = true;
      await route.fulfill({ response, json: created });
      } catch (error) { reject(error); await route.abort().catch(() => {}); }
    };
    const boardRoute = async route => {
      if (!submitted || blocked) return route.continue();
      blocked = true;
      try { const response = await route.fetch(); assert(response.ok()); capture(); await paused;
        if (entry.type === 'image') await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '合成发送后刷新失败' }) });
        else await route.fulfill({ response });
      } catch (error) { reject(error); await route.abort().catch(() => {}); }
    };
    await page.route(url => url.pathname === api.pathname, taskRoute);
    await page.route(isBoard, boardRoute);
    const timer = setTimeout(() => reject(new Error('发送后没有读取画布')), 10000);
    try {
      await composer.getByRole('button', { name: `生成${{ text: '文本', image: '图片', video: '视频' }[entry.type]}`, exact: true }).click();
      await captured;
      if (process.env.WTT_SMOKE_ARTIFACTS) { await mkdir(process.env.WTT_SMOKE_ARTIFACTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.WTT_SMOKE_ARTIFACTS, `send-${entry.type}.png`) }); }
      assert(await card.isVisible(), '发送后读取期间必须保留卡片');
      assert.equal(await canvas.locator('.wcc-loading').count(), 0, '发送不能显示首次加载遮罩');
      assert.equal(await viewport.getAttribute('data-send-marker'), 'mounted', '发送不能卸载视口');
      assert.equal(await viewport.getAttribute('style'), transform, '发送不能移动视口');
      const reply = page.waitForResponse(response => isBoard(new URL(response.url())));
      resume(); await reply;
      if (entry.type === 'image') {
        await canvas.getByRole('alert').filter({ hasText: '合成发送后刷新失败' }).waitFor();
        assert.equal(await canvas.locator('.wcc-load-error').count(), 0, '已有画布失败不能覆盖卡片');
        assert(await card.isVisible());
        if (process.env.WTT_SMOKE_ARTIFACTS) await page.screenshot({ path: path.join(process.env.WTT_SMOKE_ARTIFACTS, 'send-error.png') });
        await canvas.getByRole('button', { name: '重试刷新', exact: true }).click();
        await canvas.getByRole('alert').filter({ hasText: '合成发送后刷新失败' }).waitFor({ state: 'hidden' });
      } else await card.locator('.wcc-card-generation-status').filter({ hasText: '待核对' }).waitFor();
      assert.equal(await viewport.getAttribute('data-send-marker'), 'mounted');
      console.log('PASS 发送保留画布', entry.type, entry.type === 'image' ? '失败提示及重试' : '任务更新');
    } finally {
      clearTimeout(timer); resume();
      await page.unrouteAll({ behavior: 'wait' });
    }
  }
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
let host, browser, agentModel;
try {
  await run(process.execPath, ['scripts/build.mjs'], { cwd: repo, timeout: 30_000 });
  const workspace = path.join(temporary, 'workspace');
  await mkdir(workspace);
  const fixture = await seed(workspace);
  if(fixture.referenceId){
    const skillDir=path.join(workspace,'.agents','skills','wtt-qa-layout');
    await mkdir(skillDir,{recursive:true});
    await writeFile(path.join(skillDir,'SKILL.md'),'---\nname: wtt-qa-layout\ndescription: Isolated browser fixture\n---\n\nUse the QA marker WTT-SKILL-CONTENT-VERIFIED.\n');
  }
  const selectionCases = ['all', 'selection'].includes(scenario) ? await seedSelection(workspace) : null;
  const sendCases = ['all', 'send'].includes(scenario) ? await seedSend(workspace) : null;
  const overviewCases = (scenario === 'overview' || scenario === 'all' && process.env.WTT_OVERVIEW_ALL === '1') ? await seedCanvasOverview(workspace, run) : null;
  const referenceCase = ['all', 'references'].includes(scenario) ? await seedReferenceSelection(workspace, run) : null;
  const readCases = ['all', 'reads'].includes(scenario) ? await seedCanvasReads(workspace) : null;
  const readPerfCases = (scenario === 'readperf' || scenario === 'all' && process.env.WTT_READ_PERF === '1') ? seedReadPerformance(workspace) : null;
  const stressCases = scenario === 'stress' ? await seedCanvasStress(workspace, run) : null;
  if(scenario==='agent')agentModel=await (await import('./project-agent-smoke.mjs')).projectAgentModel(fixture);
  const env = { ...process.env,...agentModel?.env, DSH_HOME: path.join(temporary, 'dsh'), WTT_COURSE_WORKSPACE: workspace,
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}`, npm_config_offline: 'true',
    npm_config_store_dir: path.join(repo, '.runtime/pnpm-store') };
  const candidate = process.env.WTT_SMOKE_PACKAGE || repo;
  await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', candidate], { cwd: workspace, env, timeout: 30_000 });
  for (const file of ['src/canvas.jsx', 'src/canvas.css', 'dist/client.js']) assert.deepEqual(
    await readFile(path.join(candidate, file)), await readFile(path.join(env.DSH_HOME, 'profiles/web/node_modules/@wtt/dsh-creation-workbench', file)), `安装文件不一致：${file}`);
  host = spawn(process.execPath, [cli, 'web', '--port', '0', '--no-open'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const login = await loginUrl(host);
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 940 } });
  page.setDefaultTimeout(12000);
  const errors = [], consoleMessages = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) consoleMessages.push(message.text()); });
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
    if(scenario==='agent' && process.env.WTT_AGENT_AUDIT_STOP==='1'){
      const {checkProjectAgentStop}=await import('./project-agent-idle-audit.mjs');
      await checkProjectAgentStop(page,canvas,api,agentModel);
    } else if(scenario==='agent' && process.env.WTT_AGENT_AUDIT_PAGES==='1'){
      const {checkProjectAgentPages}=await import('./project-agent-idle-audit.mjs');
      await checkProjectAgentPages(canvas);
    } else if(scenario==='agent' && process.env.WTT_AGENT_AUDIT_IDLE==='1'){
      const { checkProjectAgentIdle }=await import('./project-agent-idle-audit.mjs');
      await checkProjectAgentIdle(page,canvas,api,agentModel);
    } else if(scenario==='agent'){
      await canvas.focus();await page.keyboard.press('Meta+a');
      const launcher=canvas.getByRole('button',{name:'打开项目助手'}),before=await launcher.boundingBox();
      assert.equal(before.width,40);
      assert.equal(before.height,40);
      assert.equal(await launcher.textContent(),'');
      const logo=launcher.locator('img');
      await logo.evaluate(img=>img.decode());
      assert.equal(await logo.evaluate(img=>img.naturalWidth),128);
      await page.mouse.move(before.x+20,before.y+15);await page.mouse.down();await page.mouse.move(before.x-100,before.y-58,{steps:8});await page.mouse.up();
      assert((await launcher.boundingBox()).x<before.x-50);await launcher.click();
      const panel=canvas.locator('.wtt-agent-float.is-open');
      await panel.getByRole('heading',{name:'项目助手',exact:true}).waitFor();
      const state=async()=>page.evaluate(async url=>{const r=await fetch(url,{method:'POST',body:JSON.stringify({action:'project-agent-state',data:{}})});return r.json()},api.href);
      await panel.locator('.wtt-native-editor-conversation [contenteditable=true]').first().waitFor({timeout:20000}).catch(async e=>{throw Error(e.message+' · '+await panel.innerText());});
      await panel.getByText('已选 2 张').waitFor();
      const bound=(await state()).sessionId;assert(bound);
      const plansTab=panel.getByRole('button',{name:'委托',exact:true});
      const chatTab=panel.getByRole('button',{name:'对话',exact:true});
      const mode=process.env.WTT_AGENT_SMOKE_MODE||'plan';
      const modeLabel={auto:'全自动',step:'逐项确认',plan:'先规划后执行'}[mode];
      if(mode!=='plan'){
        await panel.getByRole('button',{name:'执行方式 · 先规划后执行'}).click();await page.getByRole('menuitemradio',{name:modeLabel}).click();
      }
      const input=panel.locator('[contenteditable=true]').last();
      const routingLabel=input.locator('[data-composer-command="项目"]');
      await routingLabel.waitFor({state:'attached'});
      assert(await routingLabel.isHidden(),'自动加入的项目指令不应显示在输入框');
      assert.doesNotMatch(await input.innerText(),/\/项目/u);
      if(fixture.referenceId){
        const oldSize=await panel.boundingBox();
        const grip=panel.getByRole('button',{name:'调整浮窗大小'});
        const handle=await grip.boundingBox();
        assert(await grip.evaluate(el=>{
          const r=el.getBoundingClientRect();
          return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===el;
        }),'浮窗缩放手柄须能接收指针');
        await page.mouse.move(handle.x+10,handle.y+10);
        await page.mouse.down();await page.mouse.move(handle.x+44,handle.y-26,{steps:6});await page.mouse.up();
        await page.waitForFunction(({w,h})=>{
          const rect=document.querySelector('.wtt-agent-float.is-open')?.getBoundingClientRect();
          return rect?.width<w-25&&rect?.height<h-25;
        },{w:oldSize.width,h:oldSize.height},{timeout:3000});
        const resized=await panel.boundingBox();
        assert(resized.width<oldSize.width-25&&resized.height<oldSize.height-25);
        await panel.getByRole('button',{name:'收起项目助手'}).click();await launcher.click();
        assert.equal((await panel.boundingBox()).width,resized.width);
        await panel.getByText('已选 2 张',{exact:true}).click();
        await panel.getByRole('button',{name:'移除引用 采访乙'}).click();
        const selectCanvas=page.getByRole('combobox',{name:'当前画布',exact:true});
        await selectCanvas.selectOption(fixture.other);
        await panel.getByRole('button',{name:'画布引用',exact:true}).click();
        await panel.waitFor({state:'hidden'});
        await canvas.locator(`article[data-card-id="${fixture.referenceId}"] .wcc-reference-pick-card`).click();
        await canvas.getByRole('region',{name:'选择画布引用'}).getByRole('button',{name:'完成',exact:true}).click();
        await panel.getByText('已选 2 张',{exact:true}).waitFor();
        await selectCanvas.selectOption(fixture.id);
        await input.click();await input.press('End');
        await panel.getByRole('button',{name:'技能',exact:true}).click();
        await page.getByText('wtt-qa-layout',{exact:true}).click();
        assert.match(await input.innerText(),/wtt-qa-layout/,'原生技能菜单须把调用插入草稿');
        await plansTab.click();await chatTab.click();
        assert.match(await input.innerText(),/wtt-qa-layout/,'切换页签须保留草稿');
        if(process.env.WTT_SMOKE_ARTIFACTS){
          await mkdir(process.env.WTT_SMOKE_ARTIFACTS,{recursive:true});
          await panel.screenshot({path:path.join(process.env.WTT_SMOKE_ARTIFACTS,'project-assistant-chat.png')});
        }
      }
      await input.click();await input.press('End');await page.keyboard.insertText('从采访写脚本和分镜');await input.press('Enter');
      if(mode==='plan')await panel.getByRole('button',{name:'查看待授权计划'}).click({timeout:26000});
      else await plansTab.click();
      if(mode==='auto')await panel.getByText('浏览器跨画布委托',{exact:false}).first().waitFor({timeout:26000});
      else {
        const approve=panel.getByRole('button',{name:mode==='plan'?'授权并执行':'执行此项',exact:true});
        await approve.waitFor({timeout:26000}).catch(async e=>{throw Error(e.message+' · '+JSON.stringify(agentModel.calls)+' · '+await panel.innerText());});
        if(mode==='plan'){
          assert.equal((await state()).plans[0].steps.filter(s=>s.taskId).length,0);
          await panel.getByText('完成 0/2',{exact:true}).waitFor();
          if(fixture.referenceId&&process.env.WTT_SMOKE_ARTIFACTS)
            await panel.screenshot({path:path.join(process.env.WTT_SMOKE_ARTIFACTS,'project-assistant-plan.png')});
        }
        await approve.click();
      }
      await panel.getByRole('button',{name:'收起项目助手'}).click();
      if(process.env.WTT_AGENT_SMOKE_QUESTION==='1'){
        await launcher.click();await plansTab.click();await panel.getByText('原任务待确认',{exact:true}).waitFor({timeout:16000}).catch(async e=>{throw Error(e.message+' '+JSON.stringify({calls:agentModel.calls,state:await state()}));});
        assert.equal(agentModel.calls.filter(c=>c.name==='course_save_outline').length,0);
        await panel.getByRole('button',{name:'查看原任务',exact:true}).first().click();
        const answer=page.getByRole('radio',{name:'采用采访原文',exact:true}).last();
        await answer.click({timeout:20000});await answer.press('Enter');
      }
      if(mode==='step'){
        await launcher.click();
        await plansTab.click();
        await panel.getByRole('button',{name:'执行此项',exact:true}).click({timeout:25000});
        await panel.getByRole('button',{name:'收起项目助手'}).click();
      }
      const deadline=Date.now()+40000;
      let live=await state();
      while(live.plans[0]?.state!=='done'&&Date.now()<deadline&&!live.plans[0]?.steps.some(s=>s.state==='blocked')){
        await new Promise(resolve=>setTimeout(resolve,300));live=await state();
      }
      assert.equal(live.plans[0]?.state,'done',JSON.stringify({live,calls:agentModel.calls}));
      assert.equal(agentModel.calls.filter(c=>c.name==='course_save_outline').length,2,JSON.stringify(agentModel.calls));
      const sources=live.plans[0].steps[0].refs;assert.equal(sources.length,2);
      if(fixture.referenceId){
        assert.deepEqual(sources.map(s=>s.requirementId),[fixture.id,fixture.other]);
        assert.ok(sources.some(s=>s.cardId===fixture.referenceId&&s.hash));
        assert.ok(agentModel.skillInvocations.includes('supervisor')&&agentModel.skillInvocations.includes('task'),'DSH 应向助手和委托子任务都注入实际技能正文');
      }else assert.ok(sources.every(s=>s.requirementId===fixture.id));
      const receipts=(await state()).plans[0].steps.map(s=>s.receipt);assert(receipts.every(r=>r.requirementId===fixture.other&&r.versionId));
      await launcher.click();
      await plansTab.click();await panel.getByText('完成 2/2',{exact:true}).waitFor();
      await panel.getByRole('button',{name:'项目记忆',exact:true}).click();
      await panel.getByRole('button',{name:'新增设定'}).click();
      await panel.getByLabel('设定名称').fill('画幅');await panel.getByLabel('设定原文').fill('横屏 16:9');
      await panel.getByRole('button',{name:'保存设定'}).click();await panel.getByRole('button',{name:'画幅 · 项目'}).waitFor();
      await panel.getByLabel('查项目日志').fill('横屏');await panel.getByText(/画幅/).first().waitFor();
      const select=page.getByRole('combobox',{name:'当前画布',exact:true});
      if(await select.inputValue()===fixture.other)await select.selectOption(fixture.id);else await select.selectOption(fixture.other);
      await panel.locator('.wtt-native-editor-conversation [contenteditable=true]').first().waitFor();assert.equal((await state()).sessionId,bound);
      await panel.getByRole('button',{name:'执行方式 · '+modeLabel}).click();await page.getByRole('menuitemradio',{name:mode==='step'?'先规划后执行':'逐项确认'}).click();
      await panel.getByRole('button',{name:'项目记忆',exact:true}).click();
      await panel.getByRole('button',{name:'用项目记忆开新对话'}).click();
      await panel.locator('.wtt-native-editor-conversation [contenteditable=true]').first().waitFor();
      assert.notEqual((await state()).sessionId,bound);
      const nextInput=panel.locator('[contenteditable=true]').last();await nextInput.click();await nextInput.press('End');await page.keyboard.insertText('回忆验收，查画幅和脚本');await nextInput.press('Enter');
      const until=Date.now()+18000;while(!agentModel.evidence.length&&Date.now()<until)await new Promise(r=>setTimeout(r,250));
      assert.ok(agentModel.evidence.some(r=>r.includes('横屏 16:9')&&r.includes(receipts[1].versionId)),'新会话应检索设定及上次委托的真实版本');
      await page.setViewportSize({width:440,height:680});
      await page.waitForFunction(()=>{
        const box=document.querySelector('.wtt-agent-float.is-open')?.getBoundingClientRect();
        return box&&box.width>0&&box.left>=0&&box.right<=innerWidth+1;
      },null,{timeout:3000});
      if(fixture.referenceId&&process.env.WTT_SMOKE_ARTIFACTS){
        await panel.screenshot({path:path.join(process.env.WTT_SMOKE_ARTIFACTS,'project-assistant-narrow.png')});
        await page.evaluate(()=>{
          document.documentElement.dataset.dsThemeSource='dark';
          document.documentElement.style.colorScheme='dark';
          document.body.setAttribute('data-ds-dark-theme','');
        });
        assert.equal(await panel.evaluate(el=>getComputedStyle(el).colorScheme),'dark');
        assert.equal(await nextInput.isVisible(),true);
        await panel.screenshot({path:path.join(process.env.WTT_SMOKE_ARTIFACTS,'project-assistant-dark.png')});
      }
      await panel.getByRole('button',{name:'收起项目助手'}).click();await launcher.waitFor();
      const compact=await launcher.boundingBox();
      assert(compact.width===40&&compact.x>=0&&compact.x+compact.width<=440);
      console.log('PASS 两份来源跨画布生成两项主成果、DSH 原生对话、后台派发、浮标拖动、原文记忆、新会话接续与窄屏收起');
    }
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
    if (sendCases) await checkSend(page, canvas, sendCases, api);
    if (overviewCases) await checkCanvasOverview(page, canvas, overviewCases);
    if (referenceCase) await checkReferenceSelection(page, canvas, referenceCase, api);
    if (readCases) await checkCanvasReads(page, canvas, readCases, api);
    if (readPerfCases) await checkReadPerformance(page, canvas, readPerfCases, api);
    if (stressCases) await checkCanvasStress(page, canvas, stressCases, api);
    assert.deepEqual(errors, [], '页面不应抛出运行错误');
    assert.equal(consoleMessages.filter(message => message.includes('500')).length, sendCases ? 1 : 0, '仅允许合成刷新故障的一条500资源日志');
    assert.deepEqual(consoleMessages.filter(message => !message.includes('500')), [], '不应出现其他控制台错误或警告');
    console.log('PAGE', new URL(page.url()).origin, await page.title());
    console.log(`画布冒烟通过，用时 ${((performance.now() - start) / 1000).toFixed(1)} 秒`);
  } catch (error) {
    if (errors.length) console.error(errors.join('\n'));
    const screenshot = path.join(tmpdir(), `wtt-canvas-smoke-${process.pid}-failure.png`);
    await page.screenshot({ path: screenshot }).catch(() => {});
    try { console.error('冒烟失败现场', JSON.stringify({ screenshot, canvas: await page.getByRole('combobox', { name: '当前画布', exact: true }).inputValue(),
      viewport: await canvas.locator('.react-flow__viewport').getAttribute('style'),
      nodes: await canvas.locator('.react-flow__node').evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.id, style: node.getAttribute('style'),
        box: node.getBoundingClientRect().toJSON(), handles: [...node.querySelectorAll('.react-flow__handle')].map(handle => handle.className) }))),
      edges: await canvas.locator('.react-flow__edge').evaluateAll(edges => edges.map(edge => edge.dataset.id)) })); } catch {}
    throw error;
  }
} finally {
  agentModel?.close();
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
