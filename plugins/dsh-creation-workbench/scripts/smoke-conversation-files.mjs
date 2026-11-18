import { seedConversationReferences, checkConversationReferences, seedConversationReferenceStress, checkConversationReferenceStress } from './conversation-reference-smoke.mjs';
import { seedProjectImages, checkProjectImages } from './project-image-smoke.mjs';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { WorkbenchService } from '../src/service.mjs';

const stressMode = process.argv[2] === 'stress';
const fileMode = process.argv[2] === 'files';
const mediaMode = process.argv[2] === 'media';
const referenceMode = process.argv[2] === 'references' || stressMode;
assert(!process.argv[2] || referenceMode || fileMode || mediaMode, '用法：node scripts/smoke-conversation-files.mjs [references|stress|files|media]');
const run = promisify(execFile), repo = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(repo, '.runtime/host/node_modules/@deepseek-ai/dsh/lib/bin.js');
const playwright = ['.runtime/canvas-smoke', '.runtime/jimeng-backend'].map(dir => path.join(repo, dir, 'node_modules/playwright-core/index.mjs')).find(existsSync);
assert(playwright && existsSync(cli), '按README准备隔离DSH和Playwright运行时');
const { chromium } = await import(pathToFileURL(playwright).href);
const temporary = await mkdtemp(path.join(tmpdir(), 'wtt-chat-files-')), workspace = path.join(await realpath(temporary), 'workspace');
const artifacts = process.env.WTT_SMOKE_ARTIFACTS || temporary;
let host, browser;

async function fixture(ctx) {
  const { readFileSync } = await import('node:fs');
  const { createAssistantMessage, createUserMessage, createToolResultMessage } = await import(process.env.WTT_SMOKE_LLM_URL);
  const root = process.env.WTT_COURSE_WORKSPACE, f = JSON.parse(readFileSync(root + '/fixture.json', 'utf8'));
  if (f.media) {
    for (const { sessionId, marker } of f.media.sessions) {
      const s = ctx.sessions.create(sessionId, { meta: { cwd: root } }), turn = 1, step = 0;
      s.append('turn/start', { turn }); s.append('step/start', { turn, step });
      s.append('request/header', { reason: 'initial', header: { config: { provider: 'manual-fixture', model: 'none' } } });
      s.append('user/message', createUserMessage({ content: [{ type: 'text', text: '合成媒体任务，未调用模型。' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
      s.append('assistant/message', { turn, step, message: createAssistantMessage({ content: [{ type: 'text', text: marker }], source: { provider: 'manual-fixture', model: 'none' } }), stream: [{ type: 'text-chunks', time0: Date.now(), index: 0, dt: [], texts: [marker] }] }, { surfaceOp: 'append' });
      s.append('step/end', { turn, step }); s.append('turn/end', { turn, reason: { kind: 'completed' } }); await ctx.sessions.flush(s);
    }
    return;
  }
  const handle = f.conversationReferences ? await ctx.agents.create({ sessionId: f.sessionId, meta: { cwd: root } }) : null;
  if (handle) ctx.effect(() => () => handle.dispose());
  const s = handle?.agent.session || ctx.sessions.create(f.sessionId, { meta: { cwd: root } }), turn = 1, step = 0;
  const text = '仅合成验收，无模型调用。\n\n| 文件 | 审核 |\n| --- | --- |\n| [V2 双人中全景](working/image.png) | 合成图片 |\n| [视频片段](working/video.mp4) | 合成视频 |\n| [导演文档](working/document.md) | 合成文档 |';
  if (f.conversationReferences) {
    s.append('turn/start', {turn});s.append('step/start',{turn,step});
    s.append('request/header',{reason:'initial',header:{config:{provider:'manual-fixture',model:'none'}}});
    s.append('user/message',createUserMessage({content:[{type:'text',text:'合成任务，没有初始引用。'}],source:{kind:'user'}}),{surfaceOp:'append'});
    s.append('assistant/message',{turn,step,message:createAssistantMessage({content:[{type:'text',text}],source:{provider:'manual-fixture',model:'none'}}),stream:[{type:'text-chunks',time0:Date.now(),index:0,dt:[],texts:[text]}]},{surfaceOp:'append'});
    s.append('step/end',{turn,step});s.append('turn/end',{turn,reason:{kind:'completed'}});await ctx.sessions.flush(s);
    ctx.effect(()=>ctx.connection.fetch.register({path:'/api/wtt-chat-file-fixture',methods:['GET'],requestBody:'buffered',fetch:async()=>Response.json({sessionId:s.id,seq:s.seq,callId:f.callId})}));return;
  }
  const args = JSON.stringify({ questions: [{ id: 'review', header: '合成审核', question: '是否采用这份合成内容？',
    options: [{ label: '采用', description: '仅明确提交才采用。' }, { label: '保留候选', description: '保留未提交选择。' }] }], timeout: 600 });
  s.append('turn/start', { turn }); s.append('step/start', { turn, step });
  s.append('request/header', { reason: 'initial', header: { config: { provider: 'manual-fixture', model: 'none' },
    tools: [{ name: 'ask_user_question', description: '合成问题', parameters: { type: 'object', properties: { questions: { type: 'array' }, timeout: { type: 'number' } } } }] } });
  s.append('user/message', createUserMessage({ content: [{ type: 'text', text: '仅查看合成文件。' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  s.append('assistant/message', { turn, step, message: createAssistantMessage({ content: [{ type: 'text', text }, { type: 'tool-call', id: f.callId, name: 'ask_user_question', arguments: args }], source: { provider: 'manual-fixture', model: 'none' } }),
    stream: [{ type: 'text-chunks', time0: Date.now(), index: 0, dt: [], texts: [text] }, { type: 'tool-call-chunks', time0: Date.now(), index: 1, dt: [], id: f.callId, name: 'ask_user_question', args: [args] }] }, { surfaceOp: 'append' });
  const call = s.append('tool/call', { turn, step, callId: f.callId, name: 'ask_user_question', arguments: args });
  s.append('tool/result', { turn, step, message: createToolResultMessage({ callId: f.callId, content: [{ type: 'text', text: JSON.stringify({ pending: true }) }], isError: false }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] });
  s.append('step/end', { turn, step }); s.append('step/start', { turn, step: 1 });
  s.append('assistant/message', { turn, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'manual-fixture', model: 'none' } }),
    stream: [{ type: 'text-chunks', time0: Date.now(), index: 0, dt: [], texts: [text] }] }, { surfaceOp: 'append' });
  s.append('step/end', { turn, step: 1 }); s.append('turn/end', { turn, reason: { kind: 'completed' } }); await ctx.sessions.flush(s);
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/wtt-chat-file-fixture', methods: ['GET'], requestBody: 'buffered',
    fetch: async () => Response.json({ sessionId: s.id, seq: s.seq, callId: f.callId }) }));
}

async function loginUrl(child) {
  let output = '';
  const { promise, resolve, reject } = Promise.withResolvers();
  const timer = setTimeout(() => reject(new Error('DSH启动超时：' + output.slice(-1200))), 15000);
  const read = chunk => { output += chunk; const url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/)?.[0]; if (url) resolve(url); };
  child.stdout.on('data', read); child.stderr.on('data', read); child.once('exit', code => reject(new Error('DSH退出：' + code)));
  try { return await promise; } finally { clearTimeout(timer); }
}

async function seedMedia(service, requirementId) {
  const sessions = [];
  async function publish(type, filename, title, generation = { mode: 'new' }) {
    const { task, prepared } = service.createTask({ requirementId, outputType: type, generation, instruction: '本地合成验收',
      selectedCardIds: [], selectedSkills: [], sourceRefs: [], operationId: randomUUID() });
    const relative = path.join(prepared.deliveryDirectory, filename), sessionId = 'media-smoke-' + randomUUID();
    await writeFile(path.join(workspace, relative), await readFile(path.join(workspace, 'working', filename)));
    service.tasks.bindSession({ taskId: task.id, sessionId });
    await service.tasks.files.register({ taskId: task.id, path: relative, title, kind: type, primary: true, operationId: randomUUID() }, { sessionId });
    const marker = `${title} 原会话消息`;
    sessions.push({ sessionId, marker });
    const { node, version } = service.cards.describe({ requirementId, cardId: task.outputCardId });
    return { id: node.id, cardId: task.outputCardId, versionId: version.id, marker };
  }
  const old = await publish('video', 'video.mp4', '合成视频第一版');
  const video = await publish('video', 'video.mp4', '合成视频第二版', { mode: 'revise', cardId: old.cardId, baseVersionId: old.versionId });
  const image = await publish('image', 'image.png', '合成图片');
  const { material } = await service.importMaterial({ requirementId, filename: '上传图片.png',
    bytes: await readFile(path.join(workspace, 'working/image.png')), operationId: randomUUID() });
  const upload = `material:${material.id}`;
  service.canvas.saveBoard({ requirementId, expectedRevision: service.canvas.getBoard(requirementId).revision,
    positions: { [video.id]: { x: 115, y: 140 }, [image.id]: { x: 810, y: 140 }, [upload]: { x: 115, y: 720 } },
    viewport: { x: 20, y: 45, zoom: .68 } });
  return { old, video, image, upload, sessions };
}

async function seedMediaAttachment(service, sessions) {
  const { id } = service.store.createCanvas({ title: '媒体附件预览', operationId: randomUUID() });
  const createVideo = instruction => service.createTask({ requirementId: id, outputType: 'video', generation: { mode: 'new' },
    instruction, selectedCardIds: [], sourceRefs: [], operationId: randomUUID() });
  const { task, prepared } = createVideo('只有附件的视频');
  const { task: empty } = createVideo('未登记视频的卡片');
  const sessionId = `media-smoke-${randomUUID()}`;
  const relative = path.join(prepared.deliveryDirectory, 'attachment.mp4');
  const bytes = await readFile(path.join(workspace, 'working/video.mp4'));
  await writeFile(path.join(workspace, relative), bytes);
  service.tasks.bindSession({ taskId: task.id, sessionId });
  const registration = { taskId: task.id, path: relative, kind: 'video', title: '已登记视频附件' };
  const file = await service.tasks.files.register({ ...registration, presentation: 'attachment', operationId: randomUUID() }, { sessionId });
  assert.equal(file.cardOutput.role, 'attachment');
  assert.equal(file.cardOutput.versionId, null);
  assert.match(file.cardOutput.warning, /尚无正式版本/);
  const emptySource = `courses/${id}/tasks/${empty.id}/delivery/未登记.mp4`;
  await writeFile(path.join(workspace, emptySource), bytes);
  const { material } = await service.importMaterial({ requirementId: id, filename: '导入视频.mp4', bytes, operationId: randomUUID() });
  sessions.push({ sessionId, marker: '已完成的视频附件测试' });
  const pendingId = `output:${task.outputCardId}`, emptyId = `output:${empty.outputCardId}`;
  assert.equal(service.cards.describePending({ requirementId: id, cardId: task.outputCardId }).node.outputCard.versionId, null);
  service.canvas.saveBoard({ requirementId: id, expectedRevision: service.canvas.getBoard(id).revision,
    positions: { [pendingId]: { x: 115, y: 140 }, [emptyId]: { x: 810, y: 140 }, [`material:${material.id}`]: { x: 810, y: 705 } }, viewport: { x: 20, y: 45, zoom: .68 } });
  return { id, pendingId, emptyId, importedId: material.id, sessionId, file, registration };
}

async function checkVideoRange(page, video) {
  const url = new URL(await video.getAttribute('src'), page.url());
  const response = await page.request.get(url.href, { headers: { Range: 'bytes=32-79' } });
  const original = await readFile(path.join(workspace, 'working/video.mp4'));
  assert.equal(response.status(), 206, '播放地址必须响应区间请求');
  assert.equal(response.headers()['content-range'], `bytes 32-79/${original.length}`);
  assert.deepEqual(await response.body(), original.subarray(32, 80));
}

async function dragVideoTimeline(page, video) {
  await video.evaluate(async el => { await el.play(); el.pause(); });
  await video.hover();
  // Chromium exposes the real native timeline via CDP, including a scaled canvas card.
  const cdp = await page.context().newCDPSession(page);
  try {
    const src = await video.getAttribute('src');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `video[src=${JSON.stringify(src)}]` });
    const { node } = await cdp.send('DOM.describeNode', { nodeId, pierce: true, depth: -1 });
    function findTimeline(element) {
      const attributes = element.attributes || [];
      const pseudo = attributes.indexOf('pseudo');
      if (pseudo >= 0 && attributes[pseudo + 1] === '-webkit-media-controls-timeline') return element;
      return [...(element.children || []), ...(element.shadowRoots || [])].map(findTimeline).find(Boolean);
    }
    const timeline = findTimeline(node);
    assert(timeline, '找不到原生视频时间条');
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: timeline.backendNodeId });
    const [left, top, right, , , bottom] = model.content;
    const y = (top + bottom) / 2;
    const position = fraction => left + (right - left) * fraction;
    const drag = async (from, to) => {
      await page.mouse.move(position(from), y);
      await page.mouse.down();
      await page.mouse.move(position(to), y, { steps: 12 });
      await page.mouse.up();
    };
    await drag(.15, .78);
    assert(await video.evaluate(el => el.currentTime > el.duration * .65), '原生进度条应可向后拖到未播位置');
    await drag(.78, .25);
    assert(await video.evaluate(el => el.currentTime < el.duration * .45), '原生进度条应可回拖到前面');
  } finally { await cdp.detach(); }
}

async function checkMediaAttachment(page, canvas, requirementId, attachment) {
  const selector = page.getByRole('combobox', { name: '当前画布', exact: true });
  await selector.selectOption(attachment.id);
  const card = id => canvas.locator(`article[data-card-id="${id}"]`);
  const pending = card(attachment.pendingId), empty = card(attachment.emptyId);
  const video = pending.locator(`video[src*="${attachment.file.id}"]`);
  await video.waitFor();
  await video.evaluate(async el => {
    el.muted = true;
    await el.play();
    assertVideoReady(el);
    el.pause();
    function assertVideoReady(element) { if (element.videoWidth !== 320 || element.duration < 7) throw new Error('卡片没有解码已登记视频'); }
  });
  await empty.waitFor();
  assert.equal(await empty.locator('video').count(), 0, '任务目录有 MP4 也须经登记才可预览');
  assert.equal(await pending.locator('select').count(), 0, '预览附件不会产生版本');
  const attachmentButton = pending.getByRole('button', { name: '查看视频附件', exact: true });
  await page.screenshot({ path: path.join(artifacts, 'media-attachment-preview.png') });
  await attachmentButton.click();
  const preview = canvas.getByRole('complementary', { name: '成果文件预览' });
  await preview.locator('video').waitFor();
  await checkVideoRange(page, video);
  await checkVideoRange(page, preview.locator('video'));
  await dragVideoTimeline(page, preview.locator('video'));
  const downloadHref = await preview.getByRole('link', { name: '下载当前文件' }).getAttribute('href');
  const download = await page.request.get(new URL(downloadHref, page.url()).href, { headers: { Range: 'bytes=32-79' } });
  assert.equal(download.status(), 200);
  assert.match(download.headers()['content-disposition'], /^attachment/);
  assert.deepEqual(await download.body(), await readFile(path.join(workspace, 'working/video.mp4')));
  const fileHref = await preview.locator('video').getAttribute('src');
  assert(new URL(fileHref, page.url()).searchParams.get('sourceRef') === `artifact:${attachment.file.id}`
    || new URL(fileHref, page.url()).searchParams.get('downloadArtifact') === attachment.file.id, '侧栏预览必须指向该附件');
  await preview.getByRole('button', { name: '关闭成果预览' }).click();

  const service = new WorkbenchService({ workspaceRoot: workspace });
  let primary;
  try {
    primary = await service.tasks.files.register({ ...attachment.registration, primary: true, operationId: randomUUID() },
      { sessionId: attachment.sessionId });
    assert.equal(primary.id, attachment.file.id);
    assert.equal(primary.hash, attachment.file.hash);
    assert.equal(primary.cardOutput.role, 'primary');
    assert(primary.cardOutput.versionId);
    assert.equal(service.tasks.get(attachment.registration.taskId).files.length, 1);
  } finally { service.close(); }
  await attachmentButton.waitFor({ state: 'hidden', timeout: 18_000 });
  const published = pending.locator(`video[src*="${primary.id}"]`);
  await published.waitFor();
  await published.evaluate(async el => {
    el.muted = true;
    await el.play();
    if (el.videoWidth !== 320) throw new Error('转为正式版本后原卡无法解码同一个视频');
    el.pause();
  });
  await pending.getByText('V001', { exact: true }).waitFor();
  await pending.getByRole('heading').click();
  await canvas.getByRole('button', { name: /^用 .* 继续创作$/ }).click();
  await canvas.getByRole('menu', { name: '从卡片创建内容' }).getByRole('menuitem', { name: '文本', exact: true }).click();
  const reference = canvas.locator('.wcc-card-composer:visible .wcc-creation-reference-chip');
  await reference.getByRole('button', { name: /^查看引用 / }).waitFor();
  assert.equal(await reference.count(), 1);
  assert.equal(await reference.evaluate(el => el.classList.contains('is-unavailable')), false);
  await canvas.getByRole('button', { name: '关闭卡片创作框' }).click();
  const importedVideo = card(`material:${attachment.importedId}`).locator('video');
  await importedVideo.waitFor();
  await checkVideoRange(page, importedVideo);
  await importedVideo.dblclick({ position: { x: 80, y: 8 } });
  const importedPreview = preview.locator('video');
  await importedPreview.waitFor();
  assert.equal(new URL(await importedPreview.getAttribute('src'), page.url()).searchParams.get('materialFile'), attachment.importedId);
  await checkVideoRange(page, importedPreview);
  await preview.getByRole('button', { name: '关闭成果预览' }).click();
  await selector.selectOption(requirementId);
  console.log('PASS MP4 附件预览、完整下载、侧栏原生拖动、同路径纠正及创作引用');
}

async function checkMedia(page, canvas, media) {
  const card = id => canvas.locator(`article[data-card-id="${id}"]`);
  const videoCard = card(media.video.id), imageCard = card(media.image.id), upload = card(media.upload);
  const action = (node, label = '打开对话') => node.locator('.wcc-card-media-actions').getByRole('button', { name: label, exact: true });
  const composer = canvas.locator('.wcc-card-composer:visible');
  const close = () => canvas.getByRole('button', { name: '关闭卡片创作框' }).click();
  const chat = canvas.locator('.wcc-creation-conversation:visible');
  const viewport = canvas.locator('.react-flow__viewport');
  const readTransform = () => viewport.evaluate(el => el.style.transform);
  await action(videoCard).waitFor();
  const before = await readTransform();
  const body = videoCard.locator('video'), grip = videoCard.locator('.wcc-card-grip');
  await body.evaluate(el => el.readyState ? undefined : new Promise(resolve => el.addEventListener('loadedmetadata', resolve, { once: true })));
  const bounds = await body.boundingBox(), row = await action(videoCard).boundingBox(), header = await grip.boundingBox();
  assert(bounds.y >= header.y + header.height && row.y >= bounds.y + bounds.height, '播放、拖动和对话区域不得重叠');
  await page.screenshot({ path: path.join(artifacts, 'media-card.png') });
  // Use Chrome's actual media controls rather than calling play() or seeking via script.
  await body.hover();
  await page.mouse.click(bounds.x + 16, bounds.y + bounds.height - 22);
  await body.evaluate(el => { if (el.paused) throw new Error('点击原生播放键后视频仍暂停'); });
  await page.mouse.click(bounds.x + bounds.width * .6, bounds.y + bounds.height - 6);
  assert(await body.evaluate(el => el.currentTime > 1), '原生进度条可用');
  await dragVideoTimeline(page, body);
  assert.equal(await chat.count(), 0);
  await action(videoCard).click({ position: { x: 8, y: 10 } });
  await chat.getByText(media.video.marker, { exact: true }).waitFor();
  assert.equal(await readTransform(), before);
  await close();
  await action(imageCard).focus(); await page.keyboard.press('Enter');
  await chat.getByText(media.image.marker, { exact: true }).waitFor();
  assert.equal(await chat.getByText(media.video.marker, { exact: true }).count(), 0);
  await close();
  await action(upload, '用 AI 创作').click();
  await composer.getByRole('group', { name: '生成方式' }).waitFor();
  await composer.locator('.wcc-creation-reference-chip').filter({ hasText: '上传图片' }).waitFor();
  assert.equal(await chat.count(), 0);
  await close();
  await videoCard.locator('select').selectOption(media.old.versionId);
  const preview = canvas.getByRole('complementary', { name: '成果文件预览' });
  await preview.locator('video').waitFor();
  await checkVideoRange(page, preview.locator('video'));
  await preview.getByRole('button', { name: '关闭成果预览' }).click();
  await action(videoCard).click();
  await chat.getByText(media.old.marker, { exact: true }).waitFor(); await close();
  await imageCard.locator('img').dblclick();
  await preview.locator('img').evaluate(img => img.decode());
  await preview.getByRole('button', { name: '关闭成果预览' }).click();
  const node = videoCard.locator('..');
  const originalPosition = await node.evaluate(el => el.style.transform);
  const point = await grip.boundingBox();
  await page.mouse.move(point.x + 30, point.y + 12); await page.mouse.down();
  await page.mouse.move(point.x + 61, point.y + 36, { steps: 8 }); await page.mouse.up();
  assert.notEqual(await node.evaluate(el => el.style.transform), originalPosition, '卡头仍可拖动');
  assert.equal(await chat.count(), 0);
  for (let i = 0; i < 4; i++) {
    await canvas.getByRole('button', { name: '缩小画布', exact: true }).click();
    await page.waitForTimeout(240);
  }
  await videoCard.getByRole('heading').click();
  const shortcut = canvas.getByRole('toolbar', { name: '已选 1 个对象的操作' }).getByRole('button', { name: '打开对话', exact: true });
  await shortcut.waitFor();
  assert((await shortcut.boundingBox()).height >= 31 && (await action(videoCard).boundingBox()).height < 23);
  await page.screenshot({ path: path.join(artifacts, 'media-card-zoom.png') });
  const zoomed = await readTransform();
  await shortcut.click(); await chat.getByText(media.old.marker, { exact: true }).waitFor();
  assert.equal(await readTransform(), zoomed);
  await close();
  await page.evaluate(() => { document.documentElement.dataset.dsThemeSource = 'dark'; document.documentElement.style.colorScheme = 'dark'; document.body.setAttribute('data-ds-dark-theme', ''); });
  await videoCard.getByRole('heading').click();
  await page.setViewportSize({ width: 390, height: 900 });
  const move = canvas.getByRole('button', { name: '定位所选卡片', exact: true });
  await move.click();
  await page.waitForTimeout(350);
  const narrow = await shortcut.boundingBox();
  assert(narrow && narrow.x >= 0 && narrow.x + narrow.width <= 390);
  await page.screenshot({ path: path.join(artifacts, 'media-card-dark-390.png') });
  await shortcut.click(); await chat.getByText(media.old.marker, { exact: true }).waitFor();
  console.log('PASS 媒体整行入口、键盘、两个历史会话、上传素材、原生播放与进度、拖动、右栏、缩小快捷入口');
}

try {
  await mkdir(path.join(workspace, 'working'), { recursive: true }); await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(workspace, 'working/document.md'), '# 合成文档\n\n导演文档唯一正文。');
  await run('python3', ['-c', 'from PIL import Image;import sys;Image.new("RGB",(41,27),"blue").save(sys.argv[1])', path.join(workspace, 'working/image.png')]);
  await run('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', mediaMode ? 'testsrc2=s=320x180:d=8' : 'color=c=blue:s=32x24:d=0.3', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(workspace, 'working/video.mp4')]);
  const projectImages = fileMode ? await seedProjectImages(workspace, run) : null;
  const service = new WorkbenchService({ workspaceRoot: workspace });
  let f;
  try {
    const canvas = service.store.createCanvas({ title: '对话媒体链接冒烟', operationId: randomUUID() });
    if (mediaMode) {
      f = { requirementId: canvas.id, media: await seedMedia(service, canvas.id) };
      f.media.attachment = await seedMediaAttachment(service, f.media.sessions);
    } else {
      const task = service.createTask({ requirementId: canvas.id, outputType: 'text', selectedCardIds: [], selectedSkills: [], sourceRefs: [], generation: { mode: 'new' }, instruction: '合成媒体审核任务', operationId: randomUUID() }).task;
      f = { requirementId: canvas.id, sessionId: 'file-smoke-' + randomUUID(), callId: randomUUID() };
      service.tasks.bindSession({ taskId: task.id, sessionId: f.sessionId });
      if (referenceMode) { f.conversationReferences = await (stressMode ? seedConversationReferenceStress : seedConversationReferences)(service, canvas.id, workspace, run); f.taskId = task.id; f.taskInput = service.tasks.get(task.id).input; assert(f.taskInput); }
    }
    await writeFile(path.join(workspace, 'fixture.json'), JSON.stringify(f));
  } finally { service.close(); }
  const plugin = path.join(temporary, 'fixture'); await mkdir(plugin);
  await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ name: 'wtt-chat-file-fixture', version: '1.0.0', type: 'module', exports: { '.': './index.mjs' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  await writeFile(path.join(plugin, 'index.mjs'), `export const name='wtt-chat-file-fixture';export const inject=['connection','sessions','agents'];export const apply=${fixture.toString()};`);
  await writeFile(path.join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: wtt-chat-file-fixture\n      name: wtt-chat-file-fixture\n');
  const env = { ...process.env, DSH_HOME: path.join(temporary, 'dsh'), WTT_COURSE_WORKSPACE: workspace,
    WTT_SMOKE_LLM_URL: pathToFileURL(path.join(repo, '.runtime/host/node_modules/@deepseek-ai/dsh-llm/lib/index.js')).href,
    PATH: path.dirname(process.execPath) + ':' + process.env.PATH, npm_config_offline: 'true' };
  await run(process.execPath, ['scripts/build.mjs'], { cwd: repo, timeout: 30000 });
  const candidate = process.env.WTT_SMOKE_PACKAGE || repo;
  await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', candidate], { cwd: workspace, env, timeout: 30000 });
  await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', plugin], { cwd: workspace, env, timeout: 30000 });
  for (const file of ['src/embedded-conversation.jsx', 'src/client.jsx', 'src/outcome-viewer.jsx', 'src/canvas.jsx', 'dist/client.js']) assert.deepEqual(await readFile(path.join(candidate, file)), await readFile(path.join(env.DSH_HOME, 'profiles/web/node_modules/@wtt/dsh-creation-workbench', file)));
  host = spawn(process.execPath, [cli, 'web', '--port', '0', '--no-open'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const login = await loginUrl(host);
  browser = await chromium.launch({ executablePath: process.env.WTT_SMOKE_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10000);
  const errors = [], logs = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (['error', 'warning'].includes(message.type())) logs.push(message.text()); });
  try {
    await page.goto(login);
    const intro = page.getByRole('button', { name: '继续', exact: true }); if (await intro.waitFor({ timeout: 1800 }).then(() => true, () => false)) await intro.click();
    const account = page.getByRole('dialog').filter({ hasText: '开始使用' }).getByRole('button', { name: '关闭', exact: true }); if (await account.waitFor({ timeout: 1800 }).then(() => true, () => false)) await account.click();
    await page.getByRole('button', { name: 'WTT 创作工作台', exact: true }).click(); await page.getByRole('combobox', { name: '当前画布', exact: true }).selectOption(f.requirementId);
    const canvas = page.locator('.wtt-course-canvas:visible');
    if (mediaMode) {
      await checkMediaAttachment(page, canvas, f.requirementId, f.media.attachment);
      await checkMedia(page, canvas, f.media);
      assert.deepEqual(errors, []); assert.deepEqual(logs, []);
    } else if (fileMode) {
      await checkProjectImages(page, canvas, projectImages, workspace, artifacts);
      assert.deepEqual(errors, []);
      const layoutWarnings = logs.filter(message => message === '[React Flow]: The parent container needs a width and a height to render the graph. Help: https://reactflow.dev/error#004');
      assert.equal(layoutWarnings.length, 2, '390px全屏预览隐藏画布的既有尺寸警告不可增加');
      const expectedFailures = logs.filter(message => message === 'Failed to load resource: the server responded with a status of 400 (Bad Request)');
      assert.equal(expectedFailures.length, process.env.WTT_FILE_LAYOUT_ONLY === '1' ? 0 : 3, '仅损坏、变化和缺失图片返回400');
      assert.deepEqual(logs.filter(message => !expectedFailures.includes(message) && !layoutWarnings.includes(message)), []);
    } else if (referenceMode) {
      await (stressMode ? checkConversationReferenceStress : checkConversationReferences)(page, canvas, f.conversationReferences, artifacts);
      const verify = new WorkbenchService({ workspaceRoot: workspace });
      try { assert.deepEqual(verify.tasks.get(f.taskId).input, f.taskInput, '后续附件不能改写原任务输入'); } finally { verify.close(); }
      assert.deepEqual(errors, []);
      assert.equal(logs.filter(message => message.includes('409')).length, stressMode ? 0 : 1);
      assert.deepEqual(logs.filter(message => !message.includes('409')), []);
    } else {
      const taskButton = canvas.getByRole('button', { name: '创作任务', exact: true });
      await taskButton.locator('.wcc-studio-task-badge').filter({ hasText: /^1$/ }).waitFor();
      await taskButton.click();
      await canvas.getByRole('button', { name: '处理待确认', exact: true }).click();
      assert.equal(await taskButton.locator('.wcc-studio-task-badge').innerText(), '1', '查看不清除未处理的确认');
    const review = page.getByRole('dialog', { name: '任务待确认', exact: true }), chat = review.locator('.wtt-native-editor-conversation');
    await chat.getByRole('button', { name: 'V2 双人中全景', exact: true }).waitFor();
    await review.getByText('保留候选', { exact: true }).click(); assert(await review.getByRole('button', { name: '提交', exact: true }).isEnabled());
    const readState = () => page.request.get(new URL('/api/wtt-chat-file-fixture', login).href).then(reply => reply.json());
    const before = await readState();
    const addCanvasAsset = chat.getByRole('button', { name: '从画布添加资产', exact: true });
    // A native question takeover can replace the entire message input and its dock.
    if (await chat.locator('[contenteditable="true"]:visible').count()) {
      await addCanvasAsset.waitFor();
      assert(await addCanvasAsset.isEnabled());
      await addCanvasAsset.click();
      const picker = canvas.getByRole('region', { name: '选择画布引用', exact: true });
      await picker.waitFor(); assert.equal(await review.isVisible(), false);
      await picker.getByRole('button', { name: '取消', exact: true }).click();
      await review.waitFor({ state: 'visible' }); assert(await review.getByRole('button', { name: '提交', exact: true }).isEnabled());
    } else assert.equal(await addCanvasAsset.count(), 0, '原生问答接管时不伪装成可追加附件的输入框');
    const close = async () => { await canvas.getByRole('button', { name: '关闭成果预览', exact: true }).click(); await review.waitFor({ state: 'visible' }); assert(await review.getByRole('button', { name: '提交', exact: true }).isEnabled()); };
    await chat.getByRole('button', { name: 'V2 双人中全景', exact: true }).click();
    const image = canvas.locator('.wtt-outcome-viewer img'); await image.waitFor(); await image.evaluate(async img => { await img.decode(); if (img.naturalWidth !== 41 || img.naturalHeight !== 27) throw new Error('图片内容不匹配'); });
    assert.equal(await review.isVisible(), false); await page.screenshot({ path: path.join(artifacts, 'image.png') }); await close();
    await chat.getByRole('button', { name: '视频片段', exact: true }).click();
    const video = canvas.locator('.wtt-outcome-viewer video'); await video.waitFor();
    await checkVideoRange(page, video);
    await video.evaluate(async item => { await item.play(); item.pause(); if (item.videoWidth !== 32) throw new Error('视频未正确解码'); }); await close();
    await chat.getByRole('button', { name: '导演文档', exact: true }).click(); await canvas.getByText('导演文档唯一正文。', { exact: false }).waitFor(); await close();
    assert.deepEqual(await readState(), before, '查看文件不能回答问题或改写原session');
    await review.getByRole('button', { name: '回到卡片对话', exact: true }).click();
    const main = canvas.locator('.wtt-native-conversation:visible');
    await main.getByRole('button', { name: 'V2 双人中全景', exact: true }).click(); await image.waitFor();
    await canvas.getByRole('button', { name: '关闭成果预览', exact: true }).click();
    assert.equal(await page.getByRole('dialog', { name: '无法打开文件' }).count(), 0); assert.deepEqual(errors, []); assert.deepEqual(logs, []);
    console.log('PASS 表格图片／视频／文档、真实解码播放、审核返回与未提交选择、原卡片chat');
    }
    console.log('PAGE', new URL(page.url()).origin, await page.title());
  } catch (error) {
    await page.locator('details').evaluateAll(items => items.forEach(item => { item.open = true; }));await page.screenshot({ path: path.join(artifacts, 'failure.png') }); console.error('BODY', (await page.locator('body').innerText()).slice(-3500)); console.error('ERRORS', errors, 'CONSOLE', logs); throw error;
  }
} finally {
  await browser?.close();
  if (host?.pid && host.exitCode === null && host.signalCode === null) {
    const ended = once(host, 'exit'); host.kill('SIGTERM'); const timer = setTimeout(() => host.kill('SIGKILL'), 3000);
    try { await ended; } finally { clearTimeout(timer); }
  }
  await rm(temporary, { recursive: true, force: true });
}
