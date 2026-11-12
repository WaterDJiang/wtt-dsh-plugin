import test from 'node:test';
import assert from 'node:assert/strict';
import z from '@deepseek-ai/schemastery';
import { Config } from '../src/media-service-config.mjs';
import { createMediaServiceAccess } from '../src/media-service-host.mjs';
import { createMediaSettingsOperations } from '../src/media-service-operations.mjs';
import { configuredCredentialReferences, mediaCredentialRef, mediaServiceProfile } from '../src/media-service-settings.mjs';

const id = 'example';
const ownRef = mediaCredentialRef(id);
const profile = { displayName: '图片服务', baseURL: 'https://api.example.test/v1', type: 'image', model: 'gpt-image-1.5', protocol: 'openai-image', apiKeyEnv: ownRef };
function fixture() {
  let revision = 7;
  let values = { unrelated: { keep: true }, mediaServices: {} };
  const calls = [];
  const secrets = new Map();
  const schema = { rehydrate: value => new z(value), nodeAtPath(root, path) { for (const key of path) root = root.type === 'object' ? root.dict[key] : root.inner; return root; }, getPath(root, path) { for (const key of path) root = root?.[key]; return root; } };
  let namespaces = [];
  const ctx = { configForms: { get: () => ({ getSnapshot: () => ({ status: 'ready', writable: true, revision, value: values }) }), describe: () => ({ getSnapshot: () => ({ view: { namespaces } }), ensure: async () => {}, acceptView(view) { revision = view.revision; values = view.value; update(); } }) }, settingsSchema: schema,
    remote: { $on() { return () => {}; }, credentials: {
      async describe(refs) { calls.push(['describe', refs]); return { ok: true, value: Object.fromEntries(refs.map(ref => [ref, { configured: secrets.has(ref), writable: true }])) }; },
      async set(ref, value) { calls.push(['set', ref]); secrets.set(ref, value); return { ok: true }; },
      async unset(ref) { calls.push(['unset', ref]); secrets.delete(ref); return { ok: true }; },
    }, settings: { async mutate(ns, ops, expectedRevision) {
      calls.push(['mutate', ns, ops, expectedRevision]);
      if (expectedRevision !== revision) return { ok: false, error: { code: 'settings/conflict', message: '设置版本冲突' } };
      for (const op of ops) if (op.op === 'set') values.mediaServices[op.path[1]] = op.value; else delete values.mediaServices[op.path[1]];
      return { ok: true, value: { ns, value: values, revision: revision + 1 } };
    } } } };
  function update() { namespaces = [{ ns: 'wtt-creation-workbench', schema: Config.toJSON(), value: values }]; }
  update();
  return { ctx, calls, secrets, operations: createMediaSettingsOperations(ctx), current: () => values, revision: () => revision,
    addNamespace(namespace) { namespaces.push(namespace); }, bump() { revision++; } };
}

test('media settings store secrets only through DSH credentials, write one path with a revision and preserve unrelated config', async () => {
  const setup = fixture();
  let cleared = false;
  await setup.operations.save(id, profile, { apiKey: 'synthetic-key', expectedRevision: 7, onCredentialStored() { cleared = true; } });
  assert.equal(cleared, true);
  assert.equal(setup.secrets.get(ownRef), 'synthetic-key');
  assert.deepEqual(setup.current().unrelated, { keep: true });
  assert.equal(JSON.stringify(setup.current()).includes('synthetic-key'), false);
  const write = setup.calls.find(call => call[0] === 'mutate');
  assert.deepEqual(write.slice(1), ['wtt-creation-workbench', [{ op: 'set', path: ['mediaServices', id], value: profile }], 7]);
  await setup.operations.save(id, { ...profile, displayName: '新名称' }, { expectedRevision: setup.revision() });
  assert.equal(setup.calls.filter(call => call[0] === 'set').length, 1, '空输入保留既有 Key');
  await setup.operations.remove(id, setup.revision());
  assert.equal(setup.current().mediaServices[id], undefined);
  assert.equal(setup.secrets.get(ownRef), 'synthetic-key', '移除配置不删除凭据');
});

test('stale settings never store a new secret; a later config refusal reports the already stored credential without echo', async () => {
  const setup = fixture(); setup.bump();
  await assert.rejects(setup.operations.save(id, profile, { apiKey: 'synthetic', expectedRevision: 7 }), /其他窗口/);
  assert.equal(setup.calls.length, 0);
  setup.ctx.remote.settings.mutate = async () => ({ ok: false, error: { message: 'synthetic-key 被拒绝' } });
  await assert.rejects(setup.operations.save(id, profile, { apiKey: 'synthetic-key', expectedRevision: 8 }), error => /API Key 已存入 DSH/.test(error.message) && !error.message.includes('synthetic-key'));
  assert.equal(setup.secrets.get(ownRef), 'synthetic-key');
});

test('shared references are schema discovered, cannot be overwritten or cleared, and dedicated clearing respects other consumers', async () => {
  const setup = fixture();
  const sharedSchema = z.object({ providers: z.dict(z.object({ apiKeyEnv: z.string().role('credential-ref'), baseURL: z.string() })) });
  setup.addNamespace({ ns: 'llm-pi-ai', schema: sharedSchema.toJSON(), value: { providers: { custom: { apiKeyEnv: 'SHARED_KEY', baseURL: 'https://api.shared.test/v1' } } } });
  assert.equal(setup.operations.references().has('SHARED_KEY'), true);
  assert.equal(setup.operations.connections()[0].baseURL, 'https://api.shared.test/v1');
  const shared = { ...profile, apiKeyEnv: 'SHARED_KEY', connection: { namespace: 'llm-pi-ai', path: ['providers', 'custom'] } };
  await assert.rejects(setup.operations.save(id, shared, { apiKey: 'must-not-store', expectedRevision: 7 }), /已有凭据只能引用/);
  await setup.operations.save(id, shared, { expectedRevision: 7 });
  await assert.rejects(setup.operations.clearCredential(id), /不能.*共享凭据/);
  assert.equal(setup.calls.filter(call => ['set', 'unset'].includes(call[0])).length, 0);
  await setup.operations.save(id, profile, { apiKey: 'synthetic', expectedRevision: setup.revision() });
  setup.addNamespace({ ns: 'other', schema: z.object({ apiKeyEnv: z.string().role('credential-ref') }).toJSON(), value: { apiKeyEnv: ownRef } });
  await assert.rejects(setup.operations.clearCredential(id), /其他配置引用/);
});

test('Host resolves current DSH credentials per operation, follows linked URL/ref and fences changed task configuration', async () => {
  let secret = 'first', source = { baseURL: profile.baseURL, apiKeyEnv: 'SHARED_KEY' }, resolutions = 0;
  const config = { mediaServices: { [id]: { ...profile, connection: { namespace: 'existing', path: ['provider'] } } } };
  const access = createMediaServiceAccess({ credentials: { describe: async () => ({ configured: true, writable: true }), resolve: async () => { resolutions++; return { value: secret }; } }, settings: { describe: () => [{ ns: 'existing', value: { provider: source } }] } }, config);
  assert.equal((await access.describe(id)).configured, true); assert.equal(resolutions, 0);
  const frozen = access.get(id);
  assert.equal(frozen.apiKeyEnv, 'SHARED_KEY');
  assert.equal(await access.resolve(id, frozen), 'first');
  secret = 'rotated'; assert.equal(await access.resolve(id, frozen), 'rotated');
  source = { baseURL: 'https://different.test', apiKeyEnv: 'SHARED_KEY' };
  assert.equal(access.get(id).baseURL, source.baseURL);
  await assert.rejects(access.resolve(id, frozen), error => error.code === 'provider_configuration_changed');
});

test('profile validation rejects inline secrets and invalid endpoints, while Config preserves unrelated plugin options', () => {
  for (const field of ['apiKey', 'headers', 'password']) assert.throws(() => mediaServiceProfile(id, { ...profile, [field]: 'synthetic' }), /DSH 凭据/);
  const embeddedCredentials = new URL('https://api.test');
  embeddedCredentials.username = 'synthetic-user';
  embeddedCredentials.password = 'synthetic-password';
  for (const baseURL of ['http://external.test', embeddedCredentials.href, 'https://api.test?key=synthetic']) assert.throws(() => mediaServiceProfile(id, { ...profile, baseURL }), /HTTPS|凭据/);
  const parsed = Config({ workspaceRoot: '/project', mediaServices: { [id]: profile } });
  assert.equal(parsed.workspaceRoot, '/project');
  assert.equal(parsed.mediaServices.get()[id].apiKeyEnv, ownRef);
  assert.deepEqual(configuredCredentialReferences([], {}).size, 0);
});

// A real local listing exercises the same transport as the Host without a paid model call.
async function listingServer(handler, work) {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await work(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('media discovery reads a draft before saving, uses stored credentials, deduplicates and returns only candidate metadata', async () => {
  const { discoverMediaModels } = await import('../src/media-model-discovery.mjs');
  let calls = 0;
  await listingServer((request, response) => {
    calls++; assert.equal(request.method, 'GET'); assert.equal(request.url, '/v1/models');
    assert.equal(request.headers.authorization, 'Bearer synthetic-listing-key');
    response.end(JSON.stringify({ data: [{ id: 'custom-image', display_name: '自定义图像', apiKey: 'do-not-return' }, { id: 'custom-image' }, { id: 'custom-video' }, { id: 'synthetic-listing-key' }, {}] }));
  }, async baseURL => {
    const access = createMediaServiceAccess({ credentials: { resolve: async () => ({ value: 'synthetic-listing-key' }) } }, { mediaServices: {} });
    const result = await discoverMediaModels(access, { id, profile: { ...profile, baseURL: baseURL + '/v1', model: '', displayName: '' } });
    assert.deepEqual(result, { models: [{ id: 'custom-image', name: '自定义图像' }, { id: 'custom-video' }] });
    assert.deepEqual(access.profiles(), {});
    assert.equal(calls, 1);
  });
});

test('media discovery follows Host connection URL and key, rejects shared key writes and late connection changes', async () => {
  const { discoverMediaModels } = await import('../src/media-model-discovery.mjs');
  await listingServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer shared-secret'); response.end('{"data":[{"id":"shared-model"}]}');
  }, async baseURL => {
    let source = { baseURL, apiKeyEnv: 'SHARED_KEY' };
    const ctx = { settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { existing: source } } }] }, credentials: { resolve: async ref => { assert.equal(ref, 'SHARED_KEY'); return { value: 'shared-secret' }; } } };
    const access = createMediaServiceAccess(ctx, { mediaServices: {} });
    const linked = { ...profile, baseURL: 'https://stale.invalid/v1', connection: { namespace: 'llm-pi-ai', path: ['providers', 'existing'] } };
    assert.deepEqual((await discoverMediaModels(access, { id, profile: linked })).models, [{ id: 'shared-model' }]);
    await assert.rejects(discoverMediaModels(access, { id, profile: linked, apiKey: 'must-not-write' }), /已有凭据只能引用/);
    ctx.credentials.resolve = async () => { source = { ...source, baseURL: 'https://changed.invalid' }; return { value: 'shared-secret' }; };
    await assert.rejects(discoverMediaModels(access, { id, profile: linked }), /连接.*已变化/);
  });
});

test('media discovery refuses redirects, HTTP errors and malformed listings without leaking upstream keys', async () => {
  const { discoverMediaModels } = await import('../src/media-model-discovery.mjs');
  let status = 302, body = 'synthetic-listing-key';
  await listingServer((_request, response) => {
    response.statusCode = status; response.setHeader('Location', 'https://should-not-follow.invalid/models'); response.end(body);
  }, async baseURL => {
    const access = createMediaServiceAccess({}, { mediaServices: {} });
    const probe = () => discoverMediaModels(access, { id, profile: { ...profile, baseURL }, apiKey: 'synthetic-listing-key' });
    await assert.rejects(probe(), /HTTP 302/);
    status = 401; await assert.rejects(probe(), error => /HTTP 401/.test(error.message) && !error.message.includes('synthetic-listing-key'));
    status = 200; await assert.rejects(probe(), /JSON/);
    body = '{}'; await assert.rejects(probe(), /未提供.*模型列表/);
  });
});

test('Gemini model discovery uses Google headers, strips resource prefixes and follows bounded pagination', async () => {
  const { discoverMediaModels } = await import('../src/media-model-discovery.mjs');
  let requests = 0;
  await listingServer((request, response) => {
    requests++; assert.equal(request.headers['x-goog-api-key'], 'google-synthetic'); assert.equal(request.headers.authorization, undefined);
    const url = new URL(request.url, 'http://localhost');
    assert.equal(url.pathname, '/v1beta/models');
    response.end(JSON.stringify(url.searchParams.has('pageToken') ? { models: [{ name: 'models/custom-video' }] } : { models: [{ name: 'models/custom-image', displayName: '图像' }], nextPageToken: 'next' }));
  }, async baseURL => {
    const access = createMediaServiceAccess({}, { mediaServices: {} });
    assert.deepEqual((await discoverMediaModels(access, { id, profile: { ...profile, protocol: 'gemini-image', baseURL: baseURL + '/v1beta' }, apiKey: 'google-synthetic' })).models, [{ id: 'custom-image', name: '图像' }, { id: 'custom-video' }]);
    assert.equal(requests, 2);
  });
});
