import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

test('distributed DSH factory activates and disposes its styles with the plugin', async () => {
  const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');
  let moduleEntry;
  const styles = new Set();
  const document = {
    // ProseMirror checks browser capabilities when the plugin factory loads.
    documentElement: { style: {} },
    createElement: () => ({ textContent: '', remove() { styles.delete(this); } }),
    head: { append: (element) => styles.add(element) },
  };
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: (entry) => { moduleEntry = entry; } } }, document });
  assert.equal(moduleEntry.id, '@wtt/dsh-creation-workbench');
  const localRequire = createRequire(import.meta.url);
  const plugin = moduleEntry.factory(name => name === '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'
    ? { apply() {} } : localRequire(name));
  const disposers = [], registrations = [], sources = new Set();
  const ctx = {
    effect: (apply) => { disposers.push(apply()); },
    inputTriggers: { registerSource: source => { sources.add(source); return () => sources.delete(source); } },
    slots: { inject: (_key, apply) => apply(), register: (options, component) => { registrations.push({ options, component }); return () => {}; } },
  };
  plugin.apply(ctx);
  assert.equal(styles.size, 1);
  assert.equal(sources.size, 1);
  assert.equal([...sources][0].name, 'wtt-course-native-editor');
  assert.equal(plugin.inject.includes('inputTriggers'), true);
  assert.equal(plugin.inject.includes('conversation'), false);
  assert.equal(registrations.find(r => r.options.name === 'conversation.input.dock').options.id, 'wtt-course-edit-reference');
  assert.match([...styles][0].textContent, /\.wtt-course-workbench/);
  assert.equal(registrations.find((r) => r.options.name === 'main').options.key, 'wtt-creation-workbench');
  assert.equal(registrations.find((r) => r.options.name === 'sidebar.panellist').options.id, 'wtt-creation-workbench');
  for (const dispose of disposers) dispose?.();
  assert.equal(styles.size, 0);
  assert.equal(sources.size, 0);
});
