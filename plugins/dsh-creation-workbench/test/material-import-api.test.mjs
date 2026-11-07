import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../src/index.mjs';
import { IMPORT_MAX_BYTES } from '../src/material-import.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'wtt-import-api-')));
  const other = realpathSync(mkdtempSync(path.join(tmpdir(), 'wtt-import-api-other-')));
  const disposers = []; let endpoint;
  apply({
    effect(action) { const dispose = action(); if (typeof dispose === 'function') disposers.push(dispose); },
    connection: { fetch: { register(value) { endpoint = value; return () => {}; } } },
    tools: { register() { return () => {}; } }, skills: { register() { return () => {}; } },
  }, { workspaceRoot: root, registryFile: path.join(root, 'projects.json') });
  t.after(() => { for (const dispose of disposers.reverse()) dispose(); rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); });
  const response = (query = {}, options) => endpoint.fetch(new Request(`http://localhost/api/wtt-creation-workbench?${new URLSearchParams(query)}`, options));
  const call = async (action, data, projectId) => {
    const result = await response(projectId ? { projectId } : {}, { method: 'POST', body: JSON.stringify({ action, data }) });
    const value = await result.json(); assert.equal(result.status, 200, value.error); return value;
  };
  return { root, other, response, call, endpoint: () => endpoint };
}

test('raw imports bypass only the JSON body cap and download by exact project/material identity', async t => {
  const { root, other, response, call, endpoint } = fixture(t);
  assert.equal(endpoint().requestBody, 'buffered');
  const projectId = (await (await response({ projects: 1 })).json()).activeProjectId;
  const requirement = await call('create', { title: '原文件接口验收', operationId: randomUUID() }, projectId);
  const operationId = randomUUID(), bytes = Buffer.from('界'.repeat(550_000));
  const query = { projectId, importMaterial: requirement.id, operationId, filename: '本机课程参考.txt', x: '450', y: '320' };
  const uploaded = await response(query, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
  assert.equal(uploaded.status, 200);
  const value = await uploaded.json();
  assert.equal(value.material.importedFile.byteSize, bytes.length);
  assert.equal(value.material.importedFile.truncated, true);
  assert.deepEqual(value.board.nodes.find(node => node.refId === value.material.id).position, { x: 450, y: 320 });
  const replay = await (await response({ ...query, x: '900', y: '700' }, { method: 'POST', body: bytes })).json();
  assert.equal(replay.material.id, value.material.id);
  const download = await response({ projectId, materialFile: value.material.id });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type'), /text\/plain/);
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.equal((await response({ projectId, materialFile: value.material.id, preview: 1 })).status, 400);
  const projectB = (await call('open-project', { path: other })).project;
  assert.equal((await response({ projectId: projectB.id, materialFile: value.material.id })).status, 400);
  const wrongProject = await response({ ...query, projectId: projectB.id, operationId: randomUUID() }, { method: 'POST', body: Buffer.from('不能落入B') });
  assert.equal(wrongProject.status, 400);
  assert.match((await wrongProject.json()).error, /需求不存在/);
  const legacyLarge = await response({ projectId }, { method: 'POST', body: JSON.stringify({ action: 'add-material', data: { content: 'a'.repeat(1_500_001) } }) });
  assert.equal(legacyLarge.status, 400);
  assert.match((await legacyLarge.json()).error, /请求内容过大/);
  const tooLarge = await response({ ...query, operationId: randomUUID() }, { method: 'POST', body: Buffer.alloc(IMPORT_MAX_BYTES + 1) });
  assert.equal(tooLarge.status, 413);
  const foreignPath = await response({ projectId, materialFile: '../outside.txt' });
  assert.equal(foreignPath.status, 400);
  writeFileSync(path.join(root, value.material.importedFile.path), '外改');
  assert.equal((await response({ projectId, materialFile: value.material.id })).status, 400);
});

test('raw image previews retain their checked MIME and reject incomplete or duplicate parameters', async t => {
  const { response, call } = fixture(t);
  const projectId = (await (await response({ projects: 1 })).json()).activeProjectId;
  const requirement = await call('create', { title: '图片接口验收', operationId: randomUUID() }, projectId);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const query = { projectId, importMaterial: requirement.id, operationId: randomUUID(), filename: '图片.png' };
  const result = await (await response(query, { method: 'POST', body: bytes })).json();
  const preview = await response({ projectId, materialFile: result.material.id, preview: 1 });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type'), 'image/png');
  assert.match(preview.headers.get('content-disposition'), /^inline;/);
  assert.match(preview.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), bytes);
  assert.equal((await response({ ...query, operationId: randomUUID(), x: '3' }, { method: 'POST', body: bytes })).status, 400);
  assert.equal((await response({ importMaterial: requirement.id, operationId: randomUUID(), filename: '图片.png' }, { method: 'POST', body: bytes })).status, 400);
  const duplicate = new URLSearchParams(query); duplicate.append('operationId', randomUUID());
  assert.equal((await response(duplicate, { method: 'POST', body: bytes })).status, 400);
});

test('the whiteboard JSON action freezes actual stored text and refuses a forged copy', async t => {
  const { response, call } = fixture(t);
  const projectId = (await (await response({ projects: 1 })).json()).activeProjectId;
  const requirement = await call('create', { title: '白板快照接口验收', operationId: randomUUID() }, projectId);
  const elementId = `whiteboard:${randomUUID()}`;
  await call('save-canvas', { requirementId: requirement.id, expectedRevision: 0, elements: [{ id: elementId, kind: 'shape', shape: 'rectangle', colour: 'blue', text: '已保存形状正文', width: 258, height: 120 }] }, projectId);
  const data = { requirementId: requirement.id, elementId, expectedContent: '已保存形状正文', operationId: randomUUID() };
  const frozen = await call('snapshot-whiteboard', data, projectId);
  assert.equal(frozen.material.content, data.expectedContent);
  assert.equal(frozen.material.whiteboardSource.elementId, elementId);
  const invalid = await response({ projectId }, { method: 'POST', body: JSON.stringify({ action: 'snapshot-whiteboard', data: { ...data, operationId: randomUUID(), expectedContent: '未保存的伪造正文' } }) });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /正文已变化/);
});
