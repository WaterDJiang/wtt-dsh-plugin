import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkbenchService } from '../src/service.mjs';
import { sourceDigest, sourceView } from '../src/source-range.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'wtt-excerpt-'));
  const service = new WorkbenchService({ workspaceRoot: root });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const requirement = service.store.createRequirement({ title: '摘录验收', operationId: randomUUID() });
  const material = content => service.canvas.addMaterial({ requirementId: requirement.id, title: '原始资料', content, operationId: randomUUID() }).material;
  const selection = (source, start, end, extra = {}) => ({ requirementId: requirement.id,
    sourceCardId: `material:${source.id}`, sourceHash: source.hash, start, end,
    quote: sourceView(source.content).slice(start, end), annotation: '讲师注释，不混入原文', title: '课堂摘录', operationId: randomUUID(), ...extra });
  return { root, service, requirement, material, selection };
}

test('excerpt offsets identify repeated Chinese text in the LF view while hashing original CRLF bytes', t => {
  const { root, service, requirement, material, selection } = fixture(t);
  const original = material('首行\r\n重复中文\r中间😀\n重复中文\r\n末行');
  const view = sourceView(original.content), start = view.lastIndexOf('重复中文');
  const before = service.canvas.getBoard(requirement.id);
  const input = selection(original, start, start + 4);
  const result = service.canvas.addExcerpt(input);
  const card = result.board.nodes.find(node => node.id === `material:${result.material.id}`);
  assert.equal(result.board.revision, before.revision + 1);
  assert.equal(card.kind, 'excerpt');
  assert.equal(card.content, '重复中文');
  assert.equal(card.sourceHash, sourceDigest('重复中文'));
  assert.equal(card.excerptInfo.sourceHash, sourceDigest(original.content));
  assert.notEqual(card.excerptInfo.sourceHash, sourceDigest(view));
  assert.equal(card.excerptInfo.start, start);
  assert.equal(card.excerptInfo.rangeLabel, '第 4 行');
  assert.equal(card.excerptInfo.annotation, input.annotation);
  assert.equal(readFileSync(path.join(root, result.material.path), 'utf8'), '重复中文');
  assert.equal(readFileSync(path.join(root, original.path), 'utf8'), original.content);
  assert.equal(result.board.edges.find(edge => edge.target === card.id).provenance, true);
  assert.deepEqual(service.canvas.addExcerpt(input), result);
  assert.throws(() => service.canvas.addExcerpt({ ...input, annotation: '不同注释' }), /标识已用于不同内容/);
  const saved = service.canvas.saveBoard({ requirementId: requirement.id, expectedRevision: result.board.revision, edges: [] });
  assert.ok(saved.edges.some(edge => edge.target === card.id && edge.provenance));
  service.close();
  const restored = new WorkbenchService({ workspaceRoot: root });
  try { assert.deepEqual(restored.canvas.getBoard(requirement.id).nodes.find(node => node.id === card.id).excerptInfo, card.excerptInfo); }
  finally { restored.close(); }
});

test('invalid ranges, forged selection, stale hash and half emoji leave no excerpt or revision change', t => {
  const { service, requirement, material, selection } = fixture(t);
  const original = material('甲😀乙\n完整原文');
  const before = service.canvas.getBoard(requirement.id);
  const valid = selection(original, 0, 4);
  for (const extra of [
    { start: -1 }, { end: 1000 }, { start: 0.5 }, { start: 2, end: 3 }, { start: 1, end: 2 },
    { start: 2, end: 2 }, { quote: '伪造正文' }, { sourceHash: '0'.repeat(64) },
  ]) assert.throws(() => service.canvas.addExcerpt({ ...valid, ...extra }), /范围|正文|变化/);
  assert.deepEqual(service.canvas.getBoard(requirement.id), before);
  assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM canvas_excerpts').get().n, 0);
});

test('excerpt creation rejects foreign, mutable, binary and externally changed sources', t => {
  const { root, service, requirement, material, selection } = fixture(t);
  const original = material('不可变来源');
  const input = selection(original, 0, 2);
  const other = service.store.createRequirement({ title: '另一需求', operationId: randomUUID() });
  assert.throws(() => service.canvas.addExcerpt({ ...input, requirementId: other.id }), /来源|当前需求/);
  assert.throws(() => service.canvas.addExcerpt({ ...input, sourceCardId: `whiteboard:${randomUUID()}` }), /来源/);
  writeFileSync(path.join(root, 'reference.pdf'), 'binary fixture');
  const binary = service.canvas.addMaterial({ requirementId: requirement.id, title: 'PDF', sourcePath: 'reference.pdf', operationId: randomUUID() }).material;
  assert.throws(() => service.canvas.addExcerpt({ ...input, sourceCardId: `material:${binary.id}` }), /未提取正文/);
  writeFileSync(path.join(root, original.path), '外部篡改');
  assert.throws(() => service.canvas.addExcerpt(input), /外部修改/);
  unlinkSync(path.join(root, original.path));
  symlinkSync(path.join(root, 'reference.pdf'), path.join(root, original.path));
  assert.throws(() => service.canvas.addExcerpt(input), /文件不可用|外部修改/);
});

test('frozen excerpt remains usable and replayable after its parent changes or disappears', t => {
  const { root, service, requirement, material, selection } = fixture(t);
  const original = material('原始正文需要保留');
  const input = selection(original, 0, 4), added = service.canvas.addExcerpt(input);
  const cardId = `material:${added.material.id}`;
  writeFileSync(path.join(root, original.path), '来源外改');
  let card = service.canvas.getBoard(requirement.id).nodes.find(node => node.id === cardId);
  assert.equal(card.excerptInfo.sourceStatus, 'changed');
  assert.equal(card.status, 'ready');
  unlinkSync(path.join(root, original.path));
  card = service.canvas.getBoard(requirement.id).nodes.find(node => node.id === cardId);
  assert.equal(card.excerptInfo.sourceStatus, 'missing');
  assert.equal(service.canvas.addExcerpt(input).material.id, added.material.id);
  const prepared = service.prepareCanvas({ requirementId: requirement.id, selectedCardIds: [cardId], instruction: '使用摘录' });
  assert.match(prepared.prompt, /原始正文/);
  assert.match(prepared.prompt, /讲师注释，不混入原文/);
  const child = service.canvas.addExcerpt(selection(added.material, 0, 2));
  assert.equal(child.material.content, '原始');
});

test('outline sources support excerpts and failed metadata registration rolls back files and operation', t => {
  const { root, service, requirement } = fixture(t);
  const version = service.store.saveOutline({ requirementId: requirement.id, markdown: '# 讲师大纲\r\n\r\n学习目标', operationId: randomUUID() });
  const input = { requirementId: requirement.id, sourceCardId: `outline:${version.id}`, sourceHash: version.hash,
    start: 8, end: 12, quote: '学习目标', annotation: '', title: '目标', operationId: randomUUID() };
  service.store.db.exec("CREATE TRIGGER reject_excerpt BEFORE INSERT ON canvas_excerpts BEGIN SELECT RAISE(ABORT,'excerpt metadata rejected'); END");
  assert.throws(() => service.canvas.addExcerpt(input), /excerpt metadata rejected/);
  assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM canvas_materials').get().n, 0);
  assert.equal(service.store.db.prepare('SELECT id FROM operations WHERE id=?').get(input.operationId), undefined);
  assert.deepEqual(readdirSync(path.join(root, 'courses', requirement.id, 'materials')), []);
  assert.equal(service.canvas.getBoard(requirement.id).revision, 0);
  service.store.db.exec('DROP TRIGGER reject_excerpt');
  const result = service.canvas.addExcerpt(input);
  assert.equal(result.material.content, '学习目标');
  assert.equal(service.canvas.getBoard(requirement.id).nodes.find(node => node.id === `outline:${version.id}`).sourceHash, version.hash);
});
