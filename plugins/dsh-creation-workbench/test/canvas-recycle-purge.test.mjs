import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,unlinkSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {WorkbenchService} from '../src/service.mjs';
function fixture(t,config={}){
 const root=mkdtempSync(path.join(tmpdir(),'cw43-')),service=new WorkbenchService({workspaceRoot:root,...config});
 const req=service.store.createRequirement({background:'回收清理技术验收',operationId:randomUUID()});
 t.after(()=>{service.close();rmSync(root,{recursive:true,force:true})});return {root,service,req,r:service.recycle};
}
async function removed(f,name='参考.md',deleteFiles=true){
 writeFileSync(path.join(f.root,name),'原件 '+name);const preview=await f.service.projectFiles.preview(name);
 const ref=await f.service.projectFiles.reference({requirementId:f.req.id,path:name,hash:preview.hash,operationId:randomUUID()});
 const node=ref.board.nodes.find(n=>n.refId===ref.material.id),plan=f.r.plan({requirementId:f.req.id,selections:[{nodeId:node.id}]});
 f.r.remove({planId:plan.id,deleteFiles});return {...plan,node};
}
const execute=(f,p)=>f.r.purge({planId:p.id,confirmation:'永久删除'});
test('single purge requires exact confirmation, deletes only owned trash, keeps new source and unrelated records, and is idempotent',async t=>{
 const f=fixture(t),a=await removed(f,'a.md'),b=await removed(f,'b.md');writeFileSync(path.join(f.root,'a.md'),'同名新源文件');
 const p=f.r.purgePlan({entryIds:[a.id]});assert.equal(p.entryCount,1);assert.equal(p.fileCount,1);assert.equal(p.entries[0].files[0].originalPath,'a.md');
 assert.throws(()=>f.r.purge({planId:p.id}),/确认永久删除/);assert.ok(existsSync(path.join(f.root,a.files[0].trash)));
 const result=execute(f,p);assert.equal(result.state,'purged');assert.deepEqual(execute(f,p),result);assert.equal(existsSync(path.join(f.root,a.files[0].trash)),false);
 assert.equal(readFileSync(path.join(f.root,'a.md'),'utf8'),'同名新源文件');assert.ok(existsSync(path.join(f.root,b.files[0].trash)));assert.deepEqual(f.r.list().map(e=>e.id),[b.id]);
 assert.throws(()=>f.r.restore({entryId:a.id}),/不属于当前项目/);assert.equal(f.service.canvas.getBoard(f.req.id).nodes.some(n=>n.id===a.node.id),false);
});
test('node-only purge keeps bytes and business records across reopen, and explicit re-import can show the file again',async t=>{
 const f=fixture(t),a=await removed(f,'保留.md',false),before=readFileSync(path.join(f.root,'保留.md')),p=f.r.purgePlan({all:true});assert.equal(p.fileCount,0);
 const count=f.r.db.prepare('SELECT count(*) AS n FROM canvas_materials').get().n;execute(f,p);
 assert.deepEqual(readFileSync(path.join(f.root,'保留.md')),before);assert.equal(f.r.db.prepare('SELECT count(*) AS n FROM canvas_materials').get().n,count);
 const reopened=new WorkbenchService({workspaceRoot:f.root});t.after(()=>reopened.close());assert.equal(reopened.recycle.list().length,0);assert.equal(reopened.canvas.getBoard(f.req.id).nodes.some(n=>n.id===a.node.id),false);
 const preview=await reopened.projectFiles.preview('保留.md');await reopened.projectFiles.reference({requirementId:f.req.id,path:'保留.md',hash:preview.hash,operationId:randomUUID(),position:{x:110,y:120}});
 assert.ok(reopened.canvas.getBoard(f.req.id).nodes.some(n=>n.id===a.node.id));assert.deepEqual(reopened.canvas.getRawBoard(f.req.id).layoutPositions[a.node.id],{x:110,y:120});
});
test('clear plan is a snapshot and leaves items added after confirmation untouched',async t=>{
 const f=fixture(t),a=await removed(f,'first.md'),b=await removed(f,'second.md',false),p=f.r.purgePlan({all:true}),later=await removed(f,'later.md');
 assert.equal(p.entryCount,2);execute(f,p);assert.deepEqual(f.r.list().map(e=>e.id),[later.id]);assert.ok(existsSync(path.join(f.root,later.files[0].trash)));assert.ok(existsSync(path.join(f.root,'second.md')));assert.equal(existsSync(path.join(f.root,a.files[0].trash)),false);
 assert.throws(()=>f.r.purgePlan({entryIds:[]}),/无效/);assert.throws(()=>f.r.purgePlan({entryIds:[later.id,later.id]}),/无效/);
});
test('foreign project, restored records, and post-confirmation file changes reject without deleting',async t=>{
 const f=fixture(t),other=fixture(t),a=await removed(f),p=f.r.purgePlan({entryIds:[a.id]});assert.throws(()=>execute(other,p),/不属于当前项目/);assert.throws(()=>other.r.purgePlan({entryIds:[a.id]}),/不属于当前项目/);
 f.r.restore({entryId:a.id});assert.throws(()=>execute(f,p),/已恢复/);assert.ok(existsSync(path.join(f.root,'参考.md')));
 const b=await removed(f,'变化.md'),q=f.r.purgePlan({entryIds:[b.id]});writeFileSync(path.join(f.root,b.files[0].trash),'外部改过');assert.throws(()=>execute(f,q),/文件已变化/);assert.equal(readFileSync(path.join(f.root,b.files[0].trash),'utf8'),'外部改过');assert.equal(f.r.entry(b.id).state,'removed');
});
test('symlinks and forged trash paths never delete outside the entry directory',async t=>{
 const f=fixture(t),a=await removed(f),outside=path.join(f.root,'外部原件.md');writeFileSync(outside,'不能删除');const trash=path.join(f.root,a.files[0].trash);unlinkSync(trash);symlinkSync(outside,trash);
 assert.throws(()=>f.r.purgePlan({entryIds:[a.id]}),/链接/);assert.equal(readFileSync(outside,'utf8'),'不能删除');unlinkSync(trash);writeFileSync(trash,'原件 参考.md');
 const row=f.r.entry(a.id);row.plan.files[0].trash='../外部原件.md';f.r.db.prepare('UPDATE canvas_recycle_entries SET plan_json=? WHERE id=?').run(JSON.stringify(row.plan),a.id);
 assert.throws(()=>f.r.purgePlan({all:true}),/路径无效/);assert.ok(existsSync(outside));assert.ok(existsSync(trash));
});
test('partial unlink failure stays visible, blocks restore, and resumes safely after reopen',async t=>{
 let calls=0;const f=fixture(t,{recycleUnlink(file){if(++calls===2)throw new Error('模拟磁盘删除失败');unlinkSync(file)}}),a=await removed(f,'a.md'),b=await removed(f,'b.md'),p=f.r.purgePlan({all:true});
 assert.throws(()=>execute(f,p),/部分回收文件可能已删除/);assert.equal(f.r.list().length,2);assert.ok(f.r.list().every(e=>e.state==='purging'));assert.throws(()=>f.r.restore({entryId:a.id}),/暂不能恢复/);
 const reopened=new WorkbenchService({workspaceRoot:f.root});t.after(()=>reopened.close());assert.equal(reopened.recycle.purgePlan({all:true}).fileCount,1);
 assert.equal(reopened.recycle.purge({planId:p.id,confirmation:'永久删除'}).state,'purged');assert.equal(reopened.recycle.list().length,0);assert.equal(existsSync(path.join(f.root,a.files[0].trash)),false);assert.equal(existsSync(path.join(f.root,b.files[0].trash)),false);
});
test('purging selected formal version and mirror preserves other versions and business facts',t=>{
 const f=fixture(t),a=f.service.store.saveOutline({requirementId:f.req.id,markdown:'# V1',operationId:randomUUID()}),b=f.service.store.saveOutline({requirementId:f.req.id,markdown:'# V2',operationId:randomUUID()});f.service.deliverables.sync(f.req.id);
 const node=f.service.canvas.getBoard(f.req.id).nodes.find(n=>n.refId===a.id),r=f.r.plan({requirementId:f.req.id,selections:[{nodeId:node.id}]});f.r.remove({planId:r.id,deleteFiles:true});const p=f.r.purgePlan({all:true});assert.equal(p.fileCount,2);execute(f,p);
 assert.equal(readFileSync(path.join(f.root,b.markdownPath),'utf8'),'# V2');assert.ok(f.service.store.getVersion(a.id));assert.ok(f.service.store.getRequirement(f.req.id));assert.equal(f.service.canvas.getBoard(f.req.id).nodes.some(n=>n.id===node.id),false);
});
test('missing trash can be reviewed honestly; all cannot silently skip an in-progress restore',async t=>{
 const f=fixture(t),a=await removed(f);unlinkSync(path.join(f.root,a.files[0].trash));const p=f.r.purgePlan({all:true});assert.equal(p.fileCount,0);assert.equal(p.entries[0].files[0].missing,true);execute(f,p);assert.equal(f.r.list().length,0);assert.throws(()=>f.r.purgePlan({all:true}),/回收站为空/);
 const b=await removed(f,'busy.md');f.r.db.prepare("UPDATE canvas_recycle_entries SET state='restoring' WHERE id=?").run(b.id);assert.throws(()=>f.r.purgePlan({all:true}),/正在处理/);assert.ok(existsSync(path.join(f.root,b.files[0].trash)));
});
