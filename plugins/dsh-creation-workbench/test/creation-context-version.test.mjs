import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creationSource, freezeCreationSource, createCardContext, createRevisionContext, updateCreationReferences, creationTaskInput } from '../src/creation-context.mjs';

const hash = value => value.repeat(64);
const requirement = { id: 'requirement-one', title: '课程需求', background: '合成验收背景' };
const physical = (name, digest = 'a') => ({ id: `artifact:${name}`, kind: 'artifact', artifactKind: 'text', refId: name,
  sourceHash: hash(digest), status: 'ready', title: name, content: `正文 ${name}`, position: { x: 80, y: 120 }, extracted: true });
const scope = { projectId: 'project-one', projectName: '项目一', projectPath: '/test/one', requirement };
function descriptor({ cardId = 'logical-output', versionId = 'version-one', number = 1, type = 'text' } = {}) {
  return { card: { id: cardId, type }, version: { id: versionId, number, taskId: 'original-task' },
    node: { ...physical('current-output', 'd'), id: `output:${cardId}`, sourceId: 'artifact:current-output', artifactKind: type,
      generatedFile: { name: 'current.png', mime: 'image/png', hash: hash('d') } },
    editor: { instruction: '/wtt-course-scriptwriter 保留原教学顺序', recorded: true, taskId: 'original-task', sessionId: 'original-session',
      references: [{ ...physical('original-source'), importedFile: { name: '参考.png', mime: 'image/png', hash: hash('b') } }],
      media: { model: 'jimeng-5.0', ratio: '4:3', resolution: '2k' } } };
}

test('stable output nodes freeze their physical version id without following a later visible version', () => {
  const visible = { ...physical('unused'), id: 'output:stable', sourceId: 'artifact:physical-v1',
    refId: 'physical-v1', generatedFile: { name: 'v1.png', hash: hash('a') } };
  const source = creationSource(visible);
  const frozen = freezeCreationSource(visible);
  visible.sourceId = 'artifact:physical-v2';
  visible.sourceHash = hash('b');
  visible.generatedFile.name = 'v2.png';
  assert.equal(source.id, 'artifact:physical-v1');
  assert.equal(frozen.id, 'artifact:physical-v1');
  assert.equal(frozen.nodeId, 'output:stable');
  assert.equal(frozen.sourceHash, hash('a'));
  assert.equal(frozen.generatedFile.name, 'v1.png');
});

test('new generation tasks send a physical source and a separate new-card target', () => {
  const frame = createCardContext({ ...scope, anchor: { ...physical('v1'), id: 'output:stable', sourceId: 'artifact:v1' },
    outputType: 'text', generation: { mode: 'new' }, outputPosition: { x: 420, y: 120 } });
  frame.instruction = '  开发新的正文  ';
  const input = creationTaskInput(frame);
  assert.deepEqual(input.generation, { mode: 'new' });
  assert.deepEqual(input.selectedCardIds, ['artifact:v1']);
  assert.deepEqual(input.sourceRefs, [{ cardId: 'artifact:v1', hash: hash('a') }]);
  assert.equal(input.instruction, '开发新的正文');
  assert.equal(frame.anchor.nodeId, 'output:stable');
  input.generation.mode = 'changed';
  input.outputPosition.x = 999;
  assert.equal(frame.generation.mode, 'new');
  assert.equal(frame.outputPosition.x, 420);
});

test('revision restores the exact prompt, references and media while keeping its output separate', () => {
  const original = descriptor({ type: 'image' });
  const frame = createRevisionContext({ ...scope, descriptor: original });
  assert.equal(frame.intent, 'revise');
  assert.equal(frame.targetCard.id, 'output:logical-output');
  assert.equal(frame.anchor.id, 'artifact:current-output');
  assert.equal(frame.instruction, original.editor.instruction);
  assert.deepEqual(frame.mediaOptions, original.editor.media);
  assert.deepEqual(frame.references.map(value => value.id), ['artifact:original-source']);
  assert(!frame.references.some(value => value.id === frame.anchor.id));
  assert.equal(frame.taskId, 'original-task');
  assert.equal(frame.sessionId, 'original-session');
  original.editor.references[0].importedFile.name = 'later.png';
  original.editor.references[0].sourceHash = hash('c');
  original.editor.media.ratio = '1:1';
  original.node.generatedFile.name = 'later-output.png';
  assert.equal(frame.references[0].importedFile.name, '参考.png');
  assert.equal(frame.references[0].sourceHash, hash('a'));
  assert.equal(frame.mediaOptions.ratio, '4:3');
  assert.equal(frame.targetCard.generatedFile.name, 'current.png');
});

test('a revision can remove every old reference and sends its own card/base without self-reference', () => {
  const original = createRevisionContext({ ...scope, descriptor: descriptor() });
  const frame = updateCreationReferences(original, []);
  const input = creationTaskInput(frame);
  assert.deepEqual(frame.references, []);
  assert.deepEqual(input.selectedCardIds, []);
  assert.deepEqual(input.sourceRefs, []);
  assert.deepEqual(input.generation, { mode: 'revise', cardId: 'logical-output', baseVersionId: 'version-one' });
  assert.deepEqual(input.selectedSkills, ['wtt-course-scriptwriter']);
  assert.equal(input.outputType, 'text');
  assert.equal(input.sessionId, undefined);
  assert.equal(input.taskId, undefined);
  assert.equal(original.references.length, 1);
});

test('a later visible source version is added explicitly without rewriting the old version reference', () => {
  const frame = createRevisionContext({ ...scope, descriptor: descriptor() });
  const old = frame.references[0];
  const changedVisible = { ...physical('new-source', 'b'), id: 'output:source-card', sourceId: 'artifact:new-source' };
  const updated = updateCreationReferences(frame, [old, changedVisible]);
  changedVisible.content = 'later edit';
  assert.deepEqual(creationTaskInput(updated).sourceRefs, [
    { cardId: 'artifact:original-source', hash: hash('a') }, { cardId: 'artifact:new-source', hash: hash('b') },
  ]);
  assert.equal(updated.references[1].nodeId, 'output:source-card');
  assert.equal(updated.references[1].content, '正文 new-source');
});

test('draft identities isolate project, requirement, logical card and selected base version', () => {
  const first = createRevisionContext({ ...scope, descriptor: descriptor() });
  const otherVersion = createRevisionContext({ ...scope, descriptor: descriptor({ versionId: 'version-two', number: 2 }) });
  const otherCard = createRevisionContext({ ...scope, descriptor: descriptor({ cardId: 'another-output' }) });
  const otherProject = createRevisionContext({ ...scope, projectId: 'project-two', descriptor: descriptor() });
  const otherRequirement = createRevisionContext({ ...scope, requirement: { ...requirement, id: 'requirement-two' }, descriptor: descriptor() });
  assert.equal(new Set([first, otherVersion, otherCard, otherProject, otherRequirement].map(value => value.key)).size, 5);
  first.instruction = '只保留在第一版的草稿';
  assert.equal(otherVersion.instruction, '/wtt-course-scriptwriter 保留原教学顺序');
  assert.equal(creationTaskInput(first).generation.baseVersionId, 'version-one');
  assert.equal(creationTaskInput(otherVersion).generation.baseVersionId, 'version-two');
});

test('legacy manual versions report missing prompt history and do not invent one', () => {
  const original = descriptor();
  original.editor = { recorded: false, references: [], referenceNotes: ['原引用文件已缺失'] };
  const frame = createRevisionContext({ ...scope, descriptor: original });
  assert.equal(frame.recorded, false);
  assert.equal(frame.instruction, '');
  assert.deepEqual(frame.references, []);
  assert.deepEqual(frame.referenceNotes, ['原引用文件已缺失']);
  assert.equal(frame.sessionId, null);
  assert.equal(frame.taskId, 'original-task');
});

test('revision allows twenty-four explicit references, rejects a twenty-fifth, and new-source mode remains pinned', () => {
  const frame = createRevisionContext({ ...scope, descriptor: descriptor() });
  const cards = Array.from({ length: 25 }, (_, index) => physical(`source-${index}`));
  assert.equal(updateCreationReferences(frame, cards.slice(0, 24)).references.length, 24);
  assert.throws(() => updateCreationReferences(frame, cards), /最多引用 24/);
  const fresh = createCardContext({ ...scope, anchor: physical('pinned'), outputType: 'text', outputPosition: { x: 420, y: 120 } });
  assert.deepEqual(updateCreationReferences(fresh, []).references.map(value => value.id), ['artifact:pinned']);
});

test('editing a legacy text workflow never restores removed Skills or its previous typed pipeline', () => {
  const skills = { outline: 'wtt-course-eight-steps-dev', exercise: 'wtt-course-exercise-builder', script: 'wtt-course-scriptwriter' };
  for (const [outputType, skill] of Object.entries(skills)) {
    const original = descriptor({ type: 'text' });
    original.editor.instruction = '沿用教学目标，精简第三部分';
    original.editor.outputType = outputType;
    original.editor.selectedSkills = [skill];
    const frame = createRevisionContext({ ...scope, descriptor: original });
    assert.equal(frame.outputType, 'text');
    assert.equal(frame.workflowType, undefined);
    assert.equal(frame.instruction, original.editor.instruction);
    assert(!frame.instruction.includes(`/${skill}`));
    assert.deepEqual(frame.selectedSkills, [skill]);
    const input = creationTaskInput(frame);
    assert.equal(input.outputType, 'text');
    assert.equal(input.instruction, '沿用教学目标，精简第三部分');
    assert.deepEqual(input.selectedSkills, []);
    assert.deepEqual(input.generation, { mode: 'revise', cardId: 'logical-output', baseVersionId: 'version-one' });
  }
});

test('PPT, image and video cards never inherit a text-family workflow from unrelated editor metadata', () => {
  for (const type of ['pptx', 'image', 'video']) {
    for (const oldType of ['outline', 'exercise', 'script']) {
      const original = descriptor({ type });
      original.editor.outputType = oldType;
      const frame = createRevisionContext({ ...scope, descriptor: original });
      assert.equal(frame.outputType, type);
      assert.equal(frame.workflowType, undefined);
    }
  }
});

test('ordinary text and non-text legacy types do not become a default course workflow', () => {
  for (const oldType of ['text', 'pptx', 'image', 'video', undefined]) {
    const original = descriptor({ type: 'text' });
    original.editor.outputType = oldType;
    original.editor.instruction = '直接输出精简文本';
    const frame = createRevisionContext({ ...scope, descriptor: original });
    assert.equal(frame.workflowType, undefined);
    assert.equal(creationTaskInput(frame).outputType, 'text');
    assert.equal(frame.instruction, '直接输出精简文本');
  }
});
