import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPendingContext, generationStateSignature, nativePendingState, pendingCardTitle, pendingContinueAllowed, pendingLabel, pendingRetryAllowed, publishedTaskGeneration } from '../src/pending-card-state.mjs';
import { usableCreationSource } from '../src/creation-context.mjs';

function fixture() {
  return { projectId: 'project-a', projectName: '项目 A', projectPath: '/A', requirement: { id: 'req-a', title: '背景需求' },
    descriptor: { card: { id: 'card-a', type: 'text' },
      node: { id: 'output:card-a', kind: 'generation', title: '文本任务', position: { x: 600, y: 80 },
        outputCard: { id: 'card-a', type: 'text', versionId: null, versions: [] } },
      task: { id: 'task-a', outputCardId: 'card-a', requirementId: 'req-a', sessionId: 'session-a', dispatchStatus: 'failed',
        input: { instruction: '沿用原资料生成文本', generation: { mode: 'new' }, modelSelection: { provider: 'external', model: 'original' },
          sources: [{ cardId: 'material:source-a', kind: 'material', hash: 'a'.repeat(64), content: '提交时原文' }] } },
      pendingGeneration: { taskId: 'task-a', status: 'failed', phase: 'failed', error: '发送失败' } } };
}

test('pending editor restores the exact task snapshots without inventing a successful version or referenceable placeholder', () => {
  const input = fixture();
  const context = createPendingContext(input);
  input.descriptor.task.input.sources[0].content = '后来的原文';
  input.descriptor.task.input.modelSelection.model = 'new-global';
  assert.equal(context.pendingTaskId, 'task-a');
  assert.equal(context.sessionId, 'session-a');
  assert.equal(context.references[0].content, '提交时原文');
  assert.equal(context.references[0].sourceHash, 'a'.repeat(64));
  assert.deepEqual(context.modelSelection, { provider: 'external', model: 'original' });
  assert.equal(context.anchor.sourceHash, undefined);
  assert.equal(context.anchor.sourceId, undefined);
  assert.equal(context.baseVersion, undefined);
  assert.equal(context.targetCard.outputCard.versionId, null);
  assert.deepEqual(context.targetCard.outputCard.versions, []);
  assert.equal(usableCreationSource(context.anchor), false);
});

test('pending editor rejects a task from another requirement or card', () => {
  const otherRequirement = fixture();
  otherRequirement.descriptor.task.requirementId = 'req-b';
  assert.throws(() => createPendingContext(otherRequirement), /不匹配/);
  const otherCard = fixture();
  otherCard.descriptor.task.outputCardId = 'card-b';
  assert.throws(() => createPendingContext(otherCard), /不匹配/);
});

test('only an empty card gets a short display title while its original prompt and successful titles remain intact', () => {
  const card = { kind: 'generation', title: `${'课程背景'.repeat(30)}。后续生成指令与交付要求` };
  const original = card.title;
  assert.equal(Array.from(pendingCardTitle(card)).length, 36);
  assert.ok(pendingCardTitle(card).endsWith('…'));
  assert.equal(card.title, original);
  assert.equal(pendingCardTitle({ kind: 'generation', title: '制作课程讲义。保留原文全文' }), '制作课程讲义');
  assert.equal(pendingCardTitle({ ...card, kind: 'artifact' }), original);
  assert.equal(pendingCardTitle({ kind: 'generation', title: '😀'.repeat(37) }).replace(/…$/, '').length, 70);
});

test('only unsubmitted or failed dispatch can retry; an output attachment does not hide the dispatch state', () => {
  assert.equal(pendingRetryAllowed({ status: 'draft' }), true);
  assert.equal(pendingRetryAllowed({ status: 'output', dispatchStatus: 'failed' }), true);
  for (const status of ['submitting', 'accepted', 'unknown', 'output', 'cancelled']) assert.equal(pendingRetryAllowed({ status }), false);
});

test('native waits require real interaction types and idle never becomes confirmation', () => {
  const pending = { status: 'accepted', phase: 'unknown', sessionId: 's' };
  assert.equal(pendingLabel(nativePendingState(pending, { running: false })), '本轮已结束');
  assert.equal(pendingLabel(nativePendingState({ ...pending, status: 'unknown' }, { running: false })), '状态待核对');
  assert.equal(pendingLabel(nativePendingState(pending, { running: true })), '内容正在生成');
  assert.equal(pendingLabel(nativePendingState(pending, { pendingInteraction: { kind: 'approval' } })), '等待你授权');
  assert.equal(pendingLabel(nativePendingState(pending, { pendingInteraction: { kind: 'question' } })), '等待你回答');
  assert.equal(pendingLabel(nativePendingState(pending, { pendingInteraction: { kind: 'plan-review' } })), '等待你确认方案');
  assert.equal(pendingLabel(nativePendingState(pending, { pendingInteraction: { kind: 'unrecognized' } })), '状态待核对');
  assert.equal(nativePendingState(pending, undefined), pending);
  const failed = { ...pending, status: 'failed', phase: 'failed' };
  assert.equal(nativePendingState(failed, { running: true }), failed);
  const media = { ...pending, mediaJob: { status: 'unknown' } };
  assert.equal(nativePendingState(media, { running: true }), media);
});

test('continue is available for a stopped accepted task and yields to live confirmations', () => {
  const stopped = { status: 'accepted', phase: 'idle', sessionId: 's', message: '本轮执行已取消；文件与版本见任务记录' };
  assert.equal(pendingLabel(stopped), '本轮已中断');
  assert.equal(pendingContinueAllowed(stopped), true);
  assert.equal(pendingContinueAllowed({ ...stopped, sessionId: null }), false);
  assert.equal(pendingContinueAllowed({ ...stopped, status: 'unknown' }), false);
  assert.equal(pendingContinueAllowed(nativePendingState(stopped, { running: true })), false);
  assert.equal(pendingContinueAllowed(nativePendingState(stopped, { pendingInteraction: { kind: 'question' } })), false);
  const failed = { ...stopped, phase: 'failed' };
  assert.equal(pendingContinueAllowed(nativePendingState(failed, { running: false })), true);
  assert.equal(pendingContinueAllowed(nativePendingState(failed, { running: true })), false);
});

test('published card execution can start or stop independently of its saved version', () => {
  const task = { id: 'task', kind: 'ai', status: 'output', cardVersionId: 'v1', sessionId: 's', runtimeState: { phase: 'idle' } };
  assert.equal(publishedTaskGeneration(task), undefined);
  assert.equal(publishedTaskGeneration(task, { running: true }).phase, 'generating');
  assert.equal(pendingLabel(publishedTaskGeneration(task, { running: true })), '任务仍在运行');
  assert.equal(publishedTaskGeneration(task, { running: false, pendingInteraction: { kind: 'approval' } }).phase, 'awaiting-approval');
  assert.equal(publishedTaskGeneration({ ...task, runtimeState: { phase: 'generating' } }, { running: false }), undefined);
  assert.equal(publishedTaskGeneration({ ...task, cardVersionId: undefined }, { running: true }), undefined);
});

test('board refresh detects failed and waiting transitions before any successful artifact appears', () => {
  const task = { id: 'a', outputCardId: 'c', dispatchStatus: 'accepted', sessionId: 's', runtimeState: { phase: 'generating' } };
  const original = generationStateSignature([task]);
  assert.notEqual(generationStateSignature([{ ...task, dispatchStatus: 'failed', error: '网络错误' }]), original);
  assert.notEqual(generationStateSignature([{ ...task, runtimeState: { phase: 'awaiting-input' } }]), original);
  assert.notEqual(generationStateSignature([{ ...task, cardVersionId: 'real-v1' }]), original);
  assert.equal(generationStateSignature([{ id: 'candidate', input: { workflow: 'ppt-edit', outputCardId: 'c' } }]), generationStateSignature([]));
  assert.equal(generationStateSignature([{ ...task, instruction: 'unchanged task input' }]), original);
});


test('media pending contexts keep API provider identity and legacy jobs remain explicit', () => {
  const original = fixture();
  original.descriptor.card.type = 'image';
  original.descriptor.task.kind = 'media';
  original.descriptor.task.input = { generationMethod: 'api', providerId: 'synthetic', media: { model: 'image-one' }, sources: [] };
  original.descriptor.task.mediaJob = { taskId: 'task-a', status: 'processing' };
  const api = createPendingContext(original);
  assert.equal(api.generationMethod, 'api');
  assert.equal(api.providerId, 'synthetic');
  delete original.descriptor.task.input.generationMethod;
  delete original.descriptor.task.input.providerId;
  assert.equal(createPendingContext(original).generationMethod, 'legacy');
});
