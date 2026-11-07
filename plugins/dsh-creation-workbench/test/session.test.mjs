import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEditorSessionAcquirer, acquireCourseConversation, promptCourseSession, restoreCourseConversation, startCourseSession } from '../src/session.mjs';

test('an explicit skill must exist at the frozen path in the actual native session before admission', async () => {
  for (const skills of [[], [{ name: 'local-check', path: '/preset/other/SKILL.md' }]]) {
    const ctx = context();
    ctx.remote.skills = { list: async () => ({ ok: true, value: { skills } }) };
    await assert.rejects(promptCourseSession(ctx, { cwd: '/project', prompt: '/local-check hello',
      explicitSkills: ['local-check'], explicitSkillRefs: [{ name: 'local-check', path: '/local/SKILL.md' }] }), /不能调用|替换了同名/);
    assert.equal(ctx.calls.some(call => call[0] === 'prompt'), false);
  }
  const ctx = context();
  ctx.remote.skills = { list: async () => ({ ok: true, value: { skills: [{ name: 'local-check', path: '/local/SKILL.md' }] } }) };
  await promptCourseSession(ctx, { cwd: '/project', prompt: '/local-check hello', explicitSkills: ['local-check'],
    explicitSkillRefs: [{ name: 'local-check', path: '/local/SKILL.md' }] });
  assert.equal(ctx.calls.filter(call => call[0] === 'prompt').length, 1);
});

function projectContext(cwd = '/project-a', sessionId = 'existing-session') {
  const ctx = context();
  const reference = { sessionId, ready: null, release: () => ctx.calls.push(['release']) };
  const binding = { session: { getSnapshot: () => ({ openState: 'open' }) } };
  ctx.sessions = { retain: (id, options) => {
    ctx.calls.push(['retain', id, options]);
    reference.ready = Promise.resolve().then(() => { ctx.calls.push(['ready']); return binding; });
    return reference;
  } };
  ctx.remote.session.list = async request => {
    ctx.calls.push(['metadata', request]);
    return { ok: true, value: { items: [{ sessionId, cwd }] } };
  };
  return { ctx, reference, binding };
}

test('restoring a project session checks its Host header directory after reference readiness', async () => {
  const { ctx, reference } = projectContext();
  assert.equal(await restoreCourseConversation(ctx, { sessionId: 'existing-session', cwd: '/project-a', projectId: 'project-a' }), reference);
  assert.deepEqual(ctx.calls.map(call => call[0]), ['retain', 'ready', 'metadata']);
  assert.deepEqual(ctx.calls[2], ['metadata', {}]);
});

test('a copied project cannot restore a session from its original directory', async () => {
  const { ctx } = projectContext('/project-a');
  // A UI selection or client catalog cannot override the original Host metadata.
  ctx.uiWorkspace.current = { cwd: '/project-b' };
  ctx.sessions.list = { getSnapshot: () => ({ byId: { 'existing-session': { cwd: '/project-b' } } }) };
  await assert.rejects(restoreCourseConversation(ctx, { sessionId: 'existing-session', cwd: '/project-b', projectId: 'project-b' }), /另一个项目目录/);
  assert.deepEqual(ctx.calls.map(call => call[0]), ['retain', 'ready', 'metadata', 'release']);
});

test('missing or unreadable original session metadata releases the reference and blocks reuse', async t => {
  for (const [label, list] of [
    ['missing session', async () => ({ ok: true, value: { items: [] } })],
    ['missing directory', async () => ({ ok: true, value: { items: [{ sessionId: 'existing-session' }] } })],
    ['relative directory', async () => ({ ok: true, value: { items: [{ sessionId: 'existing-session', cwd: 'project-a' }] } })],
    ['malformed list', async () => ({ ok: true, value: {} })],
    ['remote rejection', async () => ({ ok: false, error: { message: '会话查询被拒绝' } })],
    ['transport loss', async () => { throw new Error('会话查询连接中断'); }],
  ]) await t.test(label, async () => {
    const { ctx } = projectContext();
    ctx.remote.session.list = list;
    await assert.rejects(restoreCourseConversation(ctx, { sessionId: 'existing-session', cwd: '/project-a', projectId: 'project-a' }), /无法核对原生会话/);
    assert.deepEqual(ctx.calls.map(call => call[0]), ['retain', 'ready', 'release']);
  });
});

test('a resolved ready binding with a history-open error cannot be restored as successful', async () => {
  const { ctx, binding } = projectContext();
  binding.session.getSnapshot = () => ({ openState: 'error', openError: { message: '原生历史读取失败' } });
  await assert.rejects(restoreCourseConversation(ctx, { sessionId: 'existing-session', cwd: '/project-a', projectId: 'project-a' }), /原生历史读取失败/);
  assert.deepEqual(ctx.calls.map(call => call[0]), ['retain', 'ready', 'release']);
});

test('project sessions are verified before journaling and prompt admission', async () => {
  const { ctx, reference } = projectContext();
  const lifecycle = { beforePrompt: async () => ctx.calls.push(['journal']) };
  assert.equal(await acquireCourseConversation(ctx, { cwd: '/project-a', projectId: 'project-a', prompt: '需求', requestId: 'stable-project-request' }, 'existing-session', lifecycle), reference);
  assert.deepEqual(ctx.calls.map(call => call[0]), ['retain', 'ready', 'metadata', 'journal', 'prompt']);
  assert.equal(ctx.calls.at(-1)[1].requestId, 'stable-project-request');
});

test('project mismatch prevents both journaling and prompt admission and releases only once', async () => {
  const { ctx } = projectContext('/project-a');
  await assert.rejects(acquireCourseConversation(ctx, { cwd: '/project-b', projectId: 'project-b', prompt: '需求' }, 'existing-session', {
    beforePrompt: async () => ctx.calls.push(['journal']),
  }), error => /另一个项目目录/.test(error.message) && error.submissionState === 'not-sent');
  assert.deepEqual(ctx.calls.map(call => call[0]), ['retain', 'ready', 'metadata', 'release']);
});

test('newly created project sessions also verify their original directory before sending', async () => {
  const { ctx } = projectContext('/wrong-project', 'test-session');
  await assert.rejects(acquireCourseConversation(ctx, { cwd: '/project-a', projectId: 'project-a', prompt: '需求' }), /另一个项目目录/);
  assert.deepEqual(ctx.calls.map(call => call[0]), ['workspace', 'create', 'retain', 'ready', 'metadata', 'release']);
});

test('the non-embedded prompt path cannot reuse a session from another project', async () => {
  const { ctx } = projectContext('/project-a');
  await assert.rejects(promptCourseSession(ctx, { cwd: '/project-b', projectId: 'project-b', prompt: '需求' }, 'existing-session'), /另一个项目目录/);
  assert.deepEqual(ctx.calls.map(call => call[0]), ['metadata']);
});

test('an explicit incomplete project identity cannot silently fall back to legacy restore', async () => {
  for (const projectId of [null, '', '  ', 1]) {
    const { ctx } = projectContext();
    await assert.rejects(restoreCourseConversation(ctx, { sessionId: 'existing-session', cwd: '/project-a', projectId }), /项目目录信息不完整/);
    assert.deepEqual(ctx.calls.map(call => call[0]), ['retain', 'ready', 'release']);
  }
});

test('legacy restore without projectId keeps the original public reference contract', async () => {
  const { ctx, reference } = projectContext();
  delete ctx.remote.session.list;
  assert.equal(await restoreCourseConversation(ctx, { sessionId: 'existing-session', cwd: '/legacy' }), reference);
  assert.deepEqual(ctx.calls.map(call => call[0]), ['retain', 'ready']);
});

test('a task keeps its requestId and journals the session before prompt admission', async () => {
  const ctx = context();
  ctx.sessions = { retain: () => ({ sessionId: 'existing-session', ready: Promise.resolve(), release() {} }) };
  const prepared = { cwd: '/work', prompt: '锁定的任务快照', requestId: 'stable-task-request' };
  const lifecycle = { beforePrompt: async value => ctx.calls.push(['journal', value]) };
  await acquireCourseConversation(ctx, prepared, 'existing-session', lifecycle);
  await acquireCourseConversation(ctx, prepared, 'existing-session', lifecycle);
  assert.deepEqual(ctx.calls.map(call => call[0]), ['journal', 'prompt', 'journal', 'prompt']);
  assert.deepEqual(ctx.calls[0][1], { sessionId: 'existing-session', requestId: 'stable-task-request' });
  assert.deepEqual(ctx.calls.filter(call => call[0] === 'prompt').map(call => call[1].requestId), ['stable-task-request', 'stable-task-request']);
});

test('a failed task journal cannot admit an unrecorded prompt', async () => {
  const ctx = context();
  let released = false;
  ctx.sessions = { retain: () => ({ ready: Promise.resolve(), release() { released = true; } }) };
  await assert.rejects(acquireCourseConversation(ctx, { cwd: '/work', prompt: '任务' }, 'existing-session', {
    beforePrompt: async () => { throw new Error('任务登记失败'); },
  }), error => error.message === '任务登记失败' && error.submissionState === 'not-sent');
  assert.equal(released, true);
  assert.deepEqual(ctx.calls, []);
});

test('transport loss and invalid admission receipts remain unknown, unlike explicit rejection', async () => {
  for (const [prompt, expected] of [
    [async () => { throw new Error('连接中断'); }, 'unknown'],
    [async () => ({ ok: true, value: {} }), 'unknown'],
    [async () => ({ ok: false, error: { code: 'session/not-found', message: '明确拒绝' } }), 'rejected'],
  ]) {
    const ctx = context({ prompt });
    ctx.sessions = { retain: () => ({ ready: Promise.resolve(), release() {} }) };
    await assert.rejects(acquireCourseConversation(ctx, { cwd: '/work', prompt: '任务' }, 'existing-session'), error => error.submissionState === expected);
  }
});

test('real Gateway error envelopes cannot imply that a task was never admitted', async () => {
  for (const code of ['gateway/internal', 'gateway/cancelled', 'session/agent-busy', undefined]) {
    const ctx = context({ prompt: async () => ({ ok: false, error: { code, message: '原生 Remote 失败回执' } }) });
    ctx.sessions = { retain: () => ({ ready: Promise.resolve(), release() {} }) };
    await assert.rejects(acquireCourseConversation(ctx, { cwd: '/work', prompt: '任务' }, 'existing-session'), error => error.submissionState === 'unknown');
  }
});

test('the missing model is a known unsent task failure', async () => {
  const ctx = context({ modelCatalog: async () => ({ ok: true, value: { routableProviders: [] } }) });
  await assert.rejects(acquireCourseConversation(ctx, { cwd: '/work', prompt: '任务' }), error => error.submissionState === 'not-sent');
  assert.deepEqual(ctx.calls, []);
});

function installModelSelection(ctx, respond = request => ({ ok: true, value: { selected: request } })) {
  ctx.remote.session.selectModel = async request => {
    ctx.calls.push(['select-model', request]);
    return respond(request);
  };
}

test('a frozen task model is selected through Host before a new session receives its prompt', async () => {
  const ctx = context();
  installModelSelection(ctx);
  const modelSelection = { provider: 'external', model: 'example-text', reasoningEffort: 'high' };
  await promptCourseSession(ctx, { cwd: '/work', prompt: '需求', modelSelection });
  assert.deepEqual(ctx.calls.map(call => call[0]), ['workspace', 'create', 'select-model', 'prompt']);
  assert.deepEqual(ctx.calls[2][1], { sessionId: 'test-session', ...modelSelection });
  assert.deepEqual(ctx.calls[1][1], { workspaceId: 'test-workspace' });
});

test('project checks precede explicit model selection and task journaling', async () => {
  const { ctx, reference } = projectContext();
  installModelSelection(ctx);
  const prepared = { cwd: '/project-a', projectId: 'a', prompt: '任务', modelSelection: { provider: 'external', model: 'original' } };
  assert.equal(await acquireCourseConversation(ctx, prepared, 'existing-session', { beforePrompt: async () => ctx.calls.push(['journal']) }), reference);
  assert.deepEqual(ctx.calls.map(call => call[0]), ['retain', 'ready', 'metadata', 'select-model', 'journal', 'prompt']);
  assert.deepEqual(ctx.calls[3][1], { sessionId: 'existing-session', provider: 'external', model: 'original' });
});

test('task retries continue selecting their frozen model after the Host default changes', async () => {
  const ctx = context();
  ctx.sessions = { retain: () => ({ ready: Promise.resolve(), release() {} }) };
  installModelSelection(ctx);
  const prepared = { cwd: '/work', prompt: '任务', modelSelection: { provider: 'original', model: 'frozen' } };
  await acquireCourseConversation(ctx, prepared, 'existing-session');
  ctx.remote.session.modelCatalog = async () => ({ ok: true, value: { routableProviders: ['original', 'new'], default: { provider: 'new', model: 'changed' } } });
  await acquireCourseConversation(ctx, prepared, 'existing-session');
  assert.deepEqual(ctx.calls.filter(call => call[0] === 'select-model').map(call => call[1]), [
    { sessionId: 'existing-session', provider: 'original', model: 'frozen' },
    { sessionId: 'existing-session', provider: 'original', model: 'frozen' },
  ]);
});

test('failed or malformed explicit model acknowledgements never send or silently fall back', async () => {
  for (const respond of [
    () => { throw new Error('选择服务连接中断'); },
    () => ({ ok: false, error: { message: '模型不可用' } }),
    () => ({ ok: true, value: {} }),
    () => ({ ok: true, value: { selected: { provider: 'deepseek', model: 'fallback' } } }),
    () => ({ ok: true, value: { selected: { provider: 'external', model: 'original', reasoningEffort: 'low' } } }),
  ]) {
    for (const embedded of [true, false]) {
      const ctx = context();
      ctx.sessions = { retain: () => ({ ready: Promise.resolve(), release() { ctx.calls.push(['release']); } }) };
      installModelSelection(ctx, respond);
      const prepared = { cwd: '/work', prompt: '任务', modelSelection: { provider: 'external', model: 'original', reasoningEffort: 'high' } };
      await assert.rejects((embedded ? acquireCourseConversation : promptCourseSession)(ctx, prepared, 'existing-session'), error => error.submissionState === 'not-sent');
      assert.equal(ctx.calls.some(call => call[0] === 'prompt'), false);
      assert.equal(ctx.calls.filter(call => call[0] === 'release').length, embedded ? 1 : 0);
    }
  }
});

test('missing selection API or invalid explicit selection leaves the prompt unsent', async () => {
  for (const selection of [{ provider: 'external', model: 'original' }, { provider: '', model: 'bad' }]) {
    const ctx = context();
    await assert.rejects(promptCourseSession(ctx, { cwd: '/work', prompt: '任务', modelSelection: selection }, 'existing-session'), error => error.submissionState === 'not-sent');
    assert.deepEqual(ctx.calls, []);
  }
});

function context(overrides = {}, workspaceOverrides = {}) {
  const calls = [];
  return {
    calls,
    remote: { session: {
      modelCatalog: async () => ({ ok: true, value: { routableProviders: ['configured'] } }),
      create: async (request) => { calls.push(['create', request]); return { ok: true, value: { sessionId: 'test-session' } }; },
      prompt: async (request) => { calls.push(['prompt', request]); return { ok: true, value: { accepted: true } }; },
      ...overrides,
    }, workspace: {
      create: async (request) => { calls.push(['workspace', request]); return { ok: true, value: { workspace: { workspaceId: 'test-workspace' }, created: true } }; },
      ...workspaceOverrides,
    } },
    uiWorkspace: { openSession: (id) => calls.push(['navigate', id]) },
  };
}

test('generated Remote results are unwrapped before prompt and navigation', async () => {
  const ctx = context();
  const id = await startCourseSession(ctx, { cwd: '/selected/workspace', prompt: '/course-skill\n需求' });
  assert.equal(id, 'test-session');
  assert.deepEqual(ctx.calls[0], ['workspace', { path: '/selected/workspace' }]);
  assert.deepEqual(ctx.calls[1], ['create', { workspaceId: 'test-workspace' }]);
  assert.equal(ctx.calls[2][1].sessionId, 'test-session');
  assert.equal(ctx.calls[2][1].content[0].text, '/course-skill\n需求');
  assert.deepEqual(ctx.calls[3], ['navigate', 'test-session']);
});

test('a late accepted prompt cannot navigate away after its project is no longer active', async () => {
  let finishPrompt;
  let promptStarted;
  const started = new Promise(resolve => { promptStarted = resolve; });
  const ctx = context({ prompt: request => {
    ctx.calls.push(['prompt', request]);
    promptStarted();
    return new Promise(resolve => { finishPrompt = resolve; });
  } });
  let active = true;
  const result = startCourseSession(ctx, { cwd: '/project-a', prompt: '需求' }, () => active);
  await started;
  active = false;
  finishPrompt({ ok: true, value: { accepted: true } });
  assert.equal(await result, 'test-session');
  assert.deepEqual(ctx.calls.map(call => call[0]), ['workspace', 'create', 'prompt']);
});

test('an active project still opens its accepted session with an explicit navigation predicate', async () => {
  const ctx = context();
  assert.equal(await startCourseSession(ctx, { cwd: '/work', prompt: '需求' }, () => true), 'test-session');
  assert.deepEqual(ctx.calls.at(-1), ['navigate', 'test-session']);
});

test('missing model never creates a blank session or invokes the model', async () => {
  const ctx = context({ modelCatalog: async () => ({ ok: true, value: { routableProviders: [] } }) });
  await assert.rejects(startCourseSession(ctx, { cwd: '/work', prompt: '需求' }), /尚未配置模型/);
  assert.deepEqual(ctx.calls, []);
});

test('creation or prompt rejection is shown and never navigates to an invalid session', async () => {
  const ctx = context({ create: async () => ({ ok: false, error: { message: '创建失败' } }) });
  await assert.rejects(startCourseSession(ctx, { cwd: '/work', prompt: '需求' }), /创建失败/);
  assert.deepEqual(ctx.calls, [['workspace', { path: '/work' }]]);
  const rejected = context({ prompt: async () => ({ ok: false, error: { message: '模型未就绪' } }) });
  await assert.rejects(startCourseSession(rejected, { cwd: '/work', prompt: '需求' }), /模型未就绪/);
  assert.deepEqual(rejected.calls.map(call => call[0]), ['workspace', 'create']);
});

test('canvas prompt reuses its session and does not navigate away from the workbench', async () => {
  const ctx = context();
  const id = await promptCourseSession(ctx, { cwd: '/work', prompt: '根据新选中的卡片修改' }, 'existing-session');
  assert.equal(id, 'existing-session');
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0][0], 'prompt');
  assert.equal(ctx.calls[0][1].sessionId, 'existing-session');
  assert.equal(ctx.calls[0][1].content[0].text, '根据新选中的卡片修改');
});

test('canvas prompt checks model readiness even when reusing an existing session', async () => {
  const ctx = context({ modelCatalog: async () => ({ ok: true, value: { routableProviders: [] } }) });
  await assert.rejects(promptCourseSession(ctx, { cwd: '/work', prompt: '需求' }, 'existing-session'), /尚未配置模型/);
  assert.deepEqual(ctx.calls, []);
});

test('embedded conversation opens its Client reference before admitting the prompt', async () => {
  const ctx = context();
  const reference = { sessionId: 'test-session', ready: Promise.resolve(), release: () => ctx.calls.push(['release']) };
  ctx.sessions = { retain: (id, options) => { ctx.calls.push(['retain', id, options]); return reference; } };
  assert.equal(await acquireCourseConversation(ctx, { cwd: '/work', prompt: '需求' }), reference);
  assert.deepEqual(ctx.calls.map(call => call[0]), ['workspace', 'create', 'retain', 'prompt']);
  assert.deepEqual(ctx.calls[2], ['retain', 'test-session', { source: 'wttCourseCanvas' }]);
});

test('failed embedded attachment releases its reference without admitting a prompt', async () => {
  const ctx = context();
  ctx.sessions = { retain: () => ({
    ready: Promise.reject(new Error('会话历史加载失败')),
    release: () => ctx.calls.push(['release']),
  }) };
  await assert.rejects(acquireCourseConversation(ctx, { cwd: '/work', prompt: '需求' }, 'existing-session'), /会话历史加载失败/);
  assert.deepEqual(ctx.calls, [['release']]);
});

test('rejected embedded prompt releases its newly retained reference', async () => {
  const ctx = context({ prompt: async () => ({ ok: false, error: { message: '提示未受理' } }) });
  ctx.sessions = { retain: () => ({ ready: Promise.resolve(), release: () => ctx.calls.push(['release']) }) };
  await assert.rejects(acquireCourseConversation(ctx, { cwd: '/work', prompt: '需求' }), /提示未受理/);
  assert.deepEqual(ctx.calls.map(call => call[0]), ['workspace', 'create', 'release']);
});

test('missing model never acquires an embedded reference', async () => {
  const ctx = context({ modelCatalog: async () => ({ ok: true, value: { routableProviders: [] } }) });
  ctx.sessions = { retain: () => { throw new Error('must not retain'); } };
  await assert.rejects(acquireCourseConversation(ctx, { cwd: '/work', prompt: '需求' }), /尚未配置模型/);
  assert.deepEqual(ctx.calls, []);
});

test('workspace Remote rejection prevents session creation and prompt admission', async () => {
  const ctx = context({}, { create: async () => ({ ok: false, error: { message: '工作目录不可访问' } }) });
  await assert.rejects(startCourseSession(ctx, { cwd: '/work', prompt: '需求' }), /工作目录不可访问/);
  assert.deepEqual(ctx.calls, []);
});

test('workspace transport failure prevents session creation and prompt admission', async () => {
  const ctx = context({}, { create: async () => { throw new Error('工作区连接中断'); } });
  await assert.rejects(acquireCourseConversation(ctx, { cwd: '/work', prompt: '需求' }), /工作区连接中断/);
  assert.deepEqual(ctx.calls, []);
});

test('missing workspace identity never falls back to an ungrouped cwd session', async t => {
  for (const value of [undefined, null, {}, { workspace: {} }, { workspace: { workspaceId: '' } }, { workspace: { workspaceId: '  ' } }, { workspace: { workspaceId: 1 } }]) {
    await t.test(JSON.stringify(value) ?? 'undefined', async () => {
      const ctx = context({}, { create: async () => ({ ok: true, value }) });
      await assert.rejects(promptCourseSession(ctx, { cwd: '/work', prompt: '需求' }), /未返回有效工作区/);
      assert.deepEqual(ctx.calls, []);
    });
  }
});


test('empty native editing sessions coalesce per version and never inspect or call a model', async () => {
  const {ctx}=projectContext('/project-a','session-created');
  ctx.remote.workspace.create=async()=>{ctx.calls.push(['create-workspace']);return {ok:true,value:{workspace:{workspaceId:'workspace'}}}};
  ctx.remote.session.create=async()=>{ctx.calls.push(['create-session']);return {ok:true,value:{sessionId:'session-created'}}};
  ctx.remote.session.modelCatalog=async()=>{throw new Error('must not inspect models')};
  ctx.remote.session.prompt=async()=>{throw new Error('must not send')};
  const acquire=createEditorSessionAcquirer(ctx),project={id:'project-a',path:'/project-a'};
  await Promise.all([acquire(project,undefined,'draft-a'),acquire(project,undefined,'draft-a')]);
  assert.equal(ctx.calls.filter(call=>call[0]==='create-session').length,1);
  await acquire(project,'session-created','draft-a');
  assert.equal(ctx.calls.filter(call=>call[0]==='create-session').length,1);
  await acquire(project,undefined,'draft-b');
  assert.equal(ctx.calls.filter(call=>call[0]==='create-session').length,2);
  await assert.rejects(acquire({id:'project-b',path:'/project-b'},'session-created','draft-a'),/另一个项目目录/);
});
