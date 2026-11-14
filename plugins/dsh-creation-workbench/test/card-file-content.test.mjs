import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WorkbenchService } from '../src/service.mjs';
import { cardDisplayTitle } from '../src/card-capabilities.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'wtt-card-files-'));
  const service = new WorkbenchService({ workspaceRoot: root });
  const canvas = service.store.ensureDefaultCanvas();
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const draft = type => service.createOutputDraft({ requirementId: canvas.id, outputType: type, selectedCardIds: [], sourceRefs: [], position: { x: 100, y: 100 }, operationId: randomUUID() });
  const input = (node, filename, bytes) => ({ requirementId: canvas.id, nodeId: node.id,
    versionId: node.outputCard?.versionId || null, headVersionId: node.outputCard?.latestVersionId || null,
    sourceHash: node.sourceHash || null, filename, bytes, operationId: randomUUID() });
  return { root, service, canvas, draft, input };
}

test('upload publishes on the same empty card, preserves versions and sources, replays once and survives restart', async t => {
  const f = fixture(t);
  const { material } = f.service.canvas.addMaterial({ requirementId: f.canvas.id, title: '上游', content: '冻结资料', operationId: randomUUID() });
  const source = f.service.canvas.getBoard(f.canvas.id).nodes.find(n => n.refId === material.id);
  const draft = f.service.createOutputDraft({ requirementId: f.canvas.id, outputType: 'text', selectedCardIds: [source.id], sourceRefs: [{ cardId: source.id, hash: source.sourceHash }], position: { x: 500, y: 100 }, operationId: randomUUID() });
  const first = f.input(draft.node, '原稿.md', Buffer.from('# 第一版\n\n上传正文'));
  const result = await f.service.cardFiles.upload(first);
  assert.deepEqual(await f.service.cardFiles.upload(first), result);
  let board = f.service.canvas.getBoard(f.canvas.id), node = board.nodes.find(n => n.id === draft.node.id);
  assert.equal(node.content, '# 第一版\n\n上传正文');
  assert.equal(node.outputCard.versions.length, 1);
  assert.equal(f.service.tasks.list(f.canvas.id)[0].kind, 'manual');
  assert(board.edges.some(e => e.source === source.id && e.target === node.id));
  const originalPath = node.path, originalBytes = readFileSync(path.join(f.root, originalPath));
  const second = f.input(node, '第二版.txt', Buffer.from('第二版正文'));
  const saved = await f.service.cardFiles.upload(second);
  node = f.service.canvas.getBoard(f.canvas.id).nodes.find(n => n.id === draft.node.id);
  assert.equal(saved.cardId, result.cardId); assert.equal(node.outputCard.versions.length, 2);
  assert.equal(node.content, '第二版正文');
  assert.deepEqual(readFileSync(path.join(f.root, originalPath)), originalBytes);
  assert.equal(f.service.cards.describe({ requirementId: f.canvas.id, cardId: result.cardId, versionId: result.versionId }).node.content, first.bytes.toString());
  await assert.rejects(f.service.cardFiles.upload({ ...first, operationId: randomUUID() }), /已有新版本/);
  await assert.rejects(f.service.cardFiles.upload({ ...second, filename: '不同.txt' }), /操作标识/);
  const restarted = new WorkbenchService({ workspaceRoot: f.root }); t.after(() => restarted.close());
  assert.equal(restarted.canvas.getBoard(f.canvas.id).nodes.find(n => n.id === draft.node.id).outputCard.versions.length, 2);
});

test('rename syncs card, asset list and version views without changing files, references or versions', async t => {
  const f = fixture(t), draft = f.draft('text');
  const saved = await f.service.cardFiles.upload(f.input(draft.node, '原文件.md', Buffer.from('独有正文')));
  const before = f.service.canvas.getBoard(f.canvas.id).nodes.find(n => n.id === draft.node.id);
  const bytes = readFileSync(path.join(f.root, before.path));
  const input = { requirementId: f.canvas.id, nodeId: before.id, expectedTitle: before.outputCard.title, title: '新的资产名称', operationId: randomUUID() };
  assert.deepEqual(f.service.cardFiles.rename(input), f.service.cardFiles.rename(input));
  const after = f.service.canvas.getBoard(f.canvas.id).nodes.find(n => n.id === before.id);
  assert.equal(cardDisplayTitle(after), input.title);
  assert.equal(f.service.assets.course(f.canvas.id).cards.find(c => c.id === saved.cardId).title, input.title);
  assert.equal(f.service.cards.describe({ requirementId: f.canvas.id, cardId: saved.cardId }).node.displayTitle, input.title);
  assert.equal(after.path, before.path); assert.equal(after.sourceHash, before.sourceHash);
  assert.deepEqual(after.outputCard.versions, before.outputCard.versions);
  assert.deepEqual(readFileSync(path.join(f.root, before.path)), bytes);
  assert.throws(() => f.service.cardFiles.rename({ ...input, title: '另一个名字', operationId: randomUUID() }), /名称已被/);
  assert.throws(() => f.service.cardFiles.rename({ ...input, title: ' ', operationId: randomUUID() }), /名称须/);
});

test('type, byte validation, size, ownership and pending generation failures do not publish versions', async t => {
  const f = fixture(t), draft = f.draft('image');
  await assert.rejects(f.service.cardFiles.upload(f.input(draft.node, '正文.txt', Buffer.from('不能装进图片卡'))), /类型与卡片/);
  await assert.rejects(f.service.cardFiles.upload(f.input(draft.node, '假图.png', Buffer.from('not an image'))));
  await assert.rejects(f.service.cardFiles.upload(f.input(draft.node, '大图.png', Buffer.alloc(20 * 1024 * 1024 + 1))), /20 MB/);
  const other = f.service.store.createCanvas({ title: '其他画布', operationId: randomUUID() });
  await assert.rejects(f.service.cardFiles.upload({ ...f.input(draft.node, '图.png', Buffer.from('bad')), requirementId: other.id }), /不属于/);
  assert.equal(f.service.store.db.prepare('SELECT COUNT(*) AS n FROM output_card_versions').get().n, 0);
  assert.equal(f.service.store.db.prepare('SELECT COUNT(*) AS n FROM task_files').get().n, 0);
  const made = f.service.createTask({ requirementId: f.canvas.id, outputType: 'image', instruction: '等待发送', generation: { mode: 'new', cardId: draft.card.id }, selectedSkills: [], selectedCardIds: [], sourceRefs: [], operationId: randomUUID() });
  f.service.tasks.setDispatch({ taskId: made.task.id, status: 'submitting' });
  const pending = f.service.canvas.getBoard(f.canvas.id).nodes.find(n => n.id === draft.node.id);
  await assert.rejects(f.service.cardFiles.upload(f.input(pending, '图.png', Buffer.from('bad'))), /任务尚未结束/);
});

test('real image and video uploads open as validated media on the original cards', async t => {
  const f = fixture(t), image = path.join(f.root, 'fixture.png'), video = path.join(f.root, 'fixture.mp4');
  const png = spawnSync('python3', ['-c', 'from PIL import Image;import sys;Image.new("RGB",(32,24),"blue").save(sys.argv[1])', image]);
  assert.equal(png.status, 0, png.stderr?.toString());
  const mp4 = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x24:d=0.2', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  assert.equal(mp4.status, 0, mp4.stderr?.toString());
  for (const [type, file] of [['image', image], ['video', video]]) {
    const draft = f.draft(type), bytes = readFileSync(file);
    await f.service.cardFiles.upload(f.input(draft.node, path.basename(file), bytes));
    const node = f.service.canvas.getBoard(f.canvas.id).nodes.find(n => n.id === draft.node.id);
    assert.equal(node.outputCard.type, type); assert(node.generatedFile.mime.startsWith(type + '/'));
    assert.equal(node.generatedFile.media.width, 32);
    assert.deepEqual(f.service.tasks.files.read(node.refId).bytes, bytes);
  }
});

test('parallel retries publish once and competing uploads cannot overwrite a new head', async t => {
  const f = fixture(t), draft = f.draft('text');
  const input = f.input(draft.node, '正文.md', Buffer.from('同一内容'));
  const [a, b] = await Promise.all([f.service.cardFiles.upload(input), f.service.cardFiles.upload(input)]);
  assert.deepEqual(a, b);
  const node = f.service.canvas.getBoard(f.canvas.id).nodes.find(n => n.id === draft.node.id);
  const [first, second] = await Promise.allSettled([
    f.service.cardFiles.upload(f.input(node, '版本甲.md', Buffer.from('甲内容'))),
    f.service.cardFiles.upload(f.input(node, '版本乙.md', Buffer.from('乙内容'))),
  ]);
  assert.equal([first, second].filter(r => r.status === 'fulfilled').length, 1);
  assert.match([first, second].find(r => r.status === 'rejected').reason.message, /已有新版本/);
  assert.equal(f.service.canvas.getBoard(f.canvas.id).nodes.find(n => n.id === node.id).outputCard.versions.length, 2);
});

test('uploaded PPTX and imported document cards retain their real file formats and prior versions', async t => {
  const f = fixture(t), pptx = path.join(f.root, '上传演示.pptx'), docx = path.join(f.root, '上传文档.docx');
  const made = spawnSync('python3', ['-c', 'from pptx import Presentation;from docx import Document;import sys;r=Presentation();s=r.slides.add_slide(r.slide_layouts[1]);s.shapes.title.text="Uploaded presentation";r.save(sys.argv[1]);d=Document();d.add_paragraph("Uploaded document");d.save(sys.argv[2])', pptx, docx]);
  assert.equal(made.status, 0, made.stderr?.toString());
  const draft = f.draft('pptx');
  await f.service.cardFiles.upload(f.input(draft.node, '上传演示.pptx', readFileSync(pptx)));
  const p = f.service.canvas.getBoard(f.canvas.id).nodes.find(n => n.id === draft.node.id);
  assert.equal(p.outputCard.type, 'pptx'); assert.equal(p.artifactKind, 'pptx');
  assert.equal(f.service.tasks.files.get(p.refId).validation.editabilityChecked, false);
  const imported = await f.service.importMaterial({ requirementId: f.canvas.id, filename: '原文档.docx', bytes: readFileSync(docx), operationId: randomUUID() });
  const before = f.service.canvas.getBoard(f.canvas.id).nodes.find(n => n.refId === imported.material.id);
  const result = await f.service.cardFiles.upload(f.input(before, '新版文档.docx', readFileSync(docx)));
  const after = f.service.canvas.getBoard(f.canvas.id).nodes.find(n => n.id === before.id);
  assert.equal(after.outputCard.versions.length, 2); assert(after.path.endsWith('.docx'));
  assert.deepEqual(f.service.cards.describe({ requirementId: f.canvas.id, cardId: result.cardId, versionId: before.outputCard.versionId }).node.importedFile, before.importedFile);
});
