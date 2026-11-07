import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchService } from '../src/service.mjs';
import { sourceDigest } from '../src/source-range.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wtt-creation-source-')));
  const service = new WorkbenchService({ workspaceRoot: root });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const requirement = service.store.createRequirement({ title: '来源与位置验收', background: '真实哈希冻结', operationId: randomUUID() });
  return { root, service, requirement };
}

test('source references lock same-requirement hashes and material provenance is atomic, immutable and replayable', t => {
  const { root, service, requirement } = fixture(t);
  const source = service.canvas.addMaterial({ requirementId: requirement.id, title: '原资料', content: '原始冻结正文', operationId: randomUUID() }).material;
  const refs = [{ cardId: `material:${source.id}`, hash: source.hash }];
  const values = { requirementId: requirement.id, title: '有来源的素材', content: '根据来源整理的新正文', sourceRefs: refs, operationId: randomUUID() };
  const result = service.canvas.addMaterial(values);
  assert.equal(result.material.sourceRefs[0].title, source.title);
  assert.ok(result.board.edges.find(edge => edge.source === refs[0].cardId && edge.target === `material:${result.material.id}` && edge.provenance));
  const other = service.store.createRequirement({ title: '另一个需求', operationId: randomUUID() });
  assert.throws(() => service.canvas.validateSourceRefs(other.id, refs), /不属于当前需求/);
  assert.throws(() => service.canvas.validateSourceRefs(requirement.id, [{ ...refs[0], hash: '0'.repeat(64) }]), /hash 已变化/);
  assert.throws(() => service.canvas.validateSourceRefs(requirement.id, refs, { selectedCardIds: [`requirement:${requirement.id}`] }), /必须与本次引用/);
  writeFileSync(path.join(root, source.path), '外改的正文');
  assert.throws(() => service.canvas.validateSourceRefs(requirement.id, refs), /来源文件不可用或已外改/);
  assert.equal(service.canvas.addMaterial(values).material.id, result.material.id, 'a successful operation replay must retain the original frozen reference');
  assert.equal(readFileSync(path.join(root, result.material.path), 'utf8'), values.content);
});

test('new task fields preserve the old operation hash and validate locked positions and references', t => {
  const { service, requirement } = fixture(t);
  const card = service.canvas.getBoard(requirement.id).nodes[0];
  assert.equal(card.sourceHash, sourceDigest(card.content));
  const old = { requirementId: requirement.id, instruction: '原有任务', selectedCardIds: [card.id], operationId: randomUUID() };
  const expected = sourceDigest(JSON.stringify({ requirementId: requirement.id, instruction: old.instruction, selectedCardIds: [card.id], selection: null }));
  assert.equal(service.tasks.fingerprint(old).fingerprint, expected);
  const snapshot = { requirement: { id: requirement.id }, sources: [{ cardId: card.id, hash: card.sourceHash, content: card.content }], instruction: old.instruction };
  const values = { ...old, operationId: randomUUID(), outputType: 'outline', sourceRefs: [{ cardId: card.id, hash: card.sourceHash }], outputPosition: { x: 760, y: 490 } };
  const task = service.tasks.create(values, snapshot);
  assert.deepEqual(task.input.outputPosition, { x: 760, y: 490 });
  for (const changed of [{ outputType: 'wrong' }, { outputPosition: { x: Infinity, y: 4 } }, { outputPosition: { x: 1_000_001, y: 0 } }, { sourceRefs: [] }]) assert.throws(() => service.tasks.create({ ...values, ...changed }, snapshot));
  assert.throws(() => service.tasks.replay({ ...values, outputPosition: { x: 0, y: 0 } }), /操作标识已用于不同内容/);
  const version = service.store.saveOutline({ requirementId: requirement.id, taskId: task.id, markdown: '# 位置验收大纲', sourceCardIds: [card.id], operationId: randomUUID() });
  const wordPath = path.posix.join(path.posix.dirname(version.markdownPath), 'outline.docx');
  writeFileSync(path.join(service.workspaceRoot, wordPath), 'Word binding fixture');
  service.store.markWordExport({ versionId: version.id, relativePath: wordPath });
  let board = service.canvas.getBoard(requirement.id);
  assert.deepEqual(board.nodes.find(node => node.id === `outline:${version.id}`).position, values.outputPosition);
  const word = board.nodes.find(node => node.id === `word:${version.id}`);
  assert.equal(word.sourceHash, version.hash); assert.deepEqual(word.position, { x: 760, y: 810 });
  assert.equal(service.canvas.validateSourceRefs(requirement.id, [{ cardId: word.id, hash: version.hash }])[0].kind, 'word');
  board = service.canvas.saveBoard({ requirementId: requirement.id, expectedRevision: board.revision, positions: { [`outline:${version.id}`]: { x: 80, y: 90 } } });
  assert.deepEqual(board.nodes.find(node => node.id === `outline:${version.id}`).position, { x: 80, y: 90 });
});

test('material source-row failure rolls back the new snapshot and operation while legacy material hashes stay unchanged', t => {
  const { service, requirement } = fixture(t);
  const card = service.canvas.getBoard(requirement.id).nodes[0];
  const old = { requirementId: requirement.id, title: '旧素材', content: '旧正文', operationId: randomUUID() };
  const material = service.canvas.addMaterial(old).material;
  const expected = sourceDigest(JSON.stringify({ requirementId: requirement.id, title: old.title, content: old.content, sourcePath: null }));
  assert.equal(service.store.db.prepare('SELECT input_hash FROM operations WHERE id=?').get(old.operationId).input_hash, expected);
  const values = { requirementId: requirement.id, title: '回滚素材', content: '不能伪成功', sourceRefs: [{ cardId: card.id, hash: card.sourceHash }], operationId: randomUUID() };
  service.store.db.exec("CREATE TRIGGER reject_material_source BEFORE INSERT ON canvas_material_sources BEGIN SELECT RAISE(ABORT,'source fixture rollback'); END");
  assert.throws(() => service.canvas.addMaterial(values), /source fixture rollback/);
  assert.equal(service.store.db.prepare('SELECT count(*) AS n FROM canvas_materials').get().n, 1);
  assert.equal(service.store.db.prepare('SELECT * FROM operations WHERE id=?').get(values.operationId), undefined);
  assert.equal(existsSync(path.join(service.workspaceRoot, material.path)), true);
  service.store.db.exec('DROP TRIGGER reject_material_source');
  assert.equal(service.canvas.addMaterial(values).material.sourceRefs[0].cardId, card.id);
});
