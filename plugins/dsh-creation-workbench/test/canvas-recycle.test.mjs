import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync,symlinkSync,unlinkSync,linkSync} from 'node:fs';import path from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';import {WorkbenchService} from '../src/service.mjs';
function fixture(t,config={}){const root=mkdtempSync(path.join(tmpdir(),'cw38-')),service=new WorkbenchService({workspaceRoot:root,...config}),req=service.store.createRequirement({background:'回收站验收',operationId:randomUUID()});t.after(()=>{service.close();rmSync(root,{recursive:true,force:true})});return {root,service,req,r:service.recycle}}
async function reference(f,name='参考.md',requirementId=f.req.id){writeFileSync(path.join(f.root,name),'# 原文\n不覆盖');const v=await f.service.projectFiles.preview(name),result=await f.service.projectFiles.reference({requirementId,path:name,hash:v.hash,operationId:randomUUID(),position:{x:280,y:320}});return result.board.nodes.find(n=>n.refId===result.material.id)}
const plan=(f,n)=>f.r.plan({requirementId:f.req.id,selections:[{nodeId:n.id,...(n.outputCard?.versionId?{versionId:n.outputCard.versionId}:{})}]});
test('reference metadata matches projected heads and legacy versions without hydrating other canvases', async t => {
 const f=fixture(t),other=f.service.store.createCanvas({title:'其他画布',operationId:randomUUID()});
 const shared=await reference(f);
 const v=await f.service.projectFiles.preview('参考.md');
 await f.service.projectFiles.reference({requirementId:other.id,path:v.path,hash:v.hash,operationId:randomUUID()});
 f.service.store.saveOutline({requirementId:other.id,markdown:'# 历史大纲',operationId:randomUUID()});
 await f.service.importMaterial({requirementId:other.id,filename:'导入.md',bytes:Buffer.from('# 导入快照'),operationId:randomUUID()});
 let generation={mode:'new'};
 for(let index=1;index<=2;index++){
  const {task,prepared}=f.service.createTask({requirementId:other.id,instruction:'合成版本 '+index,outputType:'text',selectedCardIds:[],sourceRefs:[],selectedSkills:[],generation,operationId:randomUUID()});
  const relative=prepared.deliveryDirectory+'/v'+index+'.md',sessionId='test:'+task.id;
  writeFileSync(path.join(f.root,relative),'# 第 '+index+' 版');
  f.service.tasks.bindSession({taskId:task.id,sessionId});
  await f.service.tasks.files.register({taskId:task.id,path:relative,title:'版本 '+index,kind:'text',primary:true,operationId:randomUUID()},{sessionId});
  const node=f.r.raw(other.id).nodes.find(node=>node.outputCard?.id===task.outputCardId);
  generation={mode:'revise',cardId:node.outputCard.id,baseVersionId:node.outputCard.versionId};
 }
 const normalize=rows=>rows.sort((a,b)=>(a.requirementId+':'+a.nodeId).localeCompare(b.requirementId+':'+b.nodeId));
 const expected=[f.req.id,other.id].flatMap(id=>f.r.raw(id).nodes.flatMap(node=>{
  const source=f.r.primary(node);return source?[{requirementId:id,nodeId:node.id,title:node.title,path:source.path,course:f.service.store.getRequirement(id).title}]:[];
 }));
 assert.deepEqual(normalize(f.r.sourceLocations()),normalize(expected));
 const raw=f.service.canvas.getRawBoard.bind(f.service.canvas),reads=[];
 f.service.canvas.getRawBoard=id=>{reads.push(id);return raw(id)};
 const p=plan(f,shared);
 assert.deepEqual(reads,[f.req.id]);
 assert.equal(p.files[0].references.length,1);
 const third=f.service.store.createCanvas({title:'确认后新增引用',operationId:randomUUID()});
 await f.service.projectFiles.reference({requirementId:third.id,path:v.path,hash:v.hash,operationId:randomUUID()});
 assert.throws(()=>f.r.remove({planId:p.id,deleteFiles:true}),/引用已变化/);
 assert.ok(existsSync(path.join(f.root,'参考.md')));
 reads.length=0;
 f.r.sourceLocations=()=>{throw new Error('node-only removal must not scan project files')};
 f.r.remove({planId:p.id});
 assert.deepEqual(reads,[f.req.id]);
 assert.ok(existsSync(path.join(f.root,'参考.md')));
});
test('hiding requirement and file nodes preserves business records and files across restart, then restores',async t=>{
 const f=fixture(t),n=await reference(f),before=readFileSync(path.join(f.root,'参考.md')),count=f.service.store.db.prepare('select count(*) as n from canvas_materials').get().n,p=plan(f,n);assert.equal(f.r.list().length,0);f.r.remove({planId:p.id});assert.equal(f.service.canvas.getBoard(f.req.id).nodes.some(x=>x.id===n.id),false);assert.deepEqual(readFileSync(path.join(f.root,'参考.md')),before);assert.equal(f.service.store.db.prepare('select count(*) as n from canvas_materials').get().n,count);
 const second=new WorkbenchService({workspaceRoot:f.root});t.after(()=>second.close());assert.equal(second.canvas.getBoard(f.req.id).nodes.some(x=>x.id===n.id),false);second.recycle.restore({entryId:p.id});assert.ok(second.canvas.getBoard(f.req.id).nodes.some(x=>x.id===n.id));
 const req=f.service.canvas.getBoard(f.req.id).nodes.find(x=>x.kind==='requirement'),rp=plan(f,req);f.r.remove({planId:rp.id});assert.ok(f.service.store.getRequirement(f.req.id));assert.equal(f.service.canvas.getBoard(f.req.id).nodes.some(x=>x.kind==='requirement'),false);f.r.restore({entryId:rp.id});
});
test('file recycle lists shared references, moves one file, supports replay and restores exact bytes',async t=>{
 const f=fixture(t),n=await reference(f),other=f.service.store.createRequirement({background:'另一课程',operationId:randomUUID()}),v=await f.service.projectFiles.preview('参考.md');await f.service.projectFiles.reference({requirementId:other.id,path:v.path,hash:v.hash,operationId:randomUUID()});const p=plan(f,n);assert.equal(p.files.length,1);assert.equal(p.files[0].references[0].course,'另一课程');
 f.r.remove({planId:p.id,deleteFiles:true});assert.equal(existsSync(path.join(f.root,'参考.md')),false);assert.ok(existsSync(path.join(f.root,p.files[0].trash)));assert.equal(f.service.canvas.readImportedFile(n.refId).bytes.toString(),'# 原文\n不覆盖');assert.equal(f.r.remove({planId:p.id,deleteFiles:true}).state,'removed');assert.throws(()=>f.r.remove({planId:p.id,deleteFiles:false}),/不同方式/);f.r.restore({entryId:p.id});assert.equal(readFileSync(path.join(f.root,'参考.md'),'utf8'),'# 原文\n不覆盖');assert.equal(f.r.restore({entryId:p.id}).state,'restored');
});
test('changed file, duplicate nodes, cross-project entry and symlink cannot delete files; restore never overwrites',async t=>{
 const f=fixture(t),n=await reference(f),p=plan(f,n);writeFileSync(path.join(f.root,'参考.md'),'新内容');assert.throws(()=>f.r.remove({planId:p.id,deleteFiles:true}),/变化/);assert.ok(f.service.canvas.getBoard(f.req.id).nodes.some(x=>x.id===n.id));const other=fixture(t);assert.throws(()=>other.r.remove({planId:p.id}),/当前项目/);assert.throws(()=>f.r.plan({requirementId:f.req.id,selections:[{nodeId:n.id},{nodeId:n.id}]}),/重复/);
 writeFileSync(path.join(f.root,'参考.md'),'# 原文\n不覆盖');const next=plan(f,n);f.r.remove({planId:next.id,deleteFiles:true});writeFileSync(path.join(f.root,'参考.md'),'同名新文件');assert.throws(()=>f.r.restore({entryId:next.id}),/同名/);assert.equal(readFileSync(path.join(f.root,'参考.md'),'utf8'),'同名新文件');unlinkSync(path.join(f.root,'参考.md'));f.r.restore({entryId:next.id});
 const linked=plan(f,n);unlinkSync(path.join(f.root,'参考.md'));writeFileSync(path.join(f.root,'other.md'),'# 原文\n不覆盖');symlinkSync(path.join(f.root,'other.md'),path.join(f.root,'参考.md'));assert.throws(()=>f.r.remove({planId:linked.id,deleteFiles:true}),/变化|安全/);assert.ok(existsSync(path.join(f.root,'other.md')));
});
test('removing a chosen formal version recycles only that file and mirror; later versions are intact',async t=>{
 const f=fixture(t),a=f.service.store.saveOutline({requirementId:f.req.id,markdown:'# 第一版',operationId:randomUUID()}),b=f.service.store.saveOutline({requirementId:f.req.id,markdown:'# 第二版',operationId:randomUUID()});f.service.deliverables.sync(f.req.id);const node=f.service.canvas.getBoard(f.req.id).nodes.find(n=>n.refId===a.id),p=plan(f,node);assert.equal(p.files.length,2);f.r.remove({planId:p.id,deleteFiles:true});assert.equal(existsSync(path.join(f.root,a.markdownPath)),false);assert.equal(readFileSync(path.join(f.root,b.markdownPath),'utf8'),'# 第二版');assert.ok(f.service.store.getVersion(a.id));f.r.restore({entryId:p.id});assert.equal(readFileSync(path.join(f.root,a.markdownPath),'utf8'),'# 第一版');
});
test('hidden free text survives subsequent layout saves and restore keeps its coordinates',async t=>{
 const f=fixture(t),id='whiteboard:'+randomUUID();let b=f.service.canvas.getBoard(f.req.id);b=f.service.canvas.saveBoard({requirementId:f.req.id,expectedRevision:b.revision,positions:{[id]:{x:88,y:99}},elements:[{id,kind:'text',text:'隐藏文字',width:280,height:100,colour:'white'}],edges:[],groups:[]});const p=f.r.plan({requirementId:f.req.id,selections:[{nodeId:id}]});f.r.remove({planId:p.id});b=f.service.canvas.getBoard(f.req.id);assert.equal(b.elements.length,0);f.service.canvas.saveBoard({requirementId:f.req.id,expectedRevision:b.revision,elements:[],positions:{},edges:[],groups:[]});f.r.restore({entryId:p.id});b=f.service.canvas.getBoard(f.req.id);assert.equal(b.elements[0].text,'隐藏文字');assert.deepEqual(f.service.canvas.getRawBoard(f.req.id).layoutPositions[id],{x:88,y:99});
});
test('partial move failure rolls back files and hides no nodes; crash journal recovers on reopen',async t=>{
 let calls=0;const f=fixture(t,{recycleMove(a,b){if(++calls===2)throw new Error('模拟第二文件失败');linkSync(a,b);unlinkSync(a)}}),a=await reference(f,'一.md'),b=await reference(f,'二.md'),p=f.r.plan({requirementId:f.req.id,selections:[{nodeId:a.id},{nodeId:b.id}]});assert.throws(()=>f.r.remove({planId:p.id,deleteFiles:true}),/模拟第二文件失败/);assert.ok(existsSync(path.join(f.root,'一.md'))&&existsSync(path.join(f.root,'二.md')));assert.equal(f.service.canvas.getBoard(f.req.id).nodes.length,3);
 const file=p.files[0];linkSync(path.join(f.root,file.path),f.r.trash(file.trash));unlinkSync(path.join(f.root,file.path));f.service.store.db.prepare('update canvas_recycle_entries set state=?,mode=1,owner_pid=2147483647 where id=?').run('moving',p.id);const second=new WorkbenchService({workspaceRoot:f.root});t.after(()=>second.close());assert.ok(existsSync(path.join(f.root,file.path)));assert.equal(second.recycle.entry(p.id).state,'planned');
});
test('pending generation is blocked until runtime reports stopped, with no automatic task cancellation',async t=>{
 const f=fixture(t),{task}=f.service.createTask({requirementId:f.req.id,instruction:'生成文本',outputType:'text',selectedCardIds:[],sourceRefs:[],selectedSkills:[],generation:{mode:'new'},operationId:randomUUID()});let node=f.r.raw(f.req.id).nodes.find(n=>n.kind==='generation');assert.ok(node);assert.throws(()=>plan(f,node),/先打开原任务停止/);f.service.tasks.runtimeStateReader=()=>({phase:'idle'});f.service.store.db.prepare("update course_tasks set status='accepted' where id=?").run(task.id);node=f.r.raw(f.req.id).nodes.find(n=>n.kind==='generation');const p=plan(f,node);f.r.remove({planId:p.id});assert.equal(f.service.tasks.get(task.id).status,'accepted');
});
test('dragging a hidden reference back restores only that card, while unrelated removed edges stay removed',async t=>{
 const f=fixture(t),a=await reference(f,'a.md'),b=await reference(f,'b.md');let board=f.service.canvas.getBoard(f.req.id);board=f.service.canvas.saveBoard({requirementId:f.req.id,expectedRevision:board.revision,positions:{},edges:[{id:'manual:unrelated',source:'requirement:'+f.req.id,target:b.id}],groups:[],elements:[]});
 const p=f.r.plan({requirementId:f.req.id,selections:[{nodeId:a.id},{nodeId:b.id}]});f.r.remove({planId:p.id});const v=await f.service.projectFiles.preview('a.md');await f.service.projectFiles.reference({requirementId:f.req.id,path:v.path,hash:v.hash,position:{x:500,y:600},operationId:randomUUID()});assert.ok(f.service.canvas.getBoard(f.req.id).nodes.some(n=>n.id===a.id));assert.equal(f.service.canvas.getBoard(f.req.id).nodes.some(n=>n.id===b.id),false);assert.equal(f.r.list()[0].nodes.length,1);f.r.restore({entryId:p.id});assert.deepEqual(f.service.canvas.getRawBoard(f.req.id).layoutPositions[a.id],{x:500,y:600});
 const planA=plan(f,a);assert.equal(planA.layout.edges.length,0);f.r.remove({planId:planA.id});board=f.service.canvas.getBoard(f.req.id);f.service.canvas.saveBoard({requirementId:f.req.id,expectedRevision:board.revision,positions:board.nodes.reduce((m,n)=>({...m,[n.id]:n.position}),{}),edges:[],groups:[],elements:[]});f.r.restore({entryId:planA.id});assert.equal(f.service.canvas.getBoard(f.req.id).edges.some(e=>e.id==='manual:unrelated'),false);
});
