import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchService, runProcess } from '../src/service.mjs';
import { createArtifactPreview } from '../src/artifact-preview.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, label = 'A', fontFamily = '') {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wtt-ppt-preview-')));
  const service = new WorkbenchService({ workspaceRoot: root });
  const preview = createArtifactPreview(service);
  t.after(() => { preview.close(); service.close(); rmSync(root, { recursive: true, force: true }); });
  const requirement = service.store.createRequirement({ title: '人工技术夹具（不是 AI 生成）', operationId: randomUUID() });
  const node = service.canvas.getBoard(requirement.id).nodes[0];
  const refs = [{ cardId: node.id, hash: node.sourceHash }];
  const task = service.tasks.create({ requirementId: requirement.id, instruction: '人工两页原生可编辑 PPTX，技术验收',
    outputType: 'pptx', selectedCardIds: [node.id], sourceRefs: refs, operationId: randomUUID() },
  { requirement: { id: requirement.id, title: requirement.title }, instruction: '人工技术夹具，不是模型输出',
    sources: [{ cardId: node.id, title: node.title, kind: node.kind, hash: node.sourceHash, content: node.content }], sourceRefs: refs, outputType: 'pptx' });
  const sessionId = `manual-technical-${task.id}`;
  service.tasks.bindSession({ taskId: task.id, sessionId });
  const directory = path.join(root, 'courses', requirement.id, 'tasks', task.id, 'delivery');
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, '人工技术夹具.pptx');
  await runProcess('python3', ['-c', String.raw`
import sys
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.enum.text import PP_ALIGN
deck=Presentation();deck.slide_width=Inches(40/3);deck.slide_height=Inches(7.5)
for number in range(1,3):
 slide=deck.slides.add_slide(deck.slide_layouts[6])
 box=slide.shapes.add_textbox(Inches(1),Inches(1),Inches(10),Inches(2))
 box.text=f'人工技术夹具：中文预览必须完整可见 / {sys.argv[2]} / 第 {number} 页'
 if sys.argv[3]:
  for paragraph in box.text_frame.paragraphs:
   for run in paragraph.runs:
    run.font.name=sys.argv[3];run.font.size=Pt(32)
  footer=slide.shapes.add_textbox(Inches(12.09),Inches(7.27),Inches(.513),Inches(.233))
  footer.margin_left=footer.margin_right=footer.margin_top=footer.margin_bottom=0
  footer.text_frame.word_wrap=False
  footer.text=f'{number} / 72';footer.text_frame.paragraphs[0].alignment=PP_ALIGN.RIGHT
  for run in footer.text_frame.paragraphs[0].runs:
   run.font.name='Consolas';run.font.size=Pt(10.5)
deck.save(sys.argv[1])
`, file, label, fontFamily]);
  const artifact = await service.tasks.files.register({ taskId: task.id, kind: 'pptx', title: '人工可编辑课件（非 AI）', path: file, operationId: randomUUID() }, { sessionId });
  const bytes = readFileSync(file);
  return { root, service, preview, artifact, file, bytes, task, requirement, directory };
}

function cacheDirectory(preview, artifact) {
  const parent = path.join(preview.cacheRoot, artifact.id);
  const name = readdirSync(parent).find(name => !name.includes('.attempt-'));
  return path.join(parent, name);
}

test('a superseded editor revision waiting in the shared queue never starts conversion', async t => {
  const f = await fixture(t); let release, current = true;
  f.preview.queue = new Promise(done => { release = done });
  const job = f.preview.prepareBytes({ id: randomUUID(), bytes: f.bytes, hash: sha(f.bytes), title: '过期草稿' }, { isCurrent: () => current, requestKey: '1' });
  assert.equal(f.preview.children.size, 0);
  current = false; release(); const result = await job;
  assert.equal(result.status, 'superseded'); assert.equal(f.preview.children.size, 0);
  assert.deepEqual(result.pages, []); assert.equal(sha(readFileSync(f.file)), f.artifact.hash);
});

test('identical edited bytes reuse their validated preview across draft ids and page reads keep their hash fence', async t => {
  const f = await fixture(t), firstId = randomUUID(), secondId = randomUUID();
  const input = { bytes: f.bytes, hash: sha(f.bytes), title: '相同文件' };
  const [first, concurrent] = await Promise.all([
    f.preview.prepareBytes({ ...input, id: firstId }, { requestKey: 'first-revision' }),
    f.preview.prepareBytes({ ...input, id: secondId }, { requestKey: 'another-revision' }),
  ]);
  assert.equal(first.status, 'ready'); assert.equal(first.artifactId, firstId);
  assert.equal(concurrent.createdAt, first.createdAt); assert.equal(concurrent.artifactId, secondId);
  // Any attempted conversion now would wait forever. A cache hit must return
  // without joining that queue, and must not retain the other draft's identity.
  f.preview.queue = new Promise(() => {});
  let timer; const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('相同内容被重复转换')), 1500) });
  try {
    const second = await Promise.race([f.preview.prepareBytes({ ...input, id: secondId }), timeout]);
    assert.equal(second.status, 'ready'); assert.equal(second.artifactId, secondId);
    assert.deepEqual(second.pages, first.pages);
    const page = await f.preview.readBytesPage({ ...input, id: secondId, page: 1 });
    assert.equal(page.hash, first.pages[0].hash); assert.equal(page.artifactHash, input.hash);
    const savedCard = await Promise.race([f.preview.get(f.artifact.id), timeout]);
    assert.equal(savedCard.status, 'ready'); assert.equal(savedCard.artifactId, f.artifact.id);
    const savedPage = await f.preview.readPage(f.artifact.id, 1, { hash: input.hash });
    assert.equal(savedPage.hash, page.hash);
    await assert.rejects(f.preview.readBytesPage({ ...input, id: secondId, hash: 'f'.repeat(64), page: 1 }), /hash/);
  } finally { clearTimeout(timer) }
});

test('installed macOS asset KaiTi resolves to the real family and produces a Chinese preview without changing the PPTX', async t => {
  const assetRoot = '/System/Library/AssetsV2/com_apple_MobileAsset_Font8';
  if (!existsSync(assetRoot)) return t.skip('This regression requires the installed macOS font asset');
  const f = await fixture(t, '楷体', 'KaiTi');
  assert.ok(f.preview.fontDirectories.includes(realpathSync(assetRoot)));
  const result = await f.preview.get(f.artifact.id);
  assert.equal(result.status, 'ready', result.error);
  assert.equal(result.chineseGlyphCheck, 'passed'); assert.equal(result.pageCount, 2);
  const config = path.join(f.root, '.wtt-workbench', 'previews', 'fonts', `${result.fontConfigurationHash}.conf`);
  const fcMatch = ['/opt/homebrew/bin/fc-match', '/usr/bin/fc-match'].find(existsSync);
  if (fcMatch) {
    const family = await runProcess('python3', ['-c',
      'import os,subprocess,sys;print(subprocess.check_output([sys.argv[2],"-f","%{family}","KaiTi"],env={**os.environ,"FONTCONFIG_FILE":sys.argv[1]},text=True))', config, fcMatch]);
    assert.match(family, /STKaiti|Kaiti SC/);
    const mono = await runProcess('python3', ['-c',
      'import os,subprocess,sys;print(subprocess.check_output([sys.argv[2],"-f","%{family}","Consolas"],env={**os.environ,"FONTCONFIG_FILE":sys.argv[1]},text=True))', config, fcMatch]);
    assert.match(mono, /Menlo/, 'Windows monospace requests must use the installed monospace family');
  }
  assert.deepEqual((await f.service.tasks.files.download(f.artifact.id)).bytes, f.bytes);
  assert.equal(sha(readFileSync(f.file)), f.artifact.hash);
});

test('manual two-page editable PPTX: actual Builder rendering, exact pages, cache integrity and project/version fences', async t => {
  const f = await fixture(t);
  let first;

  await t.test('actual LibreOffice render produces two truthful PNGs, deduplicates in-flight work and leaves the source unchanged', async () => {
    const results = await Promise.all([f.preview.get(f.artifact.id), f.preview.get(f.artifact.id)]);
    first = results[0];
    assert.equal(first.status, 'ready', first.error);
    assert.deepEqual(results[1], first);
    assert.equal(first.hash, f.artifact.hash); assert.equal(first.pageCount, 2); assert.equal(first.coverPage, 1);
    assert.equal(first.derived, true); assert.equal(first.visualReview, 'pending');
    assert.equal(first.chineseGlyphCheck, 'passed'); assert.match(first.rendererVersion, /^cw10-ppt-preview-2-/);
    assert.deepEqual(first.pages.map(page => page.number), [1, 2]);
    assert.ok(first.pages.every(page => page.width === 1280 && page.height === 720 && /^[a-f0-9]{64}$/.test(page.hash)));
    assert.equal('workspace' in first, false); assert.equal('file' in first.pages[0], false);
    const page = await f.preview.readPage(f.artifact.id, 2, { hash: f.artifact.hash });
    assert.equal(page.mime, 'image/png'); assert.equal(page.artifactHash, f.artifact.hash);
    assert.equal(sha(page.bytes), first.pages[1].hash); assert.equal(page.name, 'P002.png');
    assert.equal(sha(readFileSync(f.file)), f.artifact.hash); assert.deepEqual(readFileSync(f.file), f.bytes);
    assert.equal((await f.preview.get(f.artifact.id)).createdAt, first.createdAt);
    const cached = cacheDirectory(f.preview, f.artifact);
    assert.deepEqual(readdirSync(cached).sort(), ['P001.png', 'P002.png', 'preview.json']);
  });

  if (first.status !== 'ready') return;

  await t.test('missing/wrong source hash and out-of-range page cannot return any other version', async () => {
    await assert.rejects(f.preview.readPage(f.artifact.id, 1), /必须指定.*版本 hash/);
    await assert.rejects(f.preview.readPage(f.artifact.id, 1, { hash: '0'.repeat(64) }), /版本不匹配/);
    await assert.rejects(f.preview.readPage(f.artifact.id, 3, { hash: f.artifact.hash }), /页码无效/);
    const mismatch = await f.preview.get(f.artifact.id, { hash: '0'.repeat(64) });
    assert.equal(mismatch.status, 'failed'); assert.match(mismatch.error, /版本已不匹配/);
  });

  await t.test('a damaged PNG re-renders from the same immutable PPTX without producing another task or artifact', async () => {
    const before = f.service.tasks.files.list(f.requirement.id).length;
    const cached = cacheDirectory(f.preview, f.artifact);
    writeFileSync(path.join(cached, 'P001.png'), 'broken PNG');
    const repaired = await f.preview.get(f.artifact.id);
    assert.equal(repaired.status, 'ready', repaired.error);
    assert.notEqual(repaired.createdAt, first.createdAt);
    assert.equal(f.service.tasks.files.list(f.requirement.id).length, before);
    assert.equal(sha(readFileSync(f.file)), f.artifact.hash);
    assert.equal((await f.preview.readPage(f.artifact.id, 1, { hash: f.artifact.hash })).width, 1280);
  });

  await t.test('changed original, symlink source, symlink cache parent and unknown artifact fail explicitly', async () => {
    writeFileSync(f.file, Buffer.concat([f.bytes, Buffer.from('\nexternal edit')]));
    const changed = await f.preview.get(f.artifact.id);
    assert.equal(changed.status, 'failed'); assert.equal(changed.hash, f.artifact.hash);
    await assert.rejects(f.preview.readPage(f.artifact.id, 1, { hash: f.artifact.hash }), /外改|缺失/);
    writeFileSync(f.file, f.bytes);
    const copy = path.join(f.root, 'source-outside-task.pptx'); writeFileSync(copy, f.bytes);
    unlinkSync(f.file); symlinkSync(copy, f.file);
    const linked = await f.preview.get(f.artifact.id);
    assert.equal(linked.status, 'failed'); assert.match(linked.error, /路径不可用|符号链接/);
    unlinkSync(f.file); writeFileSync(f.file, f.bytes);
    const parent = path.join(f.preview.cacheRoot, f.artifact.id), saved = `${parent}.saved`;
    const outside = path.join(f.root, 'outside-cache'); mkdirSync(outside);
    writeFileSync(path.join(outside, 'keep.txt'), 'do not alter');
    renameSync(parent, saved); symlinkSync(outside, parent);
    const escaped = await f.preview.get(f.artifact.id);
    assert.equal(escaped.status, 'failed'); assert.match(escaped.error, /符号链接/);
    assert.equal(readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'do not alter');
    unlinkSync(parent); renameSync(saved, parent);
    assert.equal((await f.preview.get(randomUUID())).status, 'failed');
  });

  await t.test('budgets and missing runtime return failed diagnostics and preserve the registered download', async () => {
    const limited = createArtifactPreview(f.service, { maxPages: 1 });
    const result = await limited.get(f.artifact.id); limited.close();
    assert.equal(result.status, 'failed'); assert.match(result.error, /页数超过预览限制/);
    const python = f.service.python; f.service.python = '/not-installed/python-for-preview';
    const missing = createArtifactPreview(f.service); f.service.python = python;
    const unavailable = await missing.get(f.artifact.id); missing.close();
    assert.equal(unavailable.status, 'failed'); assert.match(unavailable.error, /ENOENT/);
    const deadline = createArtifactPreview(f.service, { timeoutMs: 1, maxPages: 199 });
    const timedOut = await deadline.get(f.artifact.id); deadline.close();
    assert.equal(timedOut.status, 'failed'); assert.match(timedOut.error, /超过 1 ms/);
    const original = await f.service.tasks.files.download(f.artifact.id);
    assert.deepEqual(original.bytes, f.bytes);
  });

  await t.test('Chinese text with a deliberately Latin-only font configuration cannot become a blank ready preview', async () => {
    const fonts = path.join(f.root, 'latin-only-fonts'); mkdirSync(fonts);
    cpSync('/System/Library/Fonts/Times.ttc', path.join(fonts, 'Times.ttc'));
    const missingChinese = createArtifactPreview(f.service, { fontDirectories: [fonts] });
    const result = await missingChinese.get(f.artifact.id); missingChinese.close();
    assert.equal(result.status, 'failed'); assert.match(result.error, /中文未实际绘制|字体转换失败/);
    assert.deepEqual((await f.service.tasks.files.download(f.artifact.id)).bytes, f.bytes);
  });

  await t.test('source mutation while the renderer works cannot publish a stale preview', async () => {
    const cached = cacheDirectory(f.preview, f.artifact); rmSync(cached, { recursive: true });
    const timer = setTimeout(() => writeFileSync(f.file, Buffer.concat([f.bytes, Buffer.from('changed during preview')])), 100);
    const result = await f.preview.get(f.artifact.id); clearTimeout(timer);
    assert.equal(result.status, 'failed'); assert.match(result.error, /外改|变更/);
    assert.equal(existsSync(cached), false);
    writeFileSync(f.file, f.bytes);
  });

  await t.test('same artifact id in a second project stays within that service and uses its own hash/cache', async () => {
    const other = await fixture(t, 'B');
    const alias = path.join(other.directory, 'legacy-alias.pptx'); cpSync(other.file, alias);
    const row = other.service.store.db.prepare('SELECT * FROM task_files WHERE id=?').get(other.artifact.id);
    // Deliberate legacy DB fixture: the same UUID exists independently in B.
    other.service.store.db.prepare('INSERT INTO task_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(f.artifact.id,
      row.requirement_id, row.task_id, row.kind, row.title, path.relative(other.root, alias), row.hash, row.byte_size,
      row.mime, row.validation_json, row.source_card_ids_json, row.created_at);
    assert.notEqual(row.hash, f.artifact.hash);
    const result = await other.preview.get(f.artifact.id);
    assert.equal(result.status, 'ready', result.error); assert.equal(result.hash, row.hash);
    await assert.rejects(other.preview.readPage(f.artifact.id, 1, { hash: f.artifact.hash }), /版本不匹配/);
    const absent = await other.preview.get(randomUUID()); assert.equal(absent.status, 'failed');
    const crossed = { ...other.service, tasks: f.service.tasks };
    assert.throws(() => createArtifactPreview(crossed), /必须绑定当前项目/);
    assert.equal(sha(readFileSync(f.file)), f.artifact.hash);
  });
});
