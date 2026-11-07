import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,realpathSync,readdirSync,mkdirSync,rmdirSync,readlinkSync,symlinkSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {digestFile} from './file-digest.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const stopped=new Set(['idle','failed','cancelled']);
const exists=file=>{try{lstatSync(file);return true}catch(e){if(e.code==='ENOENT')return false;throw e}};

export class ProjectFileRecycle {
 constructor(recycle){this.r=recycle;this.service=recycle.service;this.db=recycle.db;this.root=recycle.root}
 resolve(relative,{missing=false,allowLink=false}={}){
  if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||relative.includes('\\')||relative.includes('\0')||relative.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('请选择当前项目内的文件或文件夹；整体删除项目请从上级目录操作');
  if(relative.split('/')[0]==='.wtt-workbench')throw new Error('这是当前工作台正在使用的数据目录；删除整个项目时，请从上级目录操作');
  let current=this.root;if(realpathSync(current)!==current)throw new Error('项目路径已变化，请重新打开');
  const parts=relative.split('/');
  for(let i=0;i<parts.length;i++){
   current=path.join(current,parts[i]);if(!exists(current)){if(missing)return path.join(this.root,relative);throw new Error('文件或文件夹已不存在，请刷新文件树')}
   const stat=lstatSync(current);if(stat.isSymbolicLink()&&allowLink&&i===parts.length-1)return current;if(stat.isSymbolicLink()||realpathSync(current)!==current||(i<parts.length-1&&!stat.isDirectory()))throw new Error('不能删除链接或已改变的目录');
  }
  return current;
 }
 file(relative){
  const filename=this.resolve(relative);return {path:relative,...digestFile(filename)};
 }
 associations(paths){
  const courses=[];
  for(const req of this.r.store.listRequirements()){
   const original=this.service.canvas.getRawBoard(req.id),board=this.r.raw(req.id),hidden=this.r.hiddenIds(req.id),nodes=[];
   for(const node of board.nodes){
    if(hidden.has(node.id))continue;
    const sources=new Set([node.sourceId||node.id]);
    for(const version of node.outputCard?.versions||[]){sources.add(version.primaryRef);for(const output of version.outputs||[])sources.add(output.sourceId)}
    const candidates=[node,...original.nodes.filter(n=>sources.has(n.id))],matched=new Set();
    for(const candidate of candidates){
     const primary=this.r.primary(candidate);if(primary&&paths.has(primary.path))matched.add(primary.path);
     if(candidate.path&&paths.has(candidate.path))matched.add(candidate.path);
     const mirror=this.service.deliverables.info(candidate.sourceId||candidate.id);if(mirror?.path&&paths.has(mirror.path))matched.add(mirror.path);
    }
    if(!matched.size)continue;
    if(node.pendingGeneration&&!stopped.has(node.pendingGeneration.phase))throw new Error(`「${node.title}」仍在生成，请先停止原任务再删除文件`);
    nodes.push({nodeId:node.id,title:node.title,kind:node.kind,requirementId:req.id,course:req.title,headVersionId:node.outputCard?.versionId||null,sourceHash:node.sourceHash||null,position:node.position,files:[...matched].sort()});
   }
   if(nodes.length){const ids=new Set(nodes.map(n=>n.nodeId)),layout=this.r.layout(req.id);courses.push({requirementId:req.id,nodes,layout:{...layout,edges:layout.edges.filter(e=>ids.has(e.source)||ids.has(e.target)),groups:layout.groups.filter(g=>g.nodeIds.some(n=>ids.has(n)))}})}
  }
  return courses;
 }
 inventory(relative){
  this.resolve(relative,{allowLink:true});
  this.service.beforeFileInventory?.(relative);
  const stat=lstatSync(this.resolve(relative,{allowLink:true})),target={path:relative,name:path.posix.basename(relative),directory:stat.isDirectory(),...(stat.isSymbolicLink()?{symbolicLink:true}:{})},files=[],directories=[],links=[];let bytes=0;
  for(const req of this.r.store.listRequirements())for(const task of this.service.tasks.list(req.id)){
   const taskPath=`courses/${req.id}/tasks/${task.id}`,phase=task.runtimeState?.phase;
   const active=(task.mediaJob&&!['succeeded','failed'].includes(task.mediaJob.status))||(phase&&phase!=='unknown'&&!stopped.has(phase))||(['submitting','accepted','unknown'].includes(task.dispatchStatus)&&!stopped.has(phase));
   if(active&&(relative===taskPath||relative.startsWith(taskPath+'/')||taskPath.startsWith(relative+'/')))throw new Error(`「${task.title}」可能仍在使用此目录，请先核对并停止原任务`);
  }
  const visit=rel=>{
   const location=this.resolve(rel,{allowLink:true}),s=lstatSync(location);
   if(s.isDirectory()){
    directories.push({path:rel,mode:s.mode&0o777,ino:s.ino,dev:s.dev});
    for(const item of readdirSync(location).sort())visit(path.posix.join(rel,item));
   }else if(s.isSymbolicLink()){
    links.push({path:rel,target:readlinkSync(location),ino:s.ino,dev:s.dev,mtime:s.mtimeMs});
   }else if(s.isFile()){
    const file=this.file(rel);bytes+=file.bytes;files.push(file);
   }else throw new Error('目录中包含系统特殊文件，请用本机文件管理器处理');
  };
  visit(relative);const courses=this.associations(new Set([...files,...links].map(f=>f.path)));
  return {target,files,directories,links,courses,nodes:courses.flatMap(c=>c.nodes),bytes};
 }
 plan({path:relative}={}){
  const inventory=this.inventory(relative),id=randomUUID(),now=new Date().toISOString();
  const plan={id,kind:'project-files',requirementId:'',...inventory,signature:sha(JSON.stringify(inventory))};
  plan.files=plan.files.map((f,i)=>({...f,trash:`.wtt-workbench/recycle/${id}/${i}-${path.posix.basename(f.path)}`}));
  this.db.prepare('INSERT INTO canvas_recycle_entries VALUES (?,?,?,?,?,?,?,?,?)').run(id,'',JSON.stringify(plan),'planned',null,null,process.pid,now,now);
  return plan;
 }
 touch(id){
  if(!this.db.prepare('UPDATE canvas_boards SET revision=revision+1 WHERE requirement_id=?').run(id).changes)this.db.prepare("INSERT INTO canvas_boards(requirement_id,revision,positions_json,edges_json,groups_json,viewport_json) VALUES (?,1,'{}','[]','[]',?)").run(id,JSON.stringify({x:30,y:30,zoom:.8}));
 }
 ensureDirectory(relative,mode=0o755,created=[]){
  if(!relative||relative==='.')return;
  const location=this.resolve(relative,{missing:true});
  if(exists(location)){if(!lstatSync(location).isDirectory())throw new Error('恢复目录位置已被文件占用');return}
  this.ensureDirectory(path.posix.dirname(relative),0o755,created);mkdirSync(location,{mode});created.push(relative);
 }
 restoreFiles(plan){
  for(const d of plan.directories)this.ensureDirectory(d.path,d.mode);
  for(const f of plan.files){
   const trash=this.r.trash(f.trash);if(!exists(trash))continue;
   const original=this.resolve(f.path,{missing:true});if(exists(original))throw new Error(`原位置已占用：${f.path}，回收副本已保留`);
   if(digestFile(trash).hash!==f.hash)throw new Error('回收文件内容已变化，未覆盖原位置');
   this.ensureDirectory(path.posix.dirname(f.path));this.r.move(trash,original);
  }
  for(const link of plan.links||[]){
   const original=this.resolve(link.path,{missing:true,allowLink:true});
   if(exists(original)){if(lstatSync(original).isSymbolicLink()&&readlinkSync(original)===link.target)continue;throw new Error(`链接原位置已占用：${link.path}`)}
   this.ensureDirectory(path.posix.dirname(link.path));symlinkSync(link.target,original);
  }
 }
 remove({planId}={}){
  const row=this.r.entry(planId),plan=row.plan;if(plan.kind!=='project-files')throw new Error('不是文件树删除确认');
  if(row.state==='removed')return {id:row.id,state:'removed'};if(row.state!=='planned')throw new Error('记录已处理，请重新确认');
  if(sha(JSON.stringify(this.inventory(plan.target.path)))!==plan.signature)throw new Error('文件、目录子项或关联卡片已变化，请重新确认');
  if(!this.db.prepare("UPDATE canvas_recycle_entries SET state='moving',mode=1,owner_pid=? WHERE id=? AND state='planned'").run(process.pid,row.id).changes)throw new Error('另一个窗口已处理，请刷新');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   if(sha(JSON.stringify(this.inventory(plan.target.path)))!==plan.signature)throw new Error('删除范围已变化，请重新确认');
   for(const f of plan.files){const original=this.resolve(f.path),trash=this.r.trash(f.trash);if(exists(trash))throw new Error('回收位置已占用');this.r.move(original,trash);if(digestFile(trash).hash!==f.hash)throw new Error('文件移动时发生变化')}
   for(const link of plan.links||[]){const original=this.resolve(link.path,{allowLink:true});if(!lstatSync(original).isSymbolicLink()||readlinkSync(original)!==link.target)throw new Error('链接已变化，请重新确认');unlinkSync(original)}
   for(const d of [...plan.directories].reverse())rmdirSync(this.resolve(d.path));
   for(const c of plan.courses){for(const n of c.nodes)this.db.prepare('INSERT INTO canvas_hidden_nodes VALUES (?,?,?)').run(c.requirementId,n.nodeId,row.id);this.touch(c.requirementId)}
   this.db.prepare("UPDATE canvas_recycle_entries SET state='removed',error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(),row.id);this.db.exec('COMMIT');return {id:row.id,state:'removed'};
  }catch(e){
   this.db.exec('ROLLBACK');let failure='';try{this.restoreFiles(plan)}catch(cause){failure=cause.message}
   this.db.prepare('UPDATE canvas_recycle_entries SET state=?,error=? WHERE id=?').run(failure?'error':'planned',e.message+(failure?'；回滚未完成：'+failure:''),row.id);
   throw new Error(e.message+(failure?'；请从项目回收站恢复剩余文件。':''));
  }
 }
 restoreLayout(course,entryId){
  const layout=this.r.layout(course.requirementId);
  for(const n of course.nodes){if(n.position&&!layout.positions[n.nodeId])layout.positions[n.nodeId]=n.position;if(course.layout.sizes[n.nodeId]&&!layout.sizes[n.nodeId])layout.sizes[n.nodeId]=course.layout.sizes[n.nodeId]}
  for(const edge of course.layout.edges)if(!layout.edges.some(e=>e.id===edge.id))layout.edges.push(edge);
  const grouped=new Set(layout.groups.flatMap(g=>g.nodeIds));for(const group of course.layout.groups)if(!layout.groups.some(g=>g.id===group.id)&&!group.nodeIds.some(n=>grouped.has(n))){layout.groups.push(group);group.nodeIds.forEach(n=>grouped.add(n))}
  this.touch(course.requirementId);this.db.prepare('UPDATE canvas_boards SET positions_json=?,sizes_json=?,edges_json=?,groups_json=? WHERE requirement_id=?').run(JSON.stringify(layout.positions),JSON.stringify(layout.sizes),JSON.stringify(layout.edges),JSON.stringify(layout.groups),course.requirementId);
  this.db.prepare('DELETE FROM canvas_hidden_nodes WHERE entry_id=? AND requirement_id=?').run(entryId,course.requirementId);
 }
 restore(row){
  if(row.state==='restored')return {id:row.id,state:'restored'};
  if(!['removed','error'].includes(row.state))throw new Error('记录正在处理，暂不能恢复');
  const plan=row.plan;
  if(exists(this.resolve(plan.target.path,{missing:true,allowLink:true})))throw new Error(`原位置已存在同名内容：${plan.target.path}，请先移开再恢复`);
  for(const f of plan.files){if(!exists(this.r.trash(f.trash))||digestFile(this.r.trash(f.trash)).hash!==f.hash)throw new Error('回收文件缺失或已变化，未恢复节点')}
  plan.restoreCreatedDirs=[];
  if(!this.db.prepare("UPDATE canvas_recycle_entries SET state='restoring',plan_json=?,owner_pid=? WHERE id=? AND state=?").run(JSON.stringify(plan),process.pid,row.id,row.state).changes)throw new Error('另一个窗口正在处理此记录');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   // 目录清单预先记录，恢复中断时只回收已恢复且校验相同的文件。
   this.restoreFiles(plan);
   for(const c of plan.courses)this.restoreLayout(c,row.id);
   this.db.prepare("UPDATE canvas_recycle_entries SET state='restored',error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(),row.id);this.db.exec('COMMIT');return {id:row.id,state:'restored'};
  }catch(e){this.db.exec('ROLLBACK');const error=this.rollbackRestore(plan);this.db.prepare('UPDATE canvas_recycle_entries SET state=?,error=? WHERE id=?').run(error?'error':'removed',e.message+(error?'；'+error:''),row.id);throw e}
 }
 rollbackRestore(plan){
  let error='';
  for(const f of plan.files)try{const original=this.resolve(f.path,{missing:true}),trash=this.r.trash(f.trash);if(exists(original)&&!exists(trash)){if(this.file(f.path).hash!==f.hash)throw new Error('恢复后的文件已变化，原位保留');this.r.move(original,trash)}}catch(e){error+=e.message+'；'}
  for(const link of plan.links||[])try{const original=this.resolve(link.path,{missing:true,allowLink:true});if(exists(original)){if(!lstatSync(original).isSymbolicLink()||readlinkSync(original)!==link.target)throw new Error('恢复后的链接已变化，原位保留');unlinkSync(original)}}catch(e){error+=e.message+'；'}
  for(const d of [...plan.directories].reverse())try{const location=this.resolve(d.path,{missing:true});if(exists(location))rmdirSync(location)}catch(e){if(e.code!=='ENOTEMPTY')error+=e.message+'；'}
  return error;
 }
 recover(row){
  let error='';
  try{if(row.state==='moving')this.restoreFiles(row.plan);else error=this.rollbackRestore(row.plan)}catch(e){error=e.message}
  this.db.prepare('UPDATE canvas_recycle_entries SET state=?,error=? WHERE id=?').run(error?'error':row.state==='moving'?'planned':'removed',error||'上次文件操作中断，已回滚，请重新确认',row.id);
 }
}
