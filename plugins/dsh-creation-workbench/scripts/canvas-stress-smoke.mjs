// Browser plugin not available; official isolated DSH + Playwright. No model calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkbenchService } from '../src/service.mjs';

export async function seedCanvasStress(workspace, run) {
  await run('python3', ['-c', 'from PIL import Image;import sys;Image.new("RGB",(1600,900),(64,116,180)).save(sys.argv[1])', path.join(workspace, 'stress.png')]);
  const image = await readFile(path.join(workspace, 'stress.png'));
  const service = new WorkbenchService({ workspaceRoot: workspace });
  try {
    const cases = [];
    for (const count of [100, 300].filter(count => !process.env.WTT_STRESS_CARDS || count === Number(process.env.WTT_STRESS_CARDS))) {
      const { id } = service.store.createCanvas({ title: `密集连续 ${count}`, operationId: randomUUID() });
      const sources = [];
      for (let i = 0; i < 24; i++) {
        const result = i % 3 === 0
          ? await service.importMaterial({ requirementId: id, filename: `参考图${i}.png`, bytes: image, operationId: randomUUID() })
          : service.canvas.addMaterial({ requirementId: id, title: `长资料 ${i}`, content: '# 合成资料\n\n' + '正文不能丢失。'.repeat(8192), operationId: randomUUID() });
        sources.push(`material:${result.material.id}`);
      }
      let board = service.canvas.getBoard(id);
      const drafts = [];
      for (const n of [1, 20, 24]) {
        const refs = sources.slice(0, n).map(key => board.nodes.find(node => node.id === key));
        const draft = service.createOutputDraft({ requirementId: id, outputType: 'text', selectedCardIds: refs.map(ref => ref.id),
          sourceRefs: refs.map(ref => ({ cardId: ref.id, hash: ref.sourceHash })), position: { x: 80, y: 200 }, operationId: randomUUID() });
        drafts.push({ id: draft.node.id, references: n });
      }
      for (let n = service.canvas.getBoard(id).nodes.length; n < count; n++)
        service.canvas.addMaterial({ requirementId: id, title: `密集素材 ${n}`, content: '正文。'.repeat(2048), operationId: randomUUID() });
      board = service.canvas.getBoard(id);
      const ids = [...drafts.map(draft => draft.id), ...board.nodes.map(node => node.id).filter(key => !drafts.some(draft => draft.id === key))];
      const edges = [], seen = new Set(board.edges.map(edge => `${edge.source}:${edge.target}`));
      for (const target of ids.slice(27)) for (const source of sources) {
        const pair = `${source}:${target}`;
        if (seen.has(pair) || edges.length + board.edges.length >= 3900) continue;
        seen.add(pair); edges.push({ id: `stress:${edges.length}`, source, target });
      }
      const columns = count === 300 ? 20 : 10;
      service.canvas.saveBoard({ requirementId: id, expectedRevision: board.revision,
        positions: Object.fromEntries(ids.map((key, i) => [key, { x: 100 + i % columns * 360, y: 500 + Math.floor(i / columns) * 290 }])),
        sizes: Object.fromEntries(ids.map(key => [key, { width: 320, height: 256 }])), edges,
        viewport: { x: 20, y: 20, zoom: count === 300 ? .15 : .26 } });
      cases.push({ id, count, drafts, sources, edges: service.canvas.getBoard(id).edges.length });
    }
    return cases;
  } finally { service.close(); }
}

const statistics = samples => {
  const ordered = [...samples].sort((a, b) => a - b);
  return { median: ordered[Math.floor(ordered.length / 2)], p95: ordered[Math.ceil(ordered.length * .95) - 1], max: ordered.at(-1), samples };
};

async function dragCard(page, heading) {
  const box = await heading.boundingBox(), samples = [];
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  try {
    for (let i = 0; i < 9; i++) {
      const start = performance.now();
      await page.mouse.move(x + 12 + i * 3, y + 8 + i * 2);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (i > 1) samples.push(performance.now() - start);
    }
  } finally { await page.mouse.up(); }
  return statistics(samples);
}

async function continuous(page, kind, steps = 72) {
  return page.evaluate(async ({ kind, steps }) => {
    const root = document.querySelector('.react-flow'), rect = root.getBoundingClientRect();
    const samples = [], frames = [];
    for (let i = 0; i < steps; i++) {
      const start = performance.now();
      root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2, deltaX: kind === 'pan' ? (i % 2 ? -6 : 6) : 0,
        deltaY: kind === 'zoom' ? (i % 2 ? -1 : 1) : 0, ctrlKey: kind === 'zoom' }));
      await new Promise(resolve => requestAnimationFrame(resolve));
      const middle = performance.now();
      await new Promise(resolve => requestAnimationFrame(resolve));
      const end = performance.now();
      if (i >= 8) { samples.push(end - start); frames.push(middle - start, end - middle); }
    }
    return { samples, frames };
  }, { kind, steps });
}

export async function checkCanvasStress(page, canvas, cases) {
  const artifacts = process.env.WTT_SMOKE_ARTIFACTS;
  assert(artifacts, 'stress requires WTT_SMOKE_ARTIFACTS to preserve before/after samples');
  await mkdir(artifacts, { recursive: true });
  const reports = [];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 2000 });
  for (const entry of cases) {
    await page.getByRole('combobox', { name: '当前画布', exact: true }).selectOption(entry.id);
    const card = key => canvas.locator(`article[data-card-id="${key}"]`);
    await card(entry.drafts[0].id).waitFor();
    await page.waitForTimeout(700);
    await cdp.send('Profiler.start');
    const diagnostic = process.env.WTT_STRESS_DIAGNOSTIC === '1';
    const pan = await continuous(page, 'pan', diagnostic ? 24 : 72), zoom = await continuous(page, 'zoom', diagnostic ? 24 : 72);
    const report = { cards: entry.count, edges: entry.edges, mounted: await canvas.locator('article[data-card-id]').count(),
      dom: await canvas.locator('*').count(), pan: statistics(pan.samples), panFrames: statistics(pan.frames),
      zoom: statistics(zoom.samples), zoomFrames: statistics(zoom.frames), references: [] };
    if (process.env.WTT_STRESS_DRAG === '1') report.drag = await dragCard(page, card(entry.drafts.at(-1).id).locator('.wcc-card-grip'));
    for (const draft of diagnostic ? [] : entry.drafts) {
      const body = card(draft.id).locator('.wcc-card-body'), bounds = await body.boundingBox();
      await body.click({ position: { x: Math.max(2, bounds.width - 4), y: Math.max(2, bounds.height - 4) } });
      const composer = canvas.locator('.wcc-card-composer:visible'); await composer.waitFor();
      const input = composer.locator('textarea').first(); await input.waitFor();
      const samples = [];
      for (let i = 0; i < 8; i++) {
        const elapsed = await input.evaluate(async (element, value) => {
          const start = performance.now(), setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return performance.now() - start;
        }, `保留输入，不发送 ${i}`);
        assert.match(await input.inputValue(), /保留输入/);
        if (i) samples.push(elapsed);
      }
      report.references.push({ count: draft.references, typing: statistics(samples),
        hiddenPreviewBodies: await composer.locator('.wcc-creation-reference-preview pre').count(),
        dom: await composer.locator('*').count() });
      if (draft.references === 24) {
        await composer.getByRole('button', { name: '查看本次引用内容', exact: true }).click();
        const detail = composer.locator('.wcc-creation-reference-preview details').nth(1);
        await detail.locator('summary').click(); await detail.getByText('正文不能丢失。', { exact: false }).waitFor();
        await page.screenshot({ path: path.join(artifacts, `stress-${entry.count}-24.png`) });
      }
      await page.keyboard.press('Escape');
    }
    const { profile } = await cdp.send('Profiler.stop');
    if (entry.count === 300 && process.env.WTT_STRESS_EXPERIMENT === '1') {
      report.experiments = [];
      for (const [name, css] of [
        ['compositor', '.wtt-course-canvas .react-flow__viewport{will-change:transform}'],
        ['split-layers', '.wtt-course-canvas :is(.react-flow__viewport,.react-flow__nodes,.react-flow__edges){will-change:transform}'],
        ['nodes-control', '.wtt-course-canvas .react-flow__nodes{display:none}'],
        ['shadows-control', '.wtt-course-canvas .wcc-card{box-shadow:none}'],
      ]) {
        const style = await page.addStyleTag({ content: css });
        const result = await continuous(page, 'pan', 24);
        report.experiments.push({ name, pan: statistics(result.samples), frames: statistics(result.frames) });
        await style.evaluate(element => element.remove());
      }
    }
    if (entry.count === 300 && process.env.WTT_STRESS_TRACE === '1') {
      await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8,blink,cc', transferMode: 'ReturnAsStream' });
      await continuous(page, 'pan', 24);
      const finished = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
      await cdp.send('Tracing.end');
      const { stream } = await finished;
      const chunks = [];
      for (;;) { const chunk = await cdp.send('IO.read', { handle: stream }); chunks.push(chunk.data); if (chunk.eof) break; }
      await cdp.send('IO.close', { handle: stream });
      await writeFile(path.join(artifacts, 'browser-trace.json'), chunks.join(''));
    }
    await writeFile(path.join(artifacts, `${entry.count}.cpuprofile`), JSON.stringify(profile));
    reports.push(report); console.log('STRESS', JSON.stringify(report, (key, value) => key === 'samples' ? undefined : value));
    if (process.env.WTT_STRESS_CHECK === '1') {
      for (const action of ['pan', 'zoom']) assert(report[action].p95 <= 100, `${entry.count}卡${action}连续操作p95超过100ms`);
      if (report.drag) assert(report.drag.p95 <= 100, `${entry.count}卡拖动p95超过100ms`);
      for (const row of report.references) {
        assert(row.typing.p95 <= 100, `${entry.count}卡/${row.count}引用输入p95超过100ms`);
        assert.equal(row.hiddenPreviewBodies, 0, '收起的引用不应挂载正文或媒体');
      }
    }
  }
  await cdp.detach();
  await writeFile(path.join(artifacts, 'stress.json'), JSON.stringify(reports, null, 2));
  if (process.env.WTT_STRESS_BASELINE) {
    const previous = JSON.parse(await readFile(process.env.WTT_STRESS_BASELINE, 'utf8'));
    for (const report of reports) for (const key of ['pan', 'zoom']) {
      const old = previous.find(row => row.cards === report.cards)[key].median;
      assert(!(report[key].median > old * 1.2 && report[key].median - old >= 20), `${report.cards}卡${key}中位数相对预算失败`);
    }
  }
  console.log(process.env.WTT_STRESS_DIAGNOSTIC === '1' ? 'PASS 绘制热点诊断（未运行引用操作）' : 'PASS 连续平移／缩放、密集连线、1／20／24引用输入与完整详情');
}
