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
assert(!extra.length && ['all', 'delete', 'refresh', 'selection', 'send', 'references', 'reads', 'readperf', 'overview', 'stress','agent','wechat','preview','first-material'].includes(scenario), '用法：node scripts/smoke-canvas.mjs [all|delete|refresh|selection|send|references|reads|readperf|overview|stress|agent|wechat|preview|first-material]');
const cli = process.env.WTT_SMOKE_DSH_BIN || path.join(repo, '.runtime/host/node_modules/@deepseek-ai/dsh/lib/bin.js');
assert(existsSync(cli), '按 README 准备隔离 DSH 运行时');
const [hostCommand,...hostArguments] = process.env.WTT_SMOKE_DSH_BIN ? [cli] : [process.execPath,cli];
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
    if (['all', 'delete'].includes(scenario)) {
      const archive = service.store.createCanvas({ title: '回收站长列表', operationId: randomUUID() });
      for (let i = 1; i <= 24; i++) {
        const { material: item } = service.canvas.addMaterial({ requirementId: archive.id,
          title: `清空验收记录 ${i}`, content: '合成回收记录', operationId: randomUUID() });
        const plan = service.recycle.plan({ requirementId: archive.id, selections: [{ nodeId: `material:${item.id}` }] });
        service.recycle.remove({ planId: plan.id });
      }
    }
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

async function seedPptPreview(workspace, requirementId) {
  const service = new WorkbenchService({ workspaceRoot: workspace });
  try {
    const requirement = service.store.getRequirement(requirementId);
    const instruction = '中文分页预览夹具';
    const node = service.canvas.getBoard(requirementId).nodes[0];
    const sourceRefs = [{ cardId: node.id, hash: node.sourceHash }];
    const input = { requirementId, instruction, outputType: 'pptx', selectedCardIds: [node.id], sourceRefs, operationId: randomUUID() };
    const task = service.tasks.create(input, { requirement, instruction, outputType: 'pptx', sourceRefs,
      sources: [{ cardId: node.id, title: node.title, kind: node.kind, hash: node.sourceHash, content: node.content }] });
    const sessionId = 'ppt-preview-smoke';
    service.tasks.bindSession({ taskId: task.id, sessionId });
    const directory = path.join(service.workspaceRoot, 'courses', requirementId, 'tasks', task.id, 'delivery');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, '中文预览.pptx');
    await run(service.python, ['-c', `from pptx import Presentation
from pptx.util import Inches, Pt
import sys
r=Presentation()
for page in range(1,3):
 s=r.slides.add_slide(r.slide_layouts[6])
 p=s.shapes.add_textbox(Inches(1), Inches(1), Inches(7), Inches(1)).text_frame.paragraphs[0]
 a=p.add_run()
 a.text='中文课件预览验收，第 '+str(page)+' 页'
 a.font.name='Microsoft YaHei'
 a.font.size=Pt(28)
r.save(sys.argv[1])`, file]);
    return await service.tasks.files.register({ taskId: task.id, kind: 'pptx', title: instruction, path: file, operationId: randomUUID() }, { sessionId });
  } finally { service.close(); }
}

async function checkPptPreview(page, canvas, api, artifact, invalidFonts) {
  await canvas.getByRole('button', { name: '内容详情', exact: true }).click();
  await canvas.getByRole('button', { name: '关闭画布侧栏', exact: true }).waitFor();
  const get = async fields => {
    const url = new URL(api);
    for (const [key,value] of Object.entries(fields)) url.searchParams.set(key, value);
    const reply = await page.request.get(url.href);
    assert(reply.ok(), `HTTP ${reply.status()}: ${await reply.text()}`);
    return reply;
  };
  const catalog = await (await get({ skills: '' })).json();
  assert(Array.isArray(catalog.skills));
  console.log('PASS 插件激活，画布、内容侧栏和技能目录可用');
  const manifest = await (await get({ artifactPreview: artifact.id, hash: artifact.hash })).json();
  if (invalidFonts) {
    assert.equal(manifest.status, 'failed');
    assert.match(manifest.error, /预览字体目录无效/);
    assert.deepEqual(manifest.pages, []);
  } else {
    assert.equal(manifest.status, 'ready', manifest.error);
    assert.equal(manifest.chineseGlyphCheck, 'passed');
    assert.equal(manifest.pageCount, 2);
    const png = await (await get({ artifactPreviewPage: artifact.id, page: '2', hash: artifact.hash })).body();
    assert.equal(createHash('sha256').update(png).digest('hex'), manifest.pages[1].hash);
  }
  const download = await (await get({ downloadArtifact: artifact.id })).body();
  assert.equal(createHash('sha256').update(download).digest('hex'), artifact.hash);
  console.log(invalidFonts ? 'PASS 字体配置故障仅影响 PPT 预览，下载原件匹配' : 'PASS 两页中文 PPT 渲染、中文字形和原件 hash 验证');
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
  await page.getByRole('button', { name: '文件栏操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '项目回收站', exact: true }).click();
  const recycle = page.getByRole('dialog', { name: '项目回收站', exact: true });
  await recycle.locator('article').filter({ hasNotText: '清空验收记录' }).getByRole('button', { name: '恢复', exact: true }).click();
  await card.waitFor();
  await checkPurgeConfirmation(page, recycle);
  await recycle.getByRole('button', { name: '关闭项目回收站', exact: true }).click();
  await recycle.waitFor({ state: 'hidden' });
}

async function checkPurgeConfirmation(page, recycle) {
  const desktop = page.viewportSize();
  const clear = recycle.getByRole('button', { name: '清空回收站', exact: true });
  const confirmation = page.getByRole('dialog', { name: '清空回收站', exact: true });
  try {
    for (const [viewport, colorScheme] of [[desktop, 'light'], [{ width: 320, height: 430 }, 'dark']]) {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize(viewport);
      await clear.click();
      const checkbox = confirmation.getByRole('checkbox', { name: '我确认永久删除，无法恢复' });
      const submit = confirmation.getByRole('button', { name: '确认永久删除', exact: true });
      const body = confirmation.locator('.wtt-recycle-body');
      await checkbox.waitFor();
      assert.equal(await confirmation.evaluate(el => getComputedStyle(el).colorScheme), colorScheme);
      assert.equal(await checkbox.isChecked(), false);
      assert(await submit.isDisabled());
      assert(await confirmation.evaluate(dialog => {
        const body = dialog.querySelector('.wtt-recycle-body');
        const footer = dialog.querySelector('footer');
        const box = footer.getBoundingClientRect();
        return footer.contains(dialog.querySelector('[type=checkbox]')) &&
          body.scrollHeight > body.clientHeight && body.scrollTop === 0 &&
          box.top >= body.getBoundingClientRect().bottom - 1 &&
          box.y >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth &&
          footer.scrollWidth <= footer.clientWidth;
      }), '长清单首屏必须完整显示底部勾选和操作按钮');
      await checkbox.check();
      assert(await submit.isEnabled());
      assert.equal(await body.evaluate(el => el.scrollTop), 0);
      if (process.env.WTT_SMOKE_ARTIFACTS) {
        await mkdir(process.env.WTT_SMOKE_ARTIFACTS, { recursive: true });
        await confirmation.screenshot({ path: path.join(process.env.WTT_SMOKE_ARTIFACTS, `purge-confirm-${viewport.width}.png`) });
      }
      await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await checkbox.uncheck();
      assert(await submit.isDisabled());
      assert(await body.evaluate(el => el.scrollTop > 0));
      await checkbox.check();
      await confirmation.getByRole('button', { name: '取消', exact: true }).click();
      await clear.waitFor();
    }
    await recycle.getByRole('button', { name: /^永久删除：清空验收记录/ }).first().click();
    const single = page.getByRole('dialog', { name: '永久删除', exact: true });
    const checkbox = single.getByRole('checkbox');
    await checkbox.waitFor();
    assert.equal(await checkbox.isChecked(), false);
    assert(await single.getByRole('button', { name: '确认永久删除', exact: true }).isDisabled());
    await page.keyboard.press('Escape');
    assert.equal(await recycle.locator('article').count(), 24, '取消后应保留全部回收记录');
  } finally {
    await page.emulateMedia({ colorScheme: null });
    await page.setViewportSize(desktop);
  }
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
    const receipt = await reply.json();
    const persisted = await board();
    assert.equal(persisted.revision, receipt.revision);
    return { receipt, position: persisted.nodes.find(node => node.id === nodeId).position, positionIds: Object.keys(reply.request().postDataJSON().data.positions) };
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
    const [{ receipt: changedTask, position: before }] = await Promise.all([drag(28, 22), captured]);
    assert(Array.isArray(changedTask.nodes), '任务变动需要完整画布回执');
    assert(await card.isVisible(), '后台读取期间，卡片应保持显示');
    assert.equal(await canvas.locator('.wcc-loading').count(), 0, '后台读取不应进入首次加载');
    const { receipt: moved, position: after, positionIds } = await drag(47, 13);
    assert(!positionIds.includes(`output:${task.outputCardId}`), '刷新尚未送达，位置快照不包含新任务卡');
    assert(Array.isArray(moved.nodes), '坐标覆盖不完整时继续返回完整画布');
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
  const { receipt: compact, position: persisted } = await drag(23, 17);
  if (!process.env.WTT_SMOKE_PACKAGE || 'layoutToken' in compact) {
    assert.deepEqual(compact.layout?.positions[nodeId], persisted, '新任务卡已挂载后，拖动保存返回真实坐标的轻量回执');
  }
  const beforeFit = await board();
  const savedView = page.waitForResponse(reply => new URL(reply.url()).pathname === api.pathname
    && reply.request().method() === 'POST' && ['save-canvas-viewport', 'save-canvas'].includes(reply.request().postDataJSON()?.action));
  await canvas.getByRole('button', { name: '查看全部卡片', exact: true }).click();
  const fitted = await savedView;
  assert(fitted.ok(), `保存适应全部后的视口失败，HTTP ${fitted.status()}`);
  assert.notDeepEqual((await fitted.json()).viewport, beforeFit.viewport, '查看全部必须实际改变视口');
  const latest = await board();
  assert.deepEqual(latest.nodes.find(node => node.id === nodeId).position,
    beforeFit.nodes.find(node => node.id === nodeId).position, '适应全部不能修改卡片坐标');
  assert.equal(latest.layoutToken, undefined, '旧画布读取入口维持完整回执协议');
  const conflict = await page.request.post(api.href, { data: { action: 'save-canvas', data: {
    requirementId: id, expectedRevision: latest.revision - 1, layoutToken: compact.layoutToken,
  } } });
  assert.equal(conflict.status(), 400, '轻量协议继续拒绝过期 revision');
  assert.match(await conflict.text(), /已被其他操作修改/);
  assert.equal((await board()).revision, latest.revision);
}

const start = performance.now();
const temporary = await mkdtemp(path.join(tmpdir(), 'wtt-canvas-smoke-'));
let host, browser, agentModel;
try {
  await run(process.execPath, ['scripts/build.mjs'], { cwd: repo, timeout: 30_000 });
  const workspace = path.join(temporary, 'workspace');
  await mkdir(workspace);
  const fixture = scenario === 'first-material' ? {} : await seed(workspace);
  const pptPreview = scenario==='preview' ? await seedPptPreview(workspace, fixture.id) : null;
  const invalidPreviewFonts = Boolean(pptPreview && process.env.WTT_SMOKE_INVALID_PREVIEW_FONTS==='1');
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
  const loopSmoke=scenario==='agent'&&process.env.WTT_AGENT_SMOKE_LOOP==='1';
  const loopCheck=loopSmoke?await import('./project-agent-loop-smoke.mjs'):null;
  const codexBin=loopCheck&&await loopCheck.prepareCodexFixture(temporary);
  const wechatSmoke=scenario==='wechat'?await import('./project-wechat-smoke.mjs'):null;
  const wechatFixture=wechatSmoke&&await wechatSmoke.prepareWechatSmoke(temporary);
  if(scenario==='agent'||wechatSmoke)agentModel=await (await import('./project-agent-smoke.mjs')).projectAgentModel({...fixture,workspace,wechat:Boolean(wechatSmoke)});
  const env = { ...process.env,...agentModel?.env, DSH_HOME: path.join(temporary, 'dsh'), WTT_COURSE_WORKSPACE: workspace,
    PATH: [codexBin,path.dirname(process.execPath),process.env.PATH].filter(Boolean).join(path.delimiter), npm_config_offline: 'true',
    npm_config_store_dir: path.join(repo, '.runtime/pnpm-store') };
  const candidate = process.env.WTT_SMOKE_PACKAGE || repo;
  await run(hostCommand, [...hostArguments, 'plugin', '--profile', 'web', 'add', candidate], { cwd: workspace, env, timeout: 30_000 });
  const checkedAssets=['src/canvas.jsx','src/canvas.css','dist/client.js',
    ...(wechatSmoke?['src/wechat-ilink.mjs','src/project-wechat.mjs','src/project-wechat-state.mjs','src/project-wechat-dispatch.mjs','src/project-wechat-language.mjs']:[]),
    ...(loopSmoke?['src/project-agent.mjs','src/project-agent-host.mjs','src/project-result-review.mjs','src/project-codex-executor.mjs']:[])];
  for (const file of checkedAssets) assert.deepEqual(
    await readFile(path.join(candidate, file)), await readFile(path.join(env.DSH_HOME, 'profiles/web/node_modules/@wtt/dsh-creation-workbench', file)), `安装文件不一致：${file}`);
  const overlay = path.join(temporary, 'preview-fonts.json');
  const noNativeSkillMenu=process.env.WTT_AGENT_SMOKE_NO_NATIVE_SKILL_MENU==='1';
  const patches=[...(invalidPreviewFonts?[{id:'wtt-creation-workbench',config:{fontDirectories:[]}}]:[]),
    ...(noNativeSkillMenu?[{id:'ui-skill',disabled:true}]:[])];
  if(patches.length)await writeFile(overlay,JSON.stringify(patches));
  const hostEnv=wechatSmoke?{...env,WTT_WECHAT_FIXTURE_DIR:wechatFixture.dir,
    NODE_OPTIONS:['--import='+new URL('./project-wechat-fixture.mjs',import.meta.url).href,env.NODE_OPTIONS].filter(Boolean).join(' ')}:env;
  host = spawn(hostCommand, [...hostArguments, 'web', ...(patches.length ? ['--patch', overlay] : []), '--port', '0', '--no-open'], { cwd: workspace, env:hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
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
  if (fixture.id) await page.getByRole('combobox', { name: '当前画布', exact: true }).selectOption(fixture.id);
  const canvas = page.locator('.wtt-course-canvas:visible');
  const card = canvas.locator(`article[data-card-id="${fixture.nodeId}"]`);
  if (fixture.nodeId) await card.waitFor();
  const api = new URL('/api/wtt-creation-workbench', login);
  api.searchParams.set('projectId', createHash('sha256').update(await realpath(workspace)).digest('hex'));
  try {
    if(wechatSmoke)await wechatSmoke.checkProjectWechat(page,canvas,api,fixture,workspace,wechatFixture);
    if (scenario === 'first-material') {
      const {checkFirstMaterial} = await import('./canvas-first-material-smoke.mjs');
      await checkFirstMaterial(page, workspace, api);
    }
    if (pptPreview) await checkPptPreview(page, canvas, api, pptPreview, invalidPreviewFonts);
    if(scenario==='agent' && process.env.WTT_AGENT_AUDIT_STOP==='1'){
      const {checkProjectAgentStop}=await import('./project-agent-idle-audit.mjs');
      await checkProjectAgentStop(page,canvas,api,agentModel);
    } else if(scenario==='agent' && process.env.WTT_AGENT_AUDIT_PAGES==='1'){
      const {checkProjectAgentPages}=await import('./project-agent-idle-audit.mjs');
      await checkProjectAgentPages(canvas);
    } else if(scenario==='agent' && process.env.WTT_AGENT_AUDIT_IDLE==='1'){
      const { checkProjectAgentIdle }=await import('./project-agent-idle-audit.mjs');
      await checkProjectAgentIdle(page,canvas,api,agentModel);
    } else if(loopCheck){
      await loopCheck.checkProjectAgentLoop(page,canvas,api,fixture,agentModel);
    } else if(scenario==='agent'){
      await card.locator('.wcc-card-body').click({position:{x:30,y:24}});
      const materialComposer=canvas.locator('.wcc-card-composer:visible');
      await materialComposer.locator('textarea').first().waitFor();
      await materialComposer.getByRole('button',{name:'关闭卡片创作框'}).click();
      const toolbar=canvas.getByRole('toolbar',{name:'白板工具'});
      const launcher=toolbar.getByRole('button',{name:'打开WTT 项目助手'});
      const before=await launcher.boundingBox();
      const materialTool=await toolbar.getByRole('button',{name:'添加素材'}).boundingBox();
      assert.equal(before.width,materialTool.width);
      assert.equal(before.x,materialTool.x);
      assert(before.y>=materialTool.y+materialTool.height);
      assert.equal(await canvas.getByRole('button',{name:'打开WTT 项目助手'}).count(),1);
      const logo=launcher.locator('img');
      await logo.evaluate(img=>img.decode());
      assert.equal(await logo.evaluate(img=>img.naturalWidth),128);
      await canvas.getByRole('button',{name:'放大画布',exact:true}).click();
      assert.deepEqual(await launcher.boundingBox(),before);
      await canvas.getByRole('button',{name:'缩小画布',exact:true}).click();
      await canvas.focus();await page.keyboard.press('Meta+a');
      await launcher.focus();await launcher.press('Enter');
      const panel=canvas.locator('.wtt-agent-float.is-open');
      await panel.getByRole('heading',{name:'WTT 项目助手',exact:true}).waitFor();
      assert.equal(await panel.evaluate(el=>getComputedStyle(el).borderColor),'rgb(0, 47, 167)');
      assert.match(await panel.evaluate(el=>getComputedStyle(el).boxShadow),/18px/,'浮窗应有克莱因蓝外光晕');
      assert.equal(await launcher.getAttribute('aria-expanded'),'true');
      const firstPosition=await panel.boundingBox();
      const titleBar=await panel.locator('.wtt-agent-grip').boundingBox();
      await page.mouse.move(titleBar.x+90,titleBar.y+16);await page.mouse.down();
      await page.mouse.move(titleBar.x-20,titleBar.y-16,{steps:8});await page.mouse.up();
      assert((await panel.boundingBox()).x<firstPosition.x-80);
      assert.deepEqual(await launcher.boundingBox(),before);
      await panel.getByRole('button',{name:'收起WTT 项目助手'}).click();
      assert.equal(await launcher.evaluate(button=>button===document.activeElement),true);
      assert.equal(await launcher.getAttribute('aria-expanded'),'false');
      assert.equal(await panel.count(),0);
      if(process.env.WTT_SMOKE_ARTIFACTS){
        await mkdir(process.env.WTT_SMOKE_ARTIFACTS,{recursive:true});
        await page.screenshot({path:path.join(process.env.WTT_SMOKE_ARTIFACTS,'project-assistant-toolbar.png')});
      }
      await launcher.click();
      assert((await panel.boundingBox()).x<firstPosition.x-80);
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
      const skillsButton=panel.getByRole('button',{name:'技能',exact:true});
      const fallbackSkillMenu=page.getByRole('region',{name:'选择技能',exact:true});
      const skillOptions=noNativeSkillMenu?fallbackSkillMenu:panel.locator('[data-trigger-menu]').filter({hasText:'wtt-qa-layout'});
      async function checkSkillMenuBounds(){
        const menu=await skillOptions.boundingBox(),button=await skillsButton.boundingBox(),nav=await panel.getByRole('navigation',{name:'WTT 项目助手视图'}).boundingBox();
        assert(menu&&button&&nav);
        const viewport=page.viewportSize();
        assert(menu.x>=0&&menu.x+menu.width<=viewport.width+1&&menu.y>=nav.y+nav.height-1&&menu.y+menu.height<=button.y+1,
          '技能菜单须在页签与技能按钮之间：'+JSON.stringify({menu,button,nav,viewport}));
        assert(await skillsButton.evaluate(button=>{
          const box=button.getBoundingClientRect();
          return button.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2));
        }),'菜单展开后技能按钮仍须可以点击');
      }
      async function pickSkill(){
        if(noNativeSkillMenu)await fallbackSkillMenu.getByRole('textbox',{name:'搜索技能'}).fill('wtt-qa-layout');
        await page.getByText('wtt-qa-layout',{exact:true}).filter({visible:true}).last().click();
      }
      const routingLabel=input.locator('[data-composer-command="项目"]');
      await routingLabel.waitFor({state:'attached'});
      assert(await routingLabel.isHidden(),'自动加入的项目指令不应显示在输入框');
      assert.doesNotMatch(await input.innerText(),/\/项目/u);
      if(fixture.referenceId){
        if(!noNativeSkillMenu){
          await input.click();await page.keyboard.type('/');
          await skillOptions.waitFor({timeout:5000});
          await checkSkillMenuBounds();
          if(process.env.WTT_SMOKE_ARTIFACTS)await page.screenshot({path:path.join(process.env.WTT_SMOKE_ARTIFACTS,'project-assistant-slash.png')});
          await page.keyboard.press('Escape');await skillOptions.waitFor({state:'hidden'});
          assert.match(await input.innerText(),/\//u);
          await input.press('Backspace');
          await page.keyboard.type('@"./');
          await panel.locator('[data-trigger-menu] [id^="dsh-slash-option-reference-"]').first().waitFor();
          assert.equal(await skillOptions.count(),0,'带斜杠的 @ 路径应继续打开文件引用');
          await page.keyboard.press('Escape');
          for(const char of '@"./')await input.press('Backspace');
        }
        await input.click();await page.keyboard.insertText('草稿验收');
        await skillsButton.click();await skillOptions.waitFor();
        await checkSkillMenuBounds();
        await skillsButton.click();await skillOptions.waitFor({state:'hidden'});
        await skillsButton.click();await skillOptions.waitFor();
        await page.keyboard.press('Escape');await skillOptions.waitFor({state:'hidden'});
        await skillsButton.click();await skillOptions.waitFor();
        await panel.getByRole('heading',{name:'WTT 项目助手',exact:true}).click();await skillOptions.waitFor({state:'hidden'});
        await skillsButton.click();await skillOptions.waitFor();
        await plansTab.press('Enter');await chatTab.press('Enter');
        await skillOptions.waitFor({state:'hidden'});
        assert.match(await input.innerText(),/草稿验收/);
        await input.press('End');
        for(let i=0;i<'草稿验收'.length;i++)await input.press('Backspace');
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
        await panel.getByRole('button',{name:'收起WTT 项目助手'}).click();await launcher.click();
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
        if(noNativeSkillMenu){
          await skillsButton.click();await pickSkill();
        }else{
          await page.keyboard.insertText('正文技能 ');
          await page.keyboard.type('/wtt-qa-lay');
          const option=skillOptions.getByRole('option',{name:/wtt-qa-layout/});
          await option.waitFor();
          if(await option.getAttribute('aria-selected')!=='true')await page.keyboard.press('ArrowDown');
          await skillOptions.getByRole('option',{name:/wtt-qa-layout/,selected:true}).waitFor();
          await page.keyboard.press('Enter');
          await skillOptions.waitFor({state:'hidden'});
          await input.filter({hasText:/正文技能\s+\/wtt-qa-layout/}).waitFor();
          assert.match(await input.innerText(),/正文技能\s+\/wtt-qa-layout/,'正文与选中的技能应保留');
          await page.keyboard.type('/wtt-qa-lay');
          await skillOptions.getByRole('option',{name:/wtt-qa-layout/}).waitFor();
          await page.keyboard.press('Escape');
          await skillOptions.waitFor({state:'hidden'});
          for(const char of '/wtt-qa-lay')await input.press('Backspace');
          console.log('PASS 斜杠搜索、键盘选择及已有技能后的再次触发');
        }
        assert.match(await input.innerText(),/wtt-qa-layout/,'原生技能菜单须把调用插入草稿');
        await plansTab.click();await chatTab.click();
        assert.match(await input.innerText(),/wtt-qa-layout/,'切换页签须保留草稿');
        if(process.env.WTT_SMOKE_ARTIFACTS){
          await mkdir(process.env.WTT_SMOKE_ARTIFACTS,{recursive:true});
          await panel.screenshot({path:path.join(process.env.WTT_SMOKE_ARTIFACTS,'project-assistant-chat.png')});
        }
      }
      await input.click();await input.press('End');await page.keyboard.insertText('从采访写脚本和分镜');await input.press('Enter');
      const review=panel.getByRole('region',{name:'对话授权',exact:true});
      if(mode==='auto')await plansTab.click();
      else await review.waitFor({timeout:26000});
      if(mode==='plan'&&fixture.referenceId){
        await panel.getByText('已核对工作台回执。',{exact:true}).last().waitFor();
        await input.click();await input.press('End');await page.keyboard.insertText('保留这段草稿 ');
        await skillsButton.click();
        if(noNativeSkillMenu){
          await fallbackSkillMenu.getByRole('textbox',{name:'搜索技能'}).focus();await page.keyboard.press('Escape');
          await fallbackSkillMenu.waitFor({state:'hidden'});
          assert.match(await input.innerText(),/保留这段草稿/);
          await input.click();await input.press('End');await skillsButton.click();
        }
        await pickSkill();
        assert.match(await input.innerText(),/wtt-qa-layout/,'有对话历史时仍能选择技能');
        assert.match(await input.innerText(),/保留这段草稿/,'选择技能应保留已有草稿');
      }
      if(mode==='auto')await panel.getByText('浏览器跨画布委托',{exact:false}).first().waitFor({timeout:26000});
      else {
        const approve=review.getByRole('button',{name:mode==='plan'?'授权并执行':'执行此项',exact:true});
        await approve.waitFor({timeout:26000}).catch(async e=>{throw Error(e.message+' · '+JSON.stringify(agentModel.calls)+' · '+await panel.innerText());});
        assert.equal(await chatTab.getAttribute('aria-pressed'),'true','同一对话页内完成授权');
        if(mode==='plan'){
          assert.equal((await state()).plans[0].steps.filter(s=>s.taskId).length,0);
          await review.getByText(/脚本 · /).click();
          await review.getByText(/写验收脚本/).waitFor();
          const viewport=page.viewportSize();
          await page.setViewportSize({width:440,height:680});
          await approve.scrollIntoViewIfNeeded();
          assert(await input.isVisible());
          if(fixture.referenceId&&process.env.WTT_SMOKE_ARTIFACTS)
            await panel.screenshot({path:path.join(process.env.WTT_SMOKE_ARTIFACTS,'project-assistant-plan.png')});
          await page.setViewportSize(viewport);
        }
        await approve.click();
        assert.equal(await chatTab.getAttribute('aria-pressed'),'true');
      }
      await panel.getByRole('button',{name:'收起WTT 项目助手'}).click();
      const checkHandoff=process.env.WTT_AGENT_SMOKE_HANDOFF==='1';
      assert(!checkHandoff||(mode==='plan'&&process.env.WTT_AGENT_SMOKE_QUESTION==='1'),'交接冒烟需要计划授权与原生提问');
      let adoptedVersion;
      if(process.env.WTT_AGENT_SMOKE_QUESTION==='1'){
        await launcher.click();await plansTab.click();await panel.getByText('原任务待确认',{exact:true}).waitFor({timeout:16000}).catch(async e=>{throw Error(e.message+' '+JSON.stringify({panel:await panel.innerText(),calls:agentModel.calls,state:await state()}));});
        assert.equal(agentModel.calls.filter(c=>c.name==='course_save_outline').length,0);
        if(checkHandoff)await panel.getByRole('button',{name:'暂停',exact:true}).click();
        await panel.getByRole('button',{name:'打开卡片对话',exact:true}).first().click();
        const answer=page.getByRole('radio',{name:'采用采访原文',exact:true}).last();
        await answer.click({timeout:20000});await answer.press('Enter');
      }
      if(checkHandoff){
        const deadline=Date.now()+16000;
        let plan=(await state()).plans[0];
        while(!plan?.steps[0].receipt&&Date.now()<deadline){
          await new Promise(resolve=>setTimeout(resolve,300));plan=(await state()).plans[0];
        }
        const first=plan.steps[0];
        assert.equal(first.receipt?.number,1,JSON.stringify(plan));
        assert.equal(plan.state,'paused');assert.equal(plan.steps[1].taskId,null);
        const takeover=page.getByRole('button',{name:'接管这一步',exact:true});
        await takeover.waitFor();
        if(process.env.WTT_AGENT_SMOKE_NATIVE_FOLLOWUP==='1'){
          const original=page.getByRole('button',{name:'原对话',exact:true});
          if(await original.isVisible()&&await original.getAttribute('aria-expanded')==='false')await original.click();
          const nativeInput=page.locator('.wcc-creation-conversation [contenteditable=true]').last();
          await nativeInput.click();await page.keyboard.insertText('验收手动补充');await nativeInput.press('Enter');
        }else await takeover.click();
        await page.getByText('你正在处理',{exact:true}).waitFor();
        if(process.env.WTT_AGENT_SMOKE_NATIVE_FOLLOWUP==='1'){
          assert(agentModel.followups.includes(first.taskId));
          console.log('PASS 卡片在原生对话补充要求后接管确切的原步骤');
        }
        const url=new URL(api.href);
        url.searchParams.set('outputCard',first.outputCardId);url.searchParams.set('requirementId',first.requirementId);
        const {node}=await (await page.request.get(url.href)).json();
        const upload=new URL(api.href);
        upload.searchParams.set('uploadCardContent',first.requirementId);
        upload.searchParams.set('target',JSON.stringify({nodeId:node.id,versionId:first.receipt.versionId,headVersionId:first.receipt.versionId,sourceHash:node.sourceHash}));
        upload.searchParams.set('filename','manual-revision.md');upload.searchParams.set('operationId',randomUUID());
        const result=await page.request.post(upload.href,{headers:{'Content-Type':'application/octet-stream'},data:Buffer.from('# 用户确认的脚本 V2')});
        assert(result.ok(),await result.text());
        adoptedVersion=(await result.json()).versionId;
        await page.getByRole('button',{name:'交回助手 · V2',exact:true}).click();
        await launcher.click();await plansTab.click();await panel.getByRole('button',{name:'定位 V2',exact:true}).waitFor();
        assert.equal((await state()).plans[0].steps[1].taskId,null);
        await panel.getByRole('button',{name:'继续剩余步骤',exact:true}).click();
        await panel.getByRole('button',{name:'收起WTT 项目助手'}).click();
      }
      if(mode==='step'){
        await launcher.click();
        await review.getByText(/分镜 · /).waitFor({timeout:25000});
        await review.getByRole('button',{name:'执行此项',exact:true}).click();
        await panel.getByRole('button',{name:'收起WTT 项目助手'}).click();
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
      if(adoptedVersion){
        assert.equal(receipts[0].versionId,adoptedVersion);
        const taskURL=new URL(api.href);taskURL.searchParams.set('task',live.plans[0].steps[1].taskId);
        const task=await (await page.request.get(taskURL.href)).json();
        assert.equal(task.input.sources[0].versionId,adoptedVersion);
        assert.equal(task.input.sources[0].hash,receipts[0].hash);
        console.log('PASS 暂停同步、卡片接管与交回 V2、继续后仅派发一次并冻结对应版本和哈希');
      }
      await launcher.click();
      await plansTab.click();await panel.getByText('完成 2/2',{exact:true}).waitFor();
      await panel.getByRole('button',{name:'项目记忆',exact:true}).click();
      await panel.getByRole('button',{name:'新增设定'}).click();
      await panel.getByLabel('设定名称').fill('画幅');await panel.getByLabel('设定原文').fill('横屏 16:9');
      await panel.getByRole('button',{name:'保存设定'}).click();await panel.getByRole('button',{name:'画幅 · 项目'}).waitFor();
      await panel.getByLabel('查项目日志').fill('横屏');await panel.getByText(/画幅/).first().waitFor();
      const select=page.getByRole('combobox',{name:'当前画布',exact:true});
      if(await select.inputValue()===fixture.other)await select.selectOption(fixture.id);else await select.selectOption(fixture.other);
      const currentCanvas=await select.inputValue();
      await panel.locator('.wtt-native-editor-conversation [contenteditable=true]').first().waitFor();assert.equal((await state()).sessionId,bound);
      await panel.getByText('从采访写脚本和分镜',{exact:false}).first().waitFor();
      await panel.getByRole('button',{name:'执行方式 · '+modeLabel}).click();await page.getByRole('menuitemradio',{name:mode==='step'?'先规划后执行':'逐项确认'}).click();
      await panel.getByRole('button',{name:'新建对话',exact:true}).click();
      await panel.getByText('从采访写脚本和分镜',{exact:false}).first().waitFor({state:'hidden'});
      await panel.locator('.wtt-native-editor-conversation [contenteditable=true]').first().waitFor();
      assert.notEqual((await state()).sessionId,bound);
      assert.equal(await panel.getByText(/已选 \d+ 张/).count(),0,'新对话不带入旧引用');
      assert.equal((await state()).plans[0].state,'done','新建对话保留项目委托');
      assert.doesNotMatch(await panel.locator('[contenteditable=true]').last().innerText(),/保留这段草稿/);
      const nextInput=panel.locator('[contenteditable=true]').last();await nextInput.click();await nextInput.press('End');await page.keyboard.insertText('回忆验收，查画幅和脚本');await nextInput.press('Enter');
      const until=Date.now()+18000;while(!agentModel.evidence.length&&Date.now()<until)await new Promise(r=>setTimeout(r,250));
      assert.ok(agentModel.evidence.some(r=>r.includes('横屏 16:9')&&r.includes(receipts[1].versionId)),'新会话应检索设定及上次委托的真实版本');
      const routed=agentModel.newContexts[0];
      assert.equal(routed?.snapshot.canvas.id,currentCanvas);
      assert.deepEqual(routed?.snapshot.sources,[]);
      assert.equal(routed?.oldMessages,false);
      await page.setViewportSize({width:440,height:680});
      await page.waitForFunction(()=>{
        const box=document.querySelector('.wtt-agent-float.is-open')?.getBoundingClientRect();
        return box&&box.width>0&&box.left>=0&&box.right<=innerWidth+1;
      },null,{timeout:3000});
      if(fixture.referenceId){
        await skillsButton.click();await skillOptions.waitFor();await checkSkillMenuBounds();
        if(process.env.WTT_SMOKE_ARTIFACTS)await panel.screenshot({path:path.join(process.env.WTT_SMOKE_ARTIFACTS,'project-assistant-skills-narrow.png')});
        const narrowHeight=(await panel.boundingBox()).height;
        const grip=await panel.getByRole('button',{name:'调整浮窗大小'}).boundingBox();
        assert(grip,'窄屏仍应提供可操作的缩放手柄');
        await page.mouse.move(grip.x+grip.width/2,grip.y+grip.height/2);
        await page.mouse.down();await page.mouse.move(grip.x+grip.width/2,grip.y+grip.height/2-28,{steps:6});await page.mouse.up();
        await skillOptions.waitFor({state:'hidden'});
        assert((await panel.boundingBox()).height<narrowHeight-20,'窄屏拖动手柄须缩小浮窗');
        console.log('PASS 技能菜单在常规与窄视窗收起，打开菜单时可在窄屏拖动缩放');
      }
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
      if(noNativeSkillMenu){
        await skillsButton.click();
        await fallbackSkillMenu.getByRole('textbox',{name:'搜索技能'}).focus();
        const box=await fallbackSkillMenu.boundingBox();
        assert(box.x>=0&&box.y>=0&&box.x+box.width<=440&&box.y+box.height<=680);
        assert(await fallbackSkillMenu.evaluate(menu=>menu.scrollWidth<=menu.clientWidth+1),'技能名称须在菜单内换行');
        if(process.env.WTT_SMOKE_ARTIFACTS)await page.screenshot({path:path.join(process.env.WTT_SMOKE_ARTIFACTS,'project-assistant-skills.png')});
        await page.keyboard.press('Escape');await fallbackSkillMenu.waitFor({state:'hidden'});
        console.log('PASS 原生技能菜单缺失时使用同一会话目录，搜索、插入、取消和窄屏均可用');
      }
      await panel.getByRole('button',{name:'收起WTT 项目助手'}).click();await launcher.waitFor();
      const compact=await launcher.boundingBox();
      const rail=await toolbar.boundingBox();
      assert(compact.x>=rail.x&&compact.x+compact.width<=rail.x+rail.width&&compact.y+compact.height<=680);
      assert.equal(await launcher.getAttribute('aria-expanded'),'false');
      if(process.env.WTT_SMOKE_ARTIFACTS)await page.screenshot({path:path.join(process.env.WTT_SMOKE_ARTIFACTS,'project-assistant-toolbar-narrow.png')});
      console.log('PASS 固定工具栏入口、窗口拖动及恢复、窄屏收起、跨画布引用、DSH 原生对话、后台派发与新会话接续');
    }
    if (['all', 'delete'].includes(scenario)) {
      await checkDelete(page, canvas, card, api.pathname);
      console.log('PASS 删除核对、移除后视口复用、回收站恢复及长清单确认底栏');
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
  let hostStopped;
  if (host?.pid && host.exitCode === null && host.signalCode === null) {
    const force = setTimeout(() => host.kill('SIGKILL'), 3000);
    hostStopped = once(host, 'exit').finally(() => clearTimeout(force));
    host.kill('SIGTERM');
  }
  try { await Promise.all([browser?.close(), hostStopped]); }
  finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
