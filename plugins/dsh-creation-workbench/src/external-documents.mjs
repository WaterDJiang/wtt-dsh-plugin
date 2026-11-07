import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { deliverableName } from './deliverable-files.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const APP_DEFINITIONS=[
  {id:'wps',name:'WPS Office',names:['wpsoffice.app','WPS Office.app'],formats:['docx','pdf','csv','pptx']},
  {id:'powerpoint',name:'Microsoft PowerPoint',names:['Microsoft PowerPoint.app'],formats:['pptx']},
  {id:'keynote',name:'Keynote',names:['Keynote.app'],formats:['pptx']},
  {id:'word',name:'Microsoft Word',names:['Microsoft Word.app'],formats:['docx']},
  {id:'excel',name:'Microsoft Excel',names:['Microsoft Excel.app'],formats:['csv']},
  {id:'pages',name:'Pages',names:['Pages.app'],formats:['docx']},
  {id:'numbers',name:'Numbers',names:['Numbers.app'],formats:['csv']},
  {id:'preview',name:'预览',names:['Preview.app'],formats:['pdf']},
  {id:'acrobat',name:'Adobe Acrobat',names:['Adobe Acrobat.app','Adobe Acrobat Reader.app'],formats:['pdf']},
  {id:'libreoffice',name:'LibreOffice',names:['LibreOffice.app'],formats:['docx','csv','pptx']},
];
export function documentApplications(format,folders=['/Applications',path.join(os.homedir(),'Applications'),'/System/Applications']){
  return [{id:'default',name:'默认应用'},...APP_DEFINITIONS.filter(app=>app.formats.includes(format)).flatMap(app=>{
    const target=folders.flatMap(root=>app.names.map(name=>path.join(root,name))).find(file=>existsSync(path.join(file,'Contents/Info.plist')));
    return target?[{id:app.id,name:app.name,path:target}]:[];
  })];
}
function launchMac(file,application,folder){
  if(process.platform!=='darwin')throw new Error('本机应用打开仅支持运行 DSH 的 Mac，可先下载文件。');
  return new Promise((resolve,reject)=>{
    const args=folder?['-R',file]:application?.path?['-a',application.path,file]:[file];
    const child=spawn('/usr/bin/open',args,{stdio:['ignore','ignore','pipe']});let error='';
    child.stderr.on('data',chunk=>{error=(error+chunk).slice(-2000)});
    const timer=setTimeout(()=>{child.kill();reject(new Error('本机应用未及时响应，请在应用中检查文件。'))},15000);
    child.on('error',cause=>{clearTimeout(timer);reject(cause)});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`打开本机应用失败（${code}）：${error}`))});
  });
}

/** Local applications edit a managed working copy, never a registered version. */
export class ExternalDocuments {
  constructor(service,config={}){
    this.service=service;this.docs=service.documents;this.db=service.store.db;this.root=service.workspaceRoot;
    this.launch=config.openDocumentApplication||launchMac;this.folders=config.documentApplicationFolders;
    this.stabilityMs=config.documentStabilityMs??600;this.jobs=new Map();this.models=new Map();
    this.available=process.platform==='darwin'||Boolean(config.openDocumentApplication);
    this.db.exec(`CREATE TABLE IF NOT EXISTS document_external_workspaces (
      id TEXT PRIMARY KEY,draft_id TEXT UNIQUE,path TEXT UNIQUE NOT NULL,last_hash TEXT NOT NULL,
      revision INTEGER NOT NULL,updated_at TEXT NOT NULL
    );CREATE TABLE IF NOT EXISTS document_external_publications (
      operation_id TEXT PRIMARY KEY,external_id TEXT NOT NULL,new_draft_id TEXT NOT NULL
    )`);
  }
  work(draftId){return this.db.prepare('SELECT * FROM document_external_workspaces WHERE draft_id=?').get(draftId)}
  async open(scope){const d=await this.docs.open(scope);return this.status({draftId:d.id})}
  async source(draftId){const row=this.docs.row(draftId);return {row,source:await this.docs.scope(JSON.parse(row.scope_json))}}
  readWorking(relative){
    const file=path.resolve(this.root,relative);
    if(!file.startsWith(this.root+path.sep)||realpathSync(file)!==file||lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile())throw new Error('工作副本路径发生变化，不能使用链接或项目外文件。');
    const before=statSync(file);if(before.size>20*1024*1024)throw new Error('工作副本超过20MiB，请在本机应用中缩小文件后保存。');
    const bytes=readFileSync(file),after=statSync(file);
    if(before.mtimeMs!==after.mtimeMs||before.ino!==after.ino||before.size!==after.size||this.stabilityMs>0&&Date.now()-after.mtimeMs<this.stabilityMs)return {writing:true};
    return {bytes,hash:sha(bytes),file};
  }
  status({draftId}){
    const key=`status:${draftId}`;
    if(!this.jobs.has(key))this.jobs.set(key,this.sync(draftId).finally(()=>this.jobs.delete(key)));
    return this.jobs.get(key);
  }
  async sync(draftId){
    let {row,source}=await this.source(draftId),work=this.work(draftId),state='source',error='';
    if(work){
      try{
        if(work.revision!==row.revision)throw new Error('草稿已在另一处更新。可保留原工作文件，并从当前预览另建工作副本。');
        const read=this.readWorking(work.path);
        if(read.writing)state='writing';
        else if(read.hash!==work.last_hash){
          await this.docs.saveFileDraft({draftId,revision:row.revision,bytes:read.bytes,externalId:work.id});
          // A later application write is picked up by the next poll; this snapshot is immutable.
          row=this.docs.row(draftId);work=this.work(draftId);state='changed';
        }else state='ready';
      }catch(cause){state='invalid';error=`工作副本尚未导入：${cause.message}。最后有效预览已保留。`}
    }
    const snapshot=await this.docs.snapshot(draftId,row.revision);
    const format=source.extension.slice(1);let rows;
    const previewName=path.basename(source.name),previewPath=`.wtt-workbench/native-preview/${snapshot.hash}/${previewName}`;
    this.docs.write(previewPath,snapshot.bytes);
    if(format==='csv'){
      if(!this.models.has(snapshot.hash)){
        if(this.models.size>=8)this.models.delete(this.models.keys().next().value);
        this.models.set(snapshot.hash,this.docs.inspect(path.join(this.root,snapshot.path)));
      }
      rows=(await this.models.get(snapshot.hash)).rows;
    }
    return {id:draftId,revision:row.revision,hash:snapshot.hash,format,dirty:row.patch_json!=='{}',state,error,
      fileName:`${deliverableName(source.title.replace(new RegExp(`\\${source.extension}$`,'i'),''))}${source.extension}`,
      workingFile:work?.path||null,applications:documentApplications(format,this.folders).map(({path,...app})=>app),nativeAvailable:this.available,
      ...(rows?{rows}:{}),previewSource:{path:previewPath,hash:snapshot.hash,name:previewName,format,sessionId:source.sessionId},scope:JSON.parse(row.scope_json)};
  }
  async ensureWorking(draftId,{restart=false}={}){
    const {row,source}=await this.source(draftId);let work=this.work(draftId);
    if(work&&!restart)return work;
    const snapshot=await this.docs.snapshot(draftId,row.revision),id=randomUUID();
    const course=this.service.store.getRequirement(source.scope.requirementId).title;
    const title=deliverableName(source.title.replace(new RegExp(`\\${source.extension}$`,'i'),''));
    const relative=path.join('工作稿',deliverableName(course),`${title}--${id.slice(0,8)}`,source.descriptor.version?`基于V${String(source.descriptor.version.number).padStart(3,'0')}`:'基于未归档附件',title+source.extension);
    this.docs.write(relative,snapshot.bytes);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.docs.revision(this.docs.row(draftId),row.revision);
      if(work&&restart)this.db.prepare('UPDATE document_external_workspaces SET draft_id=NULL WHERE id=? AND draft_id=?').run(work.id,draftId);
      this.db.prepare('INSERT OR IGNORE INTO document_external_workspaces VALUES (?,?,?,?,?,?)').run(id,draftId,relative,snapshot.hash,row.revision,new Date().toISOString());
      this.db.exec('COMMIT');
    }catch(cause){this.db.exec('ROLLBACK');throw cause}
    return this.work(draftId);
  }
  async openApplication({draftId,application='default',restart=false}){
    const {source}=await this.source(draftId);
    const app=documentApplications(source.extension.slice(1),this.folders).find(app=>app.id===application);
    if(!app)throw new Error('所选应用未安装或不支持这个格式，请重新选择打开方式。');
    if(!this.available)throw new Error('请在运行 DSH 的 Mac 上打开文件，或先下载。');
    const work=await this.ensureWorking(draftId,{restart:restart===true});
    const file=path.resolve(this.root,work.path);
    // Opening to repair a malformed working file is allowed, but links are not.
    if(!file.startsWith(this.root+path.sep)||realpathSync(file)!==file||lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile())throw new Error('工作副本路径发生变化，未打开。');
    await this.launch(file,app,false);
    return {application:app.name,workingFile:work.path,message:`已请求使用${app.name}打开工作副本；保存后这里会更新预览。`};
  }
  async reveal({draftId}){
    const {source}=await this.source(draftId),work=this.work(draftId);let file;
    if(work){const read=this.readWorking(work.path);if(read.writing)throw new Error('工作副本正在写入，请稍后重试。');file=read.file}
    else if(source.descriptor.node.importedFile){const relative=source.descriptor.node.importedFile.path;this.docs.read(relative,source.scope.fileHash);file=path.join(this.root,relative)}
    else{this.service.deliverables.sync(source.scope.requirementId);const info=this.service.deliverables.info(source.scope.sourceRef);if(info?.status!=='ready')throw new Error(info?.error||'文件尚未整理完成');this.docs.read(info.path,source.scope.fileHash);file=path.join(this.root,info.path)}
    await this.launch(file,null,true);return {opened:true};
  }
  async saveVersion({draftId,revision,hash,operationId}){
    const op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId);
    let result,work=this.work(draftId);
    if(op)result=await this.docs.saveVersion({draftId,revision,operationId});
    else{
      const current=await this.status({draftId});
      if(current.state==='writing'||current.state==='invalid')throw new Error(current.error||'本机应用正在保存，请等待预览更新后再保存新版本。');
      if(current.revision!==revision||current.hash!==hash)throw new Error('文件又发生了变化，请核对更新后的预览，再保存新版本。');
      result=await this.docs.saveVersion({draftId,revision,operationId});
    }
    if(work&&!this.db.prepare('SELECT 1 FROM document_external_publications WHERE operation_id=?').get(operationId)){
      const old=this.docs.row(draftId),scope=JSON.parse(old.scope_json);
      const desc=this.service.cards.describe({requirementId:scope.requirementId,cardId:result.cardId,versionId:result.versionId});
      const next=await this.docs.open({requirementId:scope.requirementId,cardId:result.cardId,versionId:result.versionId,sourceRef:desc.version.primaryRef,hash:desc.node.sourceHash,...(scope.outcome?{outcome:true}:{})});
      const file=this.service.tasks.files.read(result.artifactId);
      this.db.exec('BEGIN IMMEDIATE');
      try{
        this.db.prepare('UPDATE document_external_workspaces SET draft_id=?,last_hash=?,revision=?,updated_at=? WHERE id=? AND draft_id=?')
          .run(next.id,file.artifact.hash,next.revision,new Date().toISOString(),work.id,draftId);
        this.db.prepare('INSERT OR IGNORE INTO document_external_publications VALUES (?,?,?)').run(operationId,work.id,next.id);
        this.db.exec('COMMIT');
      }catch(cause){this.db.exec('ROLLBACK');throw cause}
    }
    return result;
  }
}
