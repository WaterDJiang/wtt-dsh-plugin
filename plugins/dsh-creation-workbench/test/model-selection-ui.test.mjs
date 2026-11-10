import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/model-selection.jsx', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, loader: { '.css': 'empty' } });
const compiled = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const { ModelSelection } = compiled.exports;
const selection = { provider: 'local', model: 'course', reasoningEffort: 'high' };
const catalog = { routableProviders: ['local'], default: selection, groups: [{ id: 'local', name: '本机模型',
  models: [{ id: 'course', name: '课程模型', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }], failures: [] };
const render = props => renderToStaticMarkup(React.createElement(ModelSelection, { compact: true, catalog, selection, onChange() {}, ...props }));

test('compact model disclosure starts closed and announces actual selection', () => {
  const html = render();
  assert.match(html, /<summary[^>]*aria-label="创作模型：课程模型 · 高"/u);
  assert.match(html, /<details class="wcc-model-selection-disclosure">/u);
  assert.doesNotMatch(html, /<details[^>]*\sopen/u);
});

test('folded model summary surfaces the issue and keeps diagnostics inside the disclosure', () => {
  for (const [props, state, detail] of [
    [{ error: new Error('目录读取失败') }, '加载失败', '目录读取失败'],
    [{ selection: { provider: 'gone', model: 'missing' } }, '不可用', '这个模型目前不可用'],
    [{ catalog: { ...catalog, failures: [{ id: 'other', name: '另一提供商', message: '不可用' }] } }, '部分不可用', '另一提供商：不可用'],
    [{ catalog: null }, '未配置', '尚无可用模型'],
  ]) {
    const html = render(props);
    assert.match(html, new RegExp(`<summary[^>]*aria-label="[^"]+ · ${state}"`, 'u'));
    assert.ok(html.slice(html.indexOf('</summary>'), html.indexOf('</details>')).includes(detail));
    assert.doesNotMatch(html.slice(html.indexOf('</details>')), /role="(?:alert|status)"/u);
  }
});

test('frozen task keeps its exact model and disables edits while disclosing lock', () => {
  const html = render({ onChange: undefined });
  assert.match(html, /原任务模型已锁定/u);
  assert.match(html, /已锁定/u);
  for (const select of html.matchAll(/<select[^>]*>/gu)) assert.match(select[0], /\sdisabled/u);
  assert.match(html, /value="course" selected/u);
});

test('full model selection on other surfaces remains expanded', () => {
  const html = render({ compact: false });
  assert.doesNotMatch(html, /<details/u);
  assert.match(html, /aria-label="模型提供商"/u);
  assert.match(html, /aria-label="模型推理等级"/u);
});
