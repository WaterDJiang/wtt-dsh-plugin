import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchService } from '../src/service.mjs';
import { cardCapabilities } from '../src/card-capabilities.mjs';
import { createLayoutHistory } from '../src/canvas-history.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cw26-text-'));
  const service = new WorkbenchService({ workspaceRoot: root });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const req = service.store.createRequirement({ background: '虚构测试背景', operationId: randomUUID() });
  const board = () => service.canvas.getBoard(req.id);
  const edit = (node, content, extra = {}) => service.canvas.saveCardText({ requirementId: req.id,
    cardId: node.outputCard?.id || node.id, versionId: node.outputCard?.versionId, sourceHash: node.sourceHash,
    content, operationId: randomUUID(), ...extra });
  return { root, service, req, board, edit };
}

test('capability matrix covers every card shape with unified decisions', t => {
  const requirement = { kind: 'requirement', requirementBackground: '背景', sourceHash: 'h' };
  const projectRef = { kind: 'material', extracted: false, sourceHash: 'h', materialVersions: [{ id: 'v1', number: 1 }],
    projectFile: { path: '需求文档.md', status: 'ready' }, importedFile: { mime: 'text/markdown', name: '需求文档.md' } };
  const imported = { kind: 'material', extracted: true, sourceHash: 'h', importedFile: { mime: 'text/markdown', name: '外部.md', path: 'courses/x/imports/op/外部.md' } };
  const importedPdf = { kind: 'material', extracted: true, sourceHash: 'h', importedFile: { mime: 'application/pdf', name: '报告.pdf', path: 'courses/x/imports/op/报告.pdf' } };
  const importedImage = { kind: 'material', extracted: true, sourceHash: 'h', importedFile: { mime: 'image/png', name: '图.png', path: 'courses/x/imports/op/图.png' } };
  const importedVideo = { kind: 'material', extracted: true, sourceHash: 'h', importedFile: { mime: 'video/mp4', name: '片.mp4', path: 'courses/x/imports/op/片.mp4' } };
  const plain = { kind: 'material', extracted: true, sourceHash: 'h', path: 'courses/x/materials/素材.md' };
  const linked = { kind: 'material', extracted: true, sourceHash: 'h', sourcePath: '资料/原件.md', path: 'courses/x/materials/素材-2.md' };
  const excerpt = { kind: 'excerpt', extracted: true, sourceHash: 'h', path: 'courses/x/materials/摘录.md' };
  const outline = { kind: 'outline', content: '# 大纲', outputCard: { versions: [{ id: 'v', number: 1 }], versionId: 'v' } };
  const artifact = { kind: 'artifact', artifactKind: 'text', path: '产物/课/卡/V001/正文.md', extracted: true, outputCard: { versions: [{ id: 'v', number: 1 }], versionId: 'v' } };
  const artifactPptx = { kind: 'artifact', artifactKind: 'pptx', path: '产物/课/卡/V001/课件.pptx', outputCard: { type: 'pptx', versions: [{ id: 'v', number: 1 }], versionId: 'v' } };
  const word = { kind: 'word', path: '产物/课/大纲.docx', outputCard: { versions: [{ id: 'v', number: 1 }], versionId: 'v' } };
  const generation = { kind: 'generation' };

  assert.deepEqual(cardCapabilities(requirement), { format: 'text', purpose: '背景', editableText: { editable: true, base: '背景' },
    writeBack: { mode: 'background', path: null }, openWith: null, versioned: false, aiChat: true });
  assert.deepEqual(cardCapabilities(projectRef).writeBack, { mode: 'project-file', path: '需求文档.md' });
  assert.equal(cardCapabilities(projectRef).editableText.base, '');
  assert.equal(cardCapabilities(projectRef).openWith.path, '需求文档.md');
  assert.equal(cardCapabilities(projectRef).openWith.category, 'text');
  assert.equal(cardCapabilities(projectRef).versioned, true);
  assert.deepEqual(cardCapabilities(imported).writeBack, { mode: 'none', path: null });
  assert.equal(cardCapabilities(imported).openWith.category, 'text');
  assert.equal(cardCapabilities(imported).versioned, false);
  assert.deepEqual(cardCapabilities(importedPdf).writeBack, { mode: 'none', path: null });
  assert.equal(cardCapabilities(importedPdf).editableText.base, null);
  assert.equal(cardCapabilities(importedPdf).openWith.category, 'office');
  assert.equal(cardCapabilities(importedImage).openWith.category, 'view');
  assert.equal(cardCapabilities(importedVideo).openWith.category, 'view');
  assert.equal(cardCapabilities(importedImage).editableText.base, null);
  assert.deepEqual(cardCapabilities(plain).writeBack, { mode: 'snapshot', path: 'courses/x/materials/素材.md' });
  assert.equal(cardCapabilities(plain).versioned, true);
  assert.deepEqual(cardCapabilities(linked).writeBack, { mode: 'none', path: null });
  assert.deepEqual(cardCapabilities(excerpt).writeBack, { mode: 'none', path: null });
  const outlineCaps = cardCapabilities(outline);
  assert.equal(outlineCaps.writeBack.mode, 'version');
  assert.equal(outlineCaps.versioned, true);
  assert.equal(outlineCaps.openWith, null);
  const artifactCaps = cardCapabilities(artifact);
  assert.equal(artifactCaps.writeBack.mode, 'version');
  assert.equal(artifactCaps.versioned, true);
  assert.equal(artifactCaps.openWith.category, 'text');
  assert.equal(cardCapabilities(artifactPptx).editableText.base, null);
  assert.equal(cardCapabilities(artifactPptx).openWith.category, 'office');
  assert.equal(cardCapabilities(word).format, 'document');
  assert.equal(cardCapabilities(word).openWith.category, 'office');
  assert.equal(cardCapabilities(generation).aiChat, false);
  assert.equal(cardCapabilities(generation).editableText.base, null);
});

test('background edits replay without overwriting concurrent changes; source mismatch is visible', t => {
  const { board, edit, service, req } = fixture(t);
  const initial = board().nodes[0], op = randomUUID();
  const result = edit(initial, '第一次修改', { operationId: op });
  const second = board().nodes[0];
  edit(second, '第二次修改');
  assert.deepEqual(edit(initial, '第一次修改', { operationId: op }), result);
  assert.equal(service.store.getRequirement(req.id).background, '第二次修改');
  assert.throws(() => edit(initial, '过期编辑'), /来源内容已变化/);
  assert.throws(() => edit(initial, '不同输入', { operationId: op }), /已用于不同内容/);
});

test('manual outline edit adopts the same card, appends from old base and preserves all files', t => {
  const { service, root, req, board, edit } = fixture(t);
  const original = service.store.saveOutline({ requirementId: req.id, markdown: '# 第一版', operationId: randomUUID() });
  const one = board().nodes.find(node => node.kind === 'outline');
  const op = randomUUID();
  const result = edit(one, '# 第二版', { operationId: op });
  assert.ok(result.versionId);
  assert.deepEqual(edit(one, '# 第二版', { operationId: op }), result);
  edit(one, '# 从第一版追加第三版');
  const current = board().nodes.find(node => node.outputCard);
  assert.equal(current.outputCard.versions.length, 3);
  assert.equal(current.outputCard.number, 3);
  assert.equal(current.outputCard.versions.at(-1).baseVersionId, one.outputCard.versionId);
  assert.equal(current.kind, 'outline');
  assert.equal(readFileSync(path.join(root, original.markdownPath), 'utf8'), '# 第一版');
});

test('manual text edit creates real same-card files and preserves original prompt/references without a model session', async t => {
  const { service, root, req, board, edit } = fixture(t);
  const created = service.createTask({ requirementId: req.id, instruction: '原始提示词', outputType: 'text', selectedCardIds: [],
    sourceRefs: [], selectedSkills: [], generation: { mode: 'new' }, operationId: randomUUID() });
  const relative = `${created.prepared.deliveryDirectory}/body.md`;
  writeFileSync(path.join(root, relative), '# 原文');
  const sessionId = `fixture:${randomUUID()}`;
  service.tasks.bindSession({ taskId: created.task.id, sessionId });
  const original = await service.tasks.files.register({ taskId: created.task.id, operationId: randomUUID(), path: relative, kind: 'text', title: '文本卡' }, { sessionId });
  const one = board().nodes.find(node => node.outputCard);
  const op = randomUUID(), two = edit(one, '# 人工新版', { operationId: op });
  assert.deepEqual(edit(one, '# 人工新版', { operationId: op }), two);
  edit(one, '# 基于第一版');
  const described = service.cards.describe({ requirementId: req.id, cardId: one.outputCard.id });
  assert.equal(described.card.versions.length, 3);
  assert.equal(described.version.baseVersionId, one.outputCard.versionId);
  assert.equal(described.editor.instruction, '原始提示词');
  assert.equal(described.editor.sessionId, null);
  assert.equal(service.tasks.files.read(described.node.refId).bytes.toString(), '# 基于第一版');
  assert.equal(service.tasks.files.read(original.id).bytes.toString(), '# 原文');
  assert.ok(described.node.delivery.path.includes('产物/'));
  writeFileSync(path.join(root, original.path), '外改');
  assert.throws(() => edit(one, '# 不得继续'), /外部修改|不可用/);
});

test('plain material edits write back to their own snapshot, append version history and refuse external changes', t => {
  const { service, req, board, edit, root } = fixture(t);
  service.canvas.addMaterial({ requirementId: req.id, title: '原素材', content: '原素材内容', operationId: randomUUID() });
  const one = board().nodes.find(node => node.kind === 'material');
  assert.equal(one.materialVersions.length, 1);
  assert.equal(one.materialVersions[0].origin, 'import');
  const op = randomUUID(), result = edit(one, '修订内容', { operationId: op });
  assert.deepEqual(edit(one, '修订内容', { operationId: op }), result);
  assert.equal(board().nodes.filter(node => node.kind === 'material').length, 1);
  const same = board().nodes.find(node => node.id === one.id);
  assert.equal(same.content, '修订内容');
  assert.equal(result.savedTo, path.basename(same.path));
  assert.equal(readFileSync(path.join(root, same.path), 'utf8'), '修订内容');
  assert.equal(same.materialVersions.length, 2);
  assert.equal(same.materialVersions.at(-1).origin, 'card-edit');
  assert.equal(same.currentMaterialVersionId, same.materialVersions.at(-1).id);
  const history = service.canvas.materialVersion({ requirementId: req.id, materialId: same.refId, versionId: same.materialVersions[0].id });
  assert.equal(history.content, '原素材内容');
  assert.equal(history.number, 1);
  assert.throws(() => service.canvas.materialVersion({ requirementId: req.id, materialId: same.refId, versionId: randomUUID() }), /不存在/);
  writeFileSync(path.join(root, same.path), '外部改写');
  const before = board().nodes.find(node => node.id === one.id).materialVersions.length;
  assert.throws(() => edit(same, '不得覆盖外部修改'), /外部修改/);
  assert.equal(readFileSync(path.join(root, same.path), 'utf8'), '外部改写');
  assert.equal(board().nodes.find(node => node.id === one.id).materialVersions.length, before);
  for (const ext of ['pdf', 'docx', 'pptx', 'png', 'mp4']) assert.equal(cardCapabilities({ kind: 'artifact', path: `x.${ext}`, content: '提取正文' }).editableText.base, null);
});

test('empty text file cards edit from a blank body; external imports save as new material; strict formats stay blocked', async t => {
  const { service, req, board, edit, root } = fixture(t);
  writeFileSync(path.join(root, '需求文档.md'), '');
  const preview = await service.projectFiles.preview('需求文档.md');
  const ref = await service.projectFiles.reference({ requirementId: req.id, path: '需求文档.md', hash: preview.hash, operationId: randomUUID() });
  const node = ref.board.nodes.find(item => item.refId === ref.material.id);
  assert.equal(node.extracted, false);
  assert.equal(node.importedFile.mime, 'text/markdown');
  assert.equal(node.materialVersions.length, 1);
  assert.throws(() => service.canvas.addExcerpt({ requirementId: req.id, title: '摘录', sourceCardId: node.id, sourceHash: node.sourceHash,
    start: 0, end: 4, quote: '摘录', annotation: '', operationId: randomUUID() }), /未提取正文/);
  const imported = await service.canvas.importMaterial({ requirementId: req.id, filename: '外部笔记.md', bytes: new TextEncoder().encode(''), operationId: randomUUID() });
  const importedNode = imported.board.nodes.find(item => item.refId === imported.material.id);
  assert.equal(importedNode.projectFile, undefined);
  const op = randomUUID();
  const result = edit(importedNode, '拖入后写的正文', { operationId: op });
  assert.deepEqual(edit(importedNode, '拖入后写的正文', { operationId: op }), result);
  const materials = board().nodes.filter(item => item.kind === 'material');
  assert.equal(materials.length, 3);
  const original = board().nodes.find(item => item.id === importedNode.id);
  assert.equal(original.extracted, false);
  assert.match(original.content, /未提取正文/);
  assert.ok(board().nodes.some(item => item.kind === 'material' && item.content === '拖入后写的正文'));
});

test('project file reference cards write edits back to the source file in place, append history; external changes are refused', async t => {
  const { service, req, board, edit, root } = fixture(t);
  writeFileSync(path.join(root, '需求文档.md'), '');
  const preview = await service.projectFiles.preview('需求文档.md');
  const ref = await service.projectFiles.reference({ requirementId: req.id, path: '需求文档.md', hash: preview.hash, operationId: randomUUID() });
  const node = ref.board.nodes.find(item => item.refId === ref.material.id);
  assert.ok(node.projectFile);
  const op = randomUUID();
  const result = edit(node, '写回原文件的内容', { operationId: op });
  assert.equal(result.savedTo, '需求文档.md');
  assert.deepEqual(edit(node, '写回原文件的内容', { operationId: op }), result);
  assert.equal(readFileSync(path.join(root, '需求文档.md'), 'utf8'), '写回原文件的内容');
  const same = board().nodes.find(item => item.id === node.id);
  assert.equal(same.content, '写回原文件的内容');
  assert.equal(same.extracted, true);
  assert.equal(same.projectFile.status, 'ready');
  const after = await service.projectFiles.preview('需求文档.md');
  assert.equal(after.hash, same.sourceHash);
  assert.equal(board().nodes.filter(item => item.kind === 'material').length, 1);
  assert.equal(same.materialVersions.length, 2);
  assert.equal(same.materialVersions.at(-1).origin, 'card-edit');
  service.canvas.addExcerpt({ requirementId: req.id, title: '摘录', sourceCardId: node.id, sourceHash: same.sourceHash,
    start: 0, end: 4, quote: '写回原文', annotation: '', operationId: randomUUID() });
  writeFileSync(path.join(root, '需求文档.md'), '外部改写');
  const versionsBefore = board().nodes.find(item => item.id === node.id).materialVersions.length;
  assert.throws(() => edit(same, '不得覆盖外部修改'), /外部修改/);
  assert.equal(readFileSync(path.join(root, '需求文档.md'), 'utf8'), '外部改写');
  assert.equal(board().nodes.find(item => item.id === node.id).materialVersions.length, versionsBefore);
});

test('card open applications list direct formats and keep office on the working-copy flow', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cw-open-'));
  const calls = [];
  const service = new WorkbenchService({ workspaceRoot: root, projectFileLauncher: async (file, args) => { calls.push([path.basename(file), ...args.map(arg => arg === file ? 'FILE' : arg)]); } });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const req = service.store.createRequirement({ background: '打开方式', operationId: randomUUID() });
  writeFileSync(path.join(root, '笔记.md'), '内容');
  writeFileSync(path.join(root, '报告.pdf'), '%PDF-fake');
  const apps = await service.openCardApplications({ path: '笔记.md' });
  assert.equal(apps.mode, 'direct');
  assert.equal(apps.fileName, '笔记.md');
  assert.equal(apps.applications[0].id, 'default');
  const opened = await service.openCardApplication({ path: '笔记.md', application: 'default' });
  assert.equal(opened.fileName, '笔记.md');
  assert.deepEqual(calls, [['笔记.md', 'FILE']]);
  await assert.rejects(service.openCardApplication({ path: '报告.pdf', application: 'default' }), /预览/);
  await assert.rejects(service.openCardApplications({ path: '../逃逸.md' }));
});

test('externally deleted project source files fail edits cleanly and restore from card content re-links', async t => {
  const { service, req, board, edit, root } = fixture(t);
  writeFileSync(path.join(root, '需求文档.md'), '');
  const preview = await service.projectFiles.preview('需求文档.md');
  const ref = await service.projectFiles.reference({ requirementId: req.id, path: '需求文档.md', hash: preview.hash, operationId: randomUUID() });
  const node = ref.board.nodes.find(item => item.refId === ref.material.id);
  const op = randomUUID();
  const result = edit(node, '卡片上的正文', { operationId: op });
  assert.equal(result.savedTo, '需求文档.md');
  rmSync(path.join(root, '需求文档.md'));
  const stale = board().nodes.find(item => item.id === node.id);
  assert.equal(stale.projectFile.status, 'missing');
  const op2 = randomUUID();
  assert.throws(() => edit(stale, '源文件没了还写', { operationId: op2 }), /源文件已被删除/);
  assert.equal(existsSync(path.join(root, '需求文档.md')), false);
  writeFileSync(path.join(root, '需求文档.md'), '占用');
  await assert.rejects(Promise.resolve().then(() => service.canvas.restoreMaterialProjectFile({ requirementId: req.id, materialId: stale.refId })), /已存在文件/);
  rmSync(path.join(root, '需求文档.md'));
  const restored = service.canvas.restoreMaterialProjectFile({ requirementId: req.id, materialId: stale.refId });
  assert.equal(restored.fileName, '需求文档.md');
  assert.equal(readFileSync(path.join(root, '需求文档.md'), 'utf8'), '卡片上的正文');
  const relinked = board().nodes.find(item => item.id === node.id);
  assert.equal(relinked.projectFile.status, 'ready');
  const after = await service.projectFiles.preview('需求文档.md');
  assert.equal(after.hash, relinked.sourceHash);
  const op3 = randomUUID();
  edit(relinked, '恢复链接后再编辑', { operationId: op3 });
  assert.equal(readFileSync(path.join(root, '需求文档.md'), 'utf8'), '恢复链接后再编辑');
});

test('externally deleted material snapshots self-heal on save; missing import copies block save-as clearly', async t => {
  const { service, req, board, edit, root } = fixture(t);
  service.canvas.addMaterial({ requirementId: req.id, title: '自愈素材', content: '初始内容', operationId: randomUUID() });
  const one = board().nodes.find(node => node.kind === 'material');
  rmSync(path.join(root, one.path));
  const stale = board().nodes.find(node => node.id === one.id);
  assert.equal(stale.status, 'missing');
  edit(stale, '自愈后的新内容', { operationId: randomUUID() });
  const healed = board().nodes.find(node => node.id === one.id);
  assert.equal(healed.status, 'ready');
  assert.equal(readFileSync(path.join(root, healed.path), 'utf8'), '自愈后的新内容');
  assert.equal(healed.materialVersions.at(-1).origin, 'card-edit');
  const imported = await service.canvas.importMaterial({ requirementId: req.id, filename: '外部导入.md', bytes: new TextEncoder().encode('导入正文'), operationId: randomUUID() });
  const importNode = imported.board.nodes.find(item => item.refId === imported.material.id);
  assert.equal(importNode.projectFile, undefined);
  const importCopy = path.join(root, importNode.importedFile.path);
  rmSync(importCopy);
  const staleImport = board().nodes.find(item => item.id === importNode.id);
  assert.equal(staleImport.sourceStatus, 'missing');
  const op = randomUUID();
  assert.throws(() => edit(staleImport, '另存新素材应被拦截', { operationId: op }), /来源文件不可用|已外改/);
  assert.equal(board().nodes.filter(item => item.kind === 'material').length, 2);
});
