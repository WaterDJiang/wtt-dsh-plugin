import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

export async function seedProjectImages(workspace, run) {
  const directory = '素材 测试/版本 V001';
  await mkdir(path.join(workspace, directory), { recursive: true });
  const files = [
    ['F14 同版静态片尾素材 V1.png', 'PNG', 'image/png'],
    ['编码不同的图片.png', 'JPEG', 'image/jpeg'],
    ['大写后缀.PNG', 'PNG', 'image/png'],
    ['照片.jpg', 'JPEG', 'image/jpeg'],
    ['照片.jpeg', 'JPEG', 'image/jpeg'],
    ['透明图.webp', 'WEBP', 'image/webp'],
    ['动画.gif', 'GIF', 'image/gif'],
  ];
  for (const [name, format] of files) await run('python3', ['-c', 'from PIL import Image;import sys;Image.new("RGB",(641,427),"#1476c8").save(sys.argv[1],format=sys.argv[2])', path.join(workspace, directory, name), format]);
  await writeFile(path.join(workspace, directory, '损坏.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { directory, files };
}

export async function checkProjectImages(page, canvas, fixture, workspace, artifacts) {
  let phase = '打开文件树';
  const logWarning = message => { if (message.type() === 'warning') console.log('WARN_PHASE', phase, message.text()); };
  page.on('console', logWarning);
  await page.getByRole('button', { name: /^打开文件栏/ }).click();
  const explorer = page.getByRole('complementary', { name: '项目文件', exact: true });
  for (const directory of fixture.directory.split('/')) await explorer.getByRole('button', { name: `展开 ${directory}`, exact: true }).click();
  const viewer = canvas.getByRole('complementary', { name: '成果文件预览', exact: true });
  const row = name => explorer.getByRole('treeitem', { name, exact: true }).locator('.wtt-file-name');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  // Isolate the existing responsive layout on an older candidate, before image assertions.
  if (process.env.WTT_FILE_LAYOUT_ONLY === '1') {
    await row(fixture.files[0][0]).click(); await viewer.waitFor();
    await viewer.getByRole('link', { name: '下载当前文件', exact: true }).waitFor();
    await explorer.getByRole('button', { name: '收起文件栏', exact: true }).click();
    phase = '缩小视口'; await page.setViewportSize({ width: 390, height: 900 });
    await viewer.getByRole('button', { name: '关闭成果预览', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    page.off('console', logWarning); return;
  }
  async function check(name, mime) {
    phase = `预览 ${name}`;
    const relative = `${fixture.directory}/${name}`, bytes = await readFile(path.join(workspace, relative));
    await row(name).click(); await viewer.waitFor();
    const image = viewer.locator('img.wtt-output-image'); await image.waitFor();
    await image.evaluate(async img => { await img.decode(); if (img.naturalWidth !== 641 || img.naturalHeight !== 427) throw new Error('未显示所选图片'); });
    const href = new URL(await image.getAttribute('src'));
    assert.equal(href.searchParams.get('reviewImage'), relative); assert.equal(href.searchParams.get('hash'), sha(bytes)); assert(href.searchParams.get('projectId'));
    const response = await page.request.get(href.href); assert.equal(response.status(), 200); assert.equal(response.headers()['content-type'], mime); assert.equal(response.headers()['x-content-type-options'], 'nosniff');
    assert.deepEqual(await response.body(), bytes);
    const download = viewer.getByRole('link', { name: '下载当前文件', exact: true });
    const original = await page.request.get(await download.getAttribute('href')); assert.deepEqual(await original.body(), bytes);
    assert.deepEqual(await readFile(path.join(workspace, relative)), bytes, '预览不可改写原图');
    const rect = await image.boundingBox(); assert(rect.width > 100 && rect.height > 100, '图片必须实际占有可见尺寸');
    assert.equal(await viewer.locator('.wtt-native-document-preview').count(), 0);
    return href;
  }
  for (const [name, , mime] of fixture.files) await check(name, mime);
  const [name, , mime] = fixture.files[0];
  const firstHref = await check(name, mime);
  await viewer.getByRole('button', { name: '展开侧栏', exact: true }).click(); await check(name, mime);
  await viewer.getByRole('button', { name: '还原侧栏宽度', exact: true }).click();
  await page.screenshot({ path: path.join(artifacts, 'file-tree-light.png') });
  await page.evaluate(() => { document.documentElement.dataset.dsThemeSource = 'dark'; document.documentElement.style.colorScheme = 'dark'; document.body.setAttribute('data-ds-dark-theme', ''); });
  await check(name, mime); await page.screenshot({ path: path.join(artifacts, 'file-tree-dark.png') });
  // A late response for the previous file must never replace the next file.
  const captured = Promise.withResolvers(), release = Promise.withResolvers(), done = Promise.withResolvers();
  const delayed = url => url.searchParams.get('nativePreview') === '' && url.searchParams.get('projectPath') === `${fixture.directory}/${name}`;
  await page.route(delayed, async route => { const response = await route.fetch(); captured.resolve(); await release.promise; await route.fulfill({ response }); done.resolve(); });
  await row(name).click(); await captured.promise;
  await check(fixture.files[1][0], fixture.files[1][2]); release.resolve(); await done.promise; await page.unroute(delayed);
  assert.equal(new URL(await viewer.locator('img').getAttribute('src')).searchParams.get('reviewImage'), `${fixture.directory}/${fixture.files[1][0]}`);
  await row('损坏.png').click(); await viewer.getByText('此版本图片未能加载，可下载原图查看。', { exact: true }).waitFor();
  // Modify/delete after metadata resolution, before the verified byte request.
  for (const operation of ['change', 'remove']) {
    const relative = `${fixture.directory}/${name}`, absolute = path.join(workspace, relative), bytes = await readFile(absolute);
    const matcher = url => url.searchParams.get('reviewImage') === relative;
    await page.route(matcher, async route => { if (operation === 'change') await writeFile(absolute, 'changed'); else await rm(absolute); await route.continue(); });
    await row(name).click(); await viewer.getByText('此版本图片未能加载，可下载原图查看。', { exact: true }).waitFor();
    await page.unroute(matcher); await writeFile(absolute, bytes);
    assert.equal((await page.request.get(firstHref.href)).status(), 200);
    await check(fixture.files[1][0], fixture.files[1][2]);
  }
  await check(name, mime);
  phase = '关闭文件树';
  await explorer.getByRole('button', { name: '收起文件栏', exact: true }).click();
  await explorer.waitFor({ state: 'detached' });
  phase = '缩小视口';
  await page.setViewportSize({ width: 390, height: 900 });
  const image = viewer.locator('img.wtt-output-image'); await image.waitFor({ state: 'visible' }); await image.evaluate(img => img.decode());
  const rect = await image.boundingBox(); assert(rect.width > 100 && rect.x >= 0 && rect.x + rect.width <= 391);
  await viewer.getByRole('button', { name: '关闭成果预览', exact: true }).waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(artifacts, 'file-tree-390.png') });
  phase = '关闭窄屏预览';
  await viewer.getByRole('button', { name: '关闭成果预览', exact: true }).click(); await viewer.waitFor({ state: 'detached' });
  phase = '还原视口';
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: /^打开文件栏/ }).click();
  // Existing file-tree document/video routes still render their real content.
  await explorer.getByRole('button', { name: '展开 working', exact: true }).click();
  await row('document.md').click(); await viewer.getByText('导演文档唯一正文。', { exact: false }).waitFor();
  await row('video.mp4').click(); const video = viewer.locator('video'); await video.waitFor();
  await video.evaluate(async item => { await item.play(); item.pause(); if (item.videoWidth !== 32) throw new Error('视频未正确解码'); });
  await viewer.getByRole('button', { name: '关闭成果预览', exact: true }).click();
  page.off('console', logWarning);
  for (const directory of fixture.directory.split('/')) await explorer.getByRole('button', { name: `展开 ${directory}`, exact: true }).click();
  const href = await check(name, mime);
  const api = new URL(href); api.searchParams.delete('reviewImage'); api.searchParams.delete('hash');
  const imported = page.waitForResponse(response => response.request().method() === 'POST' && response.url().startsWith(api.origin) && response.request().postDataJSON()?.action === 'project-file-reference');
  await viewer.getByRole('button', { name: '添加到画布', exact: true }).click();
  const result = await (await imported).json(); assert(result.material?.id); await viewer.waitFor({ state: 'detached' });
  const card = canvas.locator(`.react-flow__node[data-id="material:${result.material.id}"]`); await card.waitFor();
  const cardImage = card.locator('img'); await cardImage.evaluate(img => img.decode());
  assert.equal(await cardImage.evaluate(img => img.naturalWidth), 641);
  await cardImage.dblclick(); await viewer.waitFor();
  await viewer.locator('img.wtt-output-image').evaluate(async img => { await img.decode(); if (img.naturalWidth !== 641) throw new Error('原素材预览失败'); });
  await viewer.getByRole('button', { name: '关闭成果预览', exact: true }).click();
  console.log('PASS 真实文件树：中文路径、PNG/JPEG/WebP/GIF、编码错名、下载原字节、展开关闭、明暗390px、迟到响应、损坏变化缺失、文档视频、添加画布及素材预览');
}
