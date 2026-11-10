import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkbenchStore } from '../src/store.mjs';
import { CanvasStore } from '../src/canvas-store.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'wtt-canvas-'));
  const store = new WorkbenchStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, canvas: new CanvasStore(store) };
}
const requirement = (store, title = '课程需求') => store.createRequirement({ title, customer: '客户甲', background: '真实背景', operationId: randomUUID() });
const outline = (store, requirementId, extra = {}) => store.saveOutline({ requirementId, markdown: '# 不可变大纲\n\n第一章', operationId: randomUUID(), ...extra });
const material = (canvas, requirementId, extra = {}) => canvas.addMaterial({ requirementId, title: '客户反馈', content: '需要增加课堂实操', operationId: randomUUID(), ...extra });

test('CW-01 database migration keeps historical operation replay and canonical artifacts', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtt-canvas-old-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, '.wtt-workbench'));
  const req = randomUUID(), ver = randomUUID(), op = randomUUID();
  const markdown = '# 旧大纲';
  const relative = `courses/${req}/v001/outline.md`;
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), markdown);
  const db = new DatabaseSync(path.join(root, '.wtt-workbench', 'workbench.sqlite'));
  db.exec(`CREATE TABLE requirements (id TEXT PRIMARY KEY,title TEXT,customer TEXT,audience TEXT,background TEXT,objectives TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE outline_versions (id TEXT PRIMARY KEY,requirement_id TEXT,number INTEGER,markdown TEXT,markdown_path TEXT,hash TEXT,word_path TEXT,created_at TEXT);
    CREATE TABLE operations (id TEXT PRIMARY KEY,kind TEXT,input_hash TEXT,result_id TEXT);`);
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  db.prepare('INSERT INTO requirements VALUES (?,?,?,?,?,?,?,?)').run(req, '历史课程', '', '', '', '', 'now', 'now');
  db.prepare('INSERT INTO outline_versions VALUES (?,?,?,?,?,?,?,?)').run(ver, req, 1, markdown, relative, hash(markdown), null, 'now');
  db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(op, 'save-outline', hash(JSON.stringify({ requirementId: req, markdown })), ver);
  db.close();
  const store = new WorkbenchStore(root);
  try {
    const canvas = new CanvasStore(store);
    assert.deepEqual(store.getVersion(ver).sourceCardIds, []);
    assert.equal(store.saveOutline({ requirementId: req, markdown, operationId: op, sourceCardIds: [] }).id, ver);
    const board = canvas.getBoard(req);
    assert.equal(board.nodes.find((node) => node.id === `outline:${ver}`).content, markdown);
    assert.deepEqual(board.edges.map((edge) => [edge.source, edge.target, edge.provenance]), [[`requirement:${req}`, `outline:${ver}`, true]]);
    assert.equal(outline(store, req).number, 2);
    assert.equal(readFileSync(path.join(root, relative), 'utf8'), markdown);
  } finally { store.close(); }
});

test('layout, manual edges, groups and viewport survive reopening; new versions preserve old layout', (t) => {
  const { root, store, canvas } = fixture(t);
  const req = requirement(store);
  const added = material(canvas, req.id);
  const v1 = outline(store, req.id);
  const reqId = `requirement:${req.id}`, materialId = `material:${added.material.id}`, outlineId = `outline:${v1.id}`;
  const saved = canvas.saveBoard({ requirementId: req.id, expectedRevision: added.board.revision,
    positions: { [reqId]: { x: -35, y: 200 }, [outlineId]: { x: 800, y: 700 } },
    edges: [{ id: 'manual-edge', source: materialId, target: reqId }],
    groups: [{ id: 'group-a', title: '需求与反馈', nodeIds: [reqId, materialId] }], viewport: { x: -100, y: 40, zoom: 0.7 } });
  assert.equal(saved.revision, 2);
  const v2 = outline(store, req.id, { markdown: '# 第二版' });
  store.close();
  const reopened = new WorkbenchStore(root);
  try {
    const restored = new CanvasStore(reopened).getBoard(req.id);
    assert.deepEqual(restored.groups, saved.groups);
    assert.deepEqual(restored.viewport, saved.viewport);
    assert.deepEqual(restored.nodes.find((node) => node.id === outlineId).position, { x: 800, y: 700 });
    assert.ok(restored.nodes.find((node) => node.id === `outline:${v2.id}`));
    assert.ok(restored.edges.find((edge) => edge.id === 'manual-edge'));
    assert.equal(restored.revision, saved.revision);
  } finally { reopened.close(); }
});

test('stale revisions reject without overwriting; unknown cards and forged body cannot alter truth', (t) => {
  const { root, store, canvas } = fixture(t);
  const req = requirement(store), id = `requirement:${req.id}`;
  const secondStore = new WorkbenchStore(root);
  const secondCanvas = new CanvasStore(secondStore);
  assert.equal(secondCanvas.getBoard(req.id).revision, 0);
  canvas.saveBoard({ requirementId: req.id, expectedRevision: 0, positions: { [id]: { x: 12, y: 34 } }, nodes: [{ id, content: '伪造正文' }] });
  try {
    assert.throws(() => secondCanvas.saveBoard({ requirementId: req.id, expectedRevision: 0, positions: {} }), /其他操作修改/);
  } finally { secondStore.close(); }
  assert.throws(() => canvas.saveBoard({ requirementId: req.id, expectedRevision: 0, positions: {} }), /其他操作修改/);
  assert.throws(() => canvas.saveBoard({ requirementId: req.id, expectedRevision: 1, positions: { fake: { x: 0, y: 0 } } }), /未知卡片/);
  assert.throws(() => canvas.saveBoard({ requirementId: req.id, expectedRevision: 1, positions: { [id]: { x: Infinity, y: 0 } } }), /坐标/);
  assert.throws(() => canvas.saveBoard({ requirementId: req.id, expectedRevision: 1, viewport: { x: 0, y: 0, zoom: 0 } }), /缩放/);
  assert.equal(canvas.getBoard(req.id).revision, 1);
  assert.match(canvas.getBoard(req.id).nodes[0].content, /真实背景/);
  assert.deepEqual(canvas.getBoard(req.id).nodes[0].position, { x: 12, y: 34 });
});

test('material creates an immutable UTF-8 snapshot and replays once even after original disappears', (t) => {
  const { root, store, canvas } = fixture(t);
  const req = requirement(store);
  writeFileSync(path.join(root, '客户.txt'), '客户的真实要求');
  const input = { requirementId: req.id, title: '客户文件', sourcePath: '客户.txt', operationId: randomUUID(), position: { x: 7, y: 8 } };
  const first = canvas.addMaterial(input);
  assert.equal(readFileSync(path.join(root, first.material.path), 'utf8'), '客户的真实要求');
  assert.equal(readFileSync(path.join(root, '客户.txt'), 'utf8'), '客户的真实要求');
  assert.equal(first.material.extracted, true);
  assert.deepEqual(first.board.nodes.find((node) => node.kind === 'material').position, { x: 7, y: 8 });
  unlinkSync(path.join(root, '客户.txt'));
  const replayed = canvas.addMaterial(input);
  assert.equal(replayed.material.id, first.material.id);
  assert.equal(replayed.board.revision, 1);
  assert.equal(replayed.board.nodes.find((node) => node.kind === 'material').sourceStatus, 'missing');
  assert.equal(replayed.board.nodes.filter((node) => node.kind === 'material').length, 1);
  assert.throws(() => canvas.addMaterial({ ...input, title: '不同内容' }), /不同内容/);
  writeFileSync(path.join(root, first.material.path), '外部改写');
  const changed = canvas.getBoard(req.id).nodes.find((node) => node.kind === 'material');
  assert.equal(changed.status, 'changed');
  assert.equal(changed.content, '客户的真实要求');
  unlinkSync(path.join(root, first.material.path));
  assert.equal(canvas.getBoard(req.id).nodes.find((node) => node.kind === 'material').status, 'missing');
});

test('pasted text has usable body while comments on a binary source do not claim extraction', (t) => {
  const { root, store, canvas } = fixture(t);
  const req = requirement(store);
  const pasted = material(canvas, req.id, { sourcePath: '' });
  assert.equal(pasted.material.extracted, true);
  assert.equal(pasted.board.nodes.find((node) => node.id === `material:${pasted.material.id}`).extracted, true);
  writeFileSync(path.join(root, 'slides.pptx'), Buffer.from([0, 1, 2, 255]));
  const commented = material(canvas, req.id, { content: '这是用户补充的说明', sourcePath: 'slides.pptx' });
  assert.equal(commented.material.content, '这是用户补充的说明');
  assert.equal(commented.material.extracted, false);
});

test('paths reject traversal, symlink components, missing, oversized or invalid text; binary is a reference', (t) => {
  const { root, store, canvas } = fixture(t);
  const req = requirement(store);
  const add = (sourcePath) => material(canvas, req.id, { content: '', sourcePath });
  assert.throws(() => add('../outside.txt'), /工作目录/);
  assert.throws(() => add(path.join(root, 'absolute.txt')), /工作目录/);
  assert.throws(() => add('missing.txt'), /不存在/);
  writeFileSync(path.join(root, 'huge.txt'), 'x'.repeat(1_048_577));
  assert.throws(() => add('huge.txt'), /1 MB/);
  writeFileSync(path.join(root, 'invalid.txt'), Buffer.from([0xff]));
  assert.throws(() => add('invalid.txt'), /UTF-8/);
  writeFileSync(path.join(root, 'real.txt'), '原文');
  symlinkSync(path.join(root, 'real.txt'), path.join(root, 'link.txt'));
  assert.throws(() => add('link.txt'), /符号链接/);
  mkdirSync(path.join(root, 'real-dir'));
  writeFileSync(path.join(root, 'real-dir', 'inside.md'), '内部原文');
  symlinkSync(path.join(root, 'real-dir'), path.join(root, 'link-dir'));
  assert.throws(() => add('link-dir/inside.md'), /符号链接/);
  writeFileSync(path.join(root, 'slides.pptx'), Buffer.from([0, 1, 2, 255]));
  const binary = add('slides.pptx').material;
  assert.equal(binary.extracted, false);
  assert.equal(binary.sourcePath, 'slides.pptx');
  assert.match(binary.content, /未自动提取正文/);
  assert.equal(canvas.getBoard(req.id).nodes.filter((node) => node.kind === 'material').length, 1);
});

test('real source cards are saved transactionally; all provenance edges survive user deletion', (t) => {
  const { root, store, canvas } = fixture(t);
  const req = requirement(store), other = requirement(store, '另一需求');
  const added = material(canvas, req.id), otherMaterial = material(canvas, other.id);
  const reqId = `requirement:${req.id}`, materialId = `material:${added.material.id}`;
  assert.deepEqual(canvas.validateSources(req.id, [materialId, reqId, materialId]), [materialId, reqId]);
  assert.throws(() => canvas.validateSources(req.id, [`material:${otherMaterial.material.id}`]), /当前需求/);
  assert.throws(() => outline(store, req.id, { sourceCardIds: [`requirement:${other.id}`] }), /当前需求/);
  assert.throws(() => outline(store, req.id, { sourceCardIds: [`material:${otherMaterial.material.id}`] }), /当前需求/);
  assert.deepEqual(store.getRequirement(req.id).versions, []);
  assert.equal(existsSync(path.join(root, 'courses', req.id, 'v001')), false);
  const v1 = outline(store, req.id, { sourceCardIds: [materialId, reqId, materialId] });
  assert.deepEqual(v1.sourceCardIds, [materialId, reqId].sort());
  assert.throws(() => outline(store, req.id, { sourceCardIds: [`word:${v1.id}`] }), /当前需求/);
  const wordPath = v1.markdownPath.replace(/outline\.md$/, 'outline.docx');
  writeFileSync(path.join(root, wordPath), '非空 Word 占位：仅测业务引用');
  store.markWordExport({ versionId: v1.id, relativePath: wordPath });
  const v2 = outline(store, req.id, { sourceCardIds: [`outline:${v1.id}`, `word:${v1.id}`] });
  const board = canvas.getBoard(req.id);
  assert.ok(board.edges.find((edge) => edge.source === materialId && edge.target === `outline:${v1.id}`));
  assert.ok(board.edges.find((edge) => edge.source === `outline:${v1.id}` && edge.target === `word:${v1.id}`));
  assert.ok(board.edges.find((edge) => edge.source === `word:${v1.id}` && edge.target === `outline:${v2.id}`));
  const saved = canvas.saveBoard({ requirementId: req.id, expectedRevision: board.revision, edges: [] });
  assert.deepEqual(saved.edges, board.edges);
  assert.equal(saved.nodes.find((node) => node.id === `word:${v1.id}`).path, wordPath);
});

test('edges and groups cannot smuggle foreign or unknown nodes or fake provenance', (t) => {
  const { store, canvas } = fixture(t);
  const req = requirement(store), other = requirement(store, '别的课程');
  const added = material(canvas, req.id);
  const a = `requirement:${req.id}`, b = `material:${added.material.id}`, foreign = `requirement:${other.id}`;
  const save = (data) => canvas.saveBoard({ requirementId: req.id, expectedRevision: added.board.revision, ...data });
  assert.throws(() => save({ edges: [{ id: 'a', source: a, target: foreign }] }), /未知卡片/);
  assert.throws(() => save({ edges: [{ id: 'a', source: a, target: b, provenance: true }] }), /真实产物/);
  assert.throws(() => save({ edges: [{ id: 'a', source: a, target: b }, { id: 'a', source: b, target: a }] }), /重复/);
  assert.throws(() => save({ groups: [{ id: 'g', title: '组', nodeIds: [a, foreign] }] }), /未知/);
  assert.throws(() => save({ groups: [{ id: 'g', title: '组', nodeIds: [a, a] }] }), /重复/);
  assert.throws(() => save({ groups: [{ id: 'g', title: '组', nodeIds: [a, b] }, { id: 'h', title: '重复组', nodeIds: [a, b] }] }), /重复/);
  assert.equal(canvas.getBoard(req.id).revision, added.board.revision);
});

test('failed material database writes remove only new snapshots and allow retry', (t) => {
  const { root, store, canvas } = fixture(t);
  const req = requirement(store);
  const input = { requirementId: req.id, title: '素材', content: '待保存内容', operationId: randomUUID() };
  store.db.exec("CREATE TRIGGER fail_material BEFORE INSERT ON canvas_materials BEGIN SELECT RAISE(ABORT, '材料写入失败'); END");
  assert.throws(() => canvas.addMaterial(input), /材料写入失败/);
  assert.deepEqual(readdirSync(path.join(root, 'courses', req.id, 'materials')), []);
  assert.equal(canvas.getBoard(req.id).revision, 0);
  store.db.exec('DROP TRIGGER fail_material');
  assert.equal(canvas.addMaterial(input).board.nodes.length, 2);
});

test('canvas data never crosses requirements or selected folders; artifact roots reject symlinks', (t) => {
  const a = fixture(t), b = fixture(t);
  const req = requirement(a.store), other = requirement(a.store, '另一个需求');
  material(a.canvas, req.id);
  assert.equal(a.canvas.getBoard(other.id).nodes.length, 1);
  assert.throws(() => b.canvas.getBoard(req.id), /需求不存在/);
  assert.throws(() => material(b.canvas, req.id), /需求不存在/);
  assert.deepEqual(b.store.listRequirements(), []);
  const reqB = requirement(b.store);
  symlinkSync(a.root, path.join(b.root, 'courses'));
  assert.throws(() => material(b.canvas, reqB.id), /素材目录不可用/);
  assert.equal(b.canvas.getBoard(reqB.id).revision, 0);
});

test('DSH session mappings survive restart, stay scoped and clear without changing layout revisions', (t) => {
  const { root, store, canvas } = fixture(t);
  const otherFolder = fixture(t);
  const req = requirement(store), other = requirement(store, '另一个课程');
  const sessionId = 'DSH /会话: 1';
  assert.equal(canvas.getBoard(req.id).sessionId, null);
  assert.deepEqual(canvas.setSession({ requirementId: req.id, sessionId }), { sessionId });
  assert.equal(canvas.getBoard(req.id).revision, 0);
  assert.equal(canvas.getBoard(other.id).sessionId, null);
  assert.throws(() => otherFolder.canvas.setSession({ requirementId: req.id, sessionId }), /需求不存在/);
  for (const invalid of ['', ' ', 'x'.repeat(201), undefined, 1]) {
    assert.throws(() => canvas.setSession({ requirementId: req.id, sessionId: invalid }), /会话标识/);
  }
  store.close();
  const reopened = new WorkbenchStore(root);
  try {
    const restored = new CanvasStore(reopened);
    assert.equal(restored.getBoard(req.id).sessionId, sessionId);
    assert.equal(restored.getBoard(other.id).sessionId, null);
    assert.deepEqual(restored.setSession({ requirementId: req.id, sessionId: null }), { sessionId: null });
    assert.equal(restored.getBoard(req.id).sessionId, null);
    assert.equal(restored.getBoard(req.id).revision, 0);
  } finally { reopened.close(); }
});

test('material markdown files use readable titles with sequence suffixes, sanitized characters and no overwrite', (t) => {
  const { root, store, canvas } = fixture(t);
  const req = requirement(store);
  const first = canvas.addMaterial({ requirementId: req.id, title: '需求文档', content: '第一份', operationId: randomUUID() });
  const second = canvas.addMaterial({ requirementId: req.id, title: '需求文档', content: '第二份', operationId: randomUUID() });
  const weird = canvas.addMaterial({ requirementId: req.id, title: '白板 · a/b：c', content: '特殊字符', operationId: randomUUID() });
  const imported = canvas.addMaterial({ requirementId: req.id, title: '课堂笔记.md', content: '导入标题带扩展名', operationId: randomUUID() });
  assert.equal(first.material.path, `courses/${req.id}/materials/需求文档.md`);
  assert.equal(second.material.path, `courses/${req.id}/materials/需求文档-2.md`);
  assert.equal(weird.material.path, `courses/${req.id}/materials/白板 · a_b：c.md`);
  assert.equal(imported.material.path, `courses/${req.id}/materials/课堂笔记.md`);
  for (const item of [first, second, weird, imported]) {
    assert.ok(existsSync(path.join(root, item.material.path)));
    assert.equal(readFileSync(path.join(root, item.material.path), 'utf8'), item.material.content);
  }
  writeFileSync(path.join(root, `courses/${req.id}/materials/占位.md`), '外部占位');
  const blocked = canvas.addMaterial({ requirementId: req.id, title: '占位', content: '不覆盖占位', operationId: randomUUID() });
  assert.equal(blocked.material.path, `courses/${req.id}/materials/占位-2.md`);
  assert.equal(readFileSync(path.join(root, `courses/${req.id}/materials/占位.md`), 'utf8'), '外部占位');
});