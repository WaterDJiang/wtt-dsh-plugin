// Uses the existing official isolated DSH fixture; no model requests.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function seedConversationReferences(service, requirementId, workspace, run) {
  const ids = {};
  for (const [type, filename] of [['image', 'image.png'], ['video', 'video.mp4']]) {
    const { material } = await service.importMaterial({ requirementId, filename, bytes: await readFile(path.join(workspace, 'working', filename)), operationId: randomUUID() });
    ids[type] = `material:${material.id}`;
  }
  ids.text = `material:${service.canvas.addMaterial({ requirementId, title: '追加文字', content: '# 追加文字\n\n完整正文作为附件。', operationId: randomUUID() }).material.id}`;
  const { material } = await service.importMaterial({ requirementId, filename: '参考文档.csv', bytes: Buffer.from('scene,description\n1,synthetic'), operationId: randomUUID() });
  ids.document = `material:${material.id}`;
  await run('python3', ['-c', 'from pptx import Presentation;import sys;p=Presentation();s=p.slides.add_slide(p.slide_layouts[0]);s.shapes.title.text="Native attachment";p.save(sys.argv[1])', path.join(workspace, 'working/reference.pptx')]);
  const ppt = await service.importMaterial({ requirementId, filename: '追加课件.pptx', bytes: await readFile(path.join(workspace, 'working/reference.pptx')), operationId: randomUUID() });
  ids.pptx = `material:${ppt.material.id}`;
  const draft = service.createOutputDraft({ requirementId, outputType: 'text', selectedCardIds: [], sourceRefs: [], position: { x: 50, y: 750 }, operationId: randomUUID() });
  const upload = async (node, content) => service.cardFiles.upload({ requirementId, nodeId: node.id, versionId: node.outputCard?.versionId || null, headVersionId: node.outputCard?.latestVersionId || null, sourceHash: node.sourceHash || null, filename: '历史文字.md', bytes: Buffer.from(content), operationId: randomUUID() });
  await upload(draft.node, '# 历史第一版');
  const first = service.canvas.getBoard(requirementId).nodes.find(n => n.id === draft.node.id);
  await upload(first, '# 历史第二版'); ids.historical = draft.node.id;
  const history = service.cards.describe({ requirementId, cardId: first.outputCard.id, versionId: first.outputCard.versionId }).node;
  const board = service.canvas.getBoard(requirementId), taskNode = board.nodes.find(n => n.pendingGeneration)?.id;
  assert(taskNode, '需要绑定到任务的卡片');
  const nodes = [taskNode, ...Object.values(ids)];
  service.canvas.saveBoard({ requirementId, expectedRevision: board.revision,
    positions: Object.fromEntries(nodes.map((id, i) => [id, { x: 50 + i % 3 * 360, y: 150 + Math.floor(i / 3) * 300 }])),
    sizes: Object.fromEntries(nodes.map(id => [id, { width: 320, height: 256 }])), viewport: { x: 20, y: 10, zoom: .7 } });
  const other = service.store.createCanvas({ title: '追加资产切换隔离', operationId: randomUUID() });
  service.canvas.addMaterial({ requirementId: other.id, title: '另一画布', content: '不接收旧对话附件', operationId: randomUUID() });
  return { ids, taskNode, otherId: other.id, imagePath: board.nodes.find(n => n.id === ids.image).importedFile.path,
    historyVersionId: first.outputCard.versionId, historyPath: history.path, historyHash: history.sourceHash };
}

export async function checkConversationReferences(page, canvas, fixture, artifacts) {
  const { ids } = fixture;
  const node = id => canvas.locator(`article[data-card-id="${id}"]`);
  await node(ids.historical).getByRole('combobox').selectOption(fixture.historyVersionId);
  await node(fixture.taskNode).locator('.wcc-card-body').click({ position: { x: 20, y: 30 } });
  const composer = canvas.locator('.wcc-card-composer:visible'), native = canvas.locator('.wtt-native-conversation:visible');
  await composer.waitFor();
  if (!await native.waitFor({ timeout: 2500 }).then(() => true, () => false)) {
    const toggle = composer.getByRole('button', { name: '任务对话', exact: false });
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  }
  await native.waitFor();
  const input = native.locator('[contenteditable="true"]'), add = native.getByRole('button', { name: '从画布添加资产', exact: true });
  await add.waitFor(); assert(await add.isEnabled());
  await input.fill('保留追加说明，不自动发送');
  const picker = canvas.getByRole('region', { name: '选择画布引用', exact: true });
  const choose = type => canvas.locator(`[data-id="${ids[type]}"] .wcc-reference-pick-card`).click();
  const enter = async () => { await add.click(); await picker.waitFor(); assert.equal(await composer.isVisible(), false); };
  const finish = async () => { await picker.getByRole('button', { name: '完成', exact: true }).click(); await picker.waitFor({ state: 'hidden' }); await native.waitFor(); assert.match(await input.innerText(), /保留追加说明/); };
  const remove = native.getByRole('button', { name: /^移除/ });
  await enter(); await choose('image'); await picker.getByRole('button', { name: '取消', exact: true }).click(); await native.waitFor();
  assert.equal(await remove.count(), 0); assert.match(await input.innerText(), /保留追加说明/);
  await enter(); await choose('image'); await finish();
  await native.locator('img').evaluate(img => img.decode()); assert.equal(await remove.count(), 1);
  let historicalRead = false;
  const onRequest = req => { const url = new URL(req.url()); if (url.searchParams.get('projectFileDownload') === fixture.historyPath) { assert.equal(url.searchParams.get('hash'), fixture.historyHash); historicalRead = true; } };
  page.on('request', onRequest);
  await enter(); for (const type of ['text', 'video', 'document', 'pptx', 'historical']) await choose(type); await finish();
  page.off('request', onRequest); assert(historicalRead, '使用选择的历史版本读取');
  assert.equal(await remove.count(), 6);
  await page.waitForFunction(() => [...document.querySelectorAll('.wtt-native-conversation')]
    .filter(element => element.checkVisibility()).every(element => !element.textContent.includes('上传中…')));
  assert.equal(await native.getByText('上传失败，点击重试', {exact:true}).count(), 0, '所有普通文件必须实际上传成功');
  for (const name of ['追加文字.md', 'video.mp4', '参考文档.csv', '追加课件.pptx', '历史文字.md'])
    assert.equal(await native.getByRole('button', { name: `移除文件 ${name}`, exact: true }).count(), 1);
  await page.screenshot({ path: path.join(artifacts, 'native-attachments.png') });
  await native.getByRole('button', { name: '移除图片 image.png', exact: true }).click(); assert.equal(await remove.count(), 5);
  const matcher = url => url.pathname === '/api/wtt-creation-workbench' && url.searchParams.get('projectFileDownload') === fixture.imagePath;
  await page.route(matcher, route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '合成文件已变化' }) }));
  await enter(); await choose('image'); await picker.getByRole('button', { name: '完成', exact: true }).click();
  await picker.getByRole('alert').getByText('合成文件已变化', { exact: false }).waitFor(); assert(await picker.isVisible());
  await page.unroute(matcher); await finish(); assert.equal(await remove.count(), 6);
  await page.evaluate(() => { document.documentElement.dataset.dsThemeSource = 'dark'; document.documentElement.style.colorScheme = 'dark'; document.body.setAttribute('data-ds-dark-theme', ''); });
  await page.screenshot({ path: path.join(artifacts, 'native-dark.png') });
  await page.setViewportSize({ width: 390, height: 900 }); await add.click(); await picker.waitFor();
  await picker.getByRole('button', { name: '取消', exact: true }).click(); await native.waitFor(); assert.equal(await remove.count(), 6);
  await page.screenshot({ path: path.join(artifacts, 'native-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await enter(); for (const type of ['text', 'video', 'document']) await choose(type);
  const captured = Promise.withResolvers(), release = Promise.withResolvers();
  let intercepted = 0;
  const late = url => url.pathname === '/api/wtt-creation-workbench' && url.searchParams.has('projectFileDownload');
  await page.route(late, async route => { if (++intercepted === 3) captured.resolve(); await release.promise; await route.abort().catch(() => {}); });
  await picker.getByRole('button', { name: '完成', exact: true }).click(); await captured.promise;
  await page.getByRole('combobox', { name: '当前画布', exact: true }).selectOption(fixture.otherId);
  release.resolve(); await page.unroute(late); assert.equal(intercepted, 3, '三个并行下载在切换时一同取消');
  await picker.waitFor({ state: 'hidden' }); assert.equal(await canvas.getByRole('button', { name: '从画布添加资产', exact: true }).count(), 0);
  console.log('PASS 无初始引用的任务对话、原生图片／文件附件、历史hash、原草稿／附件、取消、读取失败重试、深色／390px和切换隔离');
}

export async function seedConversationReferenceStress(service, requirementId, workspace, run) {
  await run('python3', ['-c', 'from PIL import Image;import sys;Image.effect_noise((1600,900),65).convert("RGB").save(sys.argv[1])', path.join(workspace, 'working/stress.png')]);
  const bytes = await readFile(path.join(workspace, 'working/stress.png')), ids = [];
  for (let i = 0; i < 24; i++) {
    const { material } = await service.importMaterial({ requirementId, filename: `追加压力${i}.png`, bytes, operationId: randomUUID() });
    ids.push(`material:${material.id}`);
  }
  const board = service.canvas.getBoard(requirementId), taskNode = board.nodes.find(node => node.pendingGeneration)?.id;
  service.canvas.saveBoard({ requirementId, expectedRevision: board.revision,
    positions: { [taskNode]: { x: 80, y: 250 }, ...Object.fromEntries(ids.map((id, i) => [id, { x: 80 + i % 6 * 360, y: 650 + Math.floor(i / 6) * 280 }])) },
    sizes: Object.fromEntries([taskNode, ...ids].map(id => [id, { width: 320, height: 256 }])), viewport: { x: 20, y: 10, zoom: .4 } });
  return { ids, taskNode, bytes: bytes.length };
}

export async function checkConversationReferenceStress(page, canvas, fixture, artifacts) {
  await canvas.locator(`article[data-card-id="${fixture.taskNode}"] .wcc-card-body`).click();
  const composer = canvas.locator('.wcc-card-composer:visible'), native = canvas.locator('.wtt-native-conversation:visible');
  if (!await native.waitFor({ timeout: 2500 }).then(() => true, () => false)) {
    const toggle = composer.getByRole('button', { name: '任务对话', exact: false });
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  }
  await native.waitFor();
  const input = native.locator('[contenteditable="true"]'), add = native.getByRole('button', { name: '从画布添加资产', exact: true });
  const picker = canvas.getByRole('region', { name: '选择画布引用', exact: true });
  await input.fill('原生输入保留，不发送');
  const cdp = await page.context().newCDPSession(page); await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
  let active = 0, peak = 0, total = 0;
  const pending = new Set();
  const started = request => { if (new URL(request.url()).searchParams.has('projectFileDownload')) { pending.add(request); active++; total++; peak = Math.max(peak, active); } };
  const finished = request => { if (pending.delete(request)) active--; };
  page.on('request', started); page.on('requestfinished', finished); page.on('requestfailed', finished);
  const reports = [];
  for (const count of [1, 20, 24]) {
    const addSamples = [], typing = [], feedback = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      const remove = native.getByRole('button', { name: /^移除图片/ });
      while (await remove.count()) await remove.first().click();
      await add.click(); await picker.waitFor();
      for (const id of fixture.ids.slice(0, count)) await canvas.locator(`[data-id="${id}"] .wcc-reference-pick-card`).click();
      const start = performance.now();
      await picker.getByRole('button', { name: '完成', exact: true }).evaluate(button => {
        button.addEventListener('click', () => {
          performance.mark('wtt-attachment-click');
          requestAnimationFrame(() => { performance.mark('wtt-attachment-feedback', { detail: { responded: button.disabled || !button.isConnected } }); performance.measure('wtt-attachment-feedback-delay', 'wtt-attachment-click', 'wtt-attachment-feedback'); });
        }, { once: true });
      });
      await picker.getByRole('button', { name: '完成', exact: true }).click(); await picker.waitFor({ state: 'hidden' });
      await native.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
      assert.equal(await native.getByRole('button', { name: /^移除图片/ }).count(), count);
      if (attempt) addSamples.push(performance.now() - start);
      if (attempt) feedback.push(await page.evaluate(() => performance.getEntriesByName('wtt-attachment-feedback-delay').at(-1).duration));
      assert(await page.evaluate(() => performance.getEntriesByName('wtt-attachment-feedback').at(-1).detail.responded), '完成按钮应立即进入添加状态或完成返回');
      const typeStart = performance.now(); await input.fill(`原生输入保留，不发送 ${attempt}`);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (attempt) typing.push(performance.now() - typeStart);
    }
    const stats = values => { const sorted = [...values].sort((a, b) => a - b); return { median: sorted[3], p95: sorted.at(-1), samples: values }; };
    reports.push({ count, imageBytes: fixture.bytes, add: stats(addSamples), feedback: stats(feedback), typing: stats(typing) });
    console.log('ATTACHMENTS', JSON.stringify(reports.at(-1), (key, value) => key === 'samples' ? undefined : value));
    if (process.env.WTT_CONVERSATION_PERF_CHECK === '1') {
      assert(reports.at(-1).feedback.p95 <= 100, `${count}附件点击反馈p95超过100ms`);
      assert(reports.at(-1).typing.p95 <= 100, `${count}附件原生输入p95超过100ms`);
    }
  }
  page.off('request', started); page.off('requestfinished', finished); page.off('requestfailed', finished);
  const { profile } = await cdp.send('Profiler.stop'); await cdp.detach();
  await writeFile(path.join(artifacts, 'attachments.cpuprofile'), JSON.stringify(profile));
  await writeFile(path.join(artifacts, 'attachments.json'), JSON.stringify({ reports, requests: { peak, total } }, null, 2));
  await page.screenshot({ path: path.join(artifacts, 'attachments-24.png') });
  console.log('PASS 原生1／20／24图片附件、各7次暖态添加／输入、不发送、原草稿和任务冻结输入保留');
}
