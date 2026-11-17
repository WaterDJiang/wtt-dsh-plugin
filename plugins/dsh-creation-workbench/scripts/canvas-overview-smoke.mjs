// Browser plugin not available: reuse the official isolated DSH and Playwright harness.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkbenchService } from '../src/service.mjs';

export async function seedCanvasOverview(workspace, run) {
  await run('python3', ['-c', 'from PIL import Image;from pptx import Presentation;import sys;Image.new("RGB",(48,32),"blue").save(sys.argv[1]);p=Presentation();s=p.slides.add_slide(p.slide_layouts[0]);s.shapes.title.text="Overview preview";p.save(sys.argv[2])', path.join(workspace, 'overview.png'), path.join(workspace, 'overview.pptx')]);
  await run('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x24:d=0.5', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(workspace, 'overview.mp4')]);
  await writeFile(path.join(workspace, 'overview.csv'), 'scene,description\n1,synthetic preview');
  const service = new WorkbenchService({ workspaceRoot: workspace });
  try {
    const entries = [];
    for (const count of [79, 80, 100, 300]) {
      const { id } = service.store.createCanvas({ title: `缩小预览 ${count}`, operationId: randomUUID() });
      const ids = {};
      ids.text = `material:${service.canvas.addMaterial({ requirementId: id, title: '预览文本', content: '# 可见正文\n\n缩小后仍能辨识这段内容。'.repeat(80), operationId: randomUUID() }).material.id}`;
      for (const [type, name] of [['image', 'overview.png'], ['video', 'overview.mp4']]) {
        const { material } = await service.importMaterial({ requirementId: id, filename: name, bytes: await readFile(path.join(workspace, name)), operationId: randomUUID() });
        ids[type] = `material:${material.id}`;
      }
      ids.document = `material:${service.canvas.addMaterial({ requirementId: id, title: '预览文档', sourcePath: 'overview.csv', operationId: randomUUID() }).material.id}`;
      const { task, prepared } = service.createTask({ requirementId: id, instruction: '仅合成课件，不调用模型', outputType: 'pptx', selectedCardIds: [], sourceRefs: [], selectedSkills: [], generation: { mode: 'new' }, operationId: randomUUID() });
      const file = path.join(prepared.deliveryDirectory, 'overview.pptx');
      await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
      await writeFile(path.join(workspace, file), await readFile(path.join(workspace, 'overview.pptx')));
      const sessionId = `overview:${task.id}`;
      service.tasks.bindSession({ taskId: task.id, sessionId });
      await service.tasks.files.register({ taskId: task.id, path: file, title: '预览PPT', kind: 'pptx', primary: true, operationId: randomUUID() }, { sessionId });
      ids.pptx = service.canvas.getBoard(id).nodes.find(node => node.artifactKind === 'pptx').id;
      for (let i = service.canvas.getBoard(id).nodes.length; i < count; i++) service.canvas.addMaterial({ requirementId: id, title: `预览素材 ${i}`, content: '缩小后保持预览。'.repeat(100), operationId: randomUUID() });
      const board = service.canvas.getBoard(id);
      assert.equal(board.nodes.length, count);
      const ordered = [...new Set([...Object.values(ids), ...board.nodes.map(node => node.id)])];
      const columns = count === 300 ? 20 : 10;
      const positions = Object.fromEntries(ordered.map((node, i) => [node, { x: 60 + i % columns * 360, y: 200 + Math.floor(i / columns) * 300 }]));
      positions[ordered.at(-1)] = { x: 50000, y: 50000 };
      service.canvas.saveBoard({ requirementId: id, expectedRevision: board.revision, positions, sizes: Object.fromEntries(ordered.map(node => [node, { width: 320, height: 256 }])), viewport: { x: 15, y: 70, zoom: .35 } });
      entries.push({ id, count, ids });
    }
    return entries;
  } finally { service.close(); }
}

export async function checkCanvasOverview(page, canvas, entries) {
  const before = process.env.WTT_OVERVIEW_BEFORE === '1';
  const artifacts = process.env.WTT_SMOKE_ARTIFACTS;
  if (artifacts) await mkdir(artifacts, { recursive: true });
  const reports = [];
  for (const entry of entries) {
    await page.getByRole('combobox', { name: '当前画布', exact: true }).selectOption(entry.id);
    const card = type => canvas.locator(`article[data-card-id="${entry.ids[type]}"]`);
    await card('text').waitFor();
    await page.waitForFunction(() => Math.abs(Number(document.querySelector('.react-flow__viewport')?.style.transform.match(/scale\(([^)]+)\)/)?.[1]) - .35) < .001);
    const selector = '.wcc-card-excerpt,.wtt-output-preview,.wcc-imported-thumbnail';
    const shown = async () => card('text').locator('.wcc-card-excerpt').count();
    if (before) assert.equal(await shown(), entry.count < 80 ? 1 : 0);
    else {
      await card('text').getByText('缩小后仍能辨识', { exact: false }).waitFor();
      await card('image').locator('img').evaluate(img => img.decode());
      await card('video').locator('video').waitFor();
      await card('document').locator('.wcc-card-excerpt').waitFor();
      await card('pptx').locator('.wtt-output-ppt-cover img').waitFor({ timeout: 30000 });
    }
    const originalImage = !before ? await card('image').locator('img').elementHandle() : null;
    if (artifacts) await page.screenshot({ path: path.join(artifacts, `${entry.count}-35.png`) });
    const samples = [];
    for (let i = 0; i < 8; i++) {
      await canvas.getByRole('button', { name: '放大画布', exact: true }).click();
      await page.waitForTimeout(250);
      const elapsed = await page.evaluate(() => new Promise(resolve => {
        const start = performance.now();
        document.querySelector('[aria-label="缩小画布"]').click();
        requestAnimationFrame(() => resolve(performance.now() - start));
      }));
      await page.waitForTimeout(250);
      if (i) samples.push(elapsed);
      if (!before || entry.count < 80) assert.equal(await shown(), 1, '跨40%边界不应清空正文');
    }
    if (!before) {
      assert(await originalImage.evaluate(el => el.isConnected), '跨40%边界不能卸载已有图片预览');
      await card('image').getByRole('heading').click();
      await card('image').locator('img').waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await shown(), 1, '取消选中后仍保留其他卡片预览');
    }
    for (let i = 0; i < 5; i++) { await canvas.getByRole('button', { name: '缩小画布', exact: true }).click(); await page.waitForTimeout(250); }
    const visiblePreviews = await canvas.locator(selector).count();
    const mounted = await canvas.locator('article.wcc-card').count();
    if (!before) { assert(visiblePreviews >= mounted - 2); if (entry.count >= 80) assert(mounted < entry.count, '画布外节点虚拟化保留'); }
    if (artifacts) await page.screenshot({ path: path.join(artifacts, `${entry.count}-overview.png`) });
    if (!before && entry.count === 300) {
      await page.evaluate(() => { document.documentElement.dataset.dsThemeSource = 'dark'; document.documentElement.style.colorScheme = 'dark'; document.body.setAttribute('data-ds-dark-theme', ''); });
      if (artifacts) await page.screenshot({ path: path.join(artifacts, '300-dark-overview.png') });
      await card('image').locator('img').dblclick();
      await canvas.locator('.wtt-outcome-viewer img').waitFor();
      await canvas.getByRole('button', { name: '关闭成果预览', exact: true }).click();
      await card('video').locator('video').evaluate(async video => { await video.play(); video.pause(); if (video.videoWidth !== 32) throw new Error('视频解码失败'); });
      await page.setViewportSize({ width: 390, height: 900 });
      const box = await canvas.locator('.react-flow').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(250, 0);
      await page.waitForTimeout(250);
      if (artifacts) await page.screenshot({ path: path.join(artifacts, '300-mobile-overview.png') });
      assert(await canvas.locator(selector).count() > 0, '窄屏低缩放仍有预览');
      await page.setViewportSize({ width: 1320, height: 940 });
    }
    samples.sort((a, b) => a - b);
    reports.push({ count: entry.count, samples, median: samples[3], p95: samples.at(-1), mounted, visiblePreviews, viewport: await canvas.locator('.react-flow__viewport').getAttribute('style') });
    if (!before) assert(samples.at(-1) <= 100, '缩放下一帧p95预算100ms');
  }
  if (!before && process.env.WTT_OVERVIEW_BASELINE) {
    const previous = JSON.parse(await readFile(process.env.WTT_OVERVIEW_BASELINE, 'utf8'));
    for (const report of reports) {
      const old = previous.find(row => row.count === report.count);
      assert(old);
      assert(!(report.median > old.median * 1.2 && report.median - old.median >= 20), '缩放中位数相对预算');
    }
  }
  if (artifacts) await writeFile(path.join(artifacts, 'overview.json'), JSON.stringify(reports, null, 2));
  console.log('PASS overview', JSON.stringify(reports.map(({ samples, ...r }) => r)));
}
