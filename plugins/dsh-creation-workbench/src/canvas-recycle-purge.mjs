import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,realpathSync,unlinkSync,rmdirSync} from 'node:fs';
import path from 'node:path';
import {digestFile} from './file-digest.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const fingerprint=row=>hash(JSON.stringify([row.mode,row.plan_json]));
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};

// 只管理已回收的副本，不接受业务源路径，也不递归删除目录。
export class CanvasRecyclePurge {
 constructor(recycle,config={}){
  this.recycle=recycle;this.db=recycle.db;this.root=recycle.root;this.unlink=config.recycleUnlink||unlinkSync;
  this.db.exec('CREATE TABLE IF NOT EXISTS canvas_recycle_purge_plans(id TEXT PRIMARY KEY,plan_json TEXT NOT NULL,state TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL)');
 }
 file(entryId,relative){
  if(typeof relative!=='string'||!new RegExp(`^\\.wtt-workbench/recycle/${entryId}/\\d+-[^/\\\\]+$`).test(relative)||relative.includes('\0'))throw new Error('回收文件路径无效，未删除任何源文件');
  let location=this.root;
  if(realpathSync(location)!==location)throw new Error('项目路径已变化，请重新打开项目');
  const parts=relative.split('/');
  for(let i=0;i<parts.length;i++){
   location=path.join(location,parts[i]);let stat;
   try{stat=lstatSync(location)}catch(e){if(e.code==='ENOENT')return {path:relative,missing:true};throw e}
   if(stat.isSymbolicLink()||realpathSync(location)!==location||(i<parts.length-1?!stat.isDirectory():!stat.isFile()))throw new Error('回收路径包含链接或非普通文件，已停止删除');
  }
  return {path:relative,...digestFile(location)};
 }
 hidden(id){return this.db.prepare('SELECT requirement_id,node_id FROM canvas_hidden_nodes WHERE entry_id=? ORDER BY requirement_id,node_id').all(id)}
 entries(ids){
  return ids.map(id=>{
   const row=this.recycle.entry(id);
   if(!['removed','error','purging'].includes(row.state))throw new Error('回收记录已恢复或正在处理，请刷新后重新确认');
   if(row.state==='purging'&&row.owner_pid&&row.owner_pid!==process.pid&&alive(row.owner_pid))throw new Error('另一个窗口正在删除这些内容，请稍后刷新');
   const hidden=this.hidden(id),nodeIds=new Set(hidden.map(n=>n.node_id));
   const nodes=row.plan.nodes.filter(n=>nodeIds.has(n.nodeId));
   const files=row.mode?row.plan.files.map(f=>({...this.file(id,f.trash),originalPath:f.path})):[];
   return {id,label:row.plan.target?.name,links:(row.plan.links||[]).map(l=>({path:l.path,target:l.target})),directoryCount:row.plan.directories?.length||0,requirementId:row.requirement_id,state:row.state,fingerprint:fingerprint(row),hidden,nodes:nodes.map(n=>({nodeId:n.nodeId,title:n.title})),files};
  });
 }
 summary(plan){return {id:plan.id,all:plan.all,entries:plan.entries.map(({id,label,links,directoryCount,nodes,files})=>({id,label,links,directoryCount,nodes,files:files.map(({path,originalPath,bytes,missing})=>({path,originalPath,bytes:bytes||0,missing:!!missing}))})),entryCount:plan.entries.length,nodeCount:plan.entries.reduce((n,e)=>n+e.nodes.length,0),fileCount:plan.entries.flatMap(e=>e.files).filter(f=>!f.missing).length,linkCount:plan.entries.reduce((n,e)=>n+(e.links?.length||0),0),directoryCount:plan.entries.reduce((n,e)=>n+(e.directoryCount||0),0),bytes:plan.entries.flatMap(e=>e.files).reduce((n,f)=>n+(f.bytes||0),0)}}
 plan({entryIds,all=false}={}){
  if(typeof all!=='boolean'||(all&&entryIds!==undefined))throw new Error('请选择单项或清空全部');
  const ids=all?this.recycle.list().map(e=>e.id):entryIds;
  if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length)throw new Error('回收站为空或所选记录无效');
  const plan={id:randomUUID(),all,entries:this.entries(ids)};
  this.db.prepare('INSERT INTO canvas_recycle_purge_plans VALUES (?,?,?,?,?)').run(plan.id,JSON.stringify(plan),'prepared',null,new Date().toISOString());
  return this.summary(plan);
 }
 purge({planId,confirmation}={}){
  if(confirmation!=='永久删除')throw new Error('请核对删除范围并确认永久删除');
  const record=this.db.prepare('SELECT * FROM canvas_recycle_purge_plans WHERE id=?').get(typeof planId==='string'?planId:'');
  if(!record)throw new Error('删除确认不属于当前项目，请重新核对');
  const plan=JSON.parse(record.plan_json);if(record.state==='done')return {...plan,state:'purged'};
  const retry=['running','failed'].includes(record.state);
  // 锁定期间完整核对，再留下持久化日志；文件删除无法用数据库回滚伪装成原子操作。
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const current=this.entries(plan.entries.map(e=>e.id));
   for(let i=0;i<current.length;i++){
    const a=plan.entries[i],b=current[i];
    if(a.fingerprint!==b.fingerprint||JSON.stringify(a.hidden)!==JSON.stringify(b.hidden)||(!retry&&a.state!==b.state))throw new Error('回收记录已变化，请重新核对删除范围');
    for(let j=0;j<a.files.length;j++){
     const wanted=a.files[j],found=b.files[j];
     if(!found||wanted.path!==found.path||(!retry&&!!wanted.missing!==!!found.missing)||(!found.missing&&(wanted.hash!==found.hash||wanted.ino!==found.ino||wanted.dev!==found.dev||wanted.mtime!==found.mtime)))throw new Error('回收文件已变化，请重新核对删除范围');
    }
   }
   for(const e of plan.entries)this.db.prepare("UPDATE canvas_recycle_entries SET state='purging',owner_pid=?,error=NULL WHERE id=?").run(process.pid,e.id);
   this.db.prepare("UPDATE canvas_recycle_purge_plans SET state='running',error=NULL WHERE id=?").run(planId);
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e}
  try{
   for(const entry of plan.entries)for(const expected of entry.files){
    const current=this.file(entry.id,expected.path);if(current.missing)continue;
    if(expected.hash!==current.hash||expected.ino!==current.ino||expected.dev!==current.dev||expected.mtime!==current.mtime)throw new Error('回收文件已变化，已停止删除；请重新核对剩余内容');
    this.unlink(path.join(this.root,expected.path));
   }
   const result={id:planId,entryCount:plan.entries.length,nodeCount:plan.entries.reduce((n,e)=>n+e.nodes.length,0),fileCount:plan.entries.flatMap(e=>e.files).filter(f=>!f.missing).length};
   this.db.exec('BEGIN IMMEDIATE');
   try{
    for(const entry of plan.entries){
     this.db.prepare("UPDATE canvas_hidden_nodes SET entry_id='purged' WHERE entry_id=?").run(entry.id);
     this.db.prepare('DELETE FROM canvas_recycle_entries WHERE id=?').run(entry.id);
    }
    this.db.prepare("UPDATE canvas_recycle_purge_plans SET state='done',plan_json=?,error=NULL WHERE id=?").run(JSON.stringify(result),planId);
    this.db.exec('COMMIT');
   }catch(e){this.db.exec('ROLLBACK');throw e}
   for(const entry of plan.entries){try{const folder=path.join(this.root,'.wtt-workbench/recycle',entry.id);if(!lstatSync(folder).isSymbolicLink()&&realpathSync(folder)===folder)rmdirSync(folder)}catch{/* 非空目录保留，绝不递归删除。 */}}
   return {...result,state:'purged'};
  }catch(e){
   this.db.prepare("UPDATE canvas_recycle_purge_plans SET state='failed',error=? WHERE id=?").run(e.message,planId);
   for(const entry of plan.entries)this.db.prepare("UPDATE canvas_recycle_entries SET state='purging',owner_pid=0,error=? WHERE id=?").run('删除未完成：'+e.message+'。重新核对后可继续删除。',entry.id);
   throw new Error('删除未完成，部分回收文件可能已删除。请重新核对剩余内容后继续。原因：'+e.message);
  }
 }
}
