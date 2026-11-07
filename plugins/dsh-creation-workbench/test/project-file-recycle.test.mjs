import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync,linkSync,unlinkSync,rmdirSync,readlinkSync,openSync,closeSync,ftruncateSync,statSync} from 'node:fs';
import path from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';import {WorkbenchService} from '../src/service.mjs';
function fixture(t,config={}){const root=mkdtempSync(path.join(tmpdir(),'cw44-')),service=new WorkbenchService({workspaceRoot:root,...config});t.after(()=>{service.close();rmSync(root,{recursive:true,force:true})});return {root,service,r:service.recycle,files:service.recycle.fileEntries}}
function write(f,name,content='技术原件'){mkdirSync(path.dirname(path.join(f.root,name)),{recursive:true});writeFileSync(path.join(f.root,name),content)}
const req=f=>f.service.store.createRequirement({background:'文件树删除验收',operationId:randomUUID()});
async function reference(f,r,name){const info=await f.service.projectFiles.preview(name),result=await f.service.projectFiles.reference({requirementId:r.id,path:name,hash:info.hash,operationId:randomUUID(),position:{x:300,y:200}});return result.board.nodes.find(n=>n.refId===result.material.id)}
test('unreferenced file can be recycled and restored without any course, duplicate removal is idempotent',t=>{
 const f=fixture(t);write(f,'普通.txt');const p=f.files.plan({path:'普通.txt'});assert.equal(p.nodes.length,0);assert.ok(existsSync(path.join(f.root,'普通.txt')));assert.equal(f.r.list().length,0);
 assert.equal(f.files.remove({planId:p.id}).state,'removed');assert.equal(f.files.remove({planId:p.id}).state,'removed');assert.equal(existsSync(path.join(f.root,'普通.txt')),false);assert.equal(f.r.list()[0].target.name,'普通.txt');
 f.r.restore({entryId:p.id});assert.equal(readFileSync(path.join(f.root,'普通.txt'),'utf8'),'技术原件');assert.equal(f.r.restore({entryId:p.id}).state,'restored');
});
test('nested directories, ordinary hidden files and empty folders restore exact structure across reopen',t=>{
 const f=fixture(t);write(f,'目录/子目录/a.md','# 原文');write(f,'目录/.普通隐藏','不能遗漏');mkdirSync(path.join(f.root,'目录/空目录'));write(f,'旁边.txt','保留');
 const p=f.files.plan({path:'目录'});assert.equal(p.files.length,2);assert.equal(p.directories.length,3);f.files.remove({planId:p.id});assert.equal(existsSync(path.join(f.root,'目录')),false);assert.equal(readFileSync(path.join(f.root,'旁边.txt'),'utf8'),'保留');
 const reopened=new WorkbenchService({workspaceRoot:f.root});t.after(()=>reopened.close());reopened.recycle.restore({entryId:p.id});assert.equal(readFileSync(path.join(f.root,'目录/.普通隐藏'),'utf8'),'不能遗漏');assert.ok(existsSync(path.join(f.root,'目录/空目录')));assert.equal(readFileSync(path.join(f.root,'目录/子目录/a.md'),'utf8'),'# 原文');
});
test('shared references across courses hide and restore together without exposing previously hidden cards',async t=>{
 const f=fixture(t),a=req(f),b=req(f);write(f,'共享.md');const na=await reference(f,a,'共享.md'),nb=await reference(f,b,'共享.md');
 const previous=f.r.plan({requirementId:b.id,selections:[{nodeId:nb.id}]});f.r.remove({planId:previous.id});
 let p=f.files.plan({path:'共享.md'});assert.equal(p.nodes.length,1);f.files.remove({planId:p.id});assert.equal(f.service.canvas.getBoard(a.id).nodes.some(n=>n.id===na.id),false);f.r.restore({entryId:p.id});assert.ok(f.service.canvas.getBoard(a.id).nodes.some(n=>n.id===na.id));assert.equal(f.service.canvas.getBoard(b.id).nodes.some(n=>n.id===nb.id),false);
 f.r.restore({entryId:previous.id});p=f.files.plan({path:'共享.md'});assert.equal(p.courses.length,2);f.files.remove({planId:p.id});for(const r of [a,b])assert.equal(f.service.canvas.getBoard(r.id).nodes.length,1);
 f.r.restore({entryId:p.id});for(const r of [a,b])assert.equal(f.service.canvas.getBoard(r.id).nodes.length,2);
});
test('new descendants, changed bytes, newly added references and foreign project invalidate old confirmation',async t=>{
 const f=fixture(t),other=fixture(t);write(f,'资料/a.md');let p=f.files.plan({path:'资料'});write(f,'资料/b.md');assert.throws(()=>f.files.remove({planId:p.id}),/已变化/);assert.ok(existsSync(path.join(f.root,'资料/a.md')));
 p=f.files.plan({path:'资料'});write(f,'资料/a.md','改过');assert.throws(()=>f.files.remove({planId:p.id}),/已变化/);
 p=f.files.plan({path:'资料'});await reference(f,req(f),'资料/a.md');assert.throws(()=>f.files.remove({planId:p.id}),/已变化/);assert.throws(()=>other.files.remove({planId:p.id}),/当前项目/);
});
test('current project control and traversal remain isolated while nested control directories and links can be recycled',t=>{
 const f=fixture(t);write(f,'资料/内容.md');mkdirSync(path.join(f.root,'资料/.wtt-workbench'));write(f,'外部.md','不删除');symlinkSync(path.join(f.root,'外部.md'),path.join(f.root,'资料/链接'));
 for(const selected of ['', '../外部.md', '/etc/passwd','.wtt-workbench'])assert.throws(()=>f.files.plan({path:selected}));
 const p=f.files.plan({path:'资料'});assert.equal(p.links.length,1);f.files.remove({planId:p.id});assert.equal(readFileSync(path.join(f.root,'外部.md'),'utf8'),'不删除');f.r.restore({entryId:p.id});assert.equal(readlinkSync(path.join(f.root,'资料/链接')),path.join(f.root,'外部.md'));assert.ok(existsSync(path.join(f.root,'资料/.wtt-workbench')));
});
test('restore rejects occupied name and leaves all recycled files intact',t=>{
 const f=fixture(t);write(f,'文件夹/a.txt');const p=f.files.plan({path:'文件夹'});f.files.remove({planId:p.id});write(f,'文件夹/新文件.txt','同名新目录');assert.throws(()=>f.r.restore({entryId:p.id}),/同名/);assert.equal(readFileSync(path.join(f.root,'文件夹/新文件.txt'),'utf8'),'同名新目录');assert.ok(existsSync(path.join(f.root,p.files[0].trash)));
});
test('partial move failure rolls back bytes and never hides cards',async t=>{
 let calls=0;const f=fixture(t,{recycleMove(a,b){if(++calls===2)throw new Error('模拟移动失败');linkSync(a,b);unlinkSync(a)}}),r=req(f);write(f,'资料/a.md');write(f,'资料/b.md');const n=await reference(f,r,'资料/a.md'),p=f.files.plan({path:'资料'});
 assert.throws(()=>f.files.remove({planId:p.id}),/模拟移动失败/);assert.ok(existsSync(path.join(f.root,'资料/a.md')));assert.ok(existsSync(path.join(f.root,'资料/b.md')));assert.ok(f.service.canvas.getBoard(r.id).nodes.some(x=>x.id===n.id));assert.equal(f.r.entry(p.id).state,'planned');
});
test('interrupted directory move and restore roll back to their safe states on reopen',t=>{
 const f=fixture(t);write(f,'资料/a.md');mkdirSync(path.join(f.root,'资料/空'));const p=f.files.plan({path:'资料'}),trash=f.r.trash(p.files[0].trash);linkSync(path.join(f.root,'资料/a.md'),trash);unlinkSync(path.join(f.root,'资料/a.md'));rmdirSync(path.join(f.root,'资料/空'));rmdirSync(path.join(f.root,'资料'));
 f.r.db.prepare("UPDATE canvas_recycle_entries SET state='moving',mode=1,owner_pid=2147483647 WHERE id=?").run(p.id);const a=new WorkbenchService({workspaceRoot:f.root});t.after(()=>a.close());assert.ok(existsSync(path.join(f.root,'资料/空')));assert.ok(existsSync(path.join(f.root,'资料/a.md')));assert.equal(a.recycle.entry(p.id).state,'planned');
 const next=a.recycle.fileEntries.plan({path:'资料'});a.recycle.fileEntries.remove({planId:next.id});mkdirSync(path.join(f.root,'资料'));linkSync(a.recycle.trash(next.files[0].trash),path.join(f.root,'资料/a.md'));unlinkSync(a.recycle.trash(next.files[0].trash));a.recycle.db.prepare("UPDATE canvas_recycle_entries SET state='restoring',owner_pid=2147483647 WHERE id=?").run(next.id);
 const b=new WorkbenchService({workspaceRoot:f.root});t.after(()=>b.close());assert.equal(existsSync(path.join(f.root,'资料')),false);assert.ok(existsSync(b.recycle.trash(next.files[0].trash)));assert.equal(b.recycle.entry(next.id).state,'removed');
});
test('folder recycle integrates with permanent clear including empty folders, without removing adjacent sources',t=>{
 const f=fixture(t);write(f,'资料/a.md');write(f,'保留.md');mkdirSync(path.join(f.root,'仅空目录'));const p=f.files.plan({path:'资料'}),q=f.files.plan({path:'仅空目录'});f.files.remove({planId:p.id});f.files.remove({planId:q.id});
 const cleanup=f.r.purgePlan({all:true});assert.equal(cleanup.entryCount,2);assert.equal(cleanup.fileCount,1);f.r.purge({planId:cleanup.id,confirmation:'永久删除'});assert.equal(f.r.list().length,0);assert.equal(readFileSync(path.join(f.root,'保留.md'),'utf8'),'技术原件');assert.equal(existsSync(path.join(f.root,p.files[0].trash)),false);
});
test('task directory in use is refused even without a registered output card',t=>{
 const f=fixture(t),r=req(f),{task}=f.service.createTask({requirementId:r.id,instruction:'测试生成',outputType:'text',selectedCardIds:[],sourceRefs:[],selectedSkills:[],generation:{mode:'new'},operationId:randomUUID()});write(f,`courses/${r.id}/tasks/${task.id}/working/临时.md`);f.r.db.prepare("UPDATE course_tasks SET status='unknown' WHERE id=?").run(task.id);assert.throws(()=>f.files.plan({path:`courses/${r.id}/tasks/${task.id}`}),/停止原任务/);
});
test('old-version files and human-readable mirrors map back to the current card without deleting its other versions',async t=>{
 const f=fixture(t),r=req(f),input=extra=>({requirementId:r.id,instruction:'测试文本',outputType:'text',selectedCardIds:[],sourceRefs:[],selectedSkills:[],generation:{mode:'new'},operationId:randomUUID(),...extra});
 async function publish(created,name,body){const relative=`${created.prepared.deliveryDirectory}/${name}`;write(f,relative,body);const sessionId=`session:${created.task.id}`;f.service.tasks.bindSession({taskId:created.task.id,sessionId});return f.service.tasks.files.register({taskId:created.task.id,path:relative,kind:'text',title:name,primary:true,operationId:randomUUID()},{sessionId})}
 const first=f.service.createTask(input()),one=await publish(first,'first.md','# V1');let card=f.service.canvas.getBoard(r.id).nodes.find(n=>n.outputCard);const second=f.service.createTask(input({generation:{mode:'revise',cardId:card.outputCard.id,baseVersionId:card.outputCard.versionId}})),two=await publish(second,'second.md','# V2');
 card=f.service.canvas.getBoard(r.id).nodes.find(n=>n.outputCard);let p=f.files.plan({path:one.path});assert.equal(p.nodes[0].nodeId,card.id);f.files.remove({planId:p.id});assert.equal(readFileSync(path.join(f.root,two.path),'utf8'),'# V2');assert.equal(f.service.canvas.getBoard(r.id).nodes.some(n=>n.id===card.id),false);f.r.restore({entryId:p.id});assert.equal(f.service.canvas.getBoard(r.id).nodes.find(n=>n.id===card.id).outputCard.number,2);
 f.service.deliverables.sync(r.id);const mirror=f.service.deliverables.info(`artifact:${two.id}`);p=f.files.plan({path:mirror.path});assert.ok(p.nodes.some(n=>n.nodeId===card.id));f.files.remove({planId:p.id});assert.equal(readFileSync(path.join(f.root,two.path),'utf8'),'# V2');f.r.restore({entryId:p.id});
});
test('cross-course layouts and manual relations restore while unrelated entries remain hidden',async t=>{
 const f=fixture(t),r=req(f);write(f,'a.md');const node=await reference(f,r,'a.md');let board=f.service.canvas.getBoard(r.id);const edge={id:'manual:'+randomUUID(),source:'requirement:'+r.id,target:node.id};f.service.canvas.saveBoard({requirementId:r.id,expectedRevision:board.revision,positions:{[node.id]:{x:700,y:500}},edges:[edge],groups:[],elements:[]});
 const p=f.files.plan({path:'a.md'});f.files.remove({planId:p.id});board=f.service.canvas.getBoard(r.id);f.service.canvas.saveBoard({requirementId:r.id,expectedRevision:board.revision,positions:{},edges:[],groups:[],elements:[]});f.r.restore({entryId:p.id});board=f.service.canvas.getBoard(r.id);assert.deepEqual(board.nodes.find(n=>n.id===node.id).position,{x:700,y:500});assert.ok(board.edges.some(e=>e.id===edge.id));
});
test('HTTP deletion requires explicit project and a server-issued confirmation plan',async t=>{
 const {apply}=await import('../src/index.mjs');const root=mkdtempSync(path.join(tmpdir(),'cw44-api-'));let endpoint;const dispose=[];apply({effect(fn){const d=fn();if(typeof d==='function')dispose.push(d)},connection:{fetch:{register(value){endpoint=value;return()=>{}}}},tools:{register(){return()=>{}}},skills:{register(){return()=>{}}}},{workspaceRoot:root,registryFile:path.join(root,'.projects.json')});t.after(()=>{for(const d of dispose.reverse())d();rmSync(root,{recursive:true,force:true})});
 const request=(query={},body)=>endpoint.fetch(new Request('http://localhost/api/wtt-creation-workbench?'+new URLSearchParams(query),body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined));const projectId=(await(await request({projects:'1'})).json()).activeProjectId;writeFileSync(path.join(root,'测试.txt'),'原件');
 assert.equal((await request({},{action:'project-file-delete-plan',data:{path:'测试.txt'}})).status,400);assert.equal((await request({projectId},{action:'project-file-delete',data:{path:'测试.txt'}})).status,400);
 const p=await(await request({projectId},{action:'project-file-delete-plan',data:{path:'测试.txt'}})).json();assert.ok(existsSync(path.join(root,'测试.txt')));const result=await request({projectId},{action:'project-file-delete',data:{planId:p.id}});assert.equal(result.status,200);assert.equal(existsSync(path.join(root,'测试.txt')),false);assert.equal((await request({projectId},{action:'canvas-recycle-restore',data:{entryId:p.id}})).status,200);assert.equal(readFileSync(path.join(root,'测试.txt'),'utf8'),'原件');
});
test('nested real project database, git, dependencies and runtime directories round-trip without name-based rejection',t=>{
 const f=fixture(t),nested=path.join(f.root,'aaa');mkdirSync(nested);const child=new WorkbenchService({workspaceRoot:nested}),record=child.store.createRequirement({background:'子项目业务保留',operationId:randomUUID()});child.close();
 for(const name of ['aaa/.git/config','aaa/node_modules/package/index.js','aaa/.runtime/配置.json'])write(f,name,'原文 '+name);
 const p=f.files.plan({path:'aaa'});assert.ok(p.files.some(file=>file.path==='aaa/.wtt-workbench/workbench.sqlite'));f.files.remove({planId:p.id});assert.equal(existsSync(nested),false);f.r.restore({entryId:p.id});
 const reopened=new WorkbenchService({workspaceRoot:nested});t.after(()=>reopened.close());assert.equal(reopened.store.getRequirement(record.id).background,'子项目业务保留');for(const name of ['aaa/.git/config','aaa/node_modules/package/index.js','aaa/.runtime/配置.json'])assert.equal(readFileSync(path.join(f.root,name),'utf8'),'原文 '+name);
});
test('ordinary and dangling links delete only the link; clearing link recovery metadata never follows targets',t=>{
 const f=fixture(t),outside=mkdtempSync(path.join(tmpdir(),'cw44-target-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));writeFileSync(path.join(outside,'保留.txt'),'目标不动');
 symlinkSync(outside,path.join(f.root,'目录链接'));symlinkSync(path.join(outside,'不存在'),path.join(f.root,'悬空链接'));
 let p=f.files.plan({path:'目录链接'});assert.equal(p.target.symbolicLink,true);assert.equal(p.files.length,0);assert.equal(p.links.length,1);f.files.remove({planId:p.id});assert.equal(readFileSync(path.join(outside,'保留.txt'),'utf8'),'目标不动');f.r.restore({entryId:p.id});assert.equal(readlinkSync(path.join(f.root,'目录链接')),outside);
 p=f.files.plan({path:'悬空链接'});f.files.remove({planId:p.id});const clear=f.r.purgePlan({all:true});assert.equal(clear.linkCount,1);f.r.purge({planId:clear.id,confirmation:'永久删除'});assert.equal(readFileSync(path.join(outside,'保留.txt'),'utf8'),'目标不动');assert.equal(readlinkSync(path.join(f.root,'目录链接')),outside);
});
test('changed link invalidates confirmation and interrupted link removal restores original link metadata',t=>{
 const f=fixture(t);symlinkSync('/does-not-exist-a',path.join(f.root,'链接'));const p=f.files.plan({path:'链接'});unlinkSync(path.join(f.root,'链接'));symlinkSync('/does-not-exist-b',path.join(f.root,'链接'));assert.throws(()=>f.files.remove({planId:p.id}),/已变化/);assert.equal(readlinkSync(path.join(f.root,'链接')),'/does-not-exist-b');
 const q=f.files.plan({path:'链接'});unlinkSync(path.join(f.root,'链接'));f.r.db.prepare("UPDATE canvas_recycle_entries SET state='moving',mode=1,owner_pid=2147483647 WHERE id=?").run(q.id);const reopened=new WorkbenchService({workspaceRoot:f.root});t.after(()=>reopened.close());assert.equal(readlinkSync(path.join(f.root,'链接')),'/does-not-exist-b');assert.equal(reopened.recycle.entry(q.id).state,'planned');
});
test('cached child project closes before planning, stale changes reject, restored project can reopen with new directory identity',async t=>{
 const {ProjectRegistry}=await import('../src/project-registry.mjs'),f=fixture(t);mkdirSync(path.join(f.root,'aaa'));const registry=new ProjectRegistry({workspaceRoot:f.root,registryFile:path.join(f.root,'.projects.json')});t.after(()=>registry.close());const owner=registry.get(),record=registry.open(path.join(f.root,'aaa')),child=registry.get(record.id),r=child.store.createRequirement({background:'子项目第一条',operationId:randomUUID()});
 const p=owner.recycle.fileEntries.plan({path:'aaa'});assert.equal(child.store.closed,true);const reopened=registry.get(record.id);reopened.store.createRequirement({background:'取消确认后新增',operationId:randomUUID()});assert.throws(()=>owner.recycle.fileEntries.remove({planId:p.id}),/已变化/);assert.ok(existsSync(path.join(f.root,'aaa')));
 const q=owner.recycle.fileEntries.plan({path:'aaa'});owner.recycle.fileEntries.remove({planId:q.id});assert.throws(()=>registry.get(record.id),/不可用/);owner.recycle.restore({entryId:q.id});const restored=registry.open(path.join(f.root,'aaa'));assert.equal(registry.get(restored.id).store.getRequirement(r.id).background,'子项目第一条');assert.equal(registry.get(restored.id).store.listRequirements().length,2);
});

test('resource recycle and permanent clear accept large ordinary files with bounded-memory hashing',t=>{
 const f=fixture(t),filename=path.join(f.root,'大文件.bin'),fd=openSync(filename,'w');ftruncateSync(fd,257*1024*1024);closeSync(fd);const p=f.files.plan({path:'大文件.bin'});assert.equal(p.files[0].bytes,257*1024*1024);f.files.remove({planId:p.id});assert.equal(statSync(path.join(f.root,p.files[0].trash)).size,257*1024*1024);const clear=f.r.purgePlan({all:true});f.r.purge({planId:clear.id,confirmation:'永久删除'});assert.equal(existsSync(path.join(f.root,p.files[0].trash)),false);
});
test('ordinary folders above the old 2000-entry threshold remain manageable as one confirmed scope',t=>{
 const f=fixture(t);mkdirSync(path.join(f.root,'大量文件'));for(let i=0;i<2001;i++)writeFileSync(path.join(f.root,'大量文件',i+'.txt'),'');const p=f.files.plan({path:'大量文件'});assert.equal(p.files.length,2001);f.files.remove({planId:p.id});assert.equal(existsSync(path.join(f.root,'大量文件')),false);f.r.restore({entryId:p.id});assert.ok(existsSync(path.join(f.root,'大量文件/2000.txt')));
});
test('deleting ordinary child-project contents does not close or consult an unrelated active ancestor project',async t=>{
 const {ProjectRegistry}=await import('../src/project-registry.mjs'),f=fixture(t);mkdirSync(path.join(f.root,'aaa'));const registry=new ProjectRegistry({workspaceRoot:f.root,registryFile:path.join(f.root,'.projects.json')});t.after(()=>registry.close());const parent=registry.get(),r=parent.store.createRequirement({background:'父项目运行任务',operationId:randomUUID()}),created=parent.createTask({requirementId:r.id,instruction:'父项目测试任务',outputType:'text',selectedCardIds:[],sourceRefs:[],selectedSkills:[],generation:{mode:'new'},operationId:randomUUID()});parent.store.db.prepare("UPDATE course_tasks SET status='unknown' WHERE id=?").run(created.task.id);
 const childRecord=registry.open(path.join(f.root,'aaa')),child=registry.get(childRecord.id);write(f,'aaa/普通文件.txt');const p=child.recycle.fileEntries.plan({path:'普通文件.txt'});assert.equal(parent.store.closed,false);child.recycle.fileEntries.remove({planId:p.id});assert.equal(parent.store.closed,false);child.recycle.restore({entryId:p.id});assert.equal(readFileSync(path.join(f.root,'aaa/普通文件.txt'),'utf8'),'技术原件');
});
