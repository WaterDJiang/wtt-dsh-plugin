import test from 'node:test';
import assert from 'node:assert/strict';
import { userFacingError } from '../src/user-feedback.mjs';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('ambiguous submissions retain the exact diagnosis and never recommend a duplicate send', () => {
  const original = '提交结果未知：HTTP 429 timeout，服务可能已受理';
  const result = userFacingError(new Error(original));
  assert.equal(result.detail, original);
  assert.match(result.summary, /不要重复发送/);
  assert.doesNotMatch(result.summary, /重试|稍后再试|重新发送/);
  assert.equal(result.hasDetail, true);
});

test('source conflicts preserve drafts while missing tasks and permissions have different next steps', () => {
  assert.match(userFacingError('文件已被外部修改 hash mismatch').summary, /保留当前草稿/);
  assert.match(userFacingError('session/not-found').summary, /所属项目/);
  assert.match(userFacingError('EACCES /tmp/example').summary, /权限/);
  assert.match(userFacingError('401 unauthorized').summary, /连接设置/);
});

test('unrecognized errors remain available as diagnostics and readable input validation stays direct', () => {
  const raw = 'TypeError: unexpected state\n at local-component:42';
  assert.equal(userFacingError(raw).detail, raw);
  assert.equal(userFacingError(raw).hasDetail, true);
  assert.deepEqual(userFacingError('请先填写背景信息。'), { summary: '请先填写背景信息。', detail: '请先填写背景信息。', hasDetail: false });
});

test('diagnostics are escaped and collapsed; no raw HTML becomes executable markup', async () => {
  const bundle = await build({ entryPoints: ['src/user-feedback.jsx'], bundle: true, platform: 'node', format: 'cjs',
    packages: 'external', write: false, loader: { '.css': 'empty' } });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const html = renderToStaticMarkup(React.createElement(module.exports.UserError, { error: 'TypeError: <script>bad()</script>' }));
  assert.match(html, /详细原因/);
  assert.doesNotMatch(html, /<details[^>]*\sopen|<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('PPT本机转换失败指向源稿或本机应用，不误导检查模型网络',()=>{
 const raw='预览更新失败：PPT 渲染命令退出 1：MuPDF error: format error: No common ancestor in structure tree';
 const result=userFacingError(raw);assert.match(result.summary,/本机转换/);assert.match(result.summary,/编辑源文件/);assert.doesNotMatch(result.summary,/连接设置|额度/);assert.equal(result.detail,raw);
});
