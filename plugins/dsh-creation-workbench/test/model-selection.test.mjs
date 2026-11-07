import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelCatalog, normalizeModelSelection, openNativeModelSettings } from '../src/model-selection.mjs';

test('task model snapshots retain identifiers without credentials or endpoint settings', () => {
  const source = { provider: ' local-route ', model: ' vendor/text ', reasoningEffort: ' high ', apiKey: 'not-a-real-key', baseURL: 'https://example.invalid/v1' };
  const result = normalizeModelSelection(source);
  assert.deepEqual(result, { provider: 'local-route', model: 'vendor/text', reasoningEffort: 'high' });
  source.model = 'other-model';
  assert.equal(result.model, 'vendor/text');
  assert.equal(JSON.stringify(result).includes('not-a-real-key'), false);
  assert.equal(JSON.stringify(result).includes('example.invalid'), false);
});

test('legacy callers can omit a selection while invalid explicit identifiers are rejected', () => {
  assert.equal(normalizeModelSelection(), null);
  assert.equal(normalizeModelSelection(null), null);
  for (const value of [{ provider: 'a', model: 'b', reasoningEffort: '' }, { provider: 'a', model: 'b', reasoningEffort: ' ' }]) {
    assert.deepEqual(normalizeModelSelection(value), { provider: 'a', model: 'b' });
  }
  for (const value of ['', [], {}, { provider: ' ', model: 'b' }, { provider: 'a', model: 'b\n' },
    { provider: 'a', model: 3 }, { provider: 'a', model: 'b', reasoningEffort: 3 }, { provider: 'a', model: 'b'.repeat(257) }]) {
    assert.throws(() => normalizeModelSelection(value), /模型选择/);
  }
});

test('catalog preserves routable groups, defaults and isolated failures without provider config', () => {
  const raw = {
    default: { provider: 'anthropic', model: 'example-model', secret: 'not-a-real-key' },
    routableProviders: ['anthropic', 'anthropic', 'empty', 'not-configured'],
    groups: [
      { id: 'anthropic', name: 'Claude', apiKey: 'not-a-real-key', models: [{ id: 'example-model', name: 'Example', baseURL: 'https://example.invalid', reasoning: {
        efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high',
      } }] },
      { id: 'empty', models: [] },
      { id: 'dormant', models: [{ id: 'disabled' }] },
    ],
    failures: [{ id: 'broken', name: '另一提供商', message: '目录读取失败' }],
  };
  const result = normalizeModelCatalog(raw);
  assert.deepEqual(result.routableProviders, ['anthropic']);
  assert.deepEqual(result.default, { provider: 'anthropic', model: 'example-model' });
  assert.deepEqual(result.groups[0].models[0].reasoning, { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' });
  assert.deepEqual(result.failures, [{ id: 'broken', name: '另一提供商', message: '目录读取失败' }]);
  assert.equal(result.groups.length, 1);
  assert.equal(JSON.stringify(result).includes('not-a-real-key'), false);
  assert.equal(JSON.stringify(result).includes('example.invalid'), false);
  assert.deepEqual(normalizeModelCatalog(result), result);
});

test('a stale default is retained for explicit diagnosis rather than replaced with another provider', () => {
  const result = normalizeModelCatalog({ default: { provider: 'removed', model: 'original' }, routableProviders: ['current'],
    groups: [{ id: 'current', models: [{ id: 'other' }] }], failures: [] });
  assert.deepEqual(result.default, { provider: 'removed', model: 'original' });
  assert.equal(result.groups[0].id, 'current');
});

test('malformed individual groups remain visible failures and cannot hide healthy providers', () => {
  const result = normalizeModelCatalog({ routableProviders: ['good', 'broken'], groups: [
    { id: 'broken', name: '坏目录', models: [{ id: '' }] }, { id: 'good', models: [{ id: 'fine' }] },
  ] });
  assert.deepEqual(result.routableProviders, ['good']);
  assert.equal(result.failures[0].name, '坏目录');
  assert.match(result.failures[0].message, /模型选择/);
  for (const value of [null, {}, { groups: [] }, { routableProviders: [] }]) {
    assert.throws(() => normalizeModelCatalog(value), /目录格式无效/);
  }
});

test('model settings opens only the actual single-slot winner even with minified registrant names', () => {
  const calls = [];
  const shared = { actions: { openSection: id => calls.push(['open', id]) } };
  const official = { options: {}, registrant: 'Gb', store: { create: () => { calls.push(['winner-store']); return shared; } } };
  const other = { options: {}, registrant: 'another-plugin', store: { create: () => { throw new Error('must not create foreign stores'); } } };
  const ctx = { slots: { entriesOfSlot: name => {
    calls.push(['lookup', name]);
    return name === 'sidebar.settings' ? [official] : [{ options: { id: 'models' }, registrant: 'Xa' }];
  }, entries() { return [other, official]; } } };
  Object.defineProperty(ctx, 'credentials', { get() { throw new Error('must not access credentials'); } });
  Object.defineProperty(ctx, 'remote', { get() { throw new Error('must not read configuration or send Remote writes'); } });
  openNativeModelSettings(ctx);
  assert.deepEqual(calls, [['lookup', 'sidebar.settings'], ['lookup', 'settings.section'], ['winner-store'], ['open', 'models']]);
});

test('unavailable or ambiguous model settings surfaces fail without iterating candidate stores', () => {
  for (const ctx of [undefined, {}, { slots: {} }, { slots: { entriesOfSlot: () => null } },
    { slots: { entriesOfSlot: name => name === 'sidebar.settings' ? [] : [{ options: { id: 'models' } }] } },
    { slots: { entriesOfSlot: name => name === 'sidebar.settings' ? [1, 2].map(() => ({ store: { create() { assert.fail('ambiguous candidate instantiated'); } } })) : [{ options: { id: 'models' } }] } },
    { slots: { entriesOfSlot: name => name === 'sidebar.settings' ? [{}] : [{ options: { id: 'models' } }] } },
    { slots: { entriesOfSlot: name => name === 'sidebar.settings' ? [{ registrant: '@deepseek-ai/dsh-client-ui-settings-general', store: { create() { assert.fail('no model page exists'); } } }] : [] } },
    { slots: { entriesOfSlot: name => name === 'sidebar.settings' ? [{ registrant: '@deepseek-ai/dsh-client-ui-settings-general', store: { create: () => ({ actions: {} }) } }] : [{ options: { id: 'models' }, registrant: '@deepseek-ai/dsh-client-ui-settings-models' }] } },
  ]) assert.throws(() => openNativeModelSettings(ctx), /未提供模型设置入口/);
});

test('settings diagnostics follow StoredEntry options and never expose store values', () => {
  const foreign = { options: { id: 'foreign-settings' }, registrant: 'replacement-plugin', store: { sensitive: 'not-a-real-key', create: () => ({ actions: {} }) } };
  const ctx = { slots: { entriesOfSlot: name => name === 'sidebar.settings' ? [foreign] : [{ options: { id: 'models' }, registrant: '@deepseek-ai/dsh-client-ui-settings-models' }] } };
  assert.throws(() => openNativeModelSettings(ctx), error => {
    assert.match(error.message, /replacement-plugin/);
    assert.deepEqual(error.slotMetadata, { shells: [{ id: 'foreign-settings', registrant: 'replacement-plugin' }], sections: [{ id: 'models', registrant: '@deepseek-ai/dsh-client-ui-settings-models' }] });
    assert.equal(JSON.stringify(error).includes('not-a-real-key'), false);
    return true;
  });
  ctx.slots.entriesOfSlot = name => name === 'sidebar.settings'
    ? [{ options: {}, registrant: '@deepseek-ai/dsh-client-ui-settings-general', store: { create() { assert.fail('flat id is not the StoredEntry contract'); } } }]
    : [{ id: 'models', options: {}, registrant: '@deepseek-ai/dsh-client-ui-settings-models' }];
  assert.throws(() => openNativeModelSettings(ctx), /未提供模型设置入口/);
});

test('a compatible replacement shell can serve the same public model settings action', () => {
  const calls = [];
  const ctx = { slots: { entriesOfSlot: name => name === 'sidebar.settings'
    ? [{ options: {}, store: { create: () => ({ actions: { openSection: id => calls.push(id) } }) } }]
    : [{ options: { id: 'models' } }] } };
  openNativeModelSettings(ctx);
  assert.deepEqual(calls, ['models']);
});
