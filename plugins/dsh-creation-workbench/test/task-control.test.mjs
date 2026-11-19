import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkbenchService } from '../src/service.mjs';
import { createTaskControl } from '../src/task-control.mjs';
import { readNativeTaskState } from '../src/native-task-state.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'wtt-task-control-'))), agents = new Map(), calls = [];
  const ctx = { get: name => name === 'agents' ? { get: id => agents.get(id) } : undefined,
    async parallel(event, data) { calls.push([event, data]); } };
  const service = new WorkbenchService({ workspaceRoot: root, runtimeStateReader: task => readNativeTaskState(ctx, task) });
  const { id } = service.store.createCanvas({ title: '合成停止验收', operationId: randomUUID() });
  const create = () => service.createTask({ requirementId: id, instruction: '合成任务', outputType: 'text', generation: { mode: 'new' }, selectedCardIds: [], sourceRefs: [], selectedSkills: [], operationId: randomUUID() }).task;
  const control = createTaskControl(ctx, { async refresh() {} });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  function attach(task, sessionId = 'shared-session') {
    service.tasks.bindSession({ taskId: task.id, sessionId });
    service.tasks.setDispatch({ taskId: task.id, status: 'accepted' });
    const agent = { id: sessionId, session: { header: { id: sessionId, cwd: root } }, status: 'running',
      inbox: { nextTurn: ['queued'], nextStep: [] },
      cancel(cause, options) { calls.push(['cancel', sessionId, cause, options]); this.inbox.nextTurn = []; this.status = 'idle'; },
      whenIdle: async () => {} };
    agents.set(sessionId, agent); return agent;
  }
  return { service, id, create, control, agents, calls, attach, input: task => ({ taskId: task.id, requirementId: id }) };
}

test('stopping a confirmed native group clears pending work and invokes associated activity stop, preserving other sessions', async t => {
  const f = fixture(t), one = f.create(), two = f.create(), other = f.create();
  f.attach(one); f.attach(two); const independent = f.attach(other, 'independent-session');
  const scope = await f.control.inspect(f.service, f.input(one));
  assert.equal(scope.relatedCount, 2); assert.equal(scope.stopLabel, '停止这组任务');
  const result = await f.control.stop(f.service, { ...f.input(one), token: scope.token });
  assert.equal(result.stopping, false); assert.equal(independent.status, 'running');
  assert.deepEqual(f.calls, [['cancel', 'shared-session', { kind: 'user' }, undefined], ['workspace/session-stop', { sessionId: 'shared-session' }]]);
  assert.equal(f.service.tasks.get(one.id).dispatchStatus, 'accepted');
  assert.equal(f.service.tasks.get(two.id).dispatchStatus, 'accepted');
  assert.equal(f.service.tasks.get(one.id).runtimeState.phase, 'idle');
});

test('scope changes, foreign canvas, rebound session and foreign Agent directory cannot cancel', async t => {
  const f = fixture(t), one = f.create(); f.attach(one);
  const before = await f.control.inspect(f.service, f.input(one));
  const two = f.create(); f.attach(two);
  await assert.rejects(f.control.stop(f.service, { ...f.input(one), token: before.token }), /范围/);
  await assert.rejects(f.control.inspect(f.service, { taskId: one.id, requirementId: randomUUID() }), /不属于/);
  const next = await f.control.inspect(f.service, f.input(one));
  f.service.store.db.prepare('UPDATE course_tasks SET session_id=? WHERE id=?').run('new-session', one.id);
  await assert.rejects(f.control.stop(f.service, { ...f.input(one), token: next.token }), /会话已变化/);
  f.service.store.db.prepare('UPDATE course_tasks SET session_id=? WHERE id=?').run('shared-session', one.id);
  f.agents.get('shared-session').session.header.cwd = '/different-project';
  await assert.rejects(f.control.inspect(f.service, f.input(one)), /不属于当前项目/);
  assert.deepEqual(f.calls, []);
});

test('budget stop exposes only exhausted limits and raising them preserves the task, project defaults and other limits', async t => {
  const f = fixture(t), task = f.create(), other = f.create();
  const agent = f.attach(task);
  agent.status = 'idle';
  agent.inbox.nextTurn = [];
  const original = f.service.production.policy();
  f.service.production.setTaskBudget({ taskId: task.id, ...original, maxInputTokens: 100 });
  f.service.production.sample(task.id, { tokenUsage: { uncachedInputTokens: 50, cacheReadTokens: 60, cacheWriteTokens: 0, outputTokens: 20 } });
  f.service.production.check(task.id);
  f.service.tasks.runtimeStateReader = entry => f.service.production.budgetStop(entry.id)
    ? { phase: 'idle', budgetStopped: true, message: f.service.production.budgetStop(entry.id) }
    : { phase: 'idle' };
  const plan = await f.control.inspect(f.service, f.input(task));
  assert.deepEqual(plan.budgetLimits, [{ key: 'maxInputTokens', label: '累计输入', used: 110, limit: 100, unit: 'Token' }]);
  const request = { ...f.input(task), token: plan.token, limits: [{ key: 'maxInputTokens', previous: 100, value: 200 }] };
  await assert.rejects(f.control.raiseBudget(f.service, { ...request, requirementId: randomUUID() }), /不属于/);
  await assert.rejects(f.control.raiseBudget(f.service, { ...request, limits: [{ ...request.limits[0], previous: 99 }] }), /重新核对/);
  await assert.rejects(f.control.raiseBudget(f.service, { ...request, limits: [{ ...request.limits[0], value: 110 }] }), /大于当前用量/);
  await f.control.raiseBudget(f.service, request);
  assert.deepEqual(f.service.production.inspect(task.id).policy, { ...original, maxInputTokens: 200 });
  assert.deepEqual(f.service.production.inspect(other.id).policy, original);
  assert.deepEqual(f.service.production.policy(), original);
  assert.equal(f.service.production.budgetStop(task.id), null);
  assert.equal(f.service.production.check(task.id), null);
  assert.equal(f.service.tasks.get(task.id).sessionId, agent.id);
  await assert.rejects(f.control.raiseBudget(f.service, request), /状态已变化/);
  assert.deepEqual(f.calls, []);
});

test('a stop request is not reported complete before the native Agent actually exits', async t => {
  const f = fixture(t), task = f.create(), agent = f.attach(task);
  agent.cancel = () => {}; agent.whenIdle = () => new Promise(() => {});
  const plan = await f.control.inspect(f.service, f.input(task));
  const result = await f.control.stop(f.service, { ...f.input(task), token: plan.token });
  assert.equal(result.stopping, true); assert.equal(result.state, 'running'); assert.match(result.message, /等待退出/);
  const node = f.service.canvas.getBoard(f.id).nodes.find(node => node.pendingGeneration?.taskId === task.id);
  assert.throws(() => f.service.recycle.plan({ requirementId: f.id, selections: [{ nodeId: node.id }] }), /任务尚未停止/);
});

test('a binding changed during asynchronous Host activity lookup cannot cancel the replacement session', async t => {
  const f = fixture(t), task = f.create(); f.attach(task);
  const plan = await f.control.inspect(f.service, f.input(task));
  const ctx = { get: name => name === 'agents' ? { get: id => f.agents.get(id) } : undefined,
    async waterfall() { f.service.store.db.prepare('UPDATE course_tasks SET session_id=? WHERE id=?').run('replacement', task.id); return []; } };
  const control = createTaskControl(ctx, { async refresh() {} });
  await assert.rejects(control.stop(f.service, { ...f.input(task), token: plan.token }), /会话已变化/);
  assert.deepEqual(f.calls, []);
});

test('an unsent native task can be cancelled once but cannot be dispatched or bound afterward', async t => {
  const f = fixture(t), task = f.create();
  const plan = await f.control.inspect(f.service, f.input(task));
  assert.equal(plan.stopLabel, '取消未发送任务');
  const result = await f.control.stop(f.service, { ...f.input(task), token: plan.token });
  assert.equal(result.state, 'cancelled'); assert.equal(result.canStop, false);
  assert.equal(f.service.tasks.cancelDraft(task.id).dispatchStatus, 'cancelled');
  assert.throws(() => f.service.tasks.bindSession({ taskId: task.id, sessionId: 'later' }), /已取消/);
  assert.throws(() => f.service.tasks.setDispatch({ taskId: task.id, status: 'submitting' }), /已取消/);
  assert.deepEqual(f.calls, []);
});

test('unknown execution allows node-only removal without claiming a stopped task or deleting files', async t => {
  const f = fixture(t), task = f.create(); f.attach(task); f.agents.clear();
  f.service.tasks.setDispatch({ taskId: task.id, status: 'unknown', error: '合成回执未知' });
  const control = await f.control.inspect(f.service, f.input(task));
  assert.equal(control.canStop, false); assert.equal(control.state, 'unknown');
  const node = f.service.canvas.getBoard(f.id).nodes.find(node => node.pendingGeneration?.taskId === task.id);
  const plan = f.service.recycle.plan({ requirementId: f.id, selections: [{ nodeId: node.id }] });
  assert.match(plan.nodes[0].executionWarning, /不会停止原任务/);
  assert.throws(() => f.service.recycle.remove({ planId: plan.id, deleteFiles: true }), /只能移除卡片/);
  f.service.recycle.remove({ planId: plan.id });
  assert.equal(f.service.tasks.get(task.id).dispatchStatus, 'unknown');
  f.service.recycle.restore({ entryId: plan.id });
  assert(f.service.canvas.getBoard(f.id).nodes.some(value => value.id === node.id));
});
test('project stop may cancel only its exact bound, unsubmitted draft', t=>{
  const f=fixture(t), task=f.create();
  f.service.tasks.bindSession({taskId:task.id,sessionId:'bound-draft'});
  assert.throws(()=>f.service.tasks.cancelDraft(task.id));
  assert.throws(()=>f.service.tasks.cancelDraft(task.id,'another-session'));
  assert.equal(f.service.tasks.cancelDraft(task.id,'bound-draft').dispatchStatus,'cancelled');
  assert.equal(f.service.tasks.claimDraftDispatch(task.id,'bound-draft'),false);
  const claimed=f.create();
  f.service.tasks.bindSession({taskId:claimed.id,sessionId:'sent'});
  assert.ok(f.service.tasks.claimDraftDispatch(claimed.id,'sent'));
  assert.throws(()=>f.service.tasks.cancelDraft(claimed.id,'sent'));
});
