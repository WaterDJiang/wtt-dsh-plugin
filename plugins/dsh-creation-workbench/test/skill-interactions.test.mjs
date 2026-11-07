import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskInteractions, buildQuestionAnswer, answerTaskInteraction, queuedQuestionCalls, SKILL_CONFIRMATION_INSTRUCTIONS } from '../src/skill-interactions.mjs';
import { watchCourseTaskSessions } from '../src/session.mjs';

const question = (id = 'q') => ({ kind: 'question', key: id, sessionId: 'session-a', questions: [{ id, question: '选择范围', options: [{ label: '半天' }, { label: '一天' }] }] });
const entry = pending => ({ key: `task:${pending.key}`, task: { id: 'task', sessionId: 'session-a', requirementId: 'req' }, interaction: pending });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('待办按需求和真实会话过滤，已保存产物仍等待确认，idle 不伪造待办', () => {
  const pending = question();
  const tasks = [{ id: 'a', kind: 'ai', requirementId: 'req', sessionId: 'session-a', status: 'output', cardVersionId: 'v1' }, { id: 'b', kind: 'ai', requirementId: 'other', sessionId: 'session-a' }];
  assert.equal(taskInteractions(tasks, new Map([['session-a', { pendingInteraction: pending }]]), 'req').length, 1);
  assert.equal(taskInteractions(tasks, new Map([['session-a', { running: false }]]), 'req').length, 0);
  assert.equal(taskInteractions(tasks, new Map([['session-a', { pendingInteraction: { ...pending, sessionId: 'foreign' } }]]), 'req').length, 0);
});

test('问题完整批次、选项原文、多选和自填回答；空答或非法选项被拒绝', () => {
  const pending = { ...question(), questions: [...question().questions, { id: 'free', question: '补充' }] };
  assert.throws(() => buildQuestionAnswer(pending, { q: { selected: ['半天'] } }), /每一个问题/);
  assert.throws(() => buildQuestionAnswer(pending, { q: { selected: ['半天', '一天'] }, free: { custom: '内容' } }), /选项已变化/);
  assert.throws(() => buildQuestionAnswer(pending, { q: { selected: ['错误'] }, free: { custom: '内容' } }), /选项已变化/);
  assert.deepEqual(buildQuestionAnswer(pending, { q: { selected: ['半天'] }, free: { custom: ' 保留实操 ' } }).answers,
    [{ id: 'q', selected: ['半天'] }, { id: 'free', selected: [], custom: '保留实操' }]);
});

test('方案修改永不携带批准标签，权限不可用问题回答替代', () => {
  const pending = { ...question(), kind: 'plan-review', questions: [{ id: 'p', question: '确认大纲 V2', options: [{ label: '确认继续' }, { label: '修改方案' }], intent: { kind: 'plan-review', approve: '确认继续' } }] };
  assert.deepEqual(buildQuestionAnswer(pending, {}, 'approve').answers[0].selected, ['确认继续']);
  assert.deepEqual(buildQuestionAnswer(pending, { p: { selected: ['确认继续'], custom: '增加案例' } }, 'modify').answers[0], { id: 'p', selected: ['修改方案'], custom: '增加案例' });
  assert.throws(() => buildQuestionAnswer(pending, {}, 'modify'), /修改意见/);
  assert.throws(() => buildQuestionAnswer({ kind: 'approval' }, {}), /原生任务/);
});

test('当前请求身份、重复点击和已回答请求均受保护', async () => {
  let done, calls = 0;
  const pending = { ...question('dedup'), getSnapshot: () => ({ channel: 'waterfall' }), answer: () => { calls++; return new Promise(resolve => { done = resolve; }); } };
  const target = entry(pending), answer = buildQuestionAnswer(pending, { dedup: { selected: ['半天'] } });
  await assert.rejects(answerTaskInteraction(target, answer, () => ({ ...target, key: 'new' })), /已结束或发生变化/);
  const first = answerTaskInteraction(target, answer, () => target);
  await assert.rejects(answerTaskInteraction(target, answer, () => target), /正在提交/);
  done(); await first;
  await assert.rejects(answerTaskInteraction(target, answer, () => target), /已提交/);
  assert.equal(calls, 1);
  const closed = { ...question('closed'), getSnapshot: () => ({ closed: true }), answer: async () => { calls++; } };
  await assert.rejects(answerTaskInteraction(entry(closed), {}, () => entry(closed)), /暂不可回答/);
});

function source(value) {
  const listeners = new Set();
  return { getSnapshot: () => value, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, set: next => { value = next; for (const fn of [...listeners]) fn(); }, count: () => listeners.size };
}
function context() {
  const questions = source({ active: [{ callId: 'call', state: 'continued', questions: [{ id: 'q', question: '继续？' }] }] });
  const inbox = source({});
  const status = source(new Map());
  const binding = { session: { getSnapshot: () => ({ openState: 'open' }), projections: { faceOf: key => key === 'userQuestions' ? questions : inbox } } };
  let retained = 0, released = 0, answered = 0;
  const ctx = { remote: { session: { list: async () => ({ ok: true, value: { items: [{ sessionId: 'session-a', cwd: '/project-a' }, { sessionId: 'foreign', cwd: '/project-b' }] } }) }, userQuestions: { answer: async () => { answered++; return { ok: true, value: true }; } } },
    sessions: { retain: () => { retained++; let release = false; return { ready: Promise.resolve(binding), release: () => { if (!release) { released++; release = true; } } }; } }, uiSession: { sessionStatus: status } };
  return { ctx, questions, inbox, status, counts: () => ({ retained, released, answered }) };
}

test('刷新后恢复持久化问题、回答使用原 callId，队列中已答问题不重复显示', async () => {
  const fixture = context(), snapshots = [];
  const stop = watchCourseTaskSessions(fixture.ctx, { projectId: 'a', cwd: '/project-a', sessionIds: ['session-a'] }, value => snapshots.push(value), error => assert.fail(error));
  await tick();
  const pending = snapshots.at(-1).get('session-a').pendingInteraction;
  assert.equal(pending.callId, 'call');
  assert.equal(pending.getSnapshot().channel, 'rpc');
  await pending.answer({ answers: [{ id: 'q', selected: [], custom: '继续' }] });
  assert.equal(fixture.counts().answered, 1);
  fixture.inbox.set({ 'next-step': [{ source: { kind: 'user-question-reply', callId: 'call' } }] });
  assert.equal(snapshots.at(-1).get('session-a').pendingInteraction, undefined);
  await assert.rejects(pending.answer({ answers: [] }), /已变化或回答已排队/);
  stop();
  assert.equal(fixture.counts().released, 1);
  assert.equal(fixture.questions.count(), 0);
  await assert.rejects(pending.answer({ answers: [] }), /项目已切换/);
});

test('订阅拒绝跨项目 cwd，不保留 foreign 会话；退出期间迟到恢复释放引用', async () => {
  const fixture = context(), errors = [];
  const stop = watchCourseTaskSessions(fixture.ctx, { projectId: 'a', cwd: '/project-a', sessionIds: ['foreign', 'session-a'] }, () => {}, error => errors.push(error));
  await tick(); stop();
  assert.match(errors[0], /其他项目/);
  assert.deepEqual(fixture.counts(), { retained: 1, released: 1, answered: 0 });
  assert.deepEqual([...queuedQuestionCalls({ 'next-turn': [{ source: { kind: 'user-question-reply', callId: 'x' } }] })], ['x']);
});

test('任务沟通契约保留硬门、超时停止及任务授权边界', () => {
  const prompt = SKILL_CONFIRMATION_INSTRUCTIONS.join('\n');
  assert.match(prompt, /ask_user_question/); assert.match(prompt, /立即结束当前轮次/); assert.match(prompt, /其他任务或历史对话授权不继承/);
});

test('同一 callId 的 Native 和恢复载体共享提交锁与已答标记', async () => {
  let release, calls = 0;
  const native = { ...question('carrier-swap'), callId: 'call-swap', key: 'native-key', answer: async () => { calls++; await new Promise(resolve => { release = resolve; }); } };
  const recovered = { ...native, key: 'restored-key', answer: async () => { calls++; } };
  const current = entry(native), next = entry(recovered);
  const first = answerTaskInteraction(current, { answers: [] }, () => current);
  await assert.rejects(answerTaskInteraction(next, { answers: [] }, () => next), /正在提交/);
  release(); await first;
  await assert.rejects(answerTaskInteraction(next, { answers: [] }, () => next), /已提交/);
  assert.equal(calls, 1);
});
