import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMediaProvider } from '../src/media-provider.mjs';

const SECRET = 'synthetic-session-for-local-tests';
const MODELS = ['jimeng-5.0', 'jimeng-4.6', 'jimeng-video-3.0', 'seedance-2.0-mini', 'unverified-model'];
const picture = { bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), name: '合成参考.png', mime: 'image/png' };
const imageInput = { type: 'image', model: 'jimeng-5.0', prompt: '仅测试本机协议，无真实生成', ratio: '16:9', resolution: '2k', references: [] };
function reply(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
}

async function fixture(t, handler = (_request, response) => reply(response, 404, { message: 'not found' }), config = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'wtt-media-provider-'));
  const requests = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      requests.push({ url: request.url, method: request.method, headers: request.headers, body });
      if (request.method === 'GET' && request.url === '/v1/models' && !config.modelsViaHandler) return reply(response, 200, { data: MODELS.map(id => ({ id })) });
      await handler(request, response, body);
    })().catch(error => { if (!response.destroyed) reply(response, 500, { message: error.message }); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const settingsPath = path.join(directory, 'settings.json');
  const skillConfigPath = path.join(directory, 'skill.json');
  const options = { mediaEndpoint: endpoint, mediaSessionId: SECRET, mediaSettingsPath: settingsPath, mediaSkillConfigPath: skillConfigPath,
    mediaHealthTimeoutMs: 1000, mediaSubmitTimeoutMs: 1000, mediaQueryTimeoutMs: 1000, mediaDownloadTimeoutMs: 1000, ...config };
  const provider = createMediaProvider(options);
  t.after(async () => { await provider.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  return { directory, requests, server, endpoint, settingsPath, skillConfigPath, options, provider };
}

test('safe capabilities intersect verified models without exposing credentials or accepting arbitrary providers', async t => {
  const { provider, endpoint } = await fixture(t);
  const info = await provider.capabilities();
  assert.equal(info.endpoint, endpoint); assert.equal(info.healthy, true); assert.equal(info.credentialConfigured, true);
  assert.deepEqual(info.modelDefaults.image, { model: 'jimeng-5.0', ratio: '4:3', resolution: '2k' });
  assert.deepEqual(info.modelDefaults.video, { model: 'jimeng-video-3.0', ratio: '4:3', resolution: '720p', duration: 5 });
  assert.deepEqual(info.models.map(model => model.id), MODELS.filter(id => id !== 'unverified-model'));
  assert.equal(JSON.stringify(info).includes(SECRET), false);
  const seedance = info.models.find(model => model.id === 'seedance-2.0-mini');
  assert.equal(seedance.requiresReference, true); assert.ok(seedance.durations.includes(5)); assert.ok(seedance.ratios.includes('1:1'));
  await assert.rejects(provider.updateSettings({ endpoint: 'https://example.com' }), error => error.code === 'provider_configuration_invalid');
  await assert.rejects(provider.updateSettings({ endpoint: 'http://user:secret@127.0.0.1:8000' }), error => error.code === 'provider_configuration_invalid');
  assert.equal((await provider.capabilities()).endpoint, endpoint);
});

test('settings persist all default parameters with private credentials, preserve blank inputs and permanently clear fallback', async t => {
  const setup = await fixture(t, undefined, { mediaSessionId: undefined });
  writeFileSync(setup.skillConfigPath, JSON.stringify({ session_id: 'synthetic-global-fallback' }));
  assert.equal((await setup.provider.capabilities()).credentialConfigured, true);
  const defaults = { image: { model: 'jimeng-4.6', ratio: '4:3', resolution: '4k' }, video: { model: 'seedance-2.0-mini', ratio: '1:1', resolution: '720p', duration: 5 } };
  const saved = await setup.provider.updateSettings({ sessionId: 'synthetic-new-secret', modelDefaults: defaults });
  assert.deepEqual(saved.modelDefaults, defaults);
  assert.equal(JSON.stringify(saved).includes('synthetic-new-secret'), false);
  assert.equal(statSync(setup.settingsPath).mode & 0o777, 0o600);
  await setup.provider.updateSettings({ sessionId: '' });
  assert.equal(JSON.parse(readFileSync(setup.settingsPath)).sessionId, 'synthetic-new-secret');
  const reopened = createMediaProvider(setup.options); t.after(() => reopened.close());
  assert.deepEqual((await reopened.capabilities()).modelDefaults, defaults);
  await setup.provider.updateSettings({ clearCredential: true });
  assert.equal((await reopened.capabilities()).credentialConfigured, false);
  assert.equal(readFileSync(setup.settingsPath, 'utf8').includes('synthetic-new-secret'), false);
  await setup.provider.updateSettings({ sessionId: '' });
  assert.equal((await setup.provider.capabilities()).credentialConfigured, false);
  await assert.rejects(setup.provider.updateSettings({ modelDefaults: { video: { duration: 3 } } }), error => error.code === 'provider_configuration_invalid');
  await assert.rejects(setup.provider.updateSettings({ modelDefaults: { image: { ratio: 'unknown' } } }), error => error.code === 'provider_configuration_invalid');
  await assert.rejects(setup.provider.updateSettings({ arbitrary: 'value' }), error => error.code === 'provider_configuration_invalid');
});

test('missing credentials prevent POST and unavailable services retain the verified offline catalog', async t => {
  const setup = await fixture(t, undefined, { mediaSessionId: undefined });
  await assert.rejects(setup.provider.submit(imageInput), error => error.code === 'credential_missing');
  assert.equal(setup.requests.length, 0);
  setup.server.closeAllConnections(); await new Promise(resolve => setup.server.close(resolve));
  const info = await setup.provider.capabilities();
  assert.equal(info.healthy, false); assert.ok(info.models.some(model => model.id === 'jimeng-5.0'));
  assert.match(info.error, /服务/);
});

test('image references use multipart image bytes and explicit generation parameters', async t => {
  let received;
  const setup = await fixture(t, async (request, response, body) => {
    assert.equal(request.url, '/v1/images/generations');
    const form = await new Request('http://fixture/', { method: 'POST', headers: { 'Content-Type': request.headers['content-type'] }, body }).formData();
    received = { model: form.get('model'), ratio: form.get('ratio'), resolution: form.get('resolution'), prompt: form.get('prompt'), files: [] };
    for (const file of form.getAll('images')) received.files.push({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
    reply(response, 200, { data: [{ url: 'https://example.com/generated.png' }] });
  });
  const result = await setup.provider.submit({ ...imageInput, references: [picture, { ...picture, name: 'second.png' }] });
  assert.deepEqual(result, { resultURL: 'https://example.com/generated.png' });
  assert.equal(received.model, imageInput.model); assert.equal(received.ratio, '16:9'); assert.equal(received.resolution, '2k');
  assert.equal(received.files.length, 2); assert.equal(received.files[0].name, picture.name); assert.deepEqual(received.files[0].bytes, picture.bytes);
  assert.equal(setup.requests.find(request => request.method === 'POST').headers.authorization, `Bearer ${SECRET}`);
});

test('text-only image submission returns base64 without inventing a provider task', async t => {
  const setup = await fixture(t, (_request, response, body) => {
    assert.equal(JSON.parse(body).model, 'jimeng-5.0');
    reply(response, 200, { data: [{ b64_json: 'data:image/png;base64,aGVsbG8=' }] });
  });
  assert.deepEqual(await setup.provider.submit(imageInput), { resultBase64: 'aGVsbG8=', mime: 'image/png' });
});

test('video submissions return a stable task and query that task without resubmitting generation', async t => {
  let queries = 0;
  const setup = await fixture(t, async (request, response, body) => {
    if (request.method === 'POST') {
      assert.equal(request.url, '/v1/videos/generations/async');
      const form = await new Request('http://fixture/', { method: 'POST', headers: { 'Content-Type': request.headers['content-type'] }, body }).formData();
      assert.equal(form.get('duration'), '10'); assert.equal(form.getAll('files').length, 1); assert.equal(form.getAll('images').length, 0);
      return reply(response, 200, { task_id: 'provider-task-1', status: 'processing' });
    }
    assert.equal(request.url, '/v1/videos/generations/async/provider-task-1');
    return reply(response, 200, ++queries === 1 ? { status: 'processing' } : { status: 'succeeded', data: [{ url: 'https://example.com/generated.mp4' }] });
  });
  assert.deepEqual(await setup.provider.submit({ type: 'video', model: 'jimeng-video-3.0', prompt: 'synthetic', duration: 10, references: [picture] }), { providerTaskId: 'provider-task-1' });
  assert.deepEqual(await setup.provider.query('provider-task-1'), { status: 'processing' });
  assert.deepEqual(await setup.provider.query('provider-task-1'), { status: 'succeeded', resultURL: 'https://example.com/generated.mp4' });
  assert.equal(setup.requests.filter(request => request.method === 'POST').length, 1);
});

test('unsupported models, parameter combinations and reference counts fail before HTTP', async t => {
  const setup = await fixture(t);
  for (const input of [
    { ...imageInput, model: 'unknown-model' },
    { ...imageInput, ratio: '6:1' },
    { type: 'video', model: 'seedance-2.0-mini', prompt: 'synthetic', references: [] },
    { type: 'video', model: 'jimeng-video-3.0', prompt: 'synthetic', references: [picture, picture, picture] },
    { ...imageInput, references: [{ ...picture, mime: 'video/mp4' }] },
    { ...imageInput, references: [{ ...picture, bytes: Buffer.alloc(20 * 1024 * 1024 + 1) }] },
  ]) await assert.rejects(setup.provider.submit(input), error => error.code === 'provider_rejected');
  assert.equal(setup.requests.length, 0);
});

test('Pro and Seedance reject two references before any request while basic 3.0 keeps two and images keep ten', async t => {
  const restricted = ['jimeng-video-3.0-pro', 'jimeng-video-3.5-pro', 'jimeng-video-seedance-2.0', 'seedance-2.0',
    'seedance-2.0-pro', 'jimeng-video-seedance-2.0-mini', 'seedance-2.0-mini', 'jimeng-video-seedance-2.0-fast',
    'seedance-2.0-fast', 'jimeng-video-seedance-2.0-fast-vip', 'seedance-2.0-fast-vip', 'jimeng-video-seedance-2.0-vip', 'seedance-2.0-vip'];
  const ids = ['jimeng-5.0', 'jimeng-video-3.0', ...restricted];
  const setup = await fixture(t, (request, response) => {
    if (request.url === '/v1/models') return reply(response, 200, { data: ids.map(id => ({ id })) });
    if (request.url === '/v1/videos/generations/async') return reply(response, 200, { task_id: 'synthetic-basic-dual-frame' });
    return reply(response, 200, { data: [{ url: 'https://generated.example/synthetic.png' }] });
  }, { modelsViaHandler: true });
  const caps = await setup.provider.capabilities();
  for (const model of restricted) {
    assert.equal(caps.models.find(item => item.id === model).maxReferences, 1, model);
    const before = setup.requests.length;
    await assert.rejects(setup.provider.submit({ type: 'video', model, prompt: 'synthetic', references: [picture, picture] }),
      error => error.code === 'provider_rejected' && /1/.test(error.message), model);
    assert.equal(setup.requests.length, before, `${model}: no HTTP before reference preflight`);
  }
  assert.equal(caps.models.find(item => item.id === 'jimeng-video-3.0').maxReferences, 2);
  assert.equal(caps.models.find(item => item.id === 'jimeng-5.0').maxReferences, 10);
  assert.deepEqual(await setup.provider.submit({ type: 'video', model: 'jimeng-video-3.0', prompt: 'synthetic', duration: 5,
    references: [picture, picture] }), { providerTaskId: 'synthetic-basic-dual-frame' });
  assert.deepEqual(await setup.provider.submit({ ...imageInput, references: Array.from({ length: 10 }, () => picture) }),
    { resultURL: 'https://generated.example/synthetic.png' });
  assert.equal(setup.requests.filter(request => request.method === 'POST').length, 2);
});

test('changed provider endpoints fence old submit and query requests before any HTTP', async t => {
  const first = await fixture(t), second = await fixture(t);
  await first.provider.updateSettings({ endpoint: second.endpoint });
  const before = first.requests.length + second.requests.length;
  await assert.rejects(first.provider.submit({ ...imageInput, expectedEndpoint: first.endpoint }), error => error.code === 'provider_configuration_changed');
  await assert.rejects(first.provider.query('old-task', { expectedEndpoint: first.endpoint }), error => error.code === 'provider_configuration_changed');
  assert.equal(first.requests.length + second.requests.length, before);
});

test('explicit refusals and ambiguous POST outcomes stay distinct and disclose no raw provider response', async t => {
  for (const [name, handler, code] of [
    ['unauthorized', (_req, res) => reply(res, 401, { message: `invalid ${SECRET}` }), 'credential_invalid'],
    ['native expired-token code', (_req, res) => reply(res, 200, { code: -2002, message: `Token已失效 ${SECRET}` }), 'credential_invalid'],
    ['native insufficient-credit code', (_req, res) => reply(res, 200, { code: -2009, message: `即梦积分不足 ${SECRET}` }), 'quota_exceeded'],
    ['quota', (_req, res) => reply(res, 200, { code: -2001, message: `积分不足 ${SECRET}` }), 'quota_exceeded'],
    ['rejected', (_req, res) => reply(res, 400, { error: { message: `raw-private-provider-text ${SECRET}` } }), 'provider_rejected'],
    ['ambiguous server error', (_req, res) => reply(res, 500, { message: `internal ${SECRET}` }), 'submission_unknown'],
    ['missing receipt', (_req, res) => reply(res, 200, { data: [] }), 'submission_unknown'],
    ['non JSON', (_req, res) => { res.writeHead(200); res.end('not json'); }, 'submission_unknown'],
    ['disconnected', (_req, res) => res.destroy(), 'submission_unknown'],
    ['timeout', () => {}, 'submission_unknown'],
  ]) await t.test(name, async sub => {
    const setup = await fixture(sub, handler, { mediaSubmitTimeoutMs: 35 });
    await assert.rejects(setup.provider.submit(imageInput), error => {
      assert.equal(error.message.includes(SECRET), false); assert.equal(error.message.includes('raw-private-provider-text'), false);
      return error.code === code;
    });
    assert.equal(setup.requests.filter(request => request.method === 'POST').length, 1);
  });
});

test('query uses its own timeout and reports failure without leaking backend credential echoes', async t => {
  let failed = false;
  const setup = await fixture(t, async (_request, response) => {
    if (failed) return reply(response, 200, { status: 'failed', error: `raw-private-provider-text ${SECRET}` });
    await new Promise(resolve => setTimeout(resolve, 45)); reply(response, 200, { status: 'processing' });
  }, { mediaSubmitTimeoutMs: 10, mediaQueryTimeoutMs: 200 });
  assert.deepEqual(await setup.provider.query('known-task'), { status: 'processing' });
  failed = true;
  const result = await setup.provider.query('known-task');
  assert.equal(result.status, 'failed'); assert.equal(result.error.includes(SECRET), false); assert.equal(result.error.includes('raw-private'), false);
  assert.equal(setup.requests.some(request => request.method === 'POST'), false);
});

test('queries identify permanently missing or expired provider tasks without submitting another generation', async t => {
  for (const [name, status, payload, expected] of [
    ['HTTP 404', 404, null, 'provider_task_missing'],
    ['HTTP 410', 410, { message: 'gone' }, 'provider_task_expired'],
    ['native missing errmsg', 200, { code: -2000, errmsg: `任务ID不存在 ${SECRET}` }, 'provider_task_missing'],
    ['native expired message', 400, { code: -2000, message: `任务ID已过期 ${SECRET}` }, 'provider_task_expired'],
  ]) await t.test(name, async sub => {
    const setup = await fixture(sub, (_request, response) => {
      if (payload === null) { response.writeHead(status); response.end('not JSON'); }
      else reply(response, status, payload);
    });
    await assert.rejects(setup.provider.query('original-task'), error => {
      assert.equal(error.message.includes(SECRET), false); assert.match(error.message, /不会自动重新生成/);
      return error.code === expected;
    });
    assert.deepEqual(setup.requests.map(request => [request.method, request.url]), [['GET', '/v1/videos/generations/async/original-task']]);
  });
});

test('missing task classification is confined to query semantics', async t => {
  const setup = await fixture(t, (_request, response) => reply(response, 404, { code: -2000, message: '任务ID不存在' }));
  await assert.rejects(setup.provider.submit(imageInput), error => error.code === 'provider_rejected');
  const unhealthy = await fixture(t, (_request, response) => reply(response, 404, { code: -2000, errmsg: '任务ID不存在' }), { modelsViaHandler: true });
  const info = await unhealthy.provider.capabilities();
  assert.equal(info.healthy, false); assert.match(info.error, /拒绝本次操作/);
  const unrelated = await fixture(t, (_request, response) => reply(response, 200, { code: -2000, message: '模型ID不存在' }));
  await assert.rejects(unrelated.provider.query('original-task'), error => error.code === 'provider_rejected');
});

test('result downloads follow bounded redirects, send no auth and enforce the actual streaming byte limit', async t => {
  const setup = await fixture(t, (request, response) => {
    assert.equal(request.headers.authorization, undefined);
    if (request.url === '/redirect') { response.writeHead(302, { Location: '/image' }); response.end(); }
    else if (request.url === '/loop') { response.writeHead(302, { Location: '/loop' }); response.end(); }
    else if (request.url === '/declared') { response.writeHead(200, { 'Content-Length': '99' }); response.end('x'); }
    else if (request.url === '/chunked') { response.writeHead(200); response.write('abc'); response.end('def'); }
    else { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(picture.bytes); }
  }, { mediaAllowLocalDownloads: true });
  assert.deepEqual(await setup.provider.download(`${setup.endpoint}/redirect`), { bytes: picture.bytes, mime: 'image/png' });
  await assert.rejects(setup.provider.download(`${setup.endpoint}/loop`), error => error.code === 'download_failed');
  assert.equal(setup.requests.filter(request => request.url === '/loop').length, 4);
  await assert.rejects(setup.provider.download(`${setup.endpoint}/declared`, { maxBytes: 4 }), error => error.code === 'download_too_large');
  await assert.rejects(setup.provider.download(`${setup.endpoint}/chunked`, { maxBytes: 4 }), error => error.code === 'download_too_large');
});

test('default generated-file limit is independent from the 20MiB reference-import limit', async t => {
  const content = Buffer.alloc(21 * 1024 * 1024, 1);
  const setup = await fixture(t, (_request, response) => { response.writeHead(200, { 'Content-Type': 'video/mp4' }); response.end(content); }, { mediaAllowLocalDownloads: true });
  const result = await setup.provider.download(`${setup.endpoint}/generated`);
  assert.equal(result.bytes.length, content.length);
});

test('public result downloads reject local, private, alternate-protocol and credential-bearing URLs before requesting', async t => {
  const setup = await fixture(t);
  for (const url of [`${setup.endpoint}/image`, 'http://localhost/image', 'http://10.0.0.1/image', 'http://169.254.169.254/latest', 'http://[::1]/image', 'http://[::ffff:127.0.0.1]/image', 'file:///private/tmp/file', 'data:image/png;base64,AA==', 'https://user:password@example.com/image']) {
    await assert.rejects(setup.provider.download(url), error => ['download_url_blocked', 'download_url_invalid'].includes(error.code));
  }
  assert.equal(setup.requests.length, 0);
});
