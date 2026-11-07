import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WorkbenchStore } from '../src/store.mjs';
import { CanvasStore } from '../src/canvas-store.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const requirement = (store, title = '白板验收需求') => store.createRequirement({ title, operationId: randomUUID() });
const element = (extra = {}) => ({ id: `whiteboard:${randomUUID()}`, kind: 'note', text: '先收集学员的真实任务', width: 240, height: 180, colour: 'cream', ...extra });

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'wtt-whiteboard-'));
  const store = new WorkbenchStore(root);
  const canvas = new CanvasStore(store);
  const req = requirement(store);
  const save = (data = {}, board = canvas.getBoard(req.id)) => canvas.saveBoard({ requirementId: req.id, expectedRevision: board.revision,
    positions: Object.fromEntries(board.nodes.map(node => [node.id, node.position])),
    edges: board.edges.filter(edge => !edge.provenance), groups: board.groups, viewport: board.viewport,
    elements: board.elements, ...data });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, canvas, req, save };
}

test('CW-02 board schema migrates additively and legacy saves keep whiteboard content and coordinates', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtt-whiteboard-old-'));
  const store = new WorkbenchStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const req = requirement(store);
  store.db.exec('CREATE TABLE canvas_boards (requirement_id TEXT PRIMARY KEY REFERENCES canvas_spaces(id),revision INTEGER NOT NULL,positions_json TEXT NOT NULL,edges_json TEXT NOT NULL,groups_json TEXT NOT NULL,viewport_json TEXT NOT NULL)');
  store.db.prepare('INSERT INTO canvas_boards VALUES (?,?,?,?,?,?)').run(req.id, 3, JSON.stringify({ [`requirement:${req.id}`]: { x: 12, y: 34 } }), '[]', '[]', JSON.stringify({ x: 1, y: 2, zoom: 0.6 }));
  const canvas = new CanvasStore(store);
  const migrated = canvas.getBoard(req.id);
  assert.equal(migrated.revision, 3);
  assert.deepEqual(migrated.elements, []);
  assert.deepEqual(migrated.nodes[0].position, { x: 12, y: 34 });
  const column = store.db.prepare('PRAGMA table_info(canvas_boards)').all().find(col => col.name === 'elements_json');
  assert.equal(column.notnull, 1);
  assert.equal(column.dflt_value, "'[]'");
  const note = element();
  const added = canvas.saveBoard({ requirementId: req.id, expectedRevision: 3, elements: [note], positions: { [note.id]: { x: -100, y: 250 } } });
  const legacy = canvas.saveBoard({ requirementId: req.id, expectedRevision: added.revision, positions: { [`requirement:${req.id}`]: { x: 90, y: 80 } } });
  assert.deepEqual(legacy.elements, [note]);
  assert.deepEqual(legacy.nodes.find(node => node.id === note.id).position, { x: -100, y: 250 });
});

test('text, notes and shapes edit and survive restart without moving their text into business records', t => {
  const { root, store, canvas, req, save } = fixture(t);
  const text = element({ kind: 'text', text: '课程主线', colour: 'white' });
  const note = element();
  const shape = element({ kind: 'shape', text: '', shape: 'ellipse', colour: 'blue', width: 320, height: 100 });
  let board = save({ elements: [text, note, shape], positions: { [text.id]: { x: -50, y: 75 }, [note.id]: { x: 350, y: 500 }, [shape.id]: { x: 600, y: 500 } } });
  const node = board.nodes.find(node => node.id === text.id);
  assert.equal(node.kind, 'whiteboard');
  assert.equal(node.elementKind, 'text');
  assert.equal(node.refId, text.id.slice('whiteboard:'.length));
  assert.equal(node.content, text.text);
  assert.equal(board.nodes.find(node => node.id === shape.id).title, '椭圆');
  const edited = { ...note, text: '改成小组实践与分享', colour: 'green', width: 400, height: 260 };
  board = save({ elements: [text, edited, shape] }, board);
  assert.equal(store.getRequirement(req.id).versions.length, 0);
  store.close();
  const reopened = new WorkbenchStore(root);
  try {
    const restored = new CanvasStore(reopened).getBoard(req.id);
    assert.deepEqual(restored, board);
    assert.equal(reopened.listRequirements().length, 1);
  } finally { reopened.close(); }
});

test('Host rejects malformed whiteboard fields atomically, including unsafe or duplicate identities', t => {
  const { canvas, req, save } = fixture(t);
  const good = element();
  const invalid = [
    null, {}, [null], [{ ...good, id: `requirement:${req.id}` }], [good, good],
    [{ ...good, id: 'whiteboard:not-a-uuid' }], [{ ...good, id: good.id.toUpperCase() }],
    [{ ...good, kind: 'business' }], [{ ...good, text: null }], [{ ...good, text: 'a\0b' }],
    [{ ...good, text: '中'.repeat(30_001) }], [{ ...good, width: 99 }], [{ ...good, width: 1201 }],
    [{ ...good, width: '240' }], [{ ...good, width: Infinity }], [{ ...good, height: 59 }], [{ ...good, height: 1201 }],
    [{ ...good, colour: '#fff' }], [{ ...good, shape: 'diamond' }],
    Array.from({ length: 501 }, () => element()),
    Array.from({ length: 35 }, () => element({ text: '中'.repeat(10_000) })),
  ];
  for (const elements of invalid) {
    assert.throws(() => save({ elements }), /白板/);
    assert.equal(canvas.getBoard(req.id).revision, 0);
  }
  const defaults = element({ kind: 'shape' });
  const accepted = save({ elements: [{ ...good, text: '中'.repeat(30_000), width: 100, height: 60 }, defaults] });
  assert.equal(accepted.elements[0].text.length, 30_000);
  assert.equal(accepted.elements[1].shape, 'rectangle');
});

test('whiteboard ownership and all references stay scoped to their requirement and folder', t => {
  const { store, canvas, req, save } = fixture(t);
  const own = element();
  save({ elements: [own] });
  const other = requirement(store, '另一门课程');
  assert.throws(() => canvas.saveBoard({ requirementId: other.id, expectedRevision: 0, elements: [own] }), /其他需求/);
  assert.throws(() => canvas.saveBoard({ requirementId: other.id, expectedRevision: 0, positions: { [own.id]: { x: 0, y: 0 } } }), /未知卡片/);
  assert.equal(canvas.getBoard(other.id).revision, 0);
  assert.deepEqual(canvas.getBoard(req.id).elements, [own]);
  const root2 = mkdtempSync(path.join(tmpdir(), 'wtt-whiteboard-isolated-'));
  const isolated = new WorkbenchStore(root2);
  try {
    const otherReq = requirement(isolated);
    const otherCanvas = new CanvasStore(isolated);
    assert.deepEqual(otherCanvas.getBoard(otherReq.id).elements, []);
    assert.equal(otherCanvas.saveBoard({ requirementId: otherReq.id, expectedRevision: 0, elements: [own] }).elements[0].id, own.id);
  } finally { isolated.close(); rmSync(root2, { recursive: true, force: true }); }
});

test('removing elements cleans only their actual positions, edges and groups while rejecting unknown references', t => {
  const { store, canvas, req, save } = fixture(t);
  const a = element(), b = element(), c = element();
  const reqId = `requirement:${req.id}`;
  let board = save({ elements: [a, b, c], positions: { [a.id]: { x: 1, y: 2 }, [b.id]: { x: 3, y: 4 } },
    edges: [{ id: 'edge-ra', source: reqId, target: a.id }, { id: 'edge-ab', source: a.id, target: b.id }, { id: 'edge-rb', source: reqId, target: b.id }],
    groups: [{ id: 'group-a', title: '需求便签', nodeIds: [reqId, a.id] }, { id: 'group-b', title: '便签组', nodeIds: [b.id, c.id] }] });
  const unknown = `whiteboard:${randomUUID()}`;
  assert.throws(() => save({ elements: [b, c], edges: [{ id: 'edge-unknown', source: a.id, target: unknown }] }, board), /关联线/);
  assert.throws(() => save({ elements: [b, c], groups: [{ id: 'group-forged', title: '未知引用', nodeIds: [a.id, unknown] }] }, board), /未知/);
  assert.throws(() => save({ elements: [b, c], positions: { [unknown]: { x: 0, y: 0 } } }, board), /未知/);
  assert.throws(() => save({ elements: [b, c], edges: [{ id: 'edge-forged', source: a.id, target: b.id, provenance: true }] }, board), /真实产物/);
  board = save({ elements: [b, c] }, board);
  assert.deepEqual(board.edges.filter(edge => !edge.provenance).map(edge => edge.id), ['edge-rb']);
  assert.deepEqual(board.groups.map(group => group.id), ['group-b']);
  assert.equal(board.nodes.some(node => node.id === a.id), false);
  const positions = JSON.parse(store.db.prepare('SELECT positions_json FROM canvas_boards WHERE requirement_id=?').get(req.id).positions_json);
  assert.equal(a.id in positions, false);
  // Clients may already filter removed members before sending the full snapshot.
  board = save({ elements: [b], groups: [{ ...board.groups[0], nodeIds: [b.id] }] }, board);
  assert.deepEqual(board.groups, []);
  assert.throws(() => save({ groups: [{ id: 'new-single', title: '错误单元素组', nodeIds: [b.id] }] }, board), /分组信息/);
});

test('stale whiteboard edits cannot overwrite newer content', t => {
  const { canvas, req, save } = fixture(t);
  const note = element();
  const initial = save({ elements: [note] });
  const updated = save({ elements: [{ ...note, text: '最新白板正文' }] }, initial);
  assert.throws(() => save({ elements: [{ ...note, text: '过期正文' }] }, initial), /其他操作修改/);
  assert.deepEqual(canvas.getBoard(req.id), updated);
});

test('whiteboard edits preserve real versions, files and promoted material snapshots; AI source use is explicit', t => {
  const { root, store, canvas, req, save } = fixture(t);
  const version = store.saveOutline({ requirementId: req.id, markdown: '# 正式版本\n\n业务正文', operationId: randomUUID() });
  const originalPath = path.join(root, '原始资料.txt');
  writeFileSync(originalPath, '用户原件，不覆盖');
  const files = [path.join(root, version.markdownPath), originalPath].map(file => ({ file, digest: digest(readFileSync(file)) }));
  const note = element({ text: '素材快照原文' });
  let board = save({ elements: [note] });
  assert.throws(() => canvas.validateSources(req.id, [note.id]), /先保存为素材/);
  assert.throws(() => store.saveOutline({ requirementId: req.id, markdown: '# 非法来源', sourceCardIds: [note.id], operationId: randomUUID() }), /来源卡片标识/);
  const promoted = canvas.addMaterial({ requirementId: req.id, title: '便签已冻结素材', content: note.text, operationId: randomUUID(), position: { x: 400, y: 400 } });
  assert.deepEqual(promoted.board.elements, [note]);
  board = save({ elements: [{ ...note, text: '白板后来修改的文字' }] }, promoted.board);
  assert.deepEqual(board.elements[0].text, '白板后来修改的文字');
  assert.equal(board.nodes.find(node => node.id === `material:${promoted.material.id}`).content, '素材快照原文');
  assert.equal(readFileSync(path.join(root, promoted.material.path), 'utf8'), '素材快照原文');
  assert.deepEqual(canvas.validateSources(req.id, [`material:${promoted.material.id}`]), [`material:${promoted.material.id}`]);
  const copied = store.saveOutline({ requirementId: req.id, markdown: '# 使用冻结素材', sourceCardIds: [`material:${promoted.material.id}`], operationId: randomUUID() });
  assert.deepEqual(copied.sourceCardIds, [`material:${promoted.material.id}`]);
  for (const file of files) assert.equal(digest(readFileSync(file.file)), file.digest);
  assert.equal(store.getVersion(version.id).markdown, version.markdown);
});
