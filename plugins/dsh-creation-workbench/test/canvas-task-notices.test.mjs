import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completedCanvasTasks } from '../src/canvas-task-notices.mjs';
import { createDesktopTaskNotices, desktopTaskNotificationChannel } from '../src/desktop-task-notices.mjs';

test('only saved results from settled tasks are new canvas results', () => {
  const ai = { kind: 'ai', status: 'output', dispatchStatus: 'output', runtimeState: { phase: 'idle' }, files: [{ id: 'artifact' }] };
  const media = { kind: 'media', status: 'output', mediaJob: { status: 'succeeded' }, files: [{ id: 'video-file' }] };
  const tasks = [
    { ...ai, id: 'done' },
    { ...media, id: 'video' },
    { ...ai, id: 'pending' },
    { ...ai, id: 'still-running', sessionId: 'live' },
    { ...ai, id: 'cancelled', runtimeState: { phase: 'idle', message: '本轮执行已取消；文件与版本见任务记录' } },
    { ...ai, id: 'failed', runtimeState: { phase: 'failed' } },
    { ...ai, id: 'unknown', dispatchStatus: 'unknown' },
    { ...ai, id: 'no-result', status: 'accepted' },
    { ...ai, id: 'removed-result', files: [] },
    { ...ai, id: 'manual', kind: 'manual' },
    { ...media, id: 'paused', mediaJob: { status: 'paused' } },
  ];
  const statuses = new Map([['live', { running: true }]]);
  assert.deepEqual(completedCanvasTasks(tasks, statuses, new Set(['pending'])), ['done', 'video']);
});

test('desktop task notices use the DSH renderer and return clicks to the workbench', () => {
  const events = [];
  let notice;
  class Notification {
    static permission = 'granted';
    constructor(title, options) { notice = this; events.push([title, options.body]); }
    close() { events.push('close'); }
  }
  const host = { Notification, location: new URL('dsh-app://app/'), dshDesktop: {}, focus: () => events.push('focus') };
  assert.equal(desktopTaskNotificationChannel({ ...host, location: new URL('http://localhost/') }), undefined);
  const channel = desktopTaskNotificationChannel(host, () => events.push('workbench'));
  assert.equal(channel.permission, 'granted');
  channel.send({ title: '创作画布', pending: 1, completed: 1 });
  notice.onclick();
  assert.deepEqual(events, [['创作画布', '1 项待确认，1 项已完成'], 'focus', 'workbench', 'close']);
});

test('desktop notices exclude restored history, follow active tasks after leaving and dedupe native calls', { timeout: 2000 }, async t => {
  const scope = { projectId: 'project', canvasId: 'canvas', title: '创作画布', cwd: '/isolated' };
  const done = { kind: 'ai', requirementId: scope.canvasId, status: 'output', dispatchStatus: 'output', runtimeState: { phase: 'idle' }, files: [{}] };
  const running = { ...done, id: 'new', sessionId: 'session', runtimeState: { phase: 'generating' } };
  const restored = { ...done, id: 'old-question', sessionId: 'restored', runtimeState: { phase: 'awaiting-input' } };
  function status(sessionId, key, callId) {
    return { pendingInteraction: { kind: 'question', sessionId, key, callId } };
  }
  const notices = [];
  const completion = Promise.withResolvers();
  let backgroundStopCount = 0, polls = 0, setWatchedStatuses;
  const desktop = createDesktopTaskNotices({
    channel: { permission: 'granted', send(notice) { notices.push(notice); if (notice.completed) completion.resolve(); } },
    interval: 1,
    readTasks: async ({ projectId, canvasId }, signal) => {
      assert.deepEqual([projectId, canvasId, signal.aborted], ['project', 'canvas', false]);
      if (++polls === 1) {
        setWatchedStatuses(new Map([['session', status('session', 'background', 'second-call')]]));
        return [running];
      }
      setWatchedStatuses(new Map());
      return [{ ...done, id: 'new' }, { ...done, id: 'untracked' }];
    },
    readStatuses: () => new Map(),
    watchSessions: ({ sessionIds }, onChange) => {
      setWatchedStatuses = onChange;
      assert.deepEqual(sessionIds, ['session', 'restored']);
      return () => { backgroundStopCount++; };
    },
  });
  t.after(() => desktop.dispose());
  const tasks = [{ ...done, id: 'old-result' }, running, restored];
  const seen = new Set(['old-result']);
  desktop.observe(scope, tasks, new Map(), seen);
  const withRestored = new Map([['restored', status('restored', 'same', 'old')]]);
  desktop.observe(scope, tasks, withRestored, seen);
  assert.deepEqual(notices, []);
  for (const key of ['native', 'retained']) {
    const both = new Map([...withRestored, ['session', status('session', key, 'new-call')]]);
    desktop.observe(scope, tasks, both, seen);
  }
  assert.deepEqual(notices, [{ title: scope.title, pending: 1, completed: 0 }]);
  desktop.leave(scope);
  desktop.observe({ ...scope, canvasId: 'other' }, [], new Map(), new Set());
  await completion.promise;
  desktop.observe(scope, [...tasks, { ...done, id: 'new' }].filter(task => task !== running), withRestored, seen);
  assert.deepEqual(notices, [
    { title: scope.title, pending: 1, completed: 0 },
    { title: scope.title, pending: 1, completed: 0 },
    { title: scope.title, pending: 0, completed: 1 },
  ]);
  assert.equal(backgroundStopCount, 1);
});
