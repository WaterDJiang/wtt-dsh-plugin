import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/output-preview.jsx', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, loader: { '.css': 'empty' } });
const compiled = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const { OutputPreview } = compiled.exports;
const render = props => renderToStaticMarkup(React.createElement(OutputPreview, { type: 'text', ...props }));

test('compact preview bounds long paragraphs while full preview retains the tail and Unicode', () => {
  const content = 'x'.repeat(599) + '😀' + '正文'.repeat(4000) + '完整正文末尾';
  const compact = render({ compact: true, content });
  const preview = compact.match(/<pre[^>]*>(.*?)<\/pre>/s)[1];
  assert(preview.length <= 601);
  assert(preview.endsWith('…'));
  assert.doesNotMatch(preview, /[\uD800-\uDFFF]/u);
  const full = render({ content });
  assert(full.includes(content), 'full preview must retain every original character');
  assert(!render({ compact: true, content: '短正文😀' }).includes('…'));
});

test('missing and externally changed files never expose a stale compact or full body', () => {
  for (const status of ['missing', 'changed', 'unavailable']) {
    for (const compact of [true, false]) {
      const html = render({ status, compact, content: '已失效的旧正文' });
      assert.doesNotMatch(html, /已失效的旧正文|<pre/);
      assert.match(html, /无法沿用旧预览/);
    }
  }
});
