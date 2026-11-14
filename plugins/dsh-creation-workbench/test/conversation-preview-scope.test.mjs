import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationPreviewSlot as local, registerConversationPreviewScope } from '../src/conversation-preview-scope.mjs';

test('embedded file preview reuses the complete native chat tree without taking ownership of host slots, and follows late plugin changes', () => {
  const session = { options: {}, component: () => {}, children: { 'conversation.view': { kind: 'list', scope: 'session' } } };
  const store = {}, inject = () => ({ native: true });
  const chat = { options: { id: 'chat', order: 2 }, component: () => {}, store, inject, locale: 'native-chat',
    children: { 'conversation.chat.flow': { kind: 'single', scope: 'session' } } };
  const flow = { options: {}, component: () => {}, children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } } };
  const node = { options: { key: 'assistant' }, component: () => {} };
  const sources = new Map([['conversation.session', [session]], ['conversation.view', []], ['conversation.chat.flow', [flow]], ['conversation.chat.node', [node]]]);
  const declared = new Set([...sources.keys(), local('conversation.session')]), copies = new Map(), listeners = new Map();
  const slots = {
    inject(name, callback) { assert(declared.has(name)); return callback(); },
    entriesOfSlot(name) { return sources.get(name) || []; },
    subscribe(name, callback) { const set = listeners.get(name) || new Set(); listeners.set(name, set); set.add(callback); return () => set.delete(callback); },
    register(options, component) {
      assert(options.name.startsWith('wtt.file.')); assert(declared.has(options.name));
      assert(!copies.has(options.name), 'old local registrations must be disposed before replacement');
      for (const name of Object.keys(options.children || {})) { assert(!declared.has(name), 'cannot redeclare a host-owned child'); declared.add(name); }
      copies.set(options.name, { options, component });
      return () => { copies.delete(options.name); for (const name of Object.keys(options.children || {})) declared.delete(name); };
    },
  };
  const stop = registerConversationPreviewScope({ slots }, (component, slot) => ({ component, slot }));
  assert.equal(copies.size, 1, 'an unloaded native Chat stays empty rather than opening a host sidebar');
  const inspector = { options: { id: 'inspector' }, component: () => {} };
  sources.set('conversation.view', [chat, inspector]);
  for (const callback of [...listeners.get('conversation.view')]) callback();
  assert.equal(copies.size, 4);
  const mounted = copies.get(local('conversation.view'));
  assert.equal(mounted.options.inject, inject); assert.equal(mounted.options.store, store); assert.equal(mounted.options.locale, 'native-chat');
  assert.equal(mounted.component.component, chat.component);
  assert.deepEqual(Object.keys(mounted.options.children), [local('conversation.chat.flow')]);
  assert.equal(copies.get(local('conversation.chat.node')).options.key, 'assistant');
  assert.equal(sources.get('conversation.session')[0], session); assert.equal(chat.options.id, 'chat');
  const replacement = { ...node, component: () => 'updated native occupant' };
  sources.set('conversation.chat.node', [replacement]);
  for (const callback of [...listeners.get('conversation.chat.node')]) callback();
  assert.equal(copies.get(local('conversation.chat.node')).component.component, replacement.component);
  stop(); assert.equal(copies.size, 0); assert([...listeners.values()].every(set => !set.size));
  assert(declared.has('conversation.chat.flow')); assert(declared.has(local('conversation.session')));
});
