// Browser plugin not available: exercised through the official isolated DSH and Playwright Core.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { WorkbenchService } from '../src/service.mjs';

export async function seedReferenceSelection(workspace, run) {
  const service = new WorkbenchService({ workspaceRoot: workspace });
  try {
    const { id } = service.store.createCanvas({ title: '画布可视化引用', operationId: randomUUID() });
    const ids = {};
    for (const key of ['anchor', 'text', 'outside', 'missing']) {
      const { material } = service.canvas.addMaterial({ requirementId: id, title: `引用 ${key}`, content: `# ${key}\n\n合成引用正文。`, operationId: randomUUID() });
      ids[key] = `material:${material.id}`;
    }
    await run('python3', ['-c', 'from PIL import Image;import sys;Image.new("RGB",(48,32),"blue").save(sys.argv[1])', path.join(workspace, 'reference.png')]);
    await run('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x24:d=0.2', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(workspace, 'reference.mp4')]);
    for (const [key, name] of [['image', 'reference.png'], ['video', 'reference.mp4']]) {
      const { material } = await service.importMaterial({ requirementId: id, filename: name, bytes: await readFile(path.join(workspace, name)), operationId: randomUUID() });
      ids[key] = `material:${material.id}`;
    }
    const output = service.createOutputDraft({ requirementId: id, outputType: 'text', selectedCardIds: [], sourceRefs: [], position: { x: 500, y: 150 }, operationId: randomUUID() });
    const upload = async (node, filename, content) => service.cardFiles.upload({ requirementId: id, nodeId: node.id, versionId: node.outputCard?.versionId || null, headVersionId: node.outputCard?.latestVersionId || null, sourceHash: node.sourceHash || null, filename, bytes: Buffer.from(content), operationId: randomUUID() });
    await upload(output.node, '历史第一版.md', '# 历史第一版');
    const v1 = service.canvas.getBoard(id).nodes.find(n => n.id === output.node.id);
    await upload(v1, '历史第二版.md', '# 历史第二版');
    ids.historical = output.node.id;
    const elements = [{ id: `whiteboard:${randomUUID()}`, kind: 'note', text: '白板文字快照', width: 200, height: 140, colour: 'cream' },
      { id: `whiteboard:${randomUUID()}`, kind: 'note', text: '', width: 200, height: 140, colour: 'cream' },
      { id: `whiteboard:${randomUUID()}`, kind: 'note', text: '迟到响应白板', width: 200, height: 140, colour: 'cream' }];
    ids.whiteboard = elements[0].id; ids.empty = elements[1].id; ids.late = elements[2].id;
    const positions = { [ids.anchor]: { x: 100, y: 150 }, [ids.text]: { x: 1800, y: 500 }, [ids.historical]: { x: 500, y: 150 }, [ids.image]: { x: 900, y: 150 },
      [ids.video]: { x: 500, y: 500 }, [ids.outside]: { x: 900, y: 500 }, [ids.missing]: { x: 1300, y: 150 }, [ids.whiteboard]: { x: 100, y: 500 }, [ids.empty]: { x: 100, y: 700 }, [ids.late]: { x: 500, y: 900 } };
    service.canvas.saveBoard({ requirementId: id, expectedRevision: service.canvas.getBoard(id).revision, positions, sizes: { [ids.historical]: { width: 320, height: 256 } }, elements, edges: [{ id: `edge:${randomUUID()}`, source: ids.anchor, target: ids.image }], viewport: { x: 20, y: 10, zoom: .65 } });
    // A material that refers to an unavailable external file remains visibly unavailable.
    await writeFile(path.join(workspace, 'does-not-exist.pdf'), '# 临时外部来源');
    const { material } = service.canvas.addMaterial({ requirementId: id, title: '缺失原文件', sourcePath: 'does-not-exist.pdf', operationId: randomUUID() });
    ids.unavailable = `material:${material.id}`;
    await unlink(path.join(workspace, 'does-not-exist.pdf'));
    const before = service.canvas.getBoard(id);
    const { id: otherId } = service.store.createCanvas({ title: '引用切换归属', operationId: randomUUID() });
    const { material: otherMaterial } = service.canvas.addMaterial({ requirementId: otherId, title: '另一个草稿', content: '不能被旧引用覆盖', operationId: randomUUID() });
    const performanceCases = [];
    if (process.env.WTT_REFERENCE_PERF) for (const count of [100, 300]) {
      const { id: canvasId } = service.store.createCanvas({ title: `${count} 卡引用性能`, operationId: randomUUID() });
      const cards = [];
      for (let i = 0; i < count; i++) {
        const { material } = service.canvas.addMaterial({ requirementId: canvasId, title: `引用性能 ${i}`, content: '正文。'.repeat(50), operationId: randomUUID() });
        cards.push(`material:${material.id}`);
      }
      service.canvas.saveBoard({ requirementId: canvasId, expectedRevision: service.canvas.getBoard(canvasId).revision,
        positions: Object.fromEntries(cards.map((node, i) => [node, { x: 100 + i % 15 * 360, y: 150 + Math.floor(i / 15) * 300 }])), viewport: { x: 20, y: 10, zoom: .65 } });
      performanceCases.push({ id: canvasId, cards, count });
    }
    return { id, ids, before, performanceCases, otherId, otherNodeId: `material:${otherMaterial.id}`, historical: { id: v1.sourceId, hash: v1.sourceHash } };
  } finally { service.close(); }
}

export async function checkReferenceSelection(page, canvas, fixture, api) {
  const artifacts = process.env.WTT_SMOKE_ARTIFACTS;
  const closeFiles = page.getByRole('button', { name: '收起文件栏', exact: true });
  if (await closeFiles.isVisible()) await closeFiles.click();
  if (artifacts) await mkdir(artifacts, { recursive: true });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const card = key => canvas.locator(`article[data-card-id="${fixture.ids[key]}"]`);
  const check = key => canvas.locator(`[data-id="${fixture.ids[key]}"] .wcc-reference-pick-card`);
  const mode = canvas.getByRole('region', { name: '选择画布引用', exact: true });
  const composer = canvas.locator('.wcc-card-composer:visible');
  const board = async () => { const url = new URL(api); url.searchParams.set('canvas', fixture.id); const result = await page.request.get(url.href); assert(result.ok()); return result.json(); };
  const enter = async () => {
    await composer.getByRole('button', { name: '添加引用资料', exact: true }).click();
    await composer.getByRole('button', { name: '从画布选择', exact: true }).click();
    if (!process.env.WTT_REFERENCE_BEFORE) await mode.waitFor();
  };
  await page.getByRole('combobox', { name: '当前画布', exact: true }).selectOption(fixture.id);
  const select = card('historical').getByRole('combobox');
  const oldVersion = await select.locator('option').first().getAttribute('value');
  await select.selectOption(oldVersion);
  // Historical output cards project the selected physical version onto the canvas.
  await card('anchor').locator('.wcc-card-body').click({ position: { x: 30, y: 60 } });
  await composer.waitFor();
  await composer.locator('textarea').first().fill('保留提示词，不调用模型');
  if (!process.env.WTT_REFERENCE_BEFORE) {
    const trigger = composer.getByRole('button', { name: '选择技能', exact: true });
    const search = composer.getByRole('combobox', { name: '搜索技能', exact: true });
    const height = (await composer.boundingBox()).height;
    await trigger.click();
    await search.waitFor();
    assert(await search.evaluate(input => input.closest('[popover]')?.matches(':popover-open')), '技能菜单应脱离卡片滚动区');
    assert.equal((await composer.boundingBox()).height, height, '展开技能不改变创作框高度');
    await search.press('Escape');
    await search.waitFor({ state: 'hidden' });
    await frame();
    assert(await trigger.evaluate(button => button === document.activeElement), 'Escape 将焦点还给技能按钮');
  }
  const original = await board(), viewport = await canvas.locator('.react-flow__viewport').getAttribute('style');
  const manualEdge = canvas.locator('.react-flow__edge').first();
  await manualEdge.waitFor({ state: 'attached' }); await manualEdge.dispatchEvent('click', { bubbles: true, metaKey: true }); await frame();
  const ordinaryEdges = await canvas.locator('.react-flow__edge.selected').evaluateAll(edges => edges.map(edge => edge.dataset.id).sort());
  assert.equal(ordinaryEdges.length, 1);
  const ordinarySelected = await canvas.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(n => n.dataset.id).sort());
  await enter();
  if (process.env.WTT_REFERENCE_BEFORE) {
    await composer.getByRole('textbox', { name: '搜索引用资料', exact: true }).waitFor();
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'before-list.png') });
    await composer.getByRole('button', { name: '完成选择', exact: true }).click();
    await checkReferencePerformance(page, canvas, fixture, artifacts);
    return;
  }
  assert.equal(await composer.count(), 0, '选择期间只隐藏创作框');
  assert.equal(await check('anchor').getAttribute('aria-checked'), 'true');
  assert.equal(await check('anchor').getAttribute('aria-disabled'), 'true');
  assert.equal(await check('empty').getAttribute('aria-disabled'), 'true');
  const unavailable = canvas.locator(`[data-id="${fixture.ids.unavailable}"] .wcc-reference-pick-card`);
  assert.equal(await unavailable.getAttribute('aria-disabled'), 'true');
  await check('text').click(); await check('image').click(); await check('video').click();
  assert.equal(await check('image').getAttribute('aria-checked'), 'true');
  assert.equal(await check('video').evaluate(button => getComputedStyle(button).backgroundColor), 'rgba(0, 0, 0, 0)', '鼠标悬停不能用按钮底色遮住视频卡内容');
  assert(await card('video').locator('video').evaluate(video => video.paused), '引用点选不能播放视频');
  await check('image').focus(); await page.keyboard.press('Delete');
  assert.equal(await check('image').count(), 1, '选择模式不能删除卡片');
  if (artifacts) await page.screenshot({ path: path.join(artifacts, 'after-picking.png') });
  await mode.getByRole('button', { name: '取消', exact: true }).click();
  await composer.waitFor();
  assert.equal(await composer.locator('textarea').first().inputValue(), '保留提示词，不调用模型');
  assert.equal(await composer.locator('.wcc-creation-reference-chip').count(), 1, '取消不提交引用');
  assert.equal(await canvas.locator('.react-flow__viewport').getAttribute('style'), viewport, '进入和取消不得平移缩放');
  assert.deepEqual(await canvas.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(n => n.dataset.id).sort()), ordinarySelected);
  const cancelBoard = await board();
  assert.deepEqual(cancelBoard.nodes.map(n => [n.id, n.position, n.width, n.height]), original.nodes.map(n => [n.id, n.position, n.width, n.height]));
  // Selecting the displayed historical output version freezes that version rather than latest.
  await enter();
  await check('historical').click();
  await check('image').focus(); await page.keyboard.press('Space'); await frame();
  assert.equal(await check('image').getAttribute('aria-checked'), 'true');
  await check('video').click();
  await mode.getByRole('button', { name: '完成', exact: true }).click();
  await composer.waitFor();
  assert.equal(await composer.locator('.wcc-creation-reference-chip').count(), 4);
  assert.equal(await composer.locator('textarea').first().inputValue(), '保留提示词，不调用模型');
  // Rectangle in transformed coordinates. Expand and shrink while down: only complete cards survive.
  await enter();
  await check('image').click(); await check('video').click();
  const image = await card('image').boundingBox(), outside = await card('outside').boundingBox();
  const start = { x: image.x - 8, y: image.y - 8 };
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(outside.x + outside.width + 8, outside.y + outside.height + 8, { steps: 8 }); await frame();
  assert.equal(await check('outside').getAttribute('aria-checked'), 'true');
  await page.mouse.move(image.x + image.width + 8, image.y + image.height + 8, { steps: 8 }); await frame();
  assert.equal(await check('outside').getAttribute('aria-checked'), 'false', '缩小框应取消仅本次框选加入的卡');
  assert.equal(await check('image').getAttribute('aria-checked'), 'true');
  assert.equal(await check('video').getAttribute('aria-checked'), 'false');
  await page.mouse.up(); await frame();
  assert.equal(await canvas.locator('.react-flow__viewport').getAttribute('style'), viewport);
  await page.keyboard.press('Escape'); await composer.waitFor();
  assert.deepEqual(await canvas.locator('.react-flow__edge.selected').evaluateAll(edges => edges.map(edge => edge.dataset.id).sort()), ordinaryEdges, '退出框选模式保留原有连线选择');
  assert.equal(await composer.locator('.wcc-creation-reference-chip').count(), 4);
  await enter(); await check('whiteboard').click();
  const failSnapshot = async route => {
    if (route.request().method() === 'POST' && route.request().postDataJSON()?.action === 'snapshot-whiteboard') return route.fulfill({ json: { ok: false, error: '合成白板快照失败' } });
    return route.continue();
  };
  await page.route('**/api/wtt-creation-workbench**', failSnapshot);
  await mode.getByRole('button', { name: '完成', exact: true }).click();
  await mode.getByRole('alert').filter({ hasText: '合成白板快照失败' }).waitFor();
  assert(await mode.getByRole('button', { name: '完成', exact: true }).isEnabled(), '失败后可重试');
  assert.equal(await check('whiteboard').getAttribute('aria-checked'), 'true', '失败保留当前选择');
  await page.unroute('**/api/wtt-creation-workbench**', failSnapshot);
  await mode.getByRole('button', { name: '完成', exact: true }).click();
  await composer.waitFor();
  assert.equal(await composer.locator('.wcc-creation-reference-chip').count(), 5, '白板保存快照后加入引用');
  assert.equal(await canvas.locator('.wcc-loading:visible').count(), 0);
  const saved = await board(); assert(saved.nodes.some(n => n.whiteboardSource?.elementId === fixture.ids.whiteboard));
  for (const n of original.nodes) assert.deepEqual(saved.nodes.find(c => c.id === n.id).position, n.position, '引用不能移动旧卡');
  // Computer import and @ entry remain usable after returning from the picker.
  await composer.getByRole('button', { name: '添加引用资料', exact: true }).click();
  assert(await composer.getByRole('button', { name: '从电脑添加', exact: true }).isEnabled());
  await composer.locator('input[aria-label="选择电脑素材文件"]').setInputFiles({ name: '电脑引用.txt', mimeType: 'text/plain', buffer: Buffer.from('电脑引用原文') });
  await composer.getByRole('button', { name: '查看本次引用内容', exact: true }).filter({ hasText: '6 份引用' }).waitFor();
  assert.equal(await canvas.locator('.wcc-loading:visible').count(), 0);
  assert.equal(await canvas.locator('.react-flow__viewport').getAttribute('style'), viewport);
  await composer.locator('textarea').first().fill('引用 @');
  await frame();
  assert(await composer.locator('.wcc-reference-prompt-options').count() || await composer.getByRole('listbox').count(), '@ 快捷搜索保留');
  await page.keyboard.press('Escape');
  await composer.locator('textarea').first().fill('保留提示词，不调用模型');
  if (await closeFiles.isVisible()) await closeFiles.click();
  // Simulated mobile and explicit host theme attributes, without reloading the document.
  await enter();
  await page.setViewportSize({ width: 390, height: 844 }); await frame();
  const barBox = await mode.boundingBox(); assert(barBox.x >= 0 && barBox.x + barBox.width <= 390);
  assert(await mode.getByRole('button', { name: '完成', exact: true }).evaluate(button => { const box = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); }), '窄屏完成按钮不能被其他面板遮挡');
  if (artifacts) await page.screenshot({ path: path.join(artifacts, 'mobile-picking.png') });
  const theme = await page.evaluate(() => {
    const root = document.documentElement, body = document.body;
    const previous = { source: root.getAttribute('data-ds-theme-source'), dark: body.hasAttribute('data-ds-dark-theme'), scheme: root.style.colorScheme };
    root.dataset.dsThemeSource = 'dark'; root.style.colorScheme = 'dark'; body.setAttribute('data-ds-dark-theme', ''); return previous;
  }); await frame();
  assert.equal(await canvas.evaluate(element => getComputedStyle(element).colorScheme), 'dark');
  assert.notEqual(await mode.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)', '模拟宿主深色投射必须实际改变卡片工具条底色');
  if (artifacts) await page.screenshot({ path: path.join(artifacts, 'dark-picking.png') });
  await page.evaluate(previous => {
    const root = document.documentElement, body = document.body;
    if (previous.source === null) root.removeAttribute('data-ds-theme-source'); else root.setAttribute('data-ds-theme-source', previous.source);
    root.style.colorScheme = previous.scheme; if (previous.dark) body.setAttribute('data-ds-dark-theme', ''); else body.removeAttribute('data-ds-dark-theme');
  }, theme);
  const mobileView = await canvas.locator('.react-flow__viewport').getAttribute('style');
  const anchorBox = await card('anchor').boundingBox(); await page.mouse.move(anchorBox.x + 30, anchorBox.y + 50); await page.mouse.wheel(35, 50);
  await frame(); assert.notEqual(await canvas.locator('.react-flow__viewport').getAttribute('style'), mobileView, '在卡片上滚轮仍可平移');
  const panned = await canvas.locator('.react-flow__viewport').getAttribute('style');
  await canvas.getByRole('button', { name: '放大画布', exact: true }).click(); await frame();
  assert.notEqual(await canvas.locator('.react-flow__viewport').getAttribute('style'), panned, '选择期间可用缩放控件');
  await page.keyboard.press('Escape'); await composer.waitFor();
  await page.setViewportSize({ width: 1320, height: 940 });
  // Hold a real snapshot response, leave the canvas, then release it. The other draft must not change.
  await enter(); await check('late').click();
  const paused = Promise.withResolvers(), release = Promise.withResolvers();
  const hold = async route => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON()?.action !== 'snapshot-whiteboard') return route.continue();
    const response = await route.fetch(); paused.resolve(); await release.promise; await route.fulfill({ response });
  };
  await page.route('**/api/wtt-creation-workbench**', hold);
  try {
    await mode.getByRole('button', { name: '完成', exact: true }).click(); await paused.promise;
    assert(await mode.getByRole('button', { name: '取消', exact: true }).isDisabled(), '提交期间不能取消已开始的保存');
    await page.getByRole('combobox', { name: '当前画布', exact: true }).selectOption(fixture.otherId);
    await canvas.locator(`article[data-card-id="${fixture.otherNodeId}"] .wcc-card-body`).click({ position: { x: 25, y: 80 } });
    await composer.waitFor(); await composer.locator('textarea').first().fill('另一张画布的草稿');
    release.resolve(); await frame();
    assert.equal(await mode.count(), 0);
    assert.equal(await composer.locator('.wcc-creation-reference-chip').count(), 1);
    assert.equal(await composer.locator('textarea').first().inputValue(), '另一张画布的草稿');
  } finally { release.resolve(); await page.unroute('**/api/wtt-creation-workbench**', hold); }
  await page.getByRole('combobox', { name: '当前画布', exact: true }).selectOption(fixture.id);
  await card('anchor').locator('.wcc-card-body').click({ position: { x: 30, y: 60 } }); await composer.waitFor();
  // Make a real task with the selected version/hash, stopping before native model dispatch.
  const createdTask = Promise.withResolvers();
  let submittedInput;
  const captureTask = async route => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON()?.action !== 'create-task') return route.continue();
    try {
      const data = route.request().postDataJSON().data; submittedInput = data;
      assert(data.sourceRefs.some(ref => ref.cardId === fixture.historical.id && ref.hash === fixture.historical.hash), '发送必须绑定所见 V1 的物理来源与哈希');
      const response = await route.fetch(); assert(response.ok(), await response.text()); const result = await response.json();
      const stop = await page.request.post(api.href, { data: { action: 'set-task-dispatch', data: { taskId: result.task.id, status: 'unknown' } } }); assert(stop.ok());
      result.task.dispatchStatus = 'unknown'; await route.fulfill({ response, json: result }); createdTask.resolve(result);
    } catch (cause) { createdTask.reject(cause); await route.abort(); }
  };
  await page.route('**/api/wtt-creation-workbench**', captureTask);
  try {
    await composer.getByRole('button', { name: '生成文本', exact: true }).click(); await createdTask.promise;
    await canvas.locator('.wcc-task-panel:visible').waitFor();
    const add = canvas.getByRole('button', { name: '添加引用资料', exact: true });
    assert(!await add.count() || await add.isDisabled(), '任务提交后无可编辑的引用入口');
  } finally { await page.unroute('**/api/wtt-creation-workbench**', captureTask); }
  if (artifacts) await writeFile(path.join(artifacts, 'reference-result.json'), JSON.stringify({ fixture, submittedSources: submittedInput?.sourceRefs, originalViewport: viewport, savedNodes: saved.nodes.map(n => ({ id: n.id, position: n.position })) }, null, 2));
  await checkReferencePerformance(page, canvas, fixture, artifacts);
  console.log('PASS 可视化多选、取消、历史版本哈希、键盘、框选伸缩、快照失败恢复、迟到隔离、@、电脑导入、锁定、主题、390px');
}

async function checkReferencePerformance(page, canvas, fixture, artifacts) {
  const results = [];
  for (const entry of fixture.performanceCases || []) {
    await page.getByRole('combobox', { name: '当前画布', exact: true }).selectOption(entry.id);
    const card = canvas.locator(`article[data-card-id="${entry.cards[0]}"]`);
    await card.locator('.wcc-card-body').click({ position: { x: 30, y: 60 } });
    const composer = canvas.locator('.wcc-card-composer:visible'); await composer.waitFor();
    await composer.getByRole('button', { name: '添加引用资料', exact: true }).click();
    await composer.getByRole('button', { name: '从画布选择', exact: true }).click();
    const control = process.env.WTT_REFERENCE_BEFORE ? composer.locator('.wcc-creation-reference-options input:not(:disabled)').first()
      : canvas.locator(`[data-id="${entry.cards[1]}"] .wcc-reference-pick-card`);
    await control.waitFor();
    const samples = [];
    for (let i = 0; i < 8; i++) {
      const elapsed = await control.evaluate(element => new Promise(resolve => {
        const checked = element.getAttribute('aria-checked') ?? String(element.checked), start = performance.now();
        element.click();
        const next = () => {
          const current = element.getAttribute('aria-checked') ?? String(element.checked);
          if (current !== checked) resolve(performance.now() - start); else requestAnimationFrame(next);
        };
        requestAnimationFrame(next);
      }));
      if (i) samples.push(elapsed);
    }
    const ordered = [...samples].sort((a, b) => a - b), p95Ms = ordered.at(-1);
    assert(p95Ms <= 100, `${entry.count} 卡引用下一帧 p95 ${p95Ms}ms 超过 100ms`);
    results.push({ cards: entry.count, samplesMs: samples, medianMs: ordered[3], p95Ms, renderedCards: await canvas.locator('article[data-card-id]').count() });
    if (process.env.WTT_REFERENCE_BEFORE) await composer.getByRole('button', { name: '完成选择', exact: true }).click();
    else await canvas.getByRole('region', { name: '选择画布引用' }).getByRole('button', { name: '取消', exact: true }).click();
  }
  if (artifacts && results.length) await writeFile(path.join(artifacts, 'browser-performance.json'), JSON.stringify(results, null, 2));
  if (results.length) console.log('PERF', JSON.stringify(results));
}
