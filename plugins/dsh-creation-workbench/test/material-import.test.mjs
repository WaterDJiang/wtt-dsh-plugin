import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WorkbenchService } from '../src/service.mjs';
import { inspectMaterialImport, IMPORT_MAX_BYTES, IMPORT_TEXT_BYTES } from '../src/material-import.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'wtt-import-')));
  const service = new WorkbenchService({ workspaceRoot: root });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const requirement = service.store.createRequirement({ title: '文件导入技术验收', operationId: randomUUID() });
  const imported = (filename, bytes, extra = {}) => service.importMaterial({ requirementId: requirement.id, operationId: randomUUID(), filename, bytes: Buffer.from(bytes), ...extra });
  return { root, service, requirement, imported };
}

test('UTF-8 imports preserve real original bytes and immutable extracted snapshots for every text format', async t => {
  const { root, service, requirement, imported } = fixture(t);
  for (const extension of ['txt', 'md', 'csv', 'json', 'jsonl']) {
    const bytes = Buffer.from('课程资料：材料 → 操作 → 完成判断\n');
    const { material, board } = await imported(`资料.${extension}`, bytes);
    assert.equal(material.content, bytes.toString());
    assert.equal(material.extracted, true);
    assert.equal(material.importedFile.extractionStatus, 'extracted');
    assert.equal(material.importedFile.byteSize, bytes.length);
    assert.match(material.importedFile.path, new RegExp(`^courses/${requirement.id}/imports/[0-9a-f-]+/资料\\.${extension}$`));
    assert.deepEqual(readFileSync(path.join(root, material.importedFile.path)), bytes);
    assert.equal(readFileSync(path.join(root, material.path), 'utf8'), material.content);
    assert.deepEqual(service.canvas.readImportedFile(material.id).bytes, bytes);
    const node = board.nodes.find(node => node.refId === material.id);
    assert.equal(node.importedFile.hash, material.importedFile.hash);
    assert.equal(node.sourceStatus, 'ready');
    assert.equal(node.sourceHash, material.hash);
  }
});

test('existing Python libraries extract real PDF, DOCX and PPTX while images retain exact originals', async t => {
  const { root, service, imported } = fixture(t);
  const result = spawnSync('python3', ['-c', [
    'import sys,os,fitz', 'from docx import Document', 'from pptx import Presentation', 'from pptx.util import Inches', 'from PIL import Image',
    'root=sys.argv[1]', 'pdf=fitz.open()', 'page=pdf.new_page()', 'page.insert_text((40,60),"PDF extraction fixture")', 'pdf.save(os.path.join(root,"sample.pdf"))', 'pdf.close()',
    'doc=Document()', 'doc.add_paragraph("DOCX 课程参考正文")', 'doc.add_table(rows=1,cols=1).cell(0,0).text="独立材料"', 'doc.save(os.path.join(root,"sample.docx"))',
    'deck=Presentation()', 'slide=deck.slides.add_slide(deck.slide_layouts[6])', 'slide.shapes.add_textbox(Inches(1),Inches(1),Inches(5),Inches(1)).text="PPTX 课程参考正文"', 'deck.save(os.path.join(root,"sample.pptx"))',
    'image=Image.new("RGB",(8,8),"blue")',
    '[image.save(os.path.join(root,"sample."+extension)) for extension in ["png","jpg","jpeg","webp","gif"]]',
  ].join('; '), root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const [extension, phrase] of [['pdf', 'PDF extraction fixture'], ['docx', 'DOCX 课程参考正文'], ['pptx', 'PPTX 课程参考正文']]) {
    const { material } = await imported(`sample.${extension}`, readFileSync(path.join(root, `sample.${extension}`)));
    assert.equal(material.importedFile.extractionStatus, 'extracted');
    assert.ok(material.content.includes(phrase), material.content);
    if (extension === 'docx') assert.match(material.content, /独立材料/);
  }
  for (const extension of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
    const bytes = readFileSync(path.join(root, `sample.${extension}`));
    const { material } = await imported(`sample.${extension}`, bytes);
    assert.equal(material.extracted, false);
    assert.equal(material.importedFile.extractionStatus, 'unparsed');
    assert.match(material.importedFile.extractionError, /文字识别/);
    const file = service.canvas.readImportedFile(material.id, { preview: true });
    assert.match(file.mime, /^image\//);
    assert.deepEqual(file.bytes, bytes);
  }
});

test('truncation respects the UTF-8 byte budget and retains the complete larger original', async t => {
  const { root, service, imported } = fixture(t);
  const bytes = Buffer.from('界'.repeat(500_000));
  const { material, board } = await imported('长参考.txt', bytes);
  assert.equal(material.importedFile.truncated, true);
  assert.ok(Buffer.byteLength(material.content) <= IMPORT_TEXT_BYTES);
  assert.doesNotMatch(material.content, /\ufffd/);
  assert.equal(board.nodes.find(node => node.refId === material.id).sourceStatus, 'ready');
  assert.deepEqual(service.canvas.readImportedFile(material.id).bytes, bytes);
  assert.equal(readFileSync(path.join(root, material.importedFile.path)).length, 1_500_000);
});

test('unsupported text encoding, damaged documents and disguised images retain originals without claiming extraction', async t => {
  const { service, imported } = fixture(t);
  for (const [filename, bytes] of [['损坏.pdf', Buffer.from('not a PDF')], ['损坏.docx', Buffer.from('not a ZIP')], ['损坏.pptx', Buffer.from('not a ZIP')], ['编码.txt', Buffer.from([255, 254, 0, 0])], ['伪装.png', Buffer.from('<script>alert(1)</script>')]]) {
    const { material } = await imported(filename, bytes);
    assert.equal(material.extracted, false);
    assert.equal(material.importedFile.extractionStatus, 'unparsed');
    assert.ok(material.importedFile.extractionError);
    assert.deepEqual(service.canvas.readImportedFile(material.id).bytes, bytes);
    assert.throws(() => service.canvas.readImportedFile(material.id, { preview: true }), /图片或视频可预览/);
  }
});

test('size and file names are checked before writing; operation replay ignores placement but rejects changed files', async t => {
  const { root, service, requirement, imported } = fixture(t);
  assert.equal(inspectMaterialImport({ filename: 'limit.txt', bytes: Buffer.alloc(IMPORT_MAX_BYTES) }).byteSize, IMPORT_MAX_BYTES);
  assert.throws(() => inspectMaterialImport({ filename: 'limit.txt', bytes: Buffer.alloc(IMPORT_MAX_BYTES + 1) }), error => error.status === 413);
  for (const filename of ['../逃逸.txt', 'a\\b.md', 'a\0.txt', 'a\n.txt', 'legacy.doc', 'legacy.ppt', 'x.svg', 'x.heic', 'x'.repeat(241) + '.txt']) {
    await assert.rejects(imported(filename, '正文'), /文件名|格式/);
  }
  assert.equal(service.canvas.getBoard(requirement.id).nodes.length, 1);
  assert.equal(readdirSync(root).includes('courses'), false);
  const operationId = randomUUID();
  const first = await imported('需求:参考.md', '原正文', { operationId, position: { x: 100, y: 200 } });
  const second = await imported('需求:参考.md', '原正文', { operationId, position: { x: 700, y: 800 } });
  assert.equal(first.material.id, second.material.id);
  assert.equal(second.material.importedFile.name, '需求:参考.md');
  assert.match(second.material.importedFile.path, /需求_参考\.md$/);
  assert.deepEqual(second.board.nodes.find(node => node.refId === first.material.id).position, { x: 100, y: 200 });
  await assert.rejects(imported('需求:参考.md', '改后正文', { operationId }), /不同文件或内容/);
  await assert.rejects(imported('另一个.md', '原正文', { operationId }), /不同文件或内容/);
});

test('a failed database registration removes only its newly copied original and snapshot and can retry', async t => {
  const { root, service, requirement, imported } = fixture(t);
  const operationId = randomUUID();
  service.store.db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON canvas_imports BEGIN SELECT RAISE(ABORT,'forced import registration failure'); END;");
  await assert.rejects(imported('事务.txt', '正文', { operationId }), /forced import registration failure/);
  assert.equal(service.store.db.prepare('SELECT count(*) AS n FROM canvas_materials').get().n, 0);
  assert.equal(service.store.db.prepare('SELECT count(*) AS n FROM canvas_imports').get().n, 0);
  assert.deepEqual(readdirSync(path.join(root, 'courses', requirement.id, 'imports', operationId)), []);
  assert.deepEqual(readdirSync(path.join(root, 'courses', requirement.id, 'materials')), []);
  service.store.db.exec('DROP TRIGGER fail_import');
  const { material } = await imported('事务.txt', '正文', { operationId });
  assert.equal(service.canvas.readImportedFile(material.id).bytes.toString(), '正文');
});

test('original file changes or symlink replacement cannot be downloaded or previewed', async t => {
  const { root, service, imported } = fixture(t);
  const { material } = await imported('只读.txt', '原文');
  const file = path.join(root, material.importedFile.path);
  writeFileSync(file, '改文');
  assert.throws(() => service.canvas.readImportedFile(material.id), /hash.*变化/);
  assert.equal(service.canvas.getBoard(material.requirementId).nodes.find(node => node.refId === material.id).sourceStatus, 'changed');
  assert.equal(service.prepareCanvas({ requirementId: material.requirementId, selectedCardIds: [`material:${material.id}`], instruction: '使用冻结正文' }).context[0].content, '原文');
  const outside = path.join(root, 'outside.txt'); writeFileSync(outside, '原文');
  unlinkSync(file); symlinkSync(outside, file);
  assert.throws(() => service.canvas.readImportedFile(material.id), /替换|不可用/);
  unlinkSync(file);
  assert.throws(() => service.canvas.readImportedFile(material.id), /ENOENT/);
});

test('symlinked import directories and unknown requirements cannot receive copies', async t => {
  const { root, service, requirement, imported } = fixture(t);
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'wtt-import-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'courses', requirement.id), { recursive: true });
  symlinkSync(outside, path.join(root, 'courses', requirement.id, 'imports'));
  await assert.rejects(imported('越界.txt', '正文'), /目录不可用/);
  assert.deepEqual(readdirSync(outside), []);
  await assert.rejects(service.importMaterial({ requirementId: randomUUID(), filename: '其他.txt', bytes: Buffer.from('正文'), operationId: randomUUID() }), /需求不存在/);
});

test('whiteboard references use stored text, reuse its latest text version, and keep older snapshots immutable', t => {
  const { root, service, requirement } = fixture(t);
  const id = `whiteboard:${randomUUID()}`;
  let board = service.canvas.getBoard(requirement.id);
  const element = { id, kind: 'note', text: '白板原文\n独立材料', width: 258, height: 208, colour: 'cream' };
  board = service.canvas.saveBoard({ requirementId: requirement.id, expectedRevision: board.revision, elements: [element] });
  const operationId = randomUUID();
  const args = { requirementId: requirement.id, elementId: id, expectedContent: element.text, operationId };
  const first = service.canvas.snapshotWhiteboard(args);
  assert.equal(first.material.whiteboardSource.elementId, id);
  assert.equal(first.material.whiteboardSource.revision, board.revision);
  assert.equal(first.material.content, element.text);
  assert.equal(first.board.edges.some(edge => edge.provenance && edge.source === id), false);
  const replay = service.canvas.snapshotWhiteboard({ ...args, position: { x: 500, y: 400 } });
  assert.equal(replay.material.id, first.material.id);
  board = service.canvas.saveBoard({ requirementId: requirement.id, expectedRevision: first.board.revision, viewport: { x: 90, y: 50, zoom: 1 } });
  const reused = service.canvas.snapshotWhiteboard({ ...args, operationId: randomUUID() });
  assert.equal(reused.material.id, first.material.id);
  board = service.canvas.saveBoard({ requirementId: requirement.id, expectedRevision: board.revision, elements: [{ ...element, text: '白板新文字' }] });
  assert.throws(() => service.canvas.snapshotWhiteboard({ ...args, operationId: randomUUID() }), /正文已变化/);
  const next = service.canvas.snapshotWhiteboard({ ...args, expectedContent: '白板新文字', operationId: randomUUID() });
  assert.notEqual(next.material.id, first.material.id);
  assert.equal(readFileSync(path.join(root, first.material.path), 'utf8'), element.text);
  assert.equal(service.canvas.snapshotWhiteboard(args).material.id, first.material.id);
  const other = service.store.createRequirement({ title: '其他需求', operationId: randomUUID() });
  assert.throws(() => service.canvas.snapshotWhiteboard({ ...args, requirementId: other.id, operationId: randomUUID() }), /不存在或不属于/);
  assert.throws(() => service.canvas.snapshotWhiteboard({ ...args, expectedContent: '  ', operationId: randomUUID() }), /无文字/);
});
