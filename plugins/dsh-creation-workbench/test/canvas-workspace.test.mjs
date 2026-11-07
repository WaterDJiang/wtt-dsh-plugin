import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkbenchService } from '../src/service.mjs';
import { WorkbenchStore } from '../src/store.mjs';
import { createCardContext, updateCreationReferences, creationTaskInput } from '../src/creation-context.mjs';
import { apply } from '../src/index.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'cw45-'));
  const service = new WorkbenchService({ workspaceRoot: root });
  t.after(() => { service.close(); rmSync(root,{recursive:true,force:true}); });
  return {root,service};
}

test('opening an empty folder creates one actual canvas, no requirement card, background or business record', async t => {
  const {root,service} = fixture(t);
  assert.equal((await service.snapshot()).requirements.length,0);
  const initial = await service.snapshot({openCanvas:true});
  assert.equal(initial.requirements,undefined); // Avoid doubling full version bodies in snapshots.
  assert.equal((await service.snapshot()).canvases,undefined);
  const canvas = initial.canvases[0];
  assert.equal(canvas.origin,'canvas'); assert.equal(canvas.background,'');
  assert.equal(service.store.db.prepare("SELECT type FROM sqlite_master WHERE name='requirements'").get().type,'view');
  assert.deepEqual(service.canvas.getBoard(canvas.id).nodes,[]);
  assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM asset_business').get().n,0);
  assert.equal((await service.snapshot({openCanvas:true})).canvases[0].id,canvas.id);
  const secondStore = new WorkbenchStore(root);
  t.after(()=>secondStore.close());
  assert.equal(secondStore.ensureDefaultCanvas().id,canvas.id);
  const operationId = randomUUID();
  const other = secondStore.createCanvas({operationId});
  assert.equal(other.title,'画布 2');
  assert.deepEqual(secondStore.createCanvas({operationId}),other);
  assert.throws(()=>secondStore.createCanvas({operationId,title:'其他'}),/操作标识/);
  assert.equal(secondStore.ensureDefaultCanvas().id,other.id);
  assert.equal(secondStore.listCanvases().length,2);
  assert.deepEqual(secondStore.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('existing outlines become sources directly; blank creation has zero fake references and honest prompts', async t => {
  const {root,service} = fixture(t), canvas=service.store.ensureDefaultCanvas();
  const content='# 现有课纲\n\n## 课程主线\n案例、练习与复盘。';
  writeFileSync(path.join(root,'现有课纲.md'),content);
  const file=await service.projectFiles.preview('现有课纲.md');
  const ref=await service.projectFiles.reference({requirementId:canvas.id,path:file.path,hash:file.hash,operationId:randomUUID(),position:{x:32,y:64}});
  const node=ref.board.nodes.find(n=>n.kind==='material');
  const fromFile=createCardContext({projectId:'test',requirement:canvas,anchor:node,outputType:'pptx',generation:{mode:'new'}});
  assert.equal(fromFile.pptEngine,'baoyu');assert.equal(fromFile.references[0].projectFile,undefined);
  assert.equal(fromFile.references[0].id,node.id);
  const selected=service.prepareCanvas({...creationTaskInput({...fromFile,instruction:'依据已有课纲制作 PPT'})});
  assert.equal(selected.context[0].hash,node.sourceHash);
  assert.equal(readFileSync(path.join(root,'现有课纲.md'),'utf8'),content);
  const blank=createCardContext({projectId:'test',requirement:canvas,anchor:{kind:'canvas'},blank:true,outputType:'text',generation:{mode:'new'},outputPosition:{x:100,y:100}});
  assert.deepEqual(blank.references,[]);
  const enriched=updateCreationReferences(blank,[node]);
  assert.equal(enriched.references.length,1);
  assert.deepEqual(updateCreationReferences(enriched,[]).references,[]);
  assert.throws(()=>createCardContext({projectId:'test',requirement:canvas,anchor:{kind:'canvas'}}),/没有|尚无/);
  const {task,prepared}=service.createTask({...creationTaskInput({...blank,instruction:'写一段开场白'}),operationId:randomUUID()});
  assert.equal(task.status,'draft');assert.equal(task.sessionId,null);
  assert.equal(task.input.canvasId,canvas.id);assert.deepEqual(task.input.sources,[]);
  assert.doesNotMatch(prepared.prompt,/必要业务上下文|\/wtt-course-eight-steps-dev/);
  assert.match(prepared.prompt,/不得编造/);
  assert.equal(service.canvas.getBoard(canvas.id).nodes.filter(n=>n.kind==='requirement').length,0);
});

test('optional background uses optimistic conflict checks and never deletes the canvas or other cards', async t=>{
  const {service}=fixture(t), c=service.store.ensureDefaultCanvas();
  const material=service.canvas.addMaterial({requirementId:c.id,title:'已有资料',content:'内容',operationId:randomUUID()});
  const operationId=randomUUID(), input={canvasId:c.id,background:'真实业务背景',expectedBackground:'',operationId};
  const saved=service.store.saveCanvasBackground(input);
  assert.deepEqual(service.store.saveCanvasBackground(input),saved);
  assert.equal(service.canvas.getBoard(c.id).nodes.find(n=>n.kind==='requirement').content,'真实业务背景');
  assert.throws(()=>service.store.saveCanvasBackground({...input,operationId:randomUUID(),background:'冲突'}),/已变化/);
  service.store.saveCanvasBackground({canvasId:c.id,background:'',expectedBackground:saved.background,operationId:randomUUID()});
  assert.equal(service.store.listCanvases().length,1);
  assert.equal(service.canvas.getBoard(c.id).nodes.length,1);
  assert.equal(service.canvas.getBoard(c.id).nodes[0].refId,material.material.id);
});

test('real legacy table migration keeps every dependent row, path, hash, background, layout, session and recycle entry', async t=>{
  const {root,service}=fixture(t), store=service.store;
  const old=store.createRequirement({background:'真实课程背景',customer:'机构',audience:'讲师',objectives:'实操',operationId:randomUUID()});
  const version=store.saveOutline({requirementId:old.id,markdown:'# 旧版课纲',operationId:randomUUID()});
  service.canvas.setSession({requirementId:old.id,sessionId:'legacy-session'});
  const board=service.canvas.getBoard(old.id);
  service.canvas.saveBoard({requirementId:old.id,expectedRevision:board.revision,positions:{[`requirement:${old.id}`]:{x:77,y:99}},edges:[],groups:[],elements:[],viewport:{x:25,y:43,zoom:0.8}});
  service.createTask({requirementId:old.id,selectedCardIds:[`outline:${version.id}`],outputType:'text',instruction:'技术任务',operationId:randomUUID(),generation:{mode:'new'}});
  const plan=service.recycle.plan({requirementId:old.id,selections:[{nodeId:`outline:${version.id}`}]});service.recycle.remove({planId:plan.id});
  const originalBytes=readFileSync(path.join(root,version.markdownPath));
  const oldSnapshot=store.getRequirement(old.id);
  service.close();
  const database=path.join(root,'.wtt-workbench/workbench.sqlite'),db=new DatabaseSync(database);
  db.exec(`PRAGMA foreign_keys=ON;
    DROP TRIGGER requirements_insert; DROP TRIGGER requirements_update; DROP TRIGGER requirements_delete;
    DROP VIEW requirements; DROP TABLE canvas_metadata; ALTER TABLE canvas_spaces RENAME TO requirements;`);
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r=>r.name);
  const baseline=new Map(tables.map(name=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]));
  db.close();
  const upgraded=new WorkbenchService({workspaceRoot:root});t.after(()=>upgraded.close());
  const backupPath=path.join(root,'.wtt-workbench/migrations',readdirSync(path.join(root,'.wtt-workbench/migrations'))[0]);
  assert.ok(existsSync(backupPath));
  for(const [name,rows] of baseline)assert.deepEqual(upgraded.store.db.prepare(`SELECT * FROM "${name==='requirements'?'canvas_spaces':name}"`).all(),rows,name);
  assert.deepEqual(upgraded.store.getCanvas(old.id),oldSnapshot);
  assert.deepEqual(readFileSync(path.join(root,version.markdownPath)),originalBytes);
  assert.equal(upgraded.canvas.getBoard(old.id).sessionId,'legacy-session');
  assert.equal((await upgraded.snapshot({openCanvas:true})).canvases.length,1);
  assert.deepEqual(upgraded.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  const backup=new DatabaseSync(backupPath,{readOnly:true});
  assert.deepEqual(backup.prepare('SELECT * FROM requirements').all(),baseline.get('requirements'));backup.close();
  const next=upgraded.store.createCanvas({title:'新内容画布',operationId:randomUUID()});
  upgraded.store.saveOutline({requirementId:next.id,markdown:'# 新画布版本',operationId:randomUUID()});
  assert.equal(upgraded.store.getVersion(version.id).hash,version.hash);
});

test('canvas HTTP opening and mutations require explicit project; legacy reads do not create scopes',async t=>{
  const root=mkdtempSync(path.join(tmpdir(),'cw45-api-')),disposers=[];let route;
  const ctx={effect(fn){const d=fn();if(typeof d==='function')disposers.push(d)},connection:{fetch:{register(v){route=v;return()=>{}}}},tools:{register(){return()=>{}}},skills:{register(){return()=>{}}}};
  apply(ctx,{workspaceRoot:root,registryFile:path.join(root,'projects.json')});
  t.after(()=>{for(const d of disposers.reverse())d();rmSync(root,{recursive:true,force:true})});
  const request=(query={},action,data)=>route.fetch(new Request(`http://localhost/api/wtt-creation-workbench?${new URLSearchParams(query)}`,action?{method:'POST',body:JSON.stringify({action,data})}:undefined));
  const initial=await(await request()).json();assert.equal(initial.requirements.length,0);
  const unscoped=await request({canvasWorkspace:'1'});assert.equal(unscoped.status,400);
  const opened=await(await request({projectId:initial.projectId,canvasWorkspace:'1'})).json();assert.equal(opened.canvases.length,1);
  const denied=await request({},'create-canvas',{operationId:randomUUID()});assert.equal(denied.status,400);
  const created=await(await request({projectId:initial.projectId},'create-canvas',{title:'第二画布',operationId:randomUUID()})).json();assert.equal(created.title,'第二画布');
});

test('failed migration rolls the rename back; each retry gets a new consistent backup',t=>{
  const root=mkdtempSync(path.join(tmpdir(),'cw45-rollback-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const initial=new WorkbenchStore(root),database=initial.databasePath;initial.close();
  const db=new DatabaseSync(database);
  db.exec(`DROP VIEW requirements;DROP TABLE canvas_metadata;ALTER TABLE canvas_spaces RENAME TO requirements;CREATE TABLE canvas_metadata(wrong_column TEXT);`);
  assert.throws(()=>new WorkbenchStore(root),/canvas_metadata|column/);
  assert.equal(db.prepare("SELECT type FROM sqlite_master WHERE name='requirements'").get().type,'table');
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='canvas_spaces'").get(),undefined);
  assert.throws(()=>new WorkbenchStore(root),/canvas_metadata|column/);
  assert.equal(readdirSync(path.join(root,'.wtt-workbench/migrations')).length,2);
  db.exec('DROP TABLE canvas_metadata');db.close();
  const recovered=new WorkbenchStore(root);t.after(()=>recovered.close());
  assert.equal(recovered.ensureDefaultCanvas().origin,'canvas');
  assert.deepEqual(recovered.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
