import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { MEDIA_PROTOCOLS, mediaModelDefinition, mediaDefaults } from '../src/media-api-catalog.mjs';
import { createOfficialMediaProvider } from '../src/media-api-providers.mjs';
import { mediaServiceProfile } from '../src/media-service-settings.mjs';

const SECRET = 'synthetic-media-api-key';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
async function fixture(t, protocol) {
  const preset = MEDIA_PROTOCOLS[protocol], requests = [];
  let mode = 'success', resolves = 0, secret = SECRET;
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text.startsWith('{') ? JSON.parse(text) : text;
    requests.push({ url: request.url, method: request.method, headers: request.headers, body });
    if (mode === 'disconnect' && request.method === 'POST') { request.socket.destroy(); return; }
    response.setHeader('Content-Type', 'application/json');
    const reply = payload => response.end(JSON.stringify(payload));
    const resultURL = `http://127.0.0.1:${server.address().port}/result`;
    if (mode.startsWith('redirect') && /\/videos\/task\/content$/.test(request.url)) { response.statusCode = 302; response.setHeader('Location', mode === 'redirect-private' ? resultURL.replace('127.0.0.1', '127.0.0.2') : resultURL); response.end(); return; }
    if (request.url === '/redirect-private') { response.statusCode = 302; response.setHeader('Location', resultURL.replace('127.0.0.1', '127.0.0.2')); response.end(); return; }
    if (request.url === '/result' || /\/videos\/task\/content$/.test(request.url)) { response.setHeader('Content-Type', preset.type === 'image' ? 'image/png' : 'video/mp4'); response.end(png); return; }
    if (mode === 'unauthorized') { response.statusCode = 401; reply({ error: { message: `invalid Bearer ${secret}` } }); return; }
    if (request.method === 'POST') {
      if (protocol === 'jimeng-image') reply({ data: [{ url: resultURL }] });
      else if (protocol === 'openai-image' || protocol === 'volc-image') reply({ data: [{ b64_json: png.toString('base64') }] });
      else if (protocol.startsWith('gemini-')) reply(mode === 'async' ? { id: 'task', status: 'in_progress' } : { status: 'completed', steps: [{ type: 'thought', content: [{ type: preset.type, data: 'must-skip-thought' }] }, { type: 'model_output', content: [{ type: preset.type, data: png.toString('base64') }] }] });
      else if (protocol === 'minimax-image') reply({ data: { image_urls: [resultURL] }, base_resp: { status_code: 0 } });
      else if (protocol === 'wan-image') reply({ output: { choices: [{ message: { content: [{ image: resultURL }] } }] } });
      else if (protocol === 'kling-image') reply({ code: 0, data: { task_id: 'task', task_status: 'submitted' } });
      else if (protocol === 'kling-video') reply({ code: 0, data: { id: 'task', status: 'submitted' } });
      else if (protocol === 'minimax-video') reply({ task_id: 'task', base_resp: { status_code: 0 } });
      else if (protocol === 'wan-video') reply({ output: { task_id: 'task', task_status: 'PENDING' } });
      else reply({ id: 'task', status: 'queued' });
    } else if (protocol === 'openai-video') reply({ id: 'task', status: 'completed' });
    else if (protocol === 'volc-video') reply({ id: 'task', status: 'succeeded', content: { video_url: resultURL } });
    else if (protocol === 'kling-image') reply({ code: 0, data: { task_status: 'succeed', task_result: { images: [{ url: resultURL }] } } });
    else if (protocol === 'kling-video') reply({ code: 0, data: [{ id: 'task', status: 'succeeded', outputs: [{ type: 'video', url: resultURL }] }] });
    else if (protocol === 'minimax-video') reply(request.url.startsWith('/v1/files/') ? { file: { download_url: resultURL } } : request.url.startsWith('/v1/query/') ? { status: 'Success', file_id: 'file' } : { task: { id:'task', status:'succeeded', content:{url:resultURL} } });
    else if (protocol.startsWith('gemini-')) reply({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: preset.type, data: png.toString('base64') }] }] });
    else if (protocol === 'wan-video') reply({ output: { task_status: 'SUCCEEDED', video_url: resultURL } });
    else reply({});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const profile = { displayName: preset.label, baseURL: `http://127.0.0.1:${server.address().port}`, protocol, type: preset.type, model: preset.models[0], apiKeyEnv: 'SYNTHETIC' };
  const access = { profiles: () => ({ configured: profile }), get: () => mediaServiceProfile('configured', profile), describe: async () => ({ configured: true, writable: true }), resolve: async () => { resolves++; return secret; } };
  const provider = createOfficialMediaProvider('configured', access, { mediaApiTimeoutMs: 1000 });
  t.after(async () => { provider.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { provider, profile, requests, resolves: () => resolves, setMode(value) { mode = value; }, setKey(value) { secret = value; } };
}

for (const protocol of Object.keys(MEDIA_PROTOCOLS)) test(`${protocol}: real HTTP request schema, credential headers, result recovery and unauthenticated CDN download`, async t => {
  const setup = await fixture(t, protocol), caps = await setup.provider.capabilities();
  assert.equal(setup.resolves(), 0, '能力目录不能解析真实 Key');
  assert.ok(!JSON.stringify(caps).includes(SECRET));
  const parameters = mediaDefaults(mediaModelDefinition(setup.profile));
  const result = await setup.provider.submit({ type: setup.profile.type, ...parameters, prompt: '合成协议验收', references: [], expectedEndpoint: setup.profile.baseURL });
  const request = setup.requests[0];
  assert.equal(request.headers[protocol.startsWith('gemini-') ? 'x-goog-api-key' : 'authorization'], protocol.startsWith('gemini-') ? SECRET : `Bearer ${SECRET}`);
  if (protocol === 'openai-image') { assert.equal(request.url, '/images/generations'); assert.equal(request.body.quality, 'auto'); assert.equal(request.body.size, '1024x1024'); assert.equal(request.body.response_format, undefined); }
  if (protocol === 'openai-video') { assert.equal(request.url, '/videos'); assert.match(request.headers['content-type'], /multipart/); assert.match(request.body, /name="seconds"/); }
  if (protocol.startsWith('gemini-')) { assert.equal(request.url, '/interactions'); assert.equal(request.headers['api-revision'], '2026-05-20'); assert.equal(request.body.response_format.type, setup.profile.type); }
  if (protocol === 'volc-video') { assert.equal(request.url, '/contents/generations/tasks'); assert.equal(request.body.content[0].type, 'text'); assert.equal(request.body.ratio, '1:1'); }
  if (protocol === 'kling-video') { assert.equal(request.url, '/text-to-video/kling-3.0'); assert.equal(request.body.settings.multi_shot, false); assert.equal(request.body.settings.audio, 'off'); }
  if (protocol === 'minimax-image') { assert.equal(request.body.width, 1024); assert.equal(request.body.height, 1024); assert.equal(request.body.aspect_ratio, undefined); }
  if (protocol === 'wan-image') { assert.equal(request.body.input.messages[0].content[0].text, '合成协议验收'); assert.equal(request.body.parameters.size, '1280*1280'); }
  if (protocol === 'wan-video') { assert.equal(request.headers['x-dashscope-async'], 'enable'); assert.equal(request.body.parameters.size, '1280*720'); }
  if (protocol === 'jimeng-image') { assert.equal(request.body.ratio, '1:1'); assert.equal(request.body.resolution, '2k'); assert.equal(request.body.size, undefined); }
  let final = result;
  if (result.providerTaskId) { final = await setup.provider.query(result.providerTaskId, { expectedEndpoint: setup.profile.baseURL }); assert.equal(final.status, 'succeeded'); }
  if (final.resultURL) {
    const bytes = await setup.provider.download(final.resultURL, { maxBytes: 10000 }); assert.deepEqual(bytes.bytes, png);
    const download = setup.requests.at(-1);
    assert.equal(download.headers.authorization, protocol === 'openai-video' ? `Bearer ${SECRET}` : undefined);
  } else assert.deepEqual(Buffer.from(final.resultBase64, 'base64'), png);
  if (protocol === 'kling-video') assert.equal(setup.requests[1].url, '/tasks?task_ids=task');
  if (protocol === 'minimax-video') { assert.equal(setup.requests[0].url, '/v2/video_generation'); assert.equal(setup.requests[0].body.content[0].type, 'text'); assert.equal(setup.requests[1].url, '/v2/query/video_generation/task'); }
  assert.equal(setup.requests.filter(item => item.method === 'POST').length, 1);
});

test('Jimeng proxy full endpoint submits once without duplicate paths or official size fields, including real reference bytes', async t => {
  const setup = await fixture(t, 'jimeng-image'); setup.profile.baseURL += '/v1/images/generations';
  const caps = await setup.provider.capabilities();
  const input = { type: 'image', ...mediaDefaults(mediaModelDefinition(setup.profile)), prompt: '合成', references: [], expectedEndpoint: caps.endpoint };
  await setup.provider.submit(input);
  assert.equal(setup.requests[0].url, '/v1/images/generations');
  assert.equal(setup.requests[0].body.model, 'jimeng-5.0');
  assert.equal(setup.requests[0].body.size, undefined);
  await setup.provider.submit({ ...input, references: [{ bytes: png, mime: 'image/png', name: 'reference.png' }] });
  assert.match(setup.requests[1].headers['content-type'], /multipart/);
  assert.match(setup.requests[1].body, /name="images"/);
  assert.match(setup.requests[1].body, /name="resolution"/);
  assert.doesNotMatch(setup.requests[1].body, /name="size"/);
});

test('local result downloads trust only the configured API origin and never forward credentials', async t => {
  const setup = await fixture(t, 'jimeng-image');
  const result = await setup.provider.download(setup.profile.baseURL + '/result', { maxBytes: 10000 });
  assert.deepEqual(result.bytes, png);
  assert.equal(setup.requests[0].headers.authorization, undefined);
  await assert.rejects(setup.provider.download(setup.profile.baseURL.replace('127.0.0.1', '127.0.0.2') + '/result'), error => error.code === 'download_url_blocked');
  await assert.rejects(setup.provider.download(setup.profile.baseURL + '/redirect-private'), error => error.code === 'download_url_blocked');
  const original = setup.profile.baseURL; setup.profile.baseURL = 'https://external.test/v1';
  await assert.rejects(setup.provider.download(original + '/result'), error => error.code === 'download_url_blocked');
});

test('protected video content redirects allow configured local origin without forwarding its key', async t => {
  const setup = await fixture(t, 'openai-video'); setup.setMode('redirect');
  const result = await setup.provider.download(setup.profile.baseURL + '/videos/task/content');
  assert.deepEqual(result.bytes, png);
  assert.equal(setup.requests[0].headers.authorization, `Bearer ${SECRET}`);
  assert.equal(setup.requests[1].headers.authorization, undefined);
  setup.setMode('redirect-private');
  await assert.rejects(setup.provider.download(setup.profile.baseURL + '/videos/task/content'), error => error.code === 'download_url_blocked');
  assert.equal(setup.requests.length, 3);
});

test('API errors redact keys, ambiguous POST stays unknown, invalid parameter combinations fail before a request', async t => {
  const setup = await fixture(t, 'openai-image'), parameters = mediaDefaults(mediaModelDefinition(setup.profile));
  const input = { type: 'image', ...parameters, prompt: 'synthetic', references: [] };
  setup.setMode('unauthorized');
  await assert.rejects(setup.provider.submit(input), error => error.code === 'credential_invalid' && !error.message.includes(SECRET));
  setup.setMode('disconnect');
  await assert.rejects(setup.provider.submit(input), error => error.code === 'submission_unknown');
  const before = setup.requests.length;
  await assert.rejects(setup.provider.submit({ ...input, duration: 5 }), /不支持该参数/);
  await assert.rejects(setup.provider.submit({ ...input, size: 'invalid' }), /尺寸/);
  await assert.rejects(setup.provider.submit({ ...input, expectedEndpoint: 'https://changed.test' }), error => error.code === 'provider_configuration_changed');
  assert.equal(setup.requests.length, before);
});

test('Gemini asynchronous results resume by id without a second submission and resolve rotated credentials', async t => {
  const setup = await fixture(t, 'gemini-image'); setup.setMode('async');
  const result = await setup.provider.submit({ type: 'image', ...mediaDefaults(mediaModelDefinition(setup.profile)), prompt: '合成', references: [] });
  assert.equal(result.providerTaskId, 'task');
  setup.setKey('rotated-synthetic-key');
  const recovered = await setup.provider.query(result.providerTaskId);
  assert.equal(recovered.status, 'succeeded');
  assert.deepEqual(Buffer.from(recovered.resultBase64, 'base64'), png);
  assert.equal(setup.requests[1].headers['x-goog-api-key'], 'rotated-synthetic-key');
  assert.equal(setup.requests.filter(request => request.method === 'POST').length, 1);
});

test('MiniMax legacy Hailuo uses v1 create, query and file retrieval while H3 references require explicit adaptive ratio', async t => {
  const setup = await fixture(t, 'minimax-video'); setup.profile.model = 'MiniMax-Hailuo-2.3';
  const result = await setup.provider.submit({ type: 'video', ...mediaDefaults(mediaModelDefinition(setup.profile)), prompt: '合成', references: [] });
  const recovered = await setup.provider.query(result.providerTaskId);
  assert.equal(recovered.status, 'succeeded');
  assert.deepEqual(setup.requests.map(request => request.url), ['/v1/video_generation', '/v1/query/video_generation?task_id=task', '/v1/files/retrieve?file_id=file']);
  setup.profile.model = 'MiniMax-H3';
  const parameters = mediaDefaults(mediaModelDefinition(setup.profile));
  const input = { type: 'video', ...parameters, prompt: '合成', references: [{ bytes: png, mime: 'image/png', name: 'reference.png' }] };
  await assert.rejects(setup.provider.submit(input), /adaptive/);
  assert.equal(setup.requests.length, 3);
  await setup.provider.submit({ ...input, ratio: 'adaptive' });
  assert.equal(setup.requests.at(-1).body.content[1].role, 'first_frame');
  assert.match(setup.requests.at(-1).body.content[1].image_url.url, /^data:image\/png;base64,/);
});
