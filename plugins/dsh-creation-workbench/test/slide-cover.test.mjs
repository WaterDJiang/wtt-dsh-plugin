import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { slideTree } from '../src/slide-projects.mjs';
import { slideCoverIdentity, renderSlideCover } from '../src/slide-cover.mjs';

function fixture(t, html = '<section id="cover" style="background:#ffffff;font-family:Arial"><h1>真实工程封面 &amp; 中文</h1><aside>不上屏的讲师答案</aside></section>') {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wtt-cover-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'slides'));
  writeFileSync(path.join(root, 'deck.json'), JSON.stringify({ v: 4, order: ['cover'], cover: 'cover' }));
  const file = path.join(root, 'slides/cover.html'); writeFileSync(file, html);
  return { root, file, read: revision => renderSlideCover(root, slideTree(root), revision) };
}

test('真实工程封面与树hash绑定、只读沙箱文档保留原色和正文，不显示备注', t => {
  const f = fixture(t), identity = slideCoverIdentity(f.root), cover = f.read(identity.revision);
  assert.equal(cover.revision, identity.revision); assert.equal(cover.treeHash, slideTree(f.root).hash);
  assert.equal(cover.pageCount, 1); assert.match(cover.document, /真实工程封面 &amp; 中文/);
  assert.match(cover.document, /background:#ffffff/); assert.doesNotMatch(cover.document, /不上屏的讲师答案/);
  assert.match(cover.document, /default-src 'none'/); assert.doesNotMatch(cover.document, /<script/);
  writeFileSync(f.file, '<section id="cover"><h1>新版</h1></section>');
  assert.throws(() => f.read(identity.revision), /封面已变化/);
});

test('真实图片归档内嵌；外链、越界、资源外改与活动HTML明确失败', t => {
  const f = fixture(t, '<section id="cover"><img src="project/logo.png"></section>');
  writeFileSync(path.join(f.root, 'logo.png'), Buffer.from([137,80,78,71]));
  assert.match(f.read().document, /src="data:image\/png;base64,/);
  const tree = slideTree(f.root); writeFileSync(path.join(f.root, 'logo.png'), '外改');
  assert.throws(() => renderSlideCover(f.root, tree), /资源已变化/);
  for (const html of ['<section><script>alert(1)</script></section>', '<section><img src="https://example.com/a.png"></section>', '<section><img src="../secret.png"></section>', '<section onclick="bad()"></section>', '<section><iframe src="about:blank"></iframe></section>']) {
    writeFileSync(f.file, html); assert.throws(() => f.read(), /不支持|未归档|活动属性/);
  }
});

test('封面索引和符号链接拒绝读取，不通过预览泄露工程外文件', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, 'deck.json'), JSON.stringify({ v: 4, order: ['../secret'], cover: '../secret' }));
  assert.throws(() => slideCoverIdentity(f.root), /索引无效/);
  writeFileSync(path.join(f.root, 'deck.json'), JSON.stringify({ v: 4, order: ['cover'], cover: 'cover' }));
  rmSync(f.file); symlinkSync(path.join(f.root, 'deck.json'), f.file);
  assert.throws(() => slideCoverIdentity(f.root), /符号链接/);
});
