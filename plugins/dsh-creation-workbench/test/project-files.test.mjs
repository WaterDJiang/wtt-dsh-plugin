import {spawnSync} from 'node:child_process';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,existsSync,rmSync,symlinkSync} from 'node:fs';import path from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';import {WorkbenchService} from '../src/service.mjs';import {apply} from '../src/index.mjs';
function fixture(t){const root=mkdtempSync(path.join(tmpdir(),'cw37-')),service=new WorkbenchService({workspaceRoot:root}),req=service.store.createRequirement({background:'文件树验收',operationId:randomUUID()});t.after(()=>{service.close();rmSync(root,{recursive:true,force:true})});return {root,service,req,files:service.projectFiles}}
test('project tree is lazy, directory-first and hides current control paths; visible links are not followed and create never overwrites',async t=>{
 const f=fixture(t);mkdirSync(path.join(f.root,'资料'));writeFileSync(path.join(f.root,'原件.md'),'原文');mkdirSync(path.join(f.root,'node_modules'));writeFileSync(path.join(f.root,'.secret'),'secret');symlinkSync(path.join(f.root,'资料'),path.join(f.root,'link'));
 mkdirSync(path.join(f.root,'courses','17f66d50','materials'),{recursive:true});writeFileSync(path.join(f.root,'courses','17f66d50','materials','素材.md'),'快照');
 assert.deepEqual(new Set(f.files.list().entries.map(x=>x.name)),new Set(['资料','node_modules','link','原件.md']));
 assert.equal(f.files.list().entries.some(x=>x.name==='courses'),false);
 assert.deepEqual(new Set(f.files.list('courses/17f66d50/materials').entries.map(x=>x.name)),new Set(['素材.md']));assert.equal(f.files.list().entries.find(x=>x.name==='link').symbolicLink,true);assert.deepEqual(f.files.list('node_modules').entries,[]);assert.deepEqual(f.files.list('资料').entries,[]);
 assert.equal(f.files.create({parent:'资料',name:'课纲'}).path,'资料/课纲');assert.equal(statSync(path.join(f.root,'资料/课纲')).size,0);
 assert.throws(()=>f.files.create({name:'原件.md'}),/已存在/);assert.equal(readFileSync(path.join(f.root,'原件.md'),'utf8'),'原文');assert.equal(f.files.create({name:'空课件.pptx'}).name,'空课件.pptx');assert.equal(statSync(path.join(f.root,'空课件.pptx')).size,0);
 for(const p of ['../escape','/etc/passwd','.wtt-workbench','link'])assert.throws(()=>f.files.list(p));
 for(const name of ['../a','.env','foo/bar'])assert.throws(()=>f.files.create({name}));
 assert.throws(()=>f.files.create({kind:'folder',name:'.git'}));assert.equal(existsSync(path.join(f.root,'.git')),false);
});
test('drag references keep original path and bytes; repeat is deduplicated and changed source creates separate frozen reference',async t=>{
 const f=fixture(t),p='资料.csv';writeFileSync(path.join(f.root,p),'环节,分钟\n案例,20\n');const before=readFileSync(path.join(f.root,p)),v=await f.files.preview(p);assert.equal(f.service.canvas.getBoard(f.req.id).nodes.length,1);
 const input={requirementId:f.req.id,path:p,hash:v.hash,position:{x:432,y:-123},operationId:randomUUID()};const r=await f.files.reference(input),again=await f.files.reference({...input,operationId:randomUUID()});assert.equal(r.material.id,again.material.id);assert.deepEqual(readFileSync(path.join(f.root,p)),before);
 let n=f.service.canvas.getBoard(f.req.id).nodes.find(n=>n.projectFile);assert.equal(n.projectFile.path,p);assert.equal(n.projectFile.status,'ready');assert.deepEqual(n.position,{x:432,y:-123});assert.equal(f.service.canvas.readImportedFile(n.refId).bytes.toString(),before.toString());
 writeFileSync(path.join(f.root,p),'环节,分钟\n案例,30\n');await assert.rejects(f.files.reference({...input,operationId:randomUUID()}),/已变化/);n=f.service.canvas.getBoard(f.req.id).nodes.find(n=>n.projectFile);assert.equal(n.projectFile.status,'changed');assert.equal(f.service.canvas.readImportedFile(n.refId).bytes.toString(),before.toString());
 const next=await f.files.preview(p),r2=await f.files.reference({...input,hash:next.hash,operationId:randomUUID()});assert.notEqual(r.material.id,r2.material.id);assert.equal(f.service.canvas.getBoard(f.req.id).nodes.filter(n=>n.projectFile).length,2);
 const foreign=fixture(t);await assert.rejects(foreign.files.reference({...input,hash:next.hash,operationId:randomUUID()}));
});

test('mention search distinguishes nested files and snapshots only a selected visible project file', async t => {
 const f=fixture(t);
 for(const folder of ['A','B','courses','.hidden','node_modules']){
  mkdirSync(path.join(f.root,folder),{recursive:true});
  writeFileSync(path.join(f.root,folder,'课纲.md'),folder);
 }
 symlinkSync(path.join(f.root,'B'),path.join(f.root,'link'));
 writeFileSync(path.join(f.root,'课纲.bin'),'unavailable');
 assert.deepEqual(f.files.searchReferences('课纲').entries.map(entry=>entry.path),['A/课纲.md','B/课纲.md']);
 assert.equal(f.service.canvas.getBoard(f.req.id).nodes.length,1);
 const input={requirementId:f.req.id,path:'B/课纲.md',operationId:randomUUID()};
 await assert.rejects(f.files.reference(input),/先读取/);
 const selected=await f.files.reference({...input,useCurrentFile:true});
 assert.equal(f.service.canvas.readImportedFile(selected.material.id).bytes.toString(),'B');
 for(const path of ['courses/课纲.md','.hidden/课纲.md','link/课纲.md','../课纲.md']){
  await assert.rejects(f.files.reference({...input,path,useCurrentFile:true,operationId:randomUUID()}));
 }
});
test('file references reuse document working-copy versions and persist across restart',async t=>{
 const f=fixture(t);writeFileSync(path.join(f.root,'练习.csv'),'A,B\n1,2\n');const file=await f.files.preview('练习.csv'),r=await f.files.reference({requirementId:f.req.id,path:file.path,hash:file.hash,operationId:randomUUID()});const n=r.board.nodes.find(n=>n.refId===r.material.id),scope={requirementId:f.req.id,cardId:n.outputCard.id,versionId:n.outputCard.versionId,sourceRef:n.id,hash:n.importedFile.hash};let d=await f.service.documents.open(scope);d=await f.service.documents.saveDraft({draftId:d.id,revision:0,patch:{rows:[['A','B'],['修改','2']]}});const v=await f.service.externalDocuments.saveVersion({draftId:d.id,revision:d.revision,hash:(await f.service.documents.snapshot(d.id,d.revision)).hash,operationId:randomUUID()});assert.ok(v.artifactId);assert.equal(readFileSync(path.join(f.root,'练习.csv'),'utf8'),'A,B\n1,2\n');
 const second=new WorkbenchService({workspaceRoot:f.root});t.after(()=>second.close());assert.equal(second.canvas.getRawBoard(f.req.id).nodes.find(x=>x.refId===r.material.id).projectFile.path,'练习.csv');
});
test('project file HTTP requires explicit scope and denies script execution, altered downloads and current control paths',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'cw37-api-')),dispose=[];let endpoint;apply({effect(fn){const d=fn();if(typeof d==='function')dispose.push(d)},connection:{fetch:{register(x){endpoint=x;return()=>{}}}},tools:{register(){return()=>{}}},skills:{register(){return()=>{}}}},{workspaceRoot:root,registryFile:path.join(root,'.projects.json')});t.after(()=>{for(const d of dispose.reverse())d();rmSync(root,{recursive:true,force:true})});
 const request=(query={},body)=>endpoint.fetch(new Request('http://localhost/api/wtt-creation-workbench?'+new URLSearchParams(query),body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined));const projectId=(await (await request({projects:'1'})).json()).activeProjectId;
 assert.equal((await request({projectFiles:''})).status,400);assert.equal((await request({projectId,projectFiles:''})).status,200);
 const made=await request({projectId},{action:'project-file-create',data:{name:'参考.md'}});assert.equal(made.status,200);const v=await (await request({projectId,projectFilePreview:'参考.md'})).json();assert.equal(v.content,'');assert.equal((await request({projectId,projectFileDownload:'参考.md',hash:v.hash})).status,200);
 writeFileSync(path.join(root,'参考.md'),'changed');assert.equal((await request({projectId,projectFileDownload:'参考.md',hash:v.hash})).status,400);assert.equal((await request({projectId,projectFiles:'.wtt-workbench'})).status,400);
 writeFileSync(path.join(root,'page.html'),'<script>alert(1)</script>');const code=await request({projectId,projectFileDownload:'page.html',preview:'1'});assert.equal(code.status,400);const download=await request({projectId,projectFileDownload:'page.html'});assert.match(download.headers.get('content-disposition'),/attachment/);
});

test('file tree PDF pages reuse checked renderer without creating course cards',async t=>{
 const f=fixture(t),file=path.join(f.root,'预览.pdf');const made=spawnSync('python3',['-c',"import fitz,sys;d=fitz.open();d.new_page().insert_text((72,72),'File tree preview');d.save(sys.argv[1])",file],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);
 const before=readFileSync(file),info=await f.files.preview('预览.pdf'),pages=await f.files.documentPreview.get('预览.pdf',info.hash);assert.equal(pages.pageCount,1);const image=await f.files.documentPreview.page('预览.pdf',info.hash,1);assert.equal(image.mime,'image/png');assert.deepEqual(image.bytes.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));assert.equal(f.service.canvas.getBoard(f.req.id).nodes.length,1);assert.deepEqual(readFileSync(file),before);
 await assert.rejects(f.files.documentPreview.page('预览.pdf',info.hash,2),/页码/);await assert.rejects(f.files.documentPreview.get('../预览.pdf',info.hash));
});
test('text and code references remain plain text and do not execute markup',async t=>{
 const f=fixture(t);writeFileSync(path.join(f.root,'示例.html'),'<script>not executed</script>');const v=await f.files.preview('示例.html'),r=await f.files.reference({requirementId:f.req.id,path:v.path,hash:v.hash,operationId:randomUUID()});assert.match(r.material.content,/<script>/);assert.equal(f.service.canvas.readImportedFile(r.material.id).mime,'text/plain');
});

test('IDE create preserves any suffix or no suffix, refuses content and keeps nested originals',async t=>{
 const f=fixture(t);f.files.create({name:'第一层',kind:'folder'});f.files.create({parent:'第一层',name:'第二层',kind:'folder'});
 for(const name of ['无后缀','课程.docx','演示.pptx','资料.pdf','图.png','片.mp4','数据.CSV','配置.custom-format']){
  const made=f.files.create({parent:'第一层/第二层',name});assert.equal(made.path,'第一层/第二层/'+name);assert.equal(statSync(path.join(f.root,made.path)).size,0);const preview=await f.files.preview(made.path);assert.equal(preview.empty,true);assert.equal(preview.extractionStatus,'empty');assert.equal(preview.error,undefined);
 }
 for(const content of ['正文',null,{},0]){assert.throws(()=>f.files.create({name:'不得写入.md',content}),/只创建空文件/);assert.equal(existsSync(path.join(f.root,'不得写入.md')),false)}
 writeFileSync(path.join(f.root,'第一层/第二层/课程.docx'),'original bytes');assert.throws(()=>f.files.create({parent:'第一层/第二层',name:'课程.docx'}),/已存在/);assert.equal(readFileSync(path.join(f.root,'第一层/第二层/课程.docx'),'utf8'),'original bytes');
 assert.throws(()=>f.files.create({parent:'第一层/../../',name:'越界.md'}));
});
test('project file cards expose reveal and default-app open with safe paths and text-only whitelist',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'cw37-open-'));const calls=[];
 const service=new WorkbenchService({workspaceRoot:root,projectFileLauncher:async(file,args)=>{calls.push([path.basename(file),...args])}});
 t.after(()=>{service.close();rmSync(root,{recursive:true,force:true})});
 const files=service.projectFiles;writeFileSync(path.join(root,'笔记.md'),'内容');writeFileSync(path.join(root,'报告.pdf'),'%PDF-fake');
 await files.reveal({path:'笔记.md'});await files.openExternal({path:'笔记.md'});
 assert.deepEqual(calls.map(call=>[path.basename(call[0]),...call.slice(1).map(arg=>arg.endsWith('笔记.md')?'笔记.md':arg)]),[['笔记.md','-R','笔记.md'],['笔记.md','笔记.md']]);
 await assert.rejects(files.openExternal({path:'报告.pdf'}),/右栏预览/);
 await assert.rejects(files.reveal({path:'../escape.md'}));
 await assert.rejects(files.openExternal({path:'缺失.md'}));
 assert.equal(calls.length,2);
});
