import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadConversationReferenceFiles, stageConversationReferenceFiles } from '../src/conversation-references.mjs';
import { addPickedReferences, referencePickReason } from '../src/canvas-reference-picker.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const source = bytes => ({ id: 'material:test', title: '角色/参考', sourceHash: hash('body'), importedFile: { path: 'files/reference.png', hash: hash(bytes), mime: 'image/png' } });
const env = card => ({ endpoint: query => query, isCurrent: () => true, currentCard: () => card });

test('canvas files become immutable native attachments with checked bytes and a readable safe filename', async () => {
  const bytes = Buffer.from('synthetic image bytes'), card = source(bytes), requests = [];
  const files = await loadConversationReferenceFiles([card], { ...env(card), fetchFile: async query => { requests.push(query); return new Response(bytes); } });
  assert.equal(files[0].name, '角色_参考.png'); assert.equal(files[0].type, 'image/png');
  assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), bytes);
  assert.deepEqual(requests, [{ projectFileDownload: 'files/reference.png', hash: hash(bytes) }]);
});

test('stale selection, changed raw file, bad returned bytes and failed reads refuse staging', async () => {
  const card = source('first');
  await assert.rejects(loadConversationReferenceFiles([card], { ...env(card), currentCard: () => ({ ...card, sourceHash: hash('changed') }), fetchFile: () => assert.fail('must not fetch') }), /卡片内容已变化/);
  await assert.rejects(loadConversationReferenceFiles([card], { ...env(card), currentCard: () => ({ ...card, sourceStatus: 'modified' }), fetchFile: () => assert.fail('must not fetch') }), /原文件已缺失/);
  await assert.rejects(loadConversationReferenceFiles([card], { ...env(card), fetchFile: async () => new Response('wrong bytes') }), /所选版本不一致/);
  await assert.rejects(loadConversationReferenceFiles([card], { ...env(card), fetchFile: async () => Response.json({ error: 'hash 已变化' }, { status: 409 }) }), /hash 已变化/);
});

test('late download and aborted owners cannot attach files to a replacement conversation', async () => {
  const card = source('first'); let current = true;
  await assert.rejects(loadConversationReferenceFiles([card], { ...env(card), isCurrent: () => current, fetchFile: async () => { current = false; return new Response('first'); } }), /对话或画布已切换/);
  const c = new AbortController(); c.abort();
  await assert.rejects(loadConversationReferenceFiles([card], { ...env(card), signal: c.signal }), { name: 'AbortError' });
});

test('selected historical output uses its own file/hash, and missing physical hash is resolved before download', async () => {
  const card = { id: 'artifact:old', nodeId: 'output:same-layout', sourceHash: hash('old'), title: '历史正文', path: 'versions/old.md', defaultOutcome: { path: 'versions/old.md', hash: hash('old') } };
  const [file] = await loadConversationReferenceFiles([card], { ...env(card), fetchFile: async query => { assert.equal(query.hash, hash('old')); return new Response('old'); } });
  assert.equal(await file.text(), 'old');
  const word = { id: 'word:legacy', title: '旧文档', kind: 'word', path: 'legacy.docx', sourceHash: hash('markdown') }, calls = [];
  await loadConversationReferenceFiles([word], { ...env(word), fetchFile: async query => { calls.push(query); return query.projectFilePreview ? Response.json({ hash: hash('word bytes') }) : new Response('word bytes'); } });
  assert.deepEqual(calls, [{ projectFilePreview: 'legacy.docx' }, { projectFileDownload: 'legacy.docx', hash: hash('word bytes') }]);
});

test('background and whiteboard snapshots stay local attachments, without file or asset writes', async () => {
  const card = { id: 'whiteboard:x', kind: 'whiteboard', title: '便签', content: '冻结的便签文字' };
  const [file] = await loadConversationReferenceFiles([card], { ...env(card), fetchFile: () => assert.fail('no file needed') });
  assert.equal(await file.text(), card.content); assert.equal(file.name, '便签.md');
  await assert.rejects(loadConversationReferenceFiles([{ ...card, content: '' }], env({ ...card, content: '' })), /没有可添加/);
});

test('native attachment admission keeps text, original attachments and send under native ownership', () => {
  const ids = [], calls = [];
  const service = { createDrafts: (session, files) => { calls.push([session, files]); return [{ id: 'new' }]; }, releaseDraftAttachments: () => assert.fail('not rejected') };
  stageConversationReferenceFiles({ service, sessionId: 'session-a', files: ['a'], inputActions: { addAttachments: value => { ids.push(...value); return true; }, setDraft: () => assert.fail('do not replace draft'), submit: () => assert.fail('do not send') }, readInput: () => ({ phase: 'plain', attachmentIds: ['existing'] }), isCurrent: () => true });
  assert.deepEqual(ids, ['new']); assert.deepEqual(calls, [['session-a', ['a']]]);
});

test('native locking, limits and failed admission clean only the new temporary attachments', () => {
  const released = [], service = { createDrafts: () => [{ id: 'new' }], releaseDraftAttachments: drafts => released.push(drafts) };
  const base = { service, sessionId: 's', files: ['a'], inputActions: { addAttachments: () => false }, isCurrent: () => true, readInput: () => ({ phase: 'plain', attachmentIds: [] }) };
  assert.throws(() => stageConversationReferenceFiles({ ...base, readInput: () => ({ phase: 'submitting', attachmentIds: [] }) }), /正在提交/); assert.equal(released.length, 0);
  assert.throws(() => stageConversationReferenceFiles({ ...base, readInput: () => ({ phase: 'plain', attachmentIds: Array(24).fill('old') }) }), /最多添加24/); assert.equal(released.length, 0);
  assert.throws(() => stageConversationReferenceFiles(base), /原输入和附件已保留/); assert.deepEqual(released, [[{ id: 'new' }]]);
});

test('conversation selection preserves original creation rules and respects remaining attachment capacity', () => {
  const card = { id: 'video:a', sourceStatus: 'modified', extracted: true };
  assert.equal(referencePickReason(card, { conversation: true }), '原文件已缺失或变化');
  assert.equal(referencePickReason(card, {}), '');
  const result = addPickedReferences([], [{ id: 'a' }, { id: 'b' }], { intent: 'revise', maxReferences: 1 });
  assert.deepEqual(result.references, [{ id: 'a' }]); assert.match(result.error, /1 份附件/);
});

test('bulk references read at most three files concurrently and retain selection order', async () => {
  const cards = Array.from({ length: 8 }, (_, i) => ({ ...source(`body-${i}`), id: `material:${i}`, title: `资料${i}`, importedFile: { path: `file-${i}.md`, hash: hash(`body-${i}`) } }));
  const byId = new Map(cards.map(card => [card.id, card]));
  let active = 0, peak = 0;
  const files = await loadConversationReferenceFiles(cards, { ...env(null), currentCard: card => byId.get(card.id), fetchFile: async query => {
    active++; peak = Math.max(peak, active);
    const i = Number(/file-(\d+)/.exec(query.projectFileDownload)[1]);
    await new Promise(resolve => setTimeout(resolve, (8 - i) * 2));
    active--; return new Response(`body-${i}`);
  } });
  assert.equal(peak, 3);
  assert.deepEqual(await Promise.all(files.map(file => file.text())), cards.map((_, i) => `body-${i}`));
});

test('one bulk read failure aborts peers and does not start the remaining batch', async () => {
  const cards = Array.from({ length: 8 }, (_, i) => ({ ...source('body'), id: `material:${i}` }));
  let started = 0, aborted = 0;
  await assert.rejects(loadConversationReferenceFiles(cards, { ...env(null), currentCard: card => card, fetchFile: async (_query, { signal }) => {
    if (++started === 1) return Response.json({ error: '第一份已被外改' }, { status: 409 });
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true }));
  } }), /第一份已被外改/);
  assert.equal(started, 3); assert.equal(aborted, 2);
});
