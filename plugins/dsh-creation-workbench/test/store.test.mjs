import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkbenchStore } from '../src/store.mjs';

function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'wtt-store-test-'));
  const store = new WorkbenchStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store };
}

function requirement(store, extra = {}) {
  return store.createRequirement({ title: 'AI 实战课程', operationId: randomUUID(), ...extra });
}

function outline(store, requirementId, extra = {}) {
  return store.saveOutline({ requirementId, markdown: '# 课程大纲\n\n第一章 场景与目标\n', operationId: randomUUID(), ...extra });
}

test('requirements, Unicode content and versions survive reopening the selected folder', (t) => {
  const { root, store } = workspace(t);
  const item = requirement(store, { customer: '培训机构', background: '希望能把日常资料变成成果' });
  const v1 = outline(store, item.id);
  const v2 = outline(store, item.id, { markdown: '# 课程大纲 v2\n\n## 第二章 动手练习\n' });
  assert.equal(v1.number, 1);
  assert.equal(v2.number, 2);
  assert.equal(readFileSync(path.join(root, v1.markdownPath), 'utf8'), v1.markdown);
  assert.equal(store.getVersion(v1.id).markdown, v1.markdown);
  store.close();
  const reopened = new WorkbenchStore(root);
  try {
    const restored = reopened.getRequirement(item.id);
    assert.equal(restored.background, item.background);
    assert.deepEqual(restored.versions.map((v) => v.number), [2, 1]);
    assert.equal(restored.versions[1].hash, v1.hash);
  } finally {
    reopened.close();
  }
});

test('operation replay creates no duplicate requirement or version, changed input is refused', (t) => {
  const { store } = workspace(t);
  const operationId = randomUUID();
  const input = { title: '销售课程', operationId };
  const item = store.createRequirement(input);
  assert.equal(store.createRequirement(input).id, item.id);
  assert.equal(store.listRequirements().length, 1);
  assert.throws(() => store.createRequirement({ ...input, title: '另一个课程' }), /不同内容/);
  const save = { requirementId: item.id, operationId: randomUUID(), markdown: '# 大纲\n' };
  const version = store.saveOutline(save);
  assert.equal(store.saveOutline(save).id, version.id);
  assert.equal(store.getRequirement(item.id).versions.length, 1);
  assert.throws(() => store.saveOutline({ ...save, markdown: '# 修改后大纲' }), /不同内容/);
  assert.throws(() => store.saveOutline({ ...save, operationId }), /不同内容/);
});

test('different working folders keep requirements and artifacts isolated', (t) => {
  const a = workspace(t);
  const b = workspace(t);
  const item = requirement(a.store);
  outline(a.store, item.id);
  assert.deepEqual(b.store.listRequirements(), []);
  assert.equal(b.store.getRequirement(item.id), null);
  assert.throws(() => outline(b.store, item.id), /需求不存在/);
});

test('empty, oversized or malformed inputs cannot create successful records', (t) => {
  const { store } = workspace(t);
  assert.throws(() => requirement(store, { title: ' ' }), /需求标题/);
  assert.throws(() => requirement(store, { title: 'x'.repeat(201) }), /200/);
  assert.throws(() => requirement(store, { operationId: '../bad' }), /操作标识/);
  assert.throws(() => requirement(store, { customer: {} }), /客户名称/);
  const item = requirement(store);
  assert.throws(() => outline(store, item.id, { markdown: ' ' }), /大纲正文/);
  assert.throws(() => outline(store, item.id, { markdown: '中'.repeat(400_000) }), /1 MB/);
  assert.throws(() => outline(store, item.id, { markdown: 'x'.repeat(1_048_577) }), /1048576/);
  assert.deepEqual(store.getRequirement(item.id).versions, []);
});

test('existing unregistered files are preserved and never overwritten', (t) => {
  const { root, store } = workspace(t);
  const item = requirement(store);
  const original = path.join(root, 'courses', item.id, 'v001', 'outline.md');
  mkdirSync(path.dirname(original), { recursive: true });
  writeFileSync(original, '用户原文件', 'utf8');
  const version = outline(store, item.id);
  assert.equal(version.number, 2);
  assert.equal(readFileSync(original, 'utf8'), '用户原文件');
  assert.equal(store.getRequirement(item.id).versions.length, 1);
});

test('a blocked artifact directory leaves no saved version and can be retried', (t) => {
  const { root, store } = workspace(t);
  const item = requirement(store);
  const blocked = path.join(root, 'courses');
  writeFileSync(blocked, '用户原文件');
  const input = { requirementId: item.id, markdown: '# 大纲', operationId: randomUUID() };
  assert.throws(() => store.saveOutline(input), /目录不可用/);
  assert.deepEqual(store.getRequirement(item.id).versions, []);
  assert.equal(readFileSync(blocked, 'utf8'), '用户原文件');
  rmSync(blocked);
  assert.equal(store.saveOutline(input).number, 1);
});

test('a database write failure rolls back the operation and removes only its new artifact', (t) => {
  const { root, store } = workspace(t);
  const item = requirement(store);
  const input = { requirementId: item.id, markdown: '# 大纲', operationId: randomUUID() };
  store.db.exec("CREATE TRIGGER reject_test_version BEFORE INSERT ON outline_versions BEGIN SELECT RAISE(ABORT, 'disk write rejected'); END");
  assert.throws(() => store.saveOutline(input), /disk write rejected/);
  assert.deepEqual(store.getRequirement(item.id).versions, []);
  store.db.exec('DROP TRIGGER reject_test_version');
  const version = store.saveOutline(input);
  assert.equal(version.number, 1);
  assert.equal(readFileSync(path.join(root, version.markdownPath), 'utf8'), input.markdown);
});

test('symlink artifact roots cannot write outside the selected folder', (t) => {
  const a = workspace(t);
  const b = workspace(t);
  const item = requirement(a.store);
  symlinkSync(b.root, path.join(a.root, 'courses'));
  assert.throws(() => outline(a.store, item.id), /目录不可用/);
  assert.deepEqual(a.store.getRequirement(item.id).versions, []);
});

test('Word export only registers a real nonempty file in the same immutable version directory', (t) => {
  const { root, store } = workspace(t);
  const item = requirement(store);
  const version = outline(store, item.id);
  const relativePath = path.join(path.dirname(version.markdownPath), 'outline.docx');
  assert.throws(() => store.markWordExport({ versionId: version.id, relativePath }), /真实文件/);
  writeFileSync(path.join(root, relativePath), '');
  assert.throws(() => store.markWordExport({ versionId: version.id, relativePath }), /非空/);
  writeFileSync(path.join(root, relativePath), 'validated-by-exporter');
  assert.equal(store.markWordExport({ versionId: version.id, relativePath }).wordPath, relativePath);
  assert.equal(store.markWordExport({ versionId: version.id, relativePath }).id, version.id);
  assert.equal(store.getRequirement(item.id).versions.length, 1);
  assert.equal(store.getVersion(version.id).markdown, version.markdown);
  const another = path.join(path.dirname(version.markdownPath), 'another.docx');
  writeFileSync(path.join(root, another), 'different');
  assert.throws(() => store.markWordExport({ versionId: version.id, relativePath: another }), /另一份/);
});

test('Word export rejects traversal, absolute paths, other version folders and symlinks', (t) => {
  const { root, store } = workspace(t);
  const outside = workspace(t);
  const item = requirement(store);
  const v1 = outline(store, item.id);
  const v2 = outline(store, item.id);
  const outsider = path.join(outside.root, 'outside.docx');
  writeFileSync(outsider, 'external');
  for (const relativePath of ['../outside.docx', outsider, 'C:\\outside.docx', 'file.md']) {
    assert.throws(() => store.markWordExport({ versionId: v1.id, relativePath }), /路径无效/);
  }
  const v2Docx = path.join(path.dirname(v2.markdownPath), 'outline.docx');
  writeFileSync(path.join(root, v2Docx), 'valid-location-for-v2-only');
  assert.throws(() => store.markWordExport({ versionId: v1.id, relativePath: v2Docx }), /当前版本目录/);
  const link = path.join(path.dirname(v1.markdownPath), 'linked.docx');
  symlinkSync(outsider, path.join(root, link));
  assert.throws(() => store.markWordExport({ versionId: v1.id, relativePath: link }), /真实文件/);
  assert.equal(store.getVersion(v1.id).wordPath, null);
});

test('closed stores refuse writes and close is idempotent', (t) => {
  const { store } = workspace(t);
  store.close();
  store.close();
  assert.throws(() => requirement(store), /已关闭/);
  assert.throws(() => store.listRequirements(), /已关闭/);
});
