import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchService } from '../src/service.mjs';
import { editableCardText } from '../src/card-text.mjs';
import { createLayoutHistory } from '../src/canvas-history.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cw26-text-'));
  const service = new WorkbenchService({ workspaceRoot: root });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const req = service.store.createRequirement({ background: '虚构测试背景', operationId: randomUUID() });
  const board = () => service.canvas.getBoard(req.id);
  const edit = (node, content, extra = {}) => service.canvas.saveCardText({ requirementId: req.id,
    cardId: node.outputCard?.id || node.id, versionId: node.outputCard?.versionId, sourceHash: node.sourceHash,
    content, operationId: randomUUID(), ...extra });
  return { root, service, req, board, edit };
}

test('background edits replay without overwriting concurrent changes; source mismatch is visible', t => {
  const { board, edit, service, req } = fixture(t);
  const initial = board().nodes[0], op = randomUUID();
  const result = edit(initial, '第一次修改', { operationId: op });
  const second = board().nodes[0];
  edit(second, '第二次修改');
  assert.deepEqual(edit(initial, '第一次修改', { operationId: op }), result);
  assert.equal(service.store.getRequirement(req.id).background, '第二次修改');
  assert.throws(() => edit(initial, '过期编辑'), /来源内容已变化/);
  assert.throws(() => edit(initial, '不同输入', { operationId: op }), /已用于不同内容/);
});

test('manual outline edit adopts the same card, appends from old base and preserves all files', t => {
  const { service, root, req, board, edit } = fixture(t);
  const original = service.store.saveOutline({ requirementId: req.id, markdown: '# 第一版', operationId: randomUUID() });
  const one = board().nodes.find(node => node.kind === 'outline');
  const op = randomUUID();
  const result = edit(one, '# 第二版', { operationId: op });
  assert.ok(result.versionId);
  assert.deepEqual(edit(one, '# 第二版', { operationId: op }), result);
  edit(one, '# 从第一版追加第三版');
  const current = board().nodes.find(node => node.outputCard);
  assert.equal(current.outputCard.versions.length, 3);
  assert.equal(current.outputCard.number, 3);
  assert.equal(current.outputCard.versions.at(-1).baseVersionId, one.outputCard.versionId);
  assert.equal(current.kind, 'outline');
  assert.equal(readFileSync(path.join(root, original.markdownPath), 'utf8'), '# 第一版');
});

test('manual text edit creates real same-card files and preserves original prompt/references without a model session', async t => {
  const { service, root, req, board, edit } = fixture(t);
  const created = service.createTask({ requirementId: req.id, instruction: '原始提示词', outputType: 'text', selectedCardIds: [],
    sourceRefs: [], selectedSkills: [], generation: { mode: 'new' }, operationId: randomUUID() });
  const relative = `${created.prepared.deliveryDirectory}/body.md`;
  writeFileSync(path.join(root, relative), '# 原文');
  const sessionId = `fixture:${randomUUID()}`;
  service.tasks.bindSession({ taskId: created.task.id, sessionId });
  const original = await service.tasks.files.register({ taskId: created.task.id, operationId: randomUUID(), path: relative, kind: 'text', title: '文本卡' }, { sessionId });
  const one = board().nodes.find(node => node.outputCard);
  const op = randomUUID(), two = edit(one, '# 人工新版', { operationId: op });
  assert.deepEqual(edit(one, '# 人工新版', { operationId: op }), two);
  edit(one, '# 基于第一版');
  const described = service.cards.describe({ requirementId: req.id, cardId: one.outputCard.id });
  assert.equal(described.card.versions.length, 3);
  assert.equal(described.version.baseVersionId, one.outputCard.versionId);
  assert.equal(described.editor.instruction, '原始提示词');
  assert.equal(described.editor.sessionId, null);
  assert.equal(service.tasks.files.read(described.node.refId).bytes.toString(), '# 基于第一版');
  assert.equal(service.tasks.files.read(original.id).bytes.toString(), '# 原文');
  assert.ok(described.node.delivery.path.includes('产物/'));
  writeFileSync(path.join(root, original.path), '外改');
  assert.throws(() => edit(one, '# 不得继续'), /外部修改|不可用/);
});

test('material edits preserve originals and reuse an operation; binary formats are never plaintext editors', t => {
  const { service, req, board, edit } = fixture(t);
  service.canvas.addMaterial({ requirementId: req.id, title: '原素材', content: '原素材内容', operationId: randomUUID() });
  const one = board().nodes.find(node => node.kind === 'material');
  const op = randomUUID(), result = edit(one, '修订内容', { operationId: op });
  assert.deepEqual(edit(one, '修订内容', { operationId: op }), result);
  assert.equal(board().nodes.filter(node => node.kind === 'material').length, 2);
  assert.equal(board().nodes.find(node => node.id === one.id).content, '原素材内容');
  for (const ext of ['pdf', 'docx', 'pptx', 'png', 'mp4']) assert.equal(editableCardText({ kind: 'artifact', path: `x.${ext}`, content: '提取正文' }), null);
});

test('card sizes survive old clients, version projection and reopen; reject foreign/invalid dimensions', t => {
  const { service, root, req, board, edit } = fixture(t);
  const initial = board(), id = initial.nodes[0].id;
  service.canvas.saveBoard({ requirementId: req.id, expectedRevision: initial.revision, sizes: { [id]: { width: 420, height: 350 } } });
  const updated = board();
  assert.equal(updated.nodes[0].width, 420);
  service.canvas.saveBoard({ requirementId: req.id, expectedRevision: updated.revision });
  assert.equal(board().nodes[0].height, 350);
  for (const sizes of [{ [id]: { width: 199, height: 160 } }, { [id]: { width: 1201, height: 200 } }, { 'output:foreign': { width: 300, height: 200 } }]) {
    assert.throws(() => service.canvas.saveBoard({ requirementId: req.id, expectedRevision: board().revision, sizes }), /卡片尺寸/);
  }
  const first = { positions: {}, edges: [], groups: [], sizes: { [id]: { width: 258, height: 208 } } }, second = { ...first, sizes: updated.sizes };
  const history = createLayoutHistory();
  history.record(first, second);
  assert.deepEqual(history.undo(second).sizes, first.sizes);
  assert.deepEqual(history.redo(first).sizes, second.sizes);
  const saved = service.store.saveOutline({ requirementId: req.id, markdown: '# 初始版本', operationId: randomUUID() });
  const original = board().nodes.find(node => node.refId === saved.id);
  service.canvas.saveBoard({ requirementId: req.id, expectedRevision: board().revision,
    sizes: { ...board().sizes, [original.id]: { width: 680, height: 520 } } });
  edit(original, '# 第二版本');
  const reopened = new WorkbenchService({ workspaceRoot: root });
  try {
    const current = reopened.canvas.getBoard(req.id).nodes.find(node => node.id === original.id);
    assert.equal(current.width, 680);
    assert.equal(current.height, 520);
    assert.equal(current.outputCard.number, 2);
    assert.equal(reopened.canvas.getBoard(req.id).nodes.find(node => node.id === id).width, 420);
  } finally { reopened.close(); }
});
