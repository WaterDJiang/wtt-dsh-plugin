import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkbenchService } from '../src/service.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'wtt-canvas-service-'));
  const service = new WorkbenchService({ workspaceRoot: root });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const requirement = service.store.createRequirement({ title: '画布制课', background: '需求背景信息', operationId: randomUUID() });
  const material = (title, content) => service.canvas.addMaterial({ requirementId: requirement.id, title, content, operationId: randomUUID() }).material;
  const prepare = (ids, instruction = '根据这些资料开发大纲') => service.prepareCanvas({ requirementId: requirement.id, selectedCardIds: ids, instruction });
  return { root, service, requirement, material, prepare };
}

test('canvas context contains selected material and required brief, never unrelated cards', t => {
  const { service, requirement, material, prepare } = fixture(t);
  const chosen = material('客户反馈', '反馈正文唯一标记');
  material('其他客户的补充', '不可混入的素材唯一标记');
  const result = prepare([`material:${chosen.id}`]);
  assert.match(result.prompt, /反馈正文唯一标记/);
  assert.match(result.prompt, /需求背景信息/);
  assert.doesNotMatch(result.prompt, /不可混入的素材唯一标记/);
  assert.deepEqual(result.contextSummary.map(x => x.title), ['客户反馈']);
  assert.deepEqual(result.selectedCardIds, [`material:${chosen.id}`]);
  const other = service.store.createRequirement({ title: '其他需求', operationId: randomUUID() });
  assert.throws(() => prepare([`requirement:${other.id}`]), /来源|卡片|需求/);
  assert.throws(() => prepare([]), /1–24/);
  assert.throws(() => prepare([`requirement:${requirement.id}`], ''), /创作要求/);
});

test('large selected text is bounded and explicitly marked as an excerpt', t => {
  const { material, prepare } = fixture(t);
  const chosen = material('长文本', '界'.repeat(20_000));
  const result = prepare([`material:${chosen.id}`]);
  assert.match(result.prompt, /仅为节选/);
  assert.ok(result.prompt.length < 15_000);
});

test('external changes to saved cards are reported before preparing AI context', t => {
  const { root, material, prepare } = fixture(t);
  const chosen = material('素材', '原内容');
  writeFileSync(path.join(root, chosen.path), '文件被外部修改');
  assert.throws(() => prepare([`material:${chosen.id}`]), /不可用或已外改/);
});

test('non-text file association never claims extraction, and canvas tools save exact provenance', t => {
  const { root, service, requirement, prepare } = fixture(t);
  writeFileSync(path.join(root, 'reference.pdf'), 'technical-fixture-only');
  const { material } = service.canvas.addMaterial({ requirementId: requirement.id, title: '参考文件', sourcePath: 'reference.pdf', operationId: randomUUID() });
  const result = prepare([`material:${material.id}`]);
  assert.match(result.prompt, /未提取正文/);
  assert.doesNotMatch(result.prompt, /technical-fixture-only/);
  const version = service.store.saveOutline({ requirementId: requirement.id, markdown: '# 技术验收大纲', sourceCardIds: result.selectedCardIds, operationId: randomUUID() });
  assert.deepEqual(version.sourceCardIds, result.selectedCardIds);
  assert.ok(service.canvas.getBoard(requirement.id).edges.some(edge => edge.provenance && edge.source === `material:${material.id}` && edge.target === `outline:${version.id}`));
  unlinkSync(path.join(root, 'reference.pdf'));
  assert.throws(() => prepare([`material:${material.id}`]), /不可用或已外改/);
});

test('saved text snapshot stays usable when its original source disappears', t => {
  const { root, service, requirement, prepare } = fixture(t);
  writeFileSync(path.join(root, 'reference.txt'), '已捕获的文本正文');
  const { material } = service.canvas.addMaterial({ requirementId: requirement.id, title: '参考文本', sourcePath: 'reference.txt', operationId: randomUUID() });
  unlinkSync(path.join(root, 'reference.txt'));
  const result = prepare([`material:${material.id}`]);
  assert.match(result.prompt, /已捕获的文本正文/);
  assert.match(result.prompt, /"sourceStatus":"missing"/);
});
