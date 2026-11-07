import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listProjectDirectory } from '../src/project-directory.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'wtt-project-directory-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('directory browse is read-only, includes hidden directories and valid directory aliases, and provides canonical breadcrumbs', t => {
  const root = fixture(t);
  mkdirSync(path.join(root, '项目2')); mkdirSync(path.join(root, '项目10')); mkdirSync(path.join(root, '.隐藏项目'));
  writeFileSync(path.join(root, '资料.txt'), '原文不能被浏览改动');
  symlinkSync(path.join(root, '项目2'), path.join(root, '目录别名'), 'dir');
  symlinkSync(path.join(root, '不存在'), path.join(root, '断开的别名'), 'dir');
  symlinkSync(path.join(root, '资料.txt'), path.join(root, '文件别名'), 'file');
  const namesBefore = readdirSync(root);
  const modifiedBefore = statSync(path.join(root, '资料.txt')).mtimeMs;
  const result = listProjectDirectory(root, { home: root });
  assert.equal(result.path, root); assert.equal(result.home, root); assert.equal(result.truncated, false);
  assert.deepEqual(result.entries.map(item => item.name).sort(), ['.隐藏项目', '目录别名', '项目10', '项目2'].sort());
  assert.ok(result.entries.find(item => item.name === '.隐藏项目').hidden);
  assert.equal(result.entries.find(item => item.name === '项目2').hidden, false);
  assert.ok(result.entries.findIndex(item => item.name === '项目2') < result.entries.findIndex(item => item.name === '项目10'));
  assert.equal(result.crumbs[0].path, path.parse(root).root);
  assert.equal(result.crumbs.at(-1).path, root);
  for (let index = 1; index < result.crumbs.length; index++) assert.equal(path.dirname(result.crumbs[index].path), result.crumbs[index - 1].path);
  const alias = listProjectDirectory(path.join(root, '目录别名'), { home: root });
  assert.equal(alias.path, path.join(root, '项目2'));
  assert.deepEqual(readdirSync(root), namesBefore);
  assert.equal(readFileSync(path.join(root, '资料.txt'), 'utf8'), '原文不能被浏览改动');
  assert.equal(statSync(path.join(root, '资料.txt')).mtimeMs, modifiedBefore);
  assert.equal(existsSync(path.join(root, '.wtt-workbench')), false);
});

test('directory browse defaults to home and rejects relative, missing and regular-file paths without creating them', t => {
  const root = fixture(t);
  writeFileSync(path.join(root, 'file.md'), '# 文件');
  assert.equal(listProjectDirectory(undefined, { home: root }).path, root);
  assert.equal(listProjectDirectory('', { home: root }).path, root);
  for (const value of ['relative', '\0', path.join(root, 'missing'), path.join(root, 'file.md')]) assert.throws(() => listProjectDirectory(value, { home: root }), /目录路径无效|无法浏览文件夹/);
  assert.equal(existsSync(path.join(root, 'missing')), false);
  assert.deepEqual(listProjectDirectory(path.parse(root).root, { home: root }).crumbs, [{ name: path.parse(root).root, path: path.parse(root).root }]);
});

test('directory browse reports truncation after the selectable directory limit rather than counting regular files', t => {
  const root = fixture(t);
  for (const name of ['a', 'b', 'c']) mkdirSync(path.join(root, name));
  writeFileSync(path.join(root, '0-file.txt'), 'not a directory');
  const limited = listProjectDirectory(root, { home: root, maxEntries: 2 });
  assert.deepEqual(limited.entries.map(item => item.name), ['a', 'b']); assert.equal(limited.truncated, true);
  const exact = listProjectDirectory(root, { home: root, maxEntries: 3 });
  assert.equal(exact.entries.length, 3); assert.equal(exact.truncated, false);
});
