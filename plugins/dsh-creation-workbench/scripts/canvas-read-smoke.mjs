// Browser plugin not available: use the existing official DSH / Playwright harness.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkbenchService } from '../src/service.mjs';

export async function seedCanvasReads(workspace) {
  const service = new WorkbenchService({ workspaceRoot: workspace });
  try {
    const entries = [];
    for (const [mode, type] of [['plus', 'image'], ['plus', 'text'], ['plus', 'pptx'], ['plus', 'video'], ['double', 'text'], ['double', 'image'], ['operations', 'text'], ['switch', 'text']]) {
      const { id } = service.store.createCanvas({ title: `读取保留 ${mode} ${type}`, operationId: randomUUID() });
      const { material } = service.canvas.addMaterial({ requirementId: id, title: `保留来源 ${mode} ${type}`, content: '# 保留原卡内容', operationId: randomUUID() });
      const nodeId = `material:${material.id}`;
      service.canvas.saveBoard({ requirementId: id, expectedRevision: service.canvas.getBoard(id).revision,
        positions: { [nodeId]: { x: 100, y: 180 } }, viewport: { x: 15, y: -20, zoom: .7 } });
      entries.push({ id, nodeId, mode, type });
    }
    return entries;
  } finally { service.close(); }
}

export async function checkCanvasReads(page, canvas, entries, api) {
  const artifacts = process.env.WTT_SMOKE_ARTIFACTS;
  if (artifacts) await mkdir(artifacts, { recursive: true });
  const outcomes = [];
  const choose = page.getByRole('combobox', { name: '当前画布', exact: true });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const card = id => canvas.locator(`article[data-card-id="${id}"]`);
  const isBoard = entry => url => url.pathname === api.pathname && url.searchParams.get('canvas') === entry.id;
  const board = async entry => { const url = new URL(api); url.searchParams.set('canvas', entry.id); const reply = await page.request.get(url.href); assert(reply.ok()); return reply.json(); };
  async function closePanels() {
    const closeFiles = page.getByRole('button', { name: '收起文件栏', exact: true });
    if (await closeFiles.isVisible()) await closeFiles.click();
    for (const name of ['关闭正文编辑', '关闭画布侧栏', '关闭预览']) {
      const button = canvas.getByRole('button', { name, exact: true });
      if (await button.count() && await button.first().isVisible()) await button.first().click();
    }
  }
  async function open(entry) {
    await closePanels(); await choose.selectOption(entry.id); await card(entry.nodeId).waitFor(); await frame();
  }
  async function pausedRead(entry, label, trigger, { failure = false } = {}) {
    const viewport = canvas.locator('.react-flow__viewport'), marker = randomUUID();
    await viewport.evaluate((node, value) => { node.dataset.readMarker = value; }, marker);
    const transform = await viewport.getAttribute('style');
    const reached = Promise.withResolvers(), release = Promise.withResolvers(), done = Promise.withResolvers();
    let intercepted = false, body;
    const routeRead = async route => {
      if (intercepted || route.request().method() !== 'GET') return route.continue();
      intercepted = true;
      try {
        const response = await route.fetch(); assert(response.ok()); body = await response.json();
        reached.resolve(); await release.promise;
        if (failure) await route.fulfill({ json: { ok: false, error: `合成读取失败 ${label}` } });
        else await route.fulfill({ response });
        done.resolve();
      } catch (cause) { reached.reject(cause); done.reject(cause); await route.abort().catch(() => {}); }
    };
    void done.promise.catch(() => {}); void reached.promise.catch(() => {});
    const matcher = isBoard(entry);
    await page.route(matcher, routeRead);
    const timeout = setTimeout(() => reached.reject(new Error(`${label} 未触发预期画布读取`)), 12000);
    try {
      await trigger(); await reached.promise; await frame();
      if (artifacts) await page.screenshot({ path: path.join(artifacts, `${label}-pending.png`) });
      assert(await card(entry.nodeId).isVisible(), `${label}：重读时旧卡必须继续显示`);
      assert.equal(await canvas.locator('.wcc-loading:visible').count(), 0, `${label}：已有画布不能显示首次加载遮罩`);
      assert.equal(await viewport.getAttribute('data-read-marker'), marker, `${label}：不能卸载视口`);
      assert.equal(await viewport.getAttribute('style'), transform, `${label}：读取期间不能移动视口`);
      release.resolve(); await done.promise; await frame();
      if (failure) {
        await canvas.getByRole('alert').filter({ hasText: `合成读取失败 ${label}` }).waitFor();
        assert.equal(await canvas.locator('.wcc-load-error').count(), 0);
      } else {
        await page.waitForFunction(({ id }) => !document.querySelector('.wcc-graph[aria-busy="true"]'), { id: entry.id });
        assert.equal(await viewport.getAttribute('data-read-marker'), marker, `${label}：成功后保留同一视口实例`);
      }
      outcomes.push({ label, oldCardVisible: true, sameViewport: true, failure });
      return body;
    } finally { clearTimeout(timeout); release.resolve(); await page.unroute(matcher, routeRead); }
  }
  for (const entry of entries.filter(entry => entry.mode === 'plus' || entry.mode === 'double')) {
    await open(entry);
    if (entry.mode === 'plus') {
      await card(entry.nodeId).getByRole('heading').click();
      await canvas.getByRole('button', { name: /^用 .* 继续创作$/ }).click();
    } else {
      const pane = canvas.locator('.react-flow__pane');
      const bounds = await pane.boundingBox(); await page.mouse.dblclick(bounds.x + bounds.width - 100, bounds.y + 500);
    }
    const label = `${entry.mode}-${entry.type}`, menu = canvas.locator('.wcc-node-create-menu');
    const name = { text: '文本', pptx: 'PPT', image: '图片', video: '视频' }[entry.type];
    const failAfterSave = entry.mode === 'plus' && entry.type === 'video';
    const updated = await pausedRead(entry, label, () => menu.getByRole('menuitem', { name, exact: true }).click(), { failure: failAfterSave });
    assert.equal(updated.nodes.filter(node => node.outputCard).length, 1, '一次新建只生成一张草稿卡');
    const newId = updated.nodes.find(node => node.outputCard).id;
    if (failAfterSave) {
      assert.equal(await card(newId).count(), 0, '读取失败时不伪造尚未读回的新卡');
      await pausedRead(entry, label + '-retry', () => canvas.getByRole('button', { name: '重试刷新', exact: true }).click());
    }
    await card(newId).waitFor({ state: 'attached' });
    assert.equal((await board(entry)).nodes.filter(node => node.outputCard).length, 1);
    console.log('PASS 保留画布新建', label);
  }
  const entry = entries.find(entry => entry.mode === 'operations'); await open(entry);
  // Parent workspace refresh followed by a normal canvas read, including error and retry.
  await pausedRead(entry, 'manual-refresh-failure', () => canvas.getByRole('button', { name: '刷新画布', exact: true }).click(), { failure: true });
  await pausedRead(entry, 'retry-refresh', () => canvas.getByRole('button', { name: '重试刷新', exact: true }).click());
  await canvas.getByRole('button', { name: '添加素材', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加素材', exact: true });
  await dialog.getByLabel('素材名称', { exact: true }).fill('同画布新增素材');
  await dialog.getByLabel('文字内容', { exact: true }).fill('新增成功必须保留来源卡。');
  const added = await pausedRead(entry, 'add-material', () => dialog.getByRole('button', { name: '保存素材', exact: true }).click());
  assert(added.nodes.some(node => node.title === '同画布新增素材'));
  await closePanels();
  // Saved source text is edited through the real editor, then its normal board reread is held.
  await card(entry.nodeId).locator('.wcc-card-body').dblclick();
  const editor = canvas.getByRole('textbox', { name: /^编辑 .* 的正文$/ });
  await editor.fill('原卡编辑保存后的独立标记');
  await pausedRead(entry, 'save-text', () => canvas.getByRole('button', { name: '保存到文件', exact: true }).click());
  await closePanels();
  await canvas.getByRole('button', { name: '定位所选卡片', exact: true }).click();
  await card(entry.nodeId).getByRole('button', { name: /^卡片操作：/ }).click();
  await card(entry.nodeId).getByRole('button', { name: '上传文件', exact: true }).click();
  await pausedRead(entry, 'upload-version', () => canvas.locator('input[aria-label="上传卡片内容"]').setInputFiles({ name: '新版正文.md', mimeType: 'text/markdown', buffer: Buffer.from('# 上传新版本独立标记') }));
  assert((await board(entry)).nodes.find(node => node.id === entry.nodeId).content.includes('上传新版本独立标记'));
  await closePanels();
  // Restore triggers recycledChanged with its ordinary, formerly blocking read path.
  await canvas.getByRole('button', { name: '查看全部卡片', exact: true }).click();
  const second = (await board(entry)).nodes.find(node => node.title === '同画布新增素材');
  await card(second.id).getByRole('heading').click(); await page.keyboard.press('Delete');
  const remove = page.getByRole('dialog', { name: '删除节点', exact: true });
  await remove.getByRole('radio', { name: '只移除画布节点', exact: true }).check();
  await remove.getByRole('button', { name: '移除节点', exact: true }).click(); await card(second.id).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: /^打开文件栏/ }).click();
  await page.getByRole('button', { name: '项目回收站', exact: true }).click();
  const recycle = page.getByRole('dialog', { name: '项目回收站', exact: true });
  await pausedRead(entry, 'recycle-restore', () => recycle.getByRole('button', { name: '恢复', exact: true }).click());
  await card(second.id).waitFor({ state: 'attached' });
  await recycle.getByRole('button', { name: '关闭项目回收站', exact: true }).click(); await closePanels();
  // Finish an old real read after moving to a different canvas: it must not repopulate the new one.
  const oldCaptured = Promise.withResolvers(), oldRelease = Promise.withResolvers(), oldDone = Promise.withResolvers();
  const oldMatcher = isBoard(entry);
  const oldRead = async route => { const response = await route.fetch(); oldCaptured.resolve(); await oldRelease.promise; await route.fulfill({ response }); oldDone.resolve(); };
  await page.route(oldMatcher, oldRead);
  await canvas.getByRole('button', { name: '刷新画布', exact: true }).click(); await oldCaptured.promise;
  // A delayed read of a different canvas must show that canvas's genuine first-load state.
  const other = entries.find(entry => entry.mode === 'switch'), matcher = isBoard(other);
  const captured = Promise.withResolvers(), release = Promise.withResolvers();
  const firstRead = async route => { await route.fetch(); captured.resolve(); await release.promise; await route.fulfill({ json: { ok: false, error: '合成首次读取失败' } }); };
  await page.route(matcher, firstRead);
  try {
    await choose.selectOption(other.id); await captured.promise; await frame();
    await canvas.locator('.wcc-loading:visible').waitFor(); assert.equal(await card(entry.nodeId).count(), 0, '切换时不能显示上一画布');
    oldRelease.resolve(); await oldDone.promise; await frame();
    assert.equal(await choose.inputValue(), other.id); assert.equal(await card(entry.nodeId).count(), 0, '旧画布迟到响应不能回填另一画布');
    assert(await canvas.locator('.wcc-loading:visible').isVisible());
    release.resolve(); await canvas.locator('.wcc-load-error').filter({ hasText: '合成首次读取失败' }).waitFor();
  } finally { oldRelease.resolve(); release.resolve(); await page.unroute(oldMatcher, oldRead); await page.unroute(matcher, firstRead); }
  const retryReached = Promise.withResolvers(), retryRelease = Promise.withResolvers();
  const firstRetry = async route => { const response = await route.fetch(); retryReached.resolve(); await retryRelease.promise; await route.fulfill({ response }); };
  await page.route(matcher, firstRetry);
  try {
    await canvas.getByRole('button', { name: '重新加载', exact: true }).click(); await retryReached.promise;
    await canvas.locator('.wcc-loading:visible').waitFor(); retryRelease.resolve(); await card(other.nodeId).waitFor();
  } finally { retryRelease.resolve(); await page.unroute(matcher, firstRetry); }
  outcomes.push({ label: 'first-load-switch-failure-retry', noPreviousCanvas: true, genuineLoading: true });
  // Mobile repeats the source + and empty-pane double click, without paid generation.
  await page.setViewportSize({ width: 390, height: 844 }); await closePanels();
  await open(entries[0]);
  await canvas.getByRole('button', { name: '缩小画布', exact: true }).click();
  await canvas.getByRole('button', { name: '缩小画布', exact: true }).click();
  await card(entries[0].nodeId).getByRole('heading').click();
  await canvas.getByRole('button', { name: /^用 .* 继续创作$/ }).click();
  await pausedRead(entries[0], 'mobile-plus-video', () => canvas.locator('.wcc-node-create-menu').getByRole('menuitem', { name: '视频', exact: true }).click());
  await open(other);
  const mobilePane = await canvas.locator('.react-flow__pane').boundingBox();
  await page.mouse.dblclick(mobilePane.x + mobilePane.width - 100, mobilePane.y + 500);
  await pausedRead(other, 'mobile-double-image', () => canvas.locator('.wcc-node-create-menu').getByRole('menuitem', { name: '图片', exact: true }).click());
  await page.setViewportSize({ width: 1320, height: 940 });
  if (artifacts) await writeFile(path.join(artifacts, 'read-results.json'), JSON.stringify(outcomes, null, 2));
  console.log('PASS 同画布新建／素材／保存／上传／刷新失败重试与首次切换隔离，390px');
}
