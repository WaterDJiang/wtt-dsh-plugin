import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { cpSync, writeFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { apply } from '../src/index.mjs';
import { WorkbenchService } from '../src/service.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const python = (script, ...args) => {
  const result = spawnSync('python3', ['-B', '-c', script, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

// This is a manually created protocol fixture, not a real model generation.
async function seed(root) {
  const service = new WorkbenchService({ workspaceRoot: root });
  try {
    const requirement = service.store.createRequirement({ title: 'CW11 HTTP 人工协议验收', operationId: randomUUID() });
    const source = service.canvas.getBoard(requirement.id).nodes[0];
    const created = service.createTask({ requirementId: requirement.id, instruction: '人工创建三页原生PPT，验证协议，不是模型输出',
      outputType: 'pptx', generation: { mode: 'new' }, selectedCardIds: [source.id],
      sourceRefs: [{ cardId: source.id, hash: source.sourceHash }], operationId: randomUUID() });
    const file = path.join(root, created.prepared.deliveryDirectory, '人工协议课件.pptx');
    python(String.raw`
import sys
from pptx import Presentation
from pptx.util import Inches,Pt
p=Presentation();p.slide_width=Inches(40/3);p.slide_height=Inches(7.5)
for i in range(3):
 s=p.slides.add_slide(p.slide_layouts[6])
 box=s.shapes.add_textbox(Inches(1),Inches(1),Inches(10),Inches(1));box.text='HTTP 原生中文标题 第'+str(i+1)+'页'
 box.text_frame.paragraphs[0].runs[0].font.size=Pt(28)
 s.shapes.add_textbox(Inches(1),Inches(3),Inches(10),Inches(1)).text='这一段及其他页面保留。'
 if i==0:s.notes_slide.notes_text_frame.text='原有讲师备注'
p.save(sys.argv[1])
`, file);
    const sessionId = `manual-protocol-fixture:${created.task.id}`;
    service.tasks.bindSession({ taskId: created.task.id, sessionId });
    const artifact = await service.tasks.files.register({ taskId: created.task.id, kind: 'pptx', title: '人工协议课件',
      path: file, operationId: randomUUID() }, { sessionId });
    const node = service.canvas.getBoard(requirement.id).nodes.find(node => node.outputCard);
    return { requirementId: requirement.id, original: readFileSync(file), file, artifact, sourceTaskId: created.task.id,
      scope: { requirementId: requirement.id, cardId: node.outputCard.id, versionId: node.outputCard.versionId,
        artifactId: artifact.id, hash: artifact.hash } };
  } finally { service.close(); }
}

function application(config) {
  const disposers = [], tools = new Map();
  let endpoint, closed = false;
  const ctx = {
    effect(action) { const dispose = action(); if (typeof dispose === 'function') disposers.push(dispose); },
    connection: { fetch: { register(entry) { endpoint = entry; return () => {}; } } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } },
    skills: { register() { return () => {}; } },
  };
  apply(ctx, config);
  const response = (query = {}, action, data, options = {}) => {
    const url = new URL('http://localhost/api/wtt-creation-workbench');
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
    return endpoint.fetch(new Request(url, { ...(action ? { method: 'POST', body: JSON.stringify({ action, data }) } : {}), ...options }));
  };
  const json = async res => { const body = await res.json(); assert.equal(res.status, 200, body.error); return body; };
  return { tools, response,
    get: async query => json(await response(query)),
    call: async (action, data, projectId) => json(await response({ projectId }, action, data)),
    close() { if (!closed) { closed = true; for (const dispose of disposers.reverse()) dispose(); } },
  };
}

function context(t) {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wtt-ppt-http-')));
  const root = path.join(directory, 'A'); mkdirSync(root);
  const config = { workspaceRoot: root, registryFile: path.join(directory, 'projects.json') };
  const applications = [];
  t.after(() => { for (const app of applications) app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, root, create() { const app = application(config); applications.push(app); return app; } };
}
const execution = (cwd, sessionId) => ({ signal: new AbortController().signal,
  agent: { id: sessionId, session: { header: { cwd } } } });
const patch = (draft, text, page = 0) => [{ slideId: draft.document.slides[page].id,
  changes: [{ elementId: draft.document.slides[page].elements.find(element => element.editable).id, text }] }];
const outputCard = board => board.nodes.find(node => node.outputCard);

test('PPT HTTP and Agent tool share drafts/candidates; explicit confirmation and manual save append immutable same-card versions', async t => {
  const f = context(t), fixture = await seed(f.root), app = f.create();
  const projectId = (await app.get({ projects: 1 })).defaultProjectId;
  const originalTask = await app.get({ projectId, task: fixture.sourceTaskId });
  const draft = await app.call('ppt-open', fixture.scope, projectId);
  assert.equal(draft.document.slides.length, 3); assert.equal(draft.dirty, false);
  const pages = patch(draft, 'AI 冻结时看到的人工草稿');
  pages[0].notes = '人工草稿里的讲师备注';
  const edited = await app.call('ppt-save-draft', { draftId: draft.id, revision: draft.revision, pages }, projectId);
  assert.equal(edited.revision, 1); assert.equal(edited.dirty, true);
  const args = { draftId: draft.id, revision: edited.revision, slideId: edited.document.slides[0].id,
    elementIds: [], instruction: '仅精简第一页标题与讲师备注', operationId: randomUUID() };
  const created = await app.call('ppt-create-ai', args, projectId);
  assert.equal(created.task.input.workflow, 'ppt-edit');
  assert.equal(created.prepared.projectId, projectId);
  assert.equal(created.prepared.cwd, f.root);
  assert.equal(created.prepared.taskId, created.task.id);
  assert.ok(created.prepared.prompt.includes(`projectId=${projectId}`));
  assert.match(created.prepared.prompt, /course_propose_ppt_edit/);
  assert.equal(created.task.input.pptEdit.page.elements[0].text, 'AI 冻结时看到的人工草稿');
  assert.deepEqual(created.task.input.sources, originalTask.input.sources);
  assert.equal((await app.call('ppt-create-ai', args, projectId)).task.id, created.task.id);
  const sessionId = `protocol-only-session:${created.task.id}`;
  await app.call('bind-task-session', { taskId: created.task.id, sessionId }, projectId);
  await app.call('set-task-dispatch', { taskId: created.task.id, status: 'accepted' }, projectId);
  const tool = app.tools.get('course_propose_ppt_edit');
  assert.ok(tool.parameters.properties.pages); assert.ok(tool.parameters.properties.projectId);
  const proposalPages = patch(edited, '第一页精简后的中文标题'); proposalPages[0].notes = '仅保留关键讲师提示';
  const candidate = JSON.parse(await tool.execute({ projectId, taskId: created.task.id, pages: proposalPages }, execution(f.root, sessionId)));
  assert.equal(candidate.status, 'pending');
  assert.equal(candidate.proposal.changes.find(change => change.kind === 'text').before, 'AI 冻结时看到的人工草稿');
  assert.equal(candidate.proposal.changes.find(change => change.kind === 'notes').after, '仅保留关键讲师提示');
  const waiting = await app.get({ projectId, pptProposal: created.task.id });
  assert.equal(waiting.proposal.id, candidate.proposal.id);
  assert.equal((await app.get({ projectId, task: created.task.id })).files.length, 0);
  const beforeConfirm = await app.get({ projectId, canvas: fixture.requirementId });
  assert.equal(outputCard(beforeConfirm).outputCard.versions.length, 1);

  const preview = await app.call('ppt-preview', { draftId: candidate.proposal.draftId, revision: candidate.proposal.revision }, projectId);
  assert.equal(preview.status, 'ready', preview.error); assert.equal(preview.pageCount, 3);
  assert.equal(preview.chineseGlyphCheck, 'passed');
  const previewQuery = { projectId, pptPreviewPage: candidate.proposal.draftId, revision: candidate.proposal.revision, page: 1 };
  const image = await app.response(previewQuery);
  assert.equal(image.status, 200); assert.match(image.headers.get('content-type'), /^image\/png/);
  const imageBytes = Buffer.from(await image.arrayBuffer());
  assert.deepEqual(imageBytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(hash(imageBytes), preview.pages[0].hash);
  const head = await app.response(previewQuery, undefined, undefined, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(Number(head.headers.get('content-length')), imageBytes.length);
  const range = await app.response(previewQuery, undefined, undefined, { headers: { Range: 'bytes=0-63' } });
  assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), imageBytes.subarray(0, 64));
  assert.equal((await app.get({ projectId, task: created.task.id })).files.length, 0, 'preview must not publish a formal artifact');

  const confirmation = { taskId: created.task.id, proposalId: candidate.proposal.id, operationId: randomUUID() };
  const saved = await app.call('ppt-confirm', confirmation, projectId);
  assert.equal(saved.descriptor.version.number, 2); assert.equal(saved.descriptor.version.baseVersionId, fixture.scope.versionId);
  assert.equal(saved.artifact.validation.editability.ok, true);
  assert.equal((await app.call('ppt-confirm', confirmation, projectId)).artifact.id, saved.artifact.id);
  assert.equal((await app.call('ppt-confirm', { ...confirmation, operationId: randomUUID() }, projectId)).artifact.id, saved.artifact.id);
  assert.equal((await app.get({ projectId, pptProposal: created.task.id })).status, 'confirmed');
  const download = await app.response({ projectId, downloadArtifact: saved.artifact.id });
  assert.equal(download.status, 200); assert.equal(hash(Buffer.from(await download.arrayBuffer())), saved.artifact.hash);
  const actual = JSON.parse(python('import json,sys;from pptx import Presentation;p=Presentation(sys.argv[1]);print(json.dumps({"title":p.slides[0].shapes[0].text,"notes":p.slides[0].notes_slide.notes_text_frame.text,"other":p.slides[1].shapes[0].text},ensure_ascii=False))', path.join(f.root, saved.artifact.path)));
  assert.equal(actual.title, '第一页精简后的中文标题'); assert.equal(actual.notes, '仅保留关键讲师提示');
  assert.equal(actual.other, 'HTTP 原生中文标题 第2页');

  const reopenedV1 = await app.call('ppt-open', fixture.scope, projectId);
  assert.equal(reopenedV1.id, draft.id);
  assert.equal(reopenedV1.dirty, false, 'publishing clears the consumed base-version draft');
  assert.ok(reopenedV1.revision > edited.revision);
  assert.equal(reopenedV1.document.slides[0].elements[0].text, 'HTTP 原生中文标题 第1页');
  assert.equal(reopenedV1.document.slides[0].notes, '原有讲师备注');
  const thirdDraft = await app.call('ppt-save-draft', { draftId: reopenedV1.id, revision: reopenedV1.revision,
    pages: patch(reopenedV1, '从第一版人工追加第三版') }, projectId);
  const saveArgs = { draftId: reopenedV1.id, revision: thirdDraft.revision, operationId: randomUUID() };
  const third = await app.call('ppt-save-version', saveArgs, projectId);
  assert.equal(third.task.kind, 'manual'); assert.equal(third.task.sessionId, null);
  assert.equal(third.descriptor.version.number, 3); assert.equal(third.descriptor.version.baseVersionId, fixture.scope.versionId);
  assert.equal((await app.call('ppt-save-version', saveArgs, projectId)).artifact.id, third.artifact.id);
  const originalAfterManualSave = await app.call('ppt-open', fixture.scope, projectId);
  assert.equal(originalAfterManualSave.dirty, false);
  assert.equal(originalAfterManualSave.document.slides[0].elements[0].text, 'HTTP 原生中文标题 第1页');
  const board = await app.get({ projectId, canvas: fixture.requirementId });
  assert.equal(board.nodes.filter(node => node.outputCard).length, 1);
  assert.equal(outputCard(board).outputCard.versions.length, 3);
  assert.deepEqual(readFileSync(fixture.file), fixture.original);
  assert.deepEqual(await app.get({ projectId, task: fixture.sourceTaskId }), originalTask);
});

test('PPT HTTP requires an explicit project and rejects wrong session/directory, unauthorized targets and registration bypass', async t => {
  const f = context(t), fixture = await seed(f.root);
  const otherRoot = path.join(f.directory, 'B'); cpSync(f.root, otherRoot, { recursive: true });
  const app = f.create(), projectA = (await app.get({ projects: 1 })).defaultProjectId;
  const projectB = (await app.call('open-project', { path: otherRoot })).project.id;
  const noProject = await app.response({}, 'ppt-open', fixture.scope);
  assert.equal(noProject.status, 400); assert.match((await noProject.json()).error, /必须指定当前项目/);
  const invalidProject = await app.response({ projectId: 'wrong' }, 'ppt-open', fixture.scope);
  assert.equal(invalidProject.status, 400); assert.match((await invalidProject.json()).error, /项目标识无效/);
  const draft = await app.call('ppt-open', fixture.scope, projectA);
  const wrongDraftProject = await app.response({ projectId: projectB }, 'ppt-save-draft', { draftId: draft.id, revision: 0, pages: [] });
  assert.equal(wrongDraftProject.status, 400); assert.match((await wrongDraftProject.json()).error, /草稿不存在|当前项目/);
  const selected = draft.document.slides[0].elements[0];
  const created = await app.call('ppt-create-ai', { draftId: draft.id, revision: 0, slideId: draft.document.slides[0].id,
    elementIds: [selected.id], instruction: '只改选中文字', operationId: randomUUID() }, projectA);
  const sessionId = `protocol-selection:${created.task.id}`;
  await app.call('bind-task-session', { taskId: created.task.id, sessionId }, projectA);
  const tool = app.tools.get('course_propose_ppt_edit');
  const args = { projectId: projectA, taskId: created.task.id, pages: patch(draft, '有待确认的修改') };
  await assert.rejects(tool.execute({ ...args, projectId: projectB }, execution(f.root, sessionId)), /项目标识与当前会话目录不一致/);
  await assert.rejects(tool.execute(args, execution(otherRoot, sessionId)), /项目标识与当前会话目录不一致/);
  await assert.rejects(tool.execute(args, execution(f.root, 'wrong-session')), /当前原生会话/);
  await assert.rejects(tool.execute(args, { signal: new AbortController().signal }), /原生会话/);
  await assert.rejects(tool.execute({ ...args, pages: patch(draft, '第二页未授权', 1) }, execution(f.root, sessionId)), /授权页面/);
  await assert.rejects(tool.execute({ ...args, pages: [{ slideId: draft.document.slides[0].id,
    changes: [{ elementId: draft.document.slides[0].elements[1].id, text: '同页未选中的文字' }] }] }, execution(f.root, sessionId)), /本次选择/);
  await assert.rejects(tool.execute({ ...args, pages: [{ slideId: draft.document.slides[0].id, notes: '元素任务不得改备注' }] }, execution(f.root, sessionId)), /不能修改讲师备注/);
  await assert.rejects(app.tools.get('course_register_artifact').execute({ projectId: projectA, taskId: created.task.id,
    kind: 'pptx', path: 'not-used.pptx', title: '绕过候选确认', operationId: randomUUID() }, execution(f.root, sessionId)), /不能通过普通文件登记/);
  const noProposalProject = await app.response({ pptProposal: created.task.id });
  assert.equal(noProposalProject.status, 400); assert.match((await noProposalProject.json()).error, /必须指定当前项目/);
  const unsupportedWrite = await app.response({ projectId: projectA }, 'ppt-propose', { taskId: created.task.id, pages: args.pages });
  assert.equal(unsupportedWrite.status, 400); assert.match((await unsupportedWrite.json()).error, /不支持/);
  const candidate = JSON.parse(await tool.execute(args, execution(f.root, sessionId)));
  assert.equal(candidate.status, 'pending');
  const noPreviewProject = await app.response({ pptPreviewPage: candidate.proposal.draftId, revision: 0, page: 1 });
  assert.equal(noPreviewProject.status, 400); assert.match((await noPreviewProject.json()).error, /必须指定当前项目/);
  const badPage = await app.response({ projectId: projectA, pptPreviewPage: candidate.proposal.draftId, revision: 0, page: -1 });
  assert.equal(badPage.status, 400); assert.match((await badPage.json()).error, /页码无效/);
  const unknownProposal = await app.response({ projectId: projectA }, 'ppt-confirm', { taskId: created.task.id, proposalId: randomUUID(), operationId: randomUUID() });
  assert.equal(unknownProposal.status, 400); assert.match((await unknownProposal.json()).error, /候选不存在/);
  const discard = { taskId: created.task.id, proposalId: candidate.proposal.id };
  assert.equal((await app.call('ppt-discard', discard, projectA)).status, 'discarded');
  assert.equal((await app.call('ppt-discard', discard, projectA)).status, 'discarded');
  const confirmDiscarded = await app.response({ projectId: projectA }, 'ppt-confirm', { ...discard, operationId: randomUUID() });
  assert.equal(confirmDiscarded.status, 400); assert.match((await confirmDiscarded.json()).error, /已放弃/);
  assert.equal(outputCard(await app.get({ projectId: projectA, canvas: fixture.requirementId })).outputCard.versions.length, 1);
  assert.equal(outputCard(await app.get({ projectId: projectB, canvas: fixture.requirementId })).outputCard.versions.length, 1);
  assert.deepEqual(readFileSync(fixture.file), fixture.original);
});


test('SVG HTTP source editing serves validated vector pages without broadening general media previews',async t=>{
 const f=context(t),fixture=await seed(f.root),project=path.join(f.root,'projects','源稿');
 mkdirSync(path.join(project,'svg_final'),{recursive:true});mkdirSync(path.join(project,'exports'));
 cpSync(fixture.file,path.join(project,'exports','原课件.pptx'));
 for(let i=1;i<=3;i++)writeFileSync(path.join(project,'svg_final',`p0${i}.svg`),`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><text x="80" y="120" font-size="40">页面${i}</text></svg>`);
 const app=f.create(),projects=await app.get({projects:'1'}),projectId=projects.activeProjectId;
 const found=await app.call('ppt-svg-discover',fixture.scope,projectId);assert.equal(found.status,'matched');
 const draft=await app.call('ppt-open-svg',{scope:fixture.scope,candidateId:found.candidates[0].id},projectId);
 assert.equal(draft.document.sourceFormat,'svg');
 const manifest=await app.call('ppt-preview',{draftId:draft.id,revision:0},projectId);assert.equal(manifest.sourceFormat,'svg');
 const query={projectId,pptPreviewPage:draft.id,revision:0,page:1},response=await app.response(query);
 assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/image\/svg\+xml/);assert.match(response.headers.get('content-security-policy'),/sandbox/);assert.match(await response.text(),/data-wtt-svg-id/);
 const head=await app.response(query,undefined,undefined,{method:'HEAD'});assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);
 const bad=await app.response({...query,page:0});assert.equal(bad.status,400);
});

test('SVG完整迭代HTTP与受管工具共享候选，应用源稿后才按明确请求导出PPT',async t=>{
 const f=context(t),fixture=await seed(f.root),project=path.join(f.root,'projects','完整源稿');mkdirSync(path.join(project,'svg_final'),{recursive:true});mkdirSync(path.join(project,'exports'));cpSync(fixture.file,path.join(project,'exports','原课件.pptx'));
 const pageSvg=title=>`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#edf6ff"/><text x="80" y="120" font-size="40">${title}</text></svg>`;
 for(let i=1;i<=3;i++)writeFileSync(path.join(project,'svg_final',`p0${i}.svg`),pageSvg(`原页面${i}`));
 const app=f.create(),projectId=(await app.get({projects:1})).defaultProjectId,found=await app.call('ppt-svg-discover',fixture.scope,projectId),draft=await app.call('svg-editor-open',{scope:fixture.scope,candidateId:found.candidates[0].id},projectId);
 const noProject=await app.response({},'svg-editor-state',{draftId:draft.id});assert.equal(noProject.status,400);
 const created=await app.call('svg-editor-task',{draftId:draft.id,revision:0,pageId:'p01',instruction:'重绘封面',operationId:randomUUID()},projectId),sessionId=`protocol-svg:${created.task.id}`;
 await app.call('bind-task-session',{taskId:created.task.id,sessionId},projectId);await app.call('set-task-dispatch',{taskId:created.task.id,status:'accepted'},projectId);
 const tool=app.tools.get('course_propose_svg_edit');assert.ok(tool.parameters.properties.operations);
 const candidate=JSON.parse(await tool.execute({projectId,taskId:created.task.id,summary:'已重绘封面',operations:[{type:'replace-page',pageId:'p01',svg:pageSvg('HTTP修改候选')}]},execution(f.root,sessionId)));assert.equal(candidate.status,'pending');assert.equal(candidate.formalVersionSaved,false);
 const preview=await app.response({projectId,svgEditorPage:draft.id,sourceId:candidate.proposal.sourceId,page:1});assert.equal(preview.status,200);assert.match(preview.headers.get('content-type'),/image\/svg\+xml/);assert.match(await preview.text(),/HTTP修改候选/);
 const current=await app.call('svg-editor-state',{draftId:draft.id},projectId);assert.equal(current.revision,0);assert.equal((await app.get({projectId,task:created.task.id})).files.length,0);
 const applied=await app.call('svg-editor-apply',{draftId:draft.id,revision:0,proposalId:candidate.proposal.id},projectId);assert.equal(applied.revision,1);assert.equal(applied.document.slides[0].elements[0].text,'HTTP修改候选');assert.equal(outputCard(await app.get({projectId,canvas:fixture.requirementId})).outputCard.versions.length,1);
 const saved=await app.call('svg-editor-save',{draftId:draft.id,revision:1,operationId:randomUUID()},projectId);assert.equal(saved.descriptor.version.number,2);assert.equal(saved.artifact.validation.editability.ok,true);
 const app2=f.create(),restored=await app2.call('svg-editor-state',{draftId:draft.id},projectId);assert.equal(restored.revision,1);assert.equal(restored.turns[0].status,'applied');
});
