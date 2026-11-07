import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pptInlineStyle } from '../src/ppt-inline-style.mjs';

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/ppt-inline-editor.jsx', import.meta.url))], bundle: true,
  platform: 'node', format: 'cjs', packages: 'external', write: false });
const compiled = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const { PptTextLayer } = compiled.exports;
const document = { width: 9144000, height: 5143500 };
const editable = { id: 'text-1', name: '课程标题', text: '原始标题', editable: true,
  bounds: { x: 914400, y: 914400, width: 4572000, height: 914400 }, textStyle: { fontPoints: 28, fontFamily: 'PingFang SC', bold: true, align: 'center' } };
const readonly = { ...editable, id: 'field', name: '动态字段', editable: false, reason: '动态字段只读', text: '动态日期' };
const render = props => renderToStaticMarkup(React.createElement(PptTextLayer, { document,
  slide: { id: 'page', elements: [editable, readonly] }, renderedSlide: { elements: [editable, readonly] }, ...props }));

test('page exposes direct editing and keeps readonly fields distinct without opening a second input area', () => {
  const html = render();
  assert.match(html, /直接编辑文字：原始标题/);
  assert.match(html, /查看只读文字：动态日期/);
  assert.match(html, /title="动态字段只读"/);
  assert.doesNotMatch(html, /<textarea/);
  const disabled = render({ disabled: true });
  assert.equal([...disabled.matchAll(/<button[^>]*disabled/g)].length, 2);
});

test('unrendered draft text is escaped and visibly provisional until the actual file preview catches up', () => {
  const altered = { ...editable, text: '<script>草稿</script>' };
  const html = render({ slide: { id: 'page', elements: [altered] } });
  assert.match(html, /class="wtt-ppt-inline-draft"/);
  assert.match(html, /&lt;script&gt;草稿&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(render(), /class="wtt-ppt-inline-draft"/);
});

test('text display hints scale with the real page and reject invalid geometry or unsafe style data', () => {
  const style = pptInlineStyle(document, editable);
  assert.equal(style.left, '10%'); assert.equal(style.fontWeight, 700); assert.equal(style.textAlign, 'center');
  assert.match(style.fontSize, /^[\d.]+cqw$/);
  assert.match(pptInlineStyle(document, editable, { editing: true }).fontSize, /^clamp\(12px, [\d.]+cqw, 72px\)$/);
  const unsafe = pptInlineStyle(document, { ...editable, textStyle: { fontPoints: Infinity, fontFamily: 'Arial; color:red', align: 'bad' } });
  assert.equal(unsafe.fontSize, '14px'); assert.equal(unsafe.fontFamily, 'sans-serif'); assert.equal(unsafe.textAlign, 'left');
  assert.equal(pptInlineStyle(document, { ...editable, bounds: { ...editable.bounds, width: NaN } }), null);
});

test('instant draft keeps native colors and margins while rejecting CSS from metadata', () => {
  const style = pptInlineStyle(document, { ...editable, textStyle: { ...editable.textStyle, color: '#003070', backgroundColor: '#ffffff', margins: [0, 91440, 0, 91440] } });
  assert.equal(style.color, '#003070'); assert.equal(style.backgroundColor, '#ffffff'); assert.equal(style.padding, '0cqw 1cqw 0cqw 1cqw');
  const unsafe = pptInlineStyle(document, { ...editable, textStyle: { color: 'url(https://example.com)', backgroundColor: '#fff;position:fixed', margins: [NaN] } });
  assert.equal(unsafe.color, '#222222'); assert.equal(unsafe.backgroundColor, '#ffffff'); assert.equal(unsafe.padding, '3px 5px');
});
