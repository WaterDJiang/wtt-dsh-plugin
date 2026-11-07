import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WorkbenchService } from '../src/service.mjs';

// Reuses the CW-11 native DrawingML fixture protocol; no model or media service is called.
async function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'wtt-cw12-ppt-model-')));
  const service = new WorkbenchService({ workspaceRoot: root });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const requirement = service.store.createRequirement({ background: '验证 PPT 局部编辑的模型冻结与确认门。', operationId: randomUUID() });
  const source = service.canvas.getBoard(requirement.id).nodes[0];
  const created = service.createTask({ requirementId: requirement.id, instruction: '人工原生 PPT 技术夹具，并非模型生成', outputType: 'pptx',
    generation: { mode: 'new' }, selectedCardIds: [source.id], sourceRefs: [{ cardId: source.id, hash: source.sourceHash }], operationId: randomUUID() });
  const file = path.join(root, created.prepared.deliveryDirectory, '人工模型协议夹具.pptx');
  const python = spawnSync('python3', ['-B', '-c', String.raw`
import sys
from pptx import Presentation
from pptx.util import Inches
p=Presentation()
for i in range(2):
 s=p.slides.add_slide(p.slide_layouts[6])
 s.shapes.add_textbox(Inches(1),Inches(1),Inches(7),Inches(1)).text='原生标题 第'+str(i+1)+'页'
 s.shapes.add_textbox(Inches(1),Inches(3),Inches(7),Inches(1)).text='保留正文与其他页'
p.save(sys.argv[1])
`, file], { encoding: 'utf8' });
  assert.equal(python.status, 0, python.stderr);
  const sessionId = `manual-protocol:${created.task.id}`;
  service.tasks.bindSession({ taskId: created.task.id, sessionId });
  const artifact = await service.tasks.files.register({ taskId: created.task.id, kind: 'pptx', title: '人工协议课件', path: file, operationId: randomUUID() }, { sessionId });
  const node = service.canvas.getBoard(requirement.id).nodes.find(node => node.outputCard);
  const scope = { requirementId: requirement.id, cardId: node.outputCard.id, versionId: node.outputCard.versionId, artifactId: artifact.id, hash: artifact.hash };
  return { root, service, requirement, sourceTask: created.task, artifact, file, scope };
}

test('PPT AI edit freezes its own provider/model, includes it in prepared data and operation identity, and does not publish before confirmation', async t => {
  const f = await fixture(t), draft = await f.service.deck.open(f.scope);
  const slide = draft.document.slides[0], element = slide.elements.find(value => value.editable);
  const modelSelection = { provider: 'custom-ppt-provider', model: 'ppt-editor-model', reasoningEffort: 'high' };
  const args = { draftId: draft.id, revision: draft.revision, slideId: slide.id, elementIds: [element.id],
    instruction: '只精简这一页选中的标题', operationId: randomUUID(), modelSelection };
  const created = f.service.deck.createAiTask(args);
  assert.equal(created.task.input.workflow, 'ppt-edit');
  assert.deepEqual(created.task.input.modelSelection, modelSelection);
  assert.deepEqual(created.prepared.modelSelection, modelSelection);
  assert.equal(created.prepared.taskId, created.task.id);
  assert.deepEqual(created.task.input.sources, f.sourceTask.input.sources);
  assert.equal(f.service.deck.createAiTask({ ...args, modelSelection: { ...modelSelection } }).task.id, created.task.id);
  for (const changed of [
    { ...modelSelection, provider: 'another-provider' },
    { ...modelSelection, model: 'another-model' },
    { ...modelSelection, reasoningEffort: 'low' },
    null,
  ]) assert.throws(() => f.service.deck.createAiTask({ ...args, modelSelection: changed }), /不同内容/);
  assert.equal(f.service.cards.binding(created.task.id), null);
  assert.equal(created.task.outputCardId, undefined);
  const before = f.service.canvas.getBoard(f.requirement.id);
  assert.equal(before.nodes.filter(node => node.outputCard).length, 1);
  assert.equal(before.nodes.find(node => node.outputCard).pendingGeneration, undefined);
  assert.equal(before.nodes.find(node => node.outputCard).outputCard.versions.length, 1);
  const sessionId = `ai-protocol:${created.task.id}`;
  f.service.tasks.bindSession({ taskId: created.task.id, sessionId });
  const candidate = await f.service.deck.propose({ taskId: created.task.id, sessionId,
    pages: [{ slideId: slide.id, changes: [{ elementId: element.id, text: '精简后的标题（人工模拟候选）' }] }] });
  assert.equal(candidate.status, 'pending');
  assert.equal(f.service.cards.binding(created.task.id), null);
  assert.deepEqual(f.service.tasks.get(created.task.id).files, []);
  assert.deepEqual(f.service.tasks.get(created.task.id).input.modelSelection, modelSelection);
  const after = f.service.canvas.getBoard(f.requirement.id);
  assert.equal(after.nodes.filter(node => node.outputCard).length, 1);
  assert.equal(after.nodes.find(node => node.outputCard).pendingGeneration, undefined);
  assert.equal(after.nodes.find(node => node.outputCard).outputCard.versions.length, 1);
  assert.equal(createHash('sha256').update(readFileSync(f.file)).digest('hex'), f.artifact.hash);
  assert.equal(f.service.deck.createAiTask(args).task.id, created.task.id, 'reading an accepted operation retains its frozen route and task');
});
