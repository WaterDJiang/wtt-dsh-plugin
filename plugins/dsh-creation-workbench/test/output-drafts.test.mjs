import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkbenchService} from '../src/service.mjs';
import {createCompositionContext,createRevisionContext,creationTaskInput,visibleCreationPosition} from '../src/creation-context.mjs';
import {editableCardText} from '../src/card-capabilities.mjs';

function fixture(t){
 const root=mkdtempSync(path.join(tmpdir(),'cw46-')),service=new WorkbenchService({workspaceRoot:root}),canvas=service.store.ensureDefaultCanvas();
 const material=service.canvas.addMaterial({requirementId:canvas.id,title:'A 现有课纲',content:'# 课程大纲\n\n案例→练习→复盘',operationId:randomUUID()});
 const source=service.canvas.getBoard(canvas.id).nodes.find(n=>n.refId===material.material.id);
 t.after(()=>{service.close();rmSync(root,{recursive:true,force:true})});
 const input=(outputType='text')=>({requirementId:canvas.id,outputType,selectedCardIds:[source.id],sourceRefs:[{cardId:source.id,hash:source.sourceHash}],position:{x:500,y:100},operationId:randomUUID()});
 return{root,service,canvas,source,input};
}

test('choosing any type creates a persistent B with an A to B curve and no task, file or formal version',t=>{
 const f=fixture(t),bytes=readFileSync(path.join(f.root,f.source.path));
 for(const type of ['text','pptx','image','video']){
  const input=f.input(type),d=f.service.createOutputDraft(input),again=f.service.createOutputDraft(input);
  assert.equal(d.card.id,again.card.id);assert.deepEqual(d.card.versions,[]);assert.equal(d.node.pendingGeneration.phase,'composing');
  const board=f.service.canvas.getBoard(f.canvas.id);
  assert.ok(board.nodes.some(n=>n.id===d.node.id));assert.ok(board.edges.some(e=>e.source===f.source.id&&e.target===d.node.id&&e.provenance));
  const context=createCompositionContext({projectId:'test',requirement:f.canvas,descriptor:d});
  assert.equal(context.composerNodeId,d.node.id);assert.equal(context.references[0].id,f.source.id);
  assert.notEqual(context.anchor.id,d.node.id);assert.deepEqual(creationTaskInput(context).generation,{mode:'new',cardId:d.card.id});
 }
 assert.equal(f.service.tasks.list(f.canvas.id).length,0);assert.equal(f.service.store.db.prepare('SELECT COUNT(*) AS n FROM task_files').get().n,0);
 assert.deepEqual(readFileSync(path.join(f.root,f.source.path)),bytes);
});

test('draft instruction and references persist, concurrent stale saves cannot overwrite newer input',t=>{
 const f=fixture(t),d=f.service.createOutputDraft(f.input());
 const input={...f.input(),cardId:d.card.id,instruction:'继续制作',expectedRevision:0};
 const saved=f.service.saveOutputDraft(input);assert.equal(saved.revision,1);
 assert.throws(()=>f.service.saveOutputDraft({...input,instruction:'旧窗口覆盖'}),/其他窗口/);
 const reopened=new WorkbenchService({workspaceRoot:f.root});t.after(()=>reopened.close());
 const next=reopened.cards.describeDraft({requirementId:f.canvas.id,cardId:d.card.id});
 assert.equal(next.composition.instruction,'继续制作');assert.equal(next.composition.references[0].id,f.source.id);
 assert.equal(reopened.canvas.getBoard(f.canvas.id).nodes.filter(n=>n.outputCard?.id===d.card.id).length,1);
});

test('manual text draft saves a real Markdown V1 in place and remains available for AI revision',t=>{
 const f=fixture(t),draft=f.service.createOutputDraft(f.input());
 const scope={requirementId:f.canvas.id,cardId:draft.card.id};
 f.service.saveOutputDraft({...f.input(),cardId:draft.card.id,instruction:'沿用参考课纲',expectedRevision:0});
 assert.equal(editableCardText(draft.node),'');
 const content='# 自写讲稿\n\n这段文字由人工填写。';
 const input={...scope,versionId:null,content,operationId:randomUUID()};
 const saved=f.service.canvas.saveCardText(input);
 assert.deepEqual(f.service.canvas.saveCardText(input),saved);
 assert.throws(()=>f.service.canvas.saveCardText({...input,content:'不同正文'}),/操作标识/);
 assert.throws(()=>f.service.canvas.saveCardText({...input,operationId:randomUUID()}),/已提交/);
 const initial=f.service.cards.describe(scope);
 assert.equal(saved.nodeId,draft.node.id);
 assert.equal(initial.node.title,'自写讲稿');
 assert.deepEqual(initial.node.position,draft.node.position);
 assert.equal(initial.version.number,1);
 assert.equal(path.basename(initial.node.path),'自写讲稿.md');
 assert.equal(readFileSync(path.join(f.root,initial.node.path),'utf8'),content);
 assert.equal(f.service.tasks.get(initial.version.taskId).sessionId,null);
 assert.equal(initial.editor.instruction,'沿用参考课纲');
 assert.equal(initial.editor.references[0].id,f.source.id);
 assert.ok(f.service.canvas.getBoard(f.canvas.id).edges.some(edge=>edge.source===f.source.id&&edge.target===draft.node.id));
 const second=f.service.canvas.saveCardText({...scope,versionId:saved.versionId,sourceHash:initial.node.sourceHash,content:'修订手写正文',operationId:randomUUID()});
 const revised=f.service.cards.describe(scope);
 assert.equal(revised.version.number,2);
 assert.equal(path.basename(revised.node.path),path.basename(initial.node.path));
 assert.equal(readFileSync(path.join(f.root,initial.node.path),'utf8'),content);
 const context=createRevisionContext({projectId:'test',requirement:f.canvas,descriptor:f.service.cards.describe(scope)});
 context.instruction='润色这一版';
 const {task,prepared}=f.service.createTask({...creationTaskInput(context),operationId:randomUUID()});
 assert.equal(task.outputCardId,draft.card.id);
 assert.equal(task.input.revision.versionId,second.versionId);
 assert.match(prepared.prompt,/修订手写正文/);
});

test('starting a task reuses B, maintains its edge during confirmation, and registration creates V1 in B',async t=>{
 const f=fixture(t),d=f.service.createOutputDraft(f.input());
 const context=createCompositionContext({projectId:'test',requirement:f.canvas,descriptor:d});context.instruction='按 A 写文本';
 const input={...creationTaskInput(context),operationId:randomUUID()},created=f.service.createTask(input);
 assert.equal(created.task.outputCardId,d.card.id);assert.equal(f.service.createTask(input).task.id,created.task.id);
 assert.throws(()=>f.service.createTask({...input,operationId:randomUUID()}),/原任务/);
 assert.throws(()=>f.service.canvas.saveCardText({requirementId:f.canvas.id,cardId:d.card.id,versionId:null,content:'晚到的人工正文',operationId:randomUUID()}),/已提交/);
 let board=f.service.canvas.getBoard(f.canvas.id),node=board.nodes.find(n=>n.id===d.node.id);
 assert.equal(node.pendingGeneration.taskId,created.task.id);assert.equal(node.composition,undefined);assert.ok(board.edges.some(e=>e.source===f.source.id&&e.target===node.id));
 f.service.tasks.bindSession({taskId:created.task.id,sessionId:'cw46-session'});
 f.service.tasks.setDispatch({taskId:created.task.id,status:'accepted'});
 f.service.tasks.runtimeStateReader=()=>({phase:'awaiting-input'});
 node=f.service.canvas.getBoard(f.canvas.id).nodes.find(n=>n.id===d.node.id);assert.equal(node.pendingGeneration.phase,'awaiting-input');
 writeFileSync(path.join(f.root,created.prepared.deliveryDirectory,'结果.md'),'# B 已生成\n\n依据 A 继续创作');
 const artifact=await f.service.tasks.files.register({taskId:created.task.id,kind:'text',title:'B 已生成',path:`${created.prepared.deliveryDirectory}/结果.md`,operationId:randomUUID()},{sessionId:'cw46-session'});
 board=f.service.canvas.getBoard(f.canvas.id);node=board.nodes.find(n=>n.id===d.node.id);
 assert.equal(node.outputCard.id,d.card.id);assert.equal(node.outputCard.versions.length,1);assert.equal(node.outputCard.number,1);
 assert.ok(board.edges.some(e=>e.source===f.source.id&&e.target===node.id));assert.ok(artifact.id);
 assert.equal(board.nodes.filter(n=>n.outputCard?.id===d.card.id).length,1);
});

test('unsent B can be recycled and restored with references intact; it cannot be used as a source',t=>{
 const f=fixture(t),d=f.service.createOutputDraft(f.input());
 assert.throws(()=>f.service.createOutputDraft({...f.input(),selectedCardIds:[d.node.id],sourceRefs:[{cardId:d.node.id,hash:'a'.repeat(64)}]}));
 const plan=f.service.recycle.plan({requirementId:f.canvas.id,selections:[{nodeId:d.node.id}]});
 f.service.recycle.remove({planId:plan.id});assert.equal(f.service.canvas.getBoard(f.canvas.id).nodes.some(n=>n.id===d.node.id),false);
 f.service.recycle.restore({entryId:plan.id});assert.equal(f.service.canvas.getBoard(f.canvas.id).nodes.find(n=>n.id===d.node.id).composition.references[0].id,f.source.id);
});

test('drafts remain bound to their canvas, format and immutable source hash',t=>{
 const f=fixture(t),d=f.service.createOutputDraft(f.input()),other=f.service.store.createCanvas({operationId:randomUUID()});
 assert.throws(()=>f.service.cards.describeDraft({requirementId:other.id,cardId:d.card.id}),/当前画布/);
 assert.throws(()=>f.service.cards.prepare({requirementId:other.id,outputType:'text',instruction:'test',generation:{mode:'new',cardId:d.card.id}}),/当前画布/);
 assert.throws(()=>f.service.cards.prepare({requirementId:f.canvas.id,outputType:'image',instruction:'test',generation:{mode:'new',cardId:d.card.id}}),/类型/);
 assert.throws(()=>f.service.createOutputDraft({...f.input(),sourceRefs:[{cardId:f.source.id,hash:'b'.repeat(64)}]}),/变化|匹配/);
 assert.deepEqual(f.service.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('new B stays visible without overlapping A or changing the viewport in a narrow canvas',()=>{
 const viewport={x:0,y:0,zoom:0.8},size={width:404,height:844};
 const anchor={position:{x:40,y:60},width:258,height:208};
 const position=visibleCreationPosition(anchor,[anchor],viewport,size);
 assert.ok(position.x*viewport.zoom>=0);assert.ok((position.x+258)*viewport.zoom<=size.width);
 assert.ok(position.y>=anchor.position.y+anchor.height+16 || position.x>=anchor.position.x+anchor.width+16 || position.x+258+16<=anchor.position.x || position.y+208+16<=anchor.position.y);
 assert.ok((position.y+208)*viewport.zoom+220<size.height);
 assert.deepEqual(viewport,{x:0,y:0,zoom:0.8});
});
