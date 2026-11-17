// Browser read-start feedback only; backend completion is measured separately.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkbenchService } from '../src/service.mjs';

export function seedReadPerformance(workspace) {
  const service = new WorkbenchService({ workspaceRoot: workspace });
  try {
    return [100, 300].map(count => {
      const { id } = service.store.createCanvas({ title: `${count} 卡读取反馈`, operationId: randomUUID() });
      const ids = [];
      for (let i = 0; i < count; i++) {
        const { material } = service.canvas.addMaterial({ requirementId: id, title: `读取性能 ${i}`, content: '合成正文。'.repeat(80), operationId: randomUUID() });
        ids.push(`material:${material.id}`);
      }
      service.canvas.saveBoard({ requirementId: id, expectedRevision: service.canvas.getBoard(id).revision,
        positions: Object.fromEntries(ids.map((node, i) => [node, { x: 100 + i % 15 * 360, y: 150 + Math.floor(i / 15) * 300 }])), viewport: { x: 20, y: 10, zoom: .65 } });
      return { id, count, nodeId: ids[0] };
    });
  } finally { service.close(); }
}

export async function checkReadPerformance(page, canvas, entries, api) {
  const results = [], old = process.env.WTT_READ_PERF_BEFORE === '1';
  for (const entry of entries) {
    const close = page.getByRole('button', { name: '收起文件栏', exact: true });
    if (await close.isVisible()) await close.click();
    await page.getByRole('combobox', { name: '当前画布', exact: true }).selectOption(entry.id);
    await canvas.locator(`article[data-card-id="${entry.nodeId}"]`).waitFor();
    await page.evaluate(({ id, old, apiPath }) => {
      window.__wttReadSamples = [];
      const original = window.fetch;
      window.__wttRestoreReadFetch = () => { window.fetch = original; };
      window.fetch = function(...args) {
        const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]), location.href);
        if (url.pathname === apiPath && url.searchParams.get('canvas') === id) {
          const start = performance.now(), root = document.querySelector('.wtt-course-canvas');
          const next = () => {
            const reading = root.querySelector('.wcc-studio-save-status')?.textContent.includes('加载中');
            const expected = old ? root.querySelector('.wcc-loading') : root.querySelector('.react-flow__viewport') && root.querySelector('.wcc-graph')?.inert;
            if (reading && expected) window.__wttReadSamples.push(performance.now() - start); else requestAnimationFrame(next);
          };
          requestAnimationFrame(next);
        }
        return original.apply(this, args);
      };
    }, { id: entry.id, old, apiPath: api.pathname });
    const samples = [];
    try {
      for (let i = 0; i < 8; i++) {
        const captured = Promise.withResolvers(), release = Promise.withResolvers(), done = Promise.withResolvers();
        let intercepted = false;
        const matcher = url => url.pathname === api.pathname && url.searchParams.get('canvas') === entry.id;
        void captured.promise.catch(() => {}); void done.promise.catch(() => {});
        const handler = async route => { intercepted = true; try { const response = await route.fetch(); captured.resolve(); await release.promise; await route.fulfill({ response }); done.resolve(); } catch (cause) { captured.reject(cause); done.reject(cause); } };
        await page.route(matcher, handler);
        try {
          await canvas.getByRole('button', { name: '刷新画布', exact: true }).click(); await captured.promise;
          await page.waitForFunction(length => window.__wttReadSamples.length > length, i);
          const elapsed = await page.evaluate(index => window.__wttReadSamples[index], i);
          const mounted = await canvas.locator('.react-flow__viewport').count();
          assert.equal(mounted, old ? 0 : 1, '旧版清空／新版保留图实例的反馈口径');
          if (i) samples.push(elapsed);
          release.resolve(); await done.promise;
          await page.waitForFunction(() => !document.querySelector('.wcc-studio-save-status')?.textContent.includes('加载中'));
          await canvas.locator(`article[data-card-id="${entry.nodeId}"]`).waitFor();
        } catch (cause) {
          console.error('READ PERF STATE', JSON.stringify(await canvas.evaluate(root => ({ graph: root.querySelector('.wcc-graph')?.outerHTML.slice(0, 500), status: root.querySelector('.wcc-studio-save-status')?.textContent, samples: window.__wttReadSamples }))));
          throw cause;
        } finally { release.resolve(); if (intercepted) await done.promise.catch(() => {}); await page.unroute(matcher, handler); }
      }
    } finally { await page.evaluate(() => window.__wttRestoreReadFetch()); }
    const ordered = [...samples].sort((a, b) => a - b), result = { cards: entry.count, samplesMs: samples, medianMs: ordered[3], p95Ms: ordered.at(-1), keptViewport: !old };
    assert(result.p95Ms <= 100, `${entry.count} 卡读取反馈 p95 ${result.p95Ms}ms 超过 100ms`); results.push(result);
  }
  if (process.env.WTT_SMOKE_ARTIFACTS) { await mkdir(process.env.WTT_SMOKE_ARTIFACTS, { recursive: true }); await writeFile(path.join(process.env.WTT_SMOKE_ARTIFACTS, 'read-browser-performance.json'), JSON.stringify(results, null, 2)); }
  console.log('PERF 同画布读取首帧', JSON.stringify(results));
}
