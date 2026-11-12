import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createNativeTaskStateTracker, readNativeTaskState } from '../src/native-task-state.mjs';

const task = { kind: 'ai', sessionId: 'native-session' };

test('native state uses the identity-matched live Agent public status', () => {
  const agent = { id: task.sessionId, status: 'running' };
  const ctx = { get(name) { assert.equal(name, 'agents'); return { get: id => { assert.equal(id, task.sessionId); return agent; } }; } };
  assert.deepEqual(readNativeTaskState(ctx, task), { phase: 'generating', message: '内容正在生成' });
  agent.status = 'idle';
  assert.deepEqual(readNativeTaskState(ctx, task), { phase: 'idle', message: '本轮执行已结束；文件与版本见任务记录' });
  assert.doesNotMatch(readNativeTaskState(ctx, task).message, /等待确认|等待授权|生成完成|成功/);
});

test('the direct public registry works without a Context get method', () => {
  const ctx = { agents: { get: () => ({ id: task.sessionId, status: 'running' }) } };
  assert.equal(readNativeTaskState(ctx, task).phase, 'generating');
});

test('legacy persisted idle wording is corrected on read without rewriting historical events', t => {
  const f = fixture(t);
  f.tracker.read(f.boundTask, f.service);
  f.emit(end(3, 1, { kind: 'completed' }));
  const legacy = '本轮执行已结束，尚未登记正式产物；打开原任务继续';
  f.db.prepare('UPDATE task_runtime_states SET message=? WHERE task_id=?').run(legacy, f.boundTask.id);
  const state = f.tracker.read(f.boundTask, f.service);
  assert.equal(state.phase, 'idle');
  assert.equal(state.message, '本轮执行已结束；打开原任务继续');
  assert.equal(f.db.prepare('SELECT message FROM task_runtime_states WHERE task_id=?').get(f.boundTask.id).message, legacy);
});

test('missing or uncertain live facts remain unknown instead of guessed idle', () => {
  for (const ctx of [null, {}, { get: () => undefined }, { agents: {} },
    { agents: { get: () => undefined } }, { agents: { get: () => ({ id: task.sessionId }) } },
    { agents: { get: () => ({ id: task.sessionId, status: 'paused' }) } },
    { agents: { get: () => ({ id: 'another-session', status: 'running' }) } },
    { get() { throw new Error('registry unavailable'); } },
    { agents: { get() { throw new Error('Agent disposed'); } } },
  ]) assert.equal(readNativeTaskState(ctx, task), null);
});

test('media and unbound tasks never consult native state or legacy events', () => {
  const ctx = new Proxy({}, { get() { assert.fail('no native registry read for media or unbound task'); } });
  for (const value of [null, {}, { kind: 'ai' }, { kind: 'ai', sessionId: ' ' }, { kind: 'media', sessionId: task.sessionId }, { kind: 'manual', sessionId: task.sessionId }]) {
    assert.equal(readNativeTaskState(ctx, value), null);
  }
  const agent = { id: task.sessionId, status: 'idle' };
  Object.defineProperty(agent, 'snapshotEvents', { get() { assert.fail('deprecated snapshots read'); } });
  Object.defineProperty(agent, 'ownEvents', { get() { assert.fail('deprecated event fold read'); } });
  assert.equal(readNativeTaskState({ agents: { get: () => agent } }, task).phase, 'idle');
});

function fixture(t, options = {}) {
  const db = new DatabaseSync(options.database || ':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS course_tasks(id TEXT PRIMARY KEY,kind TEXT,session_id TEXT,status TEXT)');
  db.prepare("INSERT OR IGNORE INTO course_tasks VALUES(?,?,?,?)").run('task-a', 'ai', 'native-session', 'accepted');
  const service = { workspaceRoot: '/project-a', store: { db, closed: false } };
  const listeners = new Set();
  const warnings = [];
  const agents = new Map();
  const ctx = { agents: { get: id => agents.get(id) }, sessionQuery: options.query,
    on(name, listener) { assert.equal(name, 'session/event'); listeners.add(listener); return () => listeners.delete(listener); },
    get(name) { return this[name]; }, logger: { warn: message => warnings.push(message) } };
  Object.defineProperty(ctx, 'remote', { get() { assert.fail('tracking cannot submit native prompts or change model selection'); } });
  const tracker = createNativeTaskStateTracker(ctx);
  const boundTask = { id: 'task-a', kind: 'ai', sessionId: 'native-session' };
  const session = { id: boundTask.sessionId, header: { id: boundTask.sessionId, cwd: service.workspaceRoot } };
  Object.defineProperty(session, 'snapshotEvents', { get() { assert.fail('deprecated snapshot read'); } });
  Object.defineProperty(session, 'ownEvents', { get() { assert.fail('deprecated event read'); } });
  const emit = (event, target = session) => { for (const listener of listeners) listener(target, event); };
  const closeStore = () => { if (!service.store.closed) { service.store.closed = true; db.close(); } };
  t.after(() => { tracker.close(); closeStore(); });
  return { db, service, ctx, tracker, boundTask, session, emit, agents, warnings, listeners, closeStore };
}

const start = (seq = 1, turn = 1) => ({ type: 'turn/start', seq, time: 1000 + seq, data: { turn } });
const end = (seq = 3, turn = 1, reason = { kind: 'completed' }) => ({ type: 'turn/end', seq, time: 1000 + seq, data: { turn, reason } });
const failure = (seq = 3, turn = 1) => end(seq, turn, { kind: 'error', error: { code: 'PI_AI_ERROR', status: 405,
  message: '<html><style>do not show</style><h1>405 Not Allowed</h1><p>Bearer sample-secret api_key=another-secret sk-fakeKey123456</p></html>' } });

test('explicit state refresh retries a failed history read without repeating normal board hydration', async t => {
  let attempts = 0, available = false;
  const f = fixture(t, { query: {
    listEvents() { attempts++; if (!available) throw new Error('synthetic history unavailable'); return Promise.resolve([{ sessionId: 'native-session', type: 'turn/end', seq: 3 }]); },
    async readEvent() { return { session: { id: 'native-session', cwd: '/project-a' }, target: end() }; },
  } });
  f.tracker.read(f.boundTask, f.service); await setImmediate();
  assert.equal(attempts, 1);
  available = true;
  f.tracker.read(f.boundTask, f.service); await setImmediate();
  assert.equal(attempts, 1, 'ordinary board reads must not repeatedly query history');
  assert.equal((await f.tracker.refresh(f.boundTask, f.service)).phase, 'idle');
  assert.equal(attempts, 2);
});

test('accepted provider 405 becomes a compact durable failure without changing dispatch or resubmitting', t => {
  const f = fixture(t);
  f.agents.set(f.boundTask.sessionId, { id: f.boundTask.sessionId, status: 'running' });
  assert.equal(f.tracker.read(f.boundTask, f.service).phase, 'generating');
  const original = f.db.prepare('SELECT * FROM course_tasks').all();
  f.emit(start()); f.emit(failure());
  // Live running wins until the actual driver settles.
  assert.equal(f.tracker.read(f.boundTask, f.service).phase, 'generating');
  f.agents.get(f.boundTask.sessionId).status = 'idle';
  const value = f.tracker.read(f.boundTask, f.service);
  assert.equal(value.phase, 'failed'); assert.equal(value.status, 405); assert.equal(value.code, 'PI_AI_ERROR');
  assert.match(value.message, /405 Not Allowed/);
  assert.doesNotMatch(value.message, /<html>|do not show|sample-secret|another-secret|fakeKey/);
  assert.deepEqual(f.db.prepare('SELECT * FROM course_tasks').all(), original);
  const row = f.db.prepare('SELECT * FROM task_runtime_states').get();
  assert.deepEqual(Object.keys(row).sort(), ['task_id', 'session_id', 'phase', 'turn', 'seq', 'time', 'message', 'code', 'status'].sort());
});

test('a later turn start clears old failure while stale or cross-project events cannot replace it', t => {
  const f = fixture(t);
  f.tracker.read(f.boundTask, f.service);
  f.emit(failure(3));
  assert.equal(f.tracker.read(f.boundTask, f.service).phase, 'failed');
  f.emit(start(5, 2));
  f.emit(failure(3));
  let row = f.db.prepare('SELECT * FROM task_runtime_states').get();
  assert.equal(row.phase, 'generating'); assert.equal(row.seq, 5); assert.equal(row.code, null);
  assert.equal(f.tracker.read(f.boundTask, f.service).phase, 'unknown');
  f.emit(failure(10, 3), { id: f.session.id, header: { id: f.session.id, cwd: '/project-b' } });
  row = f.db.prepare('SELECT * FROM task_runtime_states').get();
  assert.equal(row.seq, 5);
  f.emit(end(6, 2));
  assert.equal(f.tracker.read(f.boundTask, f.service).phase, 'idle');
  assert.doesNotMatch(f.tracker.read(f.boundTask, f.service).message, /确认|成功|已生成/);
});

test('cold task hydration reads only the latest terminal event and validates its real SessionHeader', async t => {
  const calls = [];
  const event = failure(8, 2);
  const query = {
    async listEvents(id) { calls.push(['list', id]); return [start(1), event].map(value => ({ sessionId: id, seq: value.seq, type: value.type, time: value.time })); },
    async readEvent(request) { calls.push(['read', request]); return { session: { id: request.sessionId, cwd: '/project-a' }, target: event }; },
  };
  const f = fixture(t, { query });
  for (let index = 0; index < 5; index++) f.tracker.read(f.boundTask, f.service);
  await setImmediate();
  assert.deepEqual(calls, [['list', 'native-session'], ['read', { sessionId: 'native-session', seq: 8, before: 0, after: 0 }]]);
  assert.equal(f.tracker.read(f.boundTask, f.service).phase, 'failed');
  assert.equal(f.tracker.read(f.boundTask, f.service).status, 405);
  assert.equal(f.db.prepare('SELECT status FROM course_tasks').get().status, 'accepted');
});

test('persisted failures survive a tracker and SQLite restart without live Agent or query services', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wtt-runtime-state-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = path.join(directory, 'runtime.sqlite');
  const first = fixture(t, { database });
  first.tracker.read(first.boundTask, first.service); first.emit(failure()); first.tracker.close(); first.closeStore();
  const second = fixture(t, { database });
  const result = second.tracker.read(second.boundTask, second.service);
  assert.equal(result.phase, 'failed'); assert.equal(result.status, 405); assert.match(result.message, /405 Not Allowed/);
});

test('an old hydrated end cannot overwrite a new live turn start', async t => {
  let resolveRead;
  const old = failure(3);
  const f = fixture(t, { query: { listEvents: async id => [{ sessionId: id, type: old.type, seq: old.seq, time: old.time }],
    readEvent: () => new Promise(resolve => { resolveRead = resolve; }) } });
  f.tracker.read(f.boundTask, f.service);
  await setImmediate();
  f.emit(start(10, 2));
  resolveRead({ session: f.session.header, target: old });
  await setImmediate();
  assert.equal(f.db.prepare('SELECT seq FROM task_runtime_states').get().seq, 10);
  assert.equal(f.tracker.read(f.boundTask, f.service).phase, 'unknown');
});

test('wrong header, wrong DB binding, open turns and read errors never manufacture failed states', async t => {
  for (const mode of ['wrong-directory', 'wrong-session', 'open-turn', 'query-error', 'rebound']) {
    let reads = 0;
    const f = fixture(t, { query: {
      async listEvents(id) { if (mode === 'query-error') throw new Error('query unavailable');
        return [{ sessionId: id, seq: 3, type: 'turn/end', time: 1003 }, ...(mode === 'open-turn' ? [{ sessionId: id, seq: 4, type: 'turn/start', time: 1004 }] : [])]; },
      async readEvent() { reads++;
        if (mode === 'rebound') f.db.prepare('UPDATE course_tasks SET session_id=?').run('new-session');
        return { session: { id: mode === 'wrong-session' ? 'foreign' : 'native-session', cwd: mode === 'wrong-directory' ? '/project-b' : '/project-a' }, target: failure() }; },
    } });
    f.tracker.read(f.boundTask, f.service);
    await setImmediate();
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM task_runtime_states').get().count, 0, mode);
    assert.notEqual(f.tracker.read(f.boundTask, f.service)?.phase, 'failed', mode);
    if (mode === 'open-turn') assert.equal(reads, 0);
  }
});

test('closing tracker or project prevents pending hydration and later listener writes', async t => {
  for (const closeProject of [false, true]) {
    let resolveRead;
    const f = fixture(t, { query: {
      listEvents: async id => [{ sessionId: id, type: 'turn/end', seq: 3, time: 1003 }],
      readEvent: () => new Promise(resolve => { resolveRead = resolve; }),
    } });
    f.tracker.read(f.boundTask, f.service);
    await setImmediate();
    if (closeProject) f.service.store.closed = true;
    else { f.tracker.close(); assert.equal(f.listeners.size, 0); }
    resolveRead({ session: f.session.header, target: failure() });
    await setImmediate();
    f.emit(failure());
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM task_runtime_states').get().count, 0);
    if (closeProject) f.service.store.closed = false;
  }
});

test('nonterminal attempts, unrelated tasks, and blocked turns do not imply confirmation or final output', t => {
  const f = fixture(t);
  f.tracker.read(f.boundTask, f.service);
  f.emit({ type: 'assistant/attempt', seq: 2, time: 1002, data: { turn: 1, stream: [] } });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM task_runtime_states').get().count, 0);
  assert.equal(f.tracker.read({ ...f.boundTask, sessionId: 'foreign' }, f.service), null);
  assert.equal(f.tracker.read({ ...f.boundTask, kind: 'media' }, f.service), null);
  f.emit(end(3, 1, { kind: 'blocked' }));
  const state = f.tracker.read(f.boundTask, f.service);
  assert.equal(state.phase, 'idle'); assert.doesNotMatch(state.message, /确认|授权|成功/);
});
