import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,statSync,readFileSync,realpathSync,mkdirSync,linkSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {CanvasRecyclePurge} from './canvas-recycle-purge.mjs';
import {ProjectFileRecycle} from './project-file-recycle.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const uuid=x=>typeof x==='string'&&/^[0-9a-f-]{36}$/.test(x);
const inactive=new Set(['composing','idle','failed','cancelled']);
function move(from,to){linkSync(from,to);try{unlinkSync(from)}catch(e){unlinkSync(to);throw e}}
export class CanvasRecycle {
 constructor(service,config={}){
  this.service=service;this.store=service.store;this.db=this.store.db;this.root=service.workspaceRoot;this.move=config.recycleMove||move;
  this.db.exec(`CREATE TABLE IF NOT EXISTS canvas_recycle_entries(id TEXT PRIMARY KEY,requirement_id TEXT NOT NULL,plan_json TEXT NOT NULL,state TEXT NOT NULL,mode INTEGER,error TEXT,owner_pid INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS canvas_hidden_nodes(requirement_id TEXT NOT NULL,node_id TEXT NOT NULL,entry_id TEXT NOT NULL,PRIMARY KEY(requirement_id,node_id));`);
  this.fileEntries=new ProjectFileRecycle(this);this.recover();this.cleanup=new CanvasRecyclePurge(this,config);
 }
 hiddenIds(id){return new Set(this.db.prepare('SELECT node_id FROM canvas_hidden_nodes WHERE requirement_id=?').all(id).map(x=>x.node_id))}
 filter(board){const hidden=this.hiddenIds(board.requirementId);if(!hidden.size)return board;return {...board,creationAnchor:board.nodes.find(n=>n.kind==='requirement'),nodes:board.nodes.filter(n=>!hidden.has(n.id)),elements:board.elements.filter(e=>!hidden.has(e.id)),edges:board.edges.filter(e=>!hidden.has(e.source)&&!hidden.has(e.target)),groups:board.groups.map(g=>({...g,nodeIds:g.nodeIds.filter(id=>!hidden.has(id))})).filter(g=>g.nodeIds.length>1)}}
 raw(id){return this.store.cards.project(this.service.canvas.getRawBoard(id))}
 file(relative,expected){
  const file=this.service.projectFiles.resolve(relative),s=statSync(file);if(s.size>256*1024*1024)throw new Error('文件超过256MiB，请先单独处理');
  const hash=sha(readFileSync(file)),after=statSync(file);if(s.ino!==after.ino||s.mtimeMs!==after.mtimeMs||s.size!==after.size)throw new Error('文件正在写入，请稍后重新确认');if(expected&&hash!==expected)throw new Error('源文件已变化，请核对后重新操作');return {file,hash};
 }
 primary(n){return n.projectFile?{path:n.projectFile.path,hash:n.projectFile.hash}:n.importedFile?{path:n.importedFile.path,hash:n.importedFile.hash}:n.kind==='requirement'||n.kind==='whiteboard'||n.kind==='generation'?null:n.path?{path:n.path,hash:n.kind==='word'?undefined:n.sourceHash}:null}
 sourceLocations(){
  const requirements=new Map(this.db.prepare('SELECT id,title FROM requirements').all().map(row=>[row.id,row.title]));
  const sources=new Map();
  const add=(sourceId,requirementId,title,relative)=>{
   if(relative&&requirements.has(requirementId))sources.set(sourceId,{requirementId,nodeId:sourceId,title,path:relative,course:requirements.get(requirementId)});
  };
  const materials=this.db.prepare(`SELECT m.id,m.requirement_id,m.title,
   COALESCE(p.source_path,i.file_path,m.markdown_path) AS path
   FROM canvas_materials m LEFT JOIN canvas_project_references p ON p.material_id=m.id
   LEFT JOIN canvas_imports i ON i.material_id=m.id`).all();
  for(const row of materials)add('material:'+row.id,row.requirement_id,row.title,row.path);
  for(const row of this.db.prepare('SELECT id,requirement_id,number,markdown_path,word_path FROM outline_versions').all()){
   add('outline:'+row.id,row.requirement_id,'大纲 v'+row.number,row.markdown_path);
   add('word:'+row.id,row.requirement_id,'Word · 大纲 v'+row.number,row.word_path);
  }
  for(const row of this.db.prepare('SELECT id,requirement_id,title,path FROM task_files').all()){
   add('artifact:'+row.id,row.requirement_id,row.title,row.path);
  }
  const outputs=this.db.prepare(`SELECT o.source_ref,v.legacy FROM output_card_outputs o
   LEFT JOIN output_card_versions v ON v.id=o.version_id`).all();
  const hidden=new Set(outputs.map(row=>row.source_ref));
  for(const row of outputs)if(row.source_ref.startsWith('outline:')&&!row.legacy)hidden.add(row.source_ref.replace('outline:','word:'));
  const visible=[...sources.values()].filter(source=>!hidden.has(source.nodeId));
  const cards=this.db.prepare(`SELECT c.id,c.node_id,c.requirement_id,v.primary_ref FROM output_cards c
   JOIN output_card_versions v ON v.id=c.head_version_id`).all();
  for(const card of cards){
   const source=sources.get(card.primary_ref);
   if(source&&source.requirementId===card.requirement_id)visible.push({...source,nodeId:card.node_id||'output:'+card.id});
  }
  return visible;
 }
 selection(requirementId,selections,{includeFiles=true}={}){
  if(!this.store.getRequirement(requirementId))throw new Error('课程不存在');if(!Array.isArray(selections)||!selections.length||selections.length>100)throw new Error('请选择1至100个节点');
  const sourceBoard=this.service.canvas.getRawBoard(requirementId),raw=this.store.cards.project(sourceBoard),hidden=this.hiddenIds(requirementId),seen=new Set(),nodes=[],files=new Map();
  for(const choice of selections){
   if(!choice||typeof choice.nodeId!=='string'||seen.has(choice.nodeId)||hidden.has(choice.nodeId))throw new Error('节点不存在、已移除或重复');seen.add(choice.nodeId);
   const current=raw.nodes.find(n=>n.id===choice.nodeId)||raw.elements.find(e=>e.id===choice.nodeId)&&{...raw.elements.find(e=>e.id===choice.nodeId),kind:'whiteboard',position:this.layout(requirementId).positions[choice.nodeId]};if(!current)throw new Error('节点不属于当前课程');
   if(current.pendingGeneration&&!inactive.has(current.pendingGeneration.phase))throw new Error(`「${current.title||'此卡片'}」的任务尚未停止，请先打开原任务停止执行，再删除。`);
   let n=current;if(choice.versionId){if(!current.outputCard)throw new Error('此节点没有所选版本');n=this.service.cards.describe({requirementId,cardId:current.outputCard.id,versionId:choice.versionId},sourceBoard).node}
   const item={nodeId:current.id,title:n.title||n.text?.slice(0,40)||'空白文字',kind:n.kind,versionId:n.outputCard?.versionId||null,headVersionId:current.outputCard?.versionId||null,sourceHash:n.sourceHash||sha(n.text||n.content||''),position:current.position};nodes.push(item);
   const source=includeFiles&&this.primary(n);if(source){
    const candidates=[{...source,role:n.projectFile?'引用源文件':'当前源文件'}];
    const ref=n.sourceId||n.id,delivery=this.service.deliverables.info(ref);if(!n.projectFile&&delivery?.originalPath===source.path&&delivery.path!==source.path)candidates.push({path:delivery.path,hash:delivery.hash,role:'成果文件夹副本'});
    for(const candidate of candidates){if(files.has(candidate.path))continue;let hash=candidate.hash,error='';try{hash=this.file(candidate.path,hash).hash}catch(e){error=e.message}files.set(candidate.path,{...candidate,hash:hash||null,error,references:[]})}
   }
  }
  if(files.size)for(const source of this.sourceLocations()){
   if(source.requirementId===requirementId&&seen.has(source.nodeId))continue;
   if(files.has(source.path)){const {path:_path,...reference}=source;files.get(source.path).references.push(reference)}
  }
  const layout=this.layout(requirementId);layout.edges=layout.edges.filter(e=>seen.has(e.source)||seen.has(e.target));layout.groups=layout.groups.filter(g=>g.nodeIds.some(id=>seen.has(id)));
  return {requirementId,nodes,files:[...files.values()].sort((a,b)=>a.path.localeCompare(b.path)),selections:selections.map(x=>({nodeId:x.nodeId,...(x.versionId?{versionId:x.versionId}:{})})),layout};
 }
 layout(id){const r=this.db.prepare('SELECT * FROM canvas_boards WHERE requirement_id=?').get(id);return r?{positions:JSON.parse(r.positions_json),sizes:JSON.parse(r.sizes_json||'{}'),edges:JSON.parse(r.edges_json),groups:JSON.parse(r.groups_json)}:{positions:{},sizes:{},edges:[],groups:[]}}
 plan(input){const plan=this.selection(input.requirementId,input.selections),id=randomUUID(),now=new Date().toISOString();for(let i=0;i<plan.files.length;i++)plan.files[i].trash=`.wtt-workbench/recycle/${id}/${i}-${path.basename(plan.files[i].path)}`;this.db.prepare('INSERT INTO canvas_recycle_entries VALUES (?,?,?,?,?,?,?,?,?)').run(id,plan.requirementId,JSON.stringify(plan),'planned',null,null,process.pid,now,now);return {id,...plan}}
 entry(id){if(!uuid(id))throw new Error('回收记录无效');const row=this.db.prepare('SELECT * FROM canvas_recycle_entries WHERE id=?').get(id);if(!row)throw new Error('回收记录不属于当前项目');return {...row,plan:JSON.parse(row.plan_json)}}
 trash(relative){
  if(!/^\.wtt-workbench\/recycle\/[a-f0-9-]{36}\/\d+-[^/]+$/.test(relative))throw new Error('回收路径无效');let folder=this.root;for(const part of path.posix.dirname(relative).split('/')){folder=path.join(folder,part);mkdirSync(folder,{recursive:true,mode:0o700});if(lstatSync(folder).isSymbolicLink()||realpathSync(folder)!==folder||!statSync(folder).isDirectory())throw new Error('回收目录不能是链接')};const file=path.join(this.root,relative);if(existsSync(file)&&(lstatSync(file).isSymbolicLink()||!statSync(file).isFile()))throw new Error('回收文件不可用');return file;
 }
 validateNodes(a,b){const keys=p=>p.nodes.map(({nodeId,versionId,headVersionId,sourceHash})=>({nodeId,versionId,headVersionId,sourceHash}));if(JSON.stringify(keys(a))!==JSON.stringify(keys(b)))throw new Error('节点或版本已变化，请重新确认删除')}
 remove({planId,deleteFiles=false}){
  if(typeof deleteFiles!=='boolean')throw new Error('请选择是否删除源文件');let row=this.entry(planId);if(row.plan.kind==='project-files')throw new Error('请使用文件树删除确认');if(row.state==='removed'){if(Boolean(row.mode)!==deleteFiles)throw new Error('此删除记录已按不同方式执行');return {id:planId,state:'removed'}}if(row.state!=='planned')throw new Error('该回收记录正在处理或已恢复，请刷新');
  const plan=row.plan;if(this.db.prepare("UPDATE canvas_recycle_entries SET state=?,mode=?,owner_pid=?,updated_at=? WHERE id=? AND state='planned'").run('moving',deleteFiles?1:0,process.pid,new Date().toISOString(),planId).changes!==1)throw new Error('回收记录已在其他位置处理');
  const moved=[];this.db.exec('BEGIN IMMEDIATE');try{
   const current=this.selection(plan.requirementId,plan.selections,{includeFiles:deleteFiles});this.validateNodes(plan,current);
   if(deleteFiles){if(!plan.files.length)throw new Error('这些节点没有可删除的源文件');const compare=p=>p.files.map(({path,hash,error,references})=>({path,hash,error,references}));if(JSON.stringify(compare(plan))!==JSON.stringify(compare(current)))throw new Error('文件或其他引用已变化，请重新确认');
    if(plan.files.some(f=>f.error))throw new Error('有文件当前不可安全回收，请只移除节点或先处理文件状态');
    for(const f of plan.files){const original=this.file(f.path,f.hash).file,dest=this.trash(f.trash);if(existsSync(dest))throw new Error('回收位置已被占用');this.move(original,dest);moved.push(f);if(sha(readFileSync(dest))!==f.hash)throw new Error('文件在回收时发生变化，已停止操作')}
   }
   for(const n of plan.nodes)this.db.prepare('INSERT INTO canvas_hidden_nodes VALUES (?,?,?)').run(plan.requirementId,n.nodeId,planId);
   if(this.db.prepare('UPDATE canvas_boards SET revision=revision+1 WHERE requirement_id=?').run(plan.requirementId).changes===0)this.db.prepare("INSERT INTO canvas_boards(requirement_id,revision,positions_json,edges_json,groups_json,viewport_json) VALUES (?,1,'{}','[]','[]',?)").run(plan.requirementId,JSON.stringify({x:30,y:30,zoom:.8}));
   this.db.prepare('UPDATE canvas_recycle_entries SET state=?,error=NULL,updated_at=? WHERE id=?').run('removed',new Date().toISOString(),planId);this.db.exec('COMMIT');return {id:planId,state:'removed'};
  }catch(e){this.db.exec('ROLLBACK');let failure='';for(const f of moved.reverse())try{if(existsSync(path.join(this.root,f.path)))throw new Error('原路径已占用');move(this.trash(f.trash),path.join(this.root,f.path))}catch(cause){failure+=cause.message+'；'}this.db.prepare('UPDATE canvas_recycle_entries SET state=?,error=? WHERE id=?').run(failure?'error':'planned',e.message+(failure?'；回滚未完成：'+failure:''),planId);throw new Error(e.message+(failure?'；回滚未完成，请打开项目回收站恢复。':''))}
 }
 restoreNode(requirementId,nodeId,position){
  const hidden=this.db.prepare('SELECT entry_id FROM canvas_hidden_nodes WHERE requirement_id=? AND node_id=?').get(requirementId,nodeId);if(!hidden)return false;
  if(hidden.entry_id==='purged'){
   if(position&&(!Number.isFinite(position.x)||!Number.isFinite(position.y)||Math.abs(position.x)>1000000||Math.abs(position.y)>1000000))throw new Error('卡片坐标无效');
   this.db.prepare("DELETE FROM canvas_hidden_nodes WHERE requirement_id=? AND node_id=? AND entry_id='purged'").run(requirementId,nodeId);
   if(position){const layout=this.layout(requirementId);layout.positions[nodeId]=position;this.db.prepare('UPDATE canvas_boards SET positions_json=?,revision=revision+1 WHERE requirement_id=?').run(JSON.stringify(layout.positions),requirementId)}
   return true;
  }
  const row=this.entry(hidden.entry_id);
  if(row.mode||row.state!=='removed')throw new Error('此文件的卡片仍在回收站，请先在项目回收站恢复后再添加');
  if(position&&(!Number.isFinite(position.x)||!Number.isFinite(position.y)||Math.abs(position.x)>1000000||Math.abs(position.y)>1000000))throw new Error('卡片坐标无效');
  this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('DELETE FROM canvas_hidden_nodes WHERE requirement_id=? AND node_id=? AND entry_id=?').run(requirementId,nodeId,row.id);if(position){const layout=this.layout(requirementId);layout.positions[nodeId]=position;this.db.prepare('UPDATE canvas_boards SET positions_json=?,revision=revision+1 WHERE requirement_id=?').run(JSON.stringify(layout.positions),requirementId)}if(!this.db.prepare('SELECT 1 FROM canvas_hidden_nodes WHERE entry_id=?').get(row.id))this.db.prepare("UPDATE canvas_recycle_entries SET state='restored',updated_at=? WHERE id=?").run(new Date().toISOString(),row.id);this.db.exec('COMMIT');return true}catch(e){this.db.exec('ROLLBACK');throw e}
 }
 list(){return this.db.prepare("SELECT * FROM canvas_recycle_entries WHERE state IN ('removed','error','moving','restoring','purging') ORDER BY created_at DESC").all().map(r=>{const plan=JSON.parse(r.plan_json),ids=this.hiddenIds(r.requirement_id);return {id:r.id,requirementId:r.requirement_id,state:r.state,deleteFiles:Boolean(r.mode),error:r.error,createdAt:r.created_at,...plan,nodes:r.mode?plan.nodes:plan.nodes.filter(n=>ids.has(n.nodeId))}})}
 purgePlan(input){return this.cleanup.plan(input)}
 purge(input){return this.cleanup.purge(input)}

 restore({entryId}){
  const row=this.entry(entryId);if(row.plan.kind==='project-files')return this.fileEntries.restore(row);if(row.state==='restored')return {id:entryId,state:'restored'};if(!['removed','error'].includes(row.state))throw new Error('记录正在处理，暂不能恢复');const plan=row.plan;if(row.mode&&row.state==='removed'&&plan.files.some(f=>!existsSync(this.trash(f.trash))))throw new Error('回收文件缺失，未恢复节点，请核对项目回收目录');const files=row.mode?plan.files.filter(f=>existsSync(this.trash(f.trash))):[];
  for(const f of files){if(existsSync(path.join(this.root,f.path)))throw new Error(`原位置已存在同名文件：${f.path}，请先移开该文件后重试。`);this.service.projectFiles.resolve(path.posix.dirname(f.path)==='.'?'':path.posix.dirname(f.path),{directory:true});if(sha(readFileSync(this.trash(f.trash)))!==f.hash)throw new Error('回收文件内容已变化，未恢复')}
  plan.restoreFiles=files.map(f=>f.path);if(this.db.prepare('UPDATE canvas_recycle_entries SET state=?,plan_json=?,owner_pid=?,updated_at=? WHERE id=? AND state=?').run('restoring',JSON.stringify(plan),process.pid,new Date().toISOString(),entryId,row.state).changes!==1)throw new Error('回收记录已在其他位置处理');const moved=[];this.db.exec('BEGIN IMMEDIATE');try{
   for(const f of files){move(this.trash(f.trash),path.join(this.root,f.path));moved.push(f);this.file(f.path,f.hash)}
   const layout=this.layout(plan.requirementId);for(const n of plan.nodes){if(n.position&&!layout.positions[n.nodeId])layout.positions[n.nodeId]=n.position;if(plan.layout.sizes[n.nodeId]&&!layout.sizes[n.nodeId])layout.sizes[n.nodeId]=plan.layout.sizes[n.nodeId]}
   for(const edge of plan.layout.edges)if(!layout.edges.some(e=>e.id===edge.id))layout.edges.push(edge);
   const grouped=new Set(layout.groups.flatMap(g=>g.nodeIds));for(const group of plan.layout.groups)if(!layout.groups.some(g=>g.id===group.id)&&!group.nodeIds.some(id=>grouped.has(id))){layout.groups.push(group);group.nodeIds.forEach(id=>grouped.add(id))}
   this.db.prepare('UPDATE canvas_boards SET positions_json=?,sizes_json=?,edges_json=?,groups_json=?,revision=revision+1 WHERE requirement_id=?').run(JSON.stringify(layout.positions),JSON.stringify(layout.sizes),JSON.stringify(layout.edges),JSON.stringify(layout.groups),plan.requirementId);
   this.db.prepare('DELETE FROM canvas_hidden_nodes WHERE entry_id=?').run(entryId);this.db.prepare('UPDATE canvas_recycle_entries SET state=?,error=NULL,updated_at=? WHERE id=?').run('restored',new Date().toISOString(),entryId);this.db.exec('COMMIT');this.store.outputSaved?.(plan.requirementId);return {id:entryId,state:'restored'};
  }catch(e){this.db.exec('ROLLBACK');let fail='';for(const f of moved.reverse())try{move(path.join(this.root,f.path),this.trash(f.trash))}catch(cause){fail+=cause.message+'；'}this.db.prepare('UPDATE canvas_recycle_entries SET state=?,error=? WHERE id=?').run(fail?'error':'removed',e.message+(fail?'；'+fail:''),entryId);throw e}
 }
 recover(){for(const r of this.db.prepare("SELECT * FROM canvas_recycle_entries WHERE state IN ('moving','restoring')").all()){try{process.kill(r.owner_pid,0);continue}catch{}const plan=JSON.parse(r.plan_json);if(plan.kind==='project-files'){this.fileEntries.recover({...r,plan});continue}let error='';for(const f of r.mode?plan.files.filter(f=>r.state!=='restoring'||!plan.restoreFiles||plan.restoreFiles.includes(f.path)):[])try{const trash=this.trash(f.trash),original=path.join(this.root,f.path);if(r.state==='moving'&&existsSync(trash)){if(existsSync(original))throw new Error('原路径占用，文件保留在回收站');this.service.projectFiles.resolve(path.posix.dirname(f.path)==='.'?'':path.posix.dirname(f.path),{directory:true});move(trash,original)}if(r.state==='restoring'&&existsSync(original)&&!existsSync(trash)){this.file(f.path,f.hash);move(original,trash)}}catch(e){error+=e.message+'；'}this.db.prepare('UPDATE canvas_recycle_entries SET state=?,error=? WHERE id=?').run(error?'error':r.state==='moving'?'planned':'removed',error||'上次操作中断，已回滚，可重新操作',r.id)}}
}
