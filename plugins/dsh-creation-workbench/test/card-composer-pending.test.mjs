import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

// Exercise the actual JSX and its rendered button, without a browser or extra dependencies.
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/card-creation.jsx', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, loader: { '.css': 'empty' } });
const compiled = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const { CardComposer } = compiled.exports;

function render(outputType, status, { pending = true, sourceStatus, intent } = {}) {
  const references = [{ id: 'requirement:r', kind: 'requirement', title: '原始背景', sourceHash: 'a'.repeat(64), content: '提交时背景', ...(sourceStatus ? { status: sourceStatus } : {}) }];
  const context = { key: 'p:r:pending:card:task', projectName: '验收项目', requirementTitle: '原始背景', outputType,
    anchor: { id: 'output:card', kind: 'generation', title: '尚无成功产物', outputCard: { versions: [], versionId: null } },
    references, instruction: '使用冻结背景制作内容', intent,
    ...(pending ? { pendingTaskId: 'task', taskId: 'task', pendingGeneration: { taskId: 'task', status, phase: status === 'accepted' ? 'failed' : status } } : {}) };
  return renderToStaticMarkup(React.createElement(CardComposer, { context, references, instruction: context.instruction,
    creationTypes: [{ id: outputType, label: outputType, available: false, message: '请先核对已保存来源' }],
    // Even if a caller accidentally permits sending, accepted/unknown must stay blocked internally.
    canSend: true, onSend() {} }));
}

function sendButton(markup) {
  const match = markup.match(/<button\b[^>]*class="[^"]*\bwcc-creation-send\b[^"]*"[^>]*>[\s\S]*?<\/button>/u);
  assert.ok(match, 'actual submit button should be rendered');
  return match[0];
}
function retryButton(markup) {
  return markup.match(/<button\b[^>]*>重试原任务<\/button>/u)?.[0];
}

for (const type of ['text', 'pptx', 'image', 'video']) {
  for (const status of ['draft', 'failed']) test(`${type} original ${status} task can retry despite an unreferenceable placeholder and disabled new-source menu`, () => {
    const markup = render(type, status);
    const button = retryButton(markup);
    assert.ok(button, 'the original unsent task must retain its explicit retry');
    assert.match(button, /重试原任务/u);
    assert.doesNotMatch(button, /\sdisabled(?:=|\s|>)/u);
    assert.doesNotMatch(markup, /请先核对已保存来源/u);
  });

  for (const status of ['accepted', 'unknown']) test(`${type} original ${status} task cannot resend and has no misleading placeholder-source warning`, () => {
    const markup = render(type, status);
    assert.doesNotMatch(markup, /\bwcc-creation-send\b/u);
    assert.equal(retryButton(markup), undefined);
    assert.doesNotMatch(markup, /aria-label="创作要求"|class="wcc-model-selection/u);
    assert.match(markup, /创作详情/u);
    assert.doesNotMatch(markup, /请先核对已保存来源/u);
  });
}

test('actual missing-reference warnings remain visible when the placeholder source check is bypassed', () => {
  assert.match(render('text', 'draft', { sourceStatus: 'missing' }), /文件已缺失/u);
  assert.match(render('text', 'draft', { sourceStatus: 'modified' }), /文件已在外部修改/u);
});

test('a new creation still respects an unavailable source menu', () => {
  const markup = render('text', 'draft', { pending: false });
  assert.match(sendButton(markup), /\sdisabled(?:=|\s|>)/u);
  assert.match(markup, /请先核对已保存来源/u);
});

test('saved output opens an explicit revision action instead of a second editable composer', () => {
  const markup = render('pptx', 'accepted', { pending: false, intent: 'revise' });
  assert.match(markup, /基于此版修改/);
  assert.match(markup, /已保存/);
  assert.doesNotMatch(markup, /aria-label="创作要求"|class="wcc-model-selection|\bwcc-creation-send\b/u);
});


for (const outputType of ['image', 'video']) test(`${outputType} defaults to Skill and API without providers cannot submit`, () => {
  const context = { key: 'media', outputType, anchor: { kind: 'canvas', title: '媒体' }, references: [], instruction: '制作一份媒体', generation: { mode: 'new' } };
  const renderMedia = generationMethod => renderToStaticMarkup(React.createElement(CardComposer, { context: { ...context, generationMethod }, instruction: context.instruction,
    creationTypes: [{ id: outputType, available: true }], mediaCapabilities: { providers: [] }, onSend() {} }));
  const skill = renderMedia(undefined);
  assert.match(skill, /aria-pressed="true"[^>]*>Skill 生成/);
  assert.match(skill, /选择技能/);
  assert.doesNotMatch(sendButton(skill), /\sdisabled(?:=|\s|>)/u);
  assert.doesNotMatch(skill, /即梦|jimeng|生成模型/);
  const api = renderMedia('api');
  assert.match(api, /尚未接入 API 服务/);
  assert.match(sendButton(api), /\sdisabled(?:=|\s|>)/u);
  assert.doesNotMatch(api, /即梦|jimeng|选择技能/);
});
