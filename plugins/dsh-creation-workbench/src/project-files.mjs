import { constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DocumentPreview} from './document-preview.mjs';
import {inspectMaterialImport,extractMaterialImport,IMPORT_MAX_BYTES,supportsMaterialImport} from './material-import.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const blocked=new Set(['.wtt-workbench']);
// courses/ 是工作台管理数据区（导入副本、素材快照、任务产物中转）：文件树不再展示，卡片菜单仍是访问入口
const managedRootDirs=new Set(['courses']);
const textExtensions=new Set(['.md','.markdown','.txt','.csv','.json','.jsonl','.yaml','.yml','.html','.css','.js','.mjs','.py','.xml','.log']);
// 卡片「默认应用打开」只放行纯文本文档；Office 等可编辑格式仍走右栏工作副本流程，避免绕过版本契约
const openableTextExtensions=new Set(['.md','.markdown','.txt']);
class ProjectDocumentPreview extends DocumentPreview {
 async source(relative,hash){
  if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))throw new Error('文件预览校验值无效');
  const file=this.service.projectFiles.read(relative,hash),extension=path.extname(file.name).toLowerCase();
  if(!['.pdf','.docx','.pptx'].includes(extension))throw new Error('此入口只预览PDF、Word或PPTX');
  return {...file,extension,id:'project-'+sha(relative).slice(0,24),ref:relative};
 }
}
export class ProjectFiles {
 constructor(service,config={}){this.service=service;this.root=service.workspaceRoot;this.cache=new Map();this.documentPreview=new ProjectDocumentPreview(service);this.launch=config.projectFileLauncher||openWithSystem}
 resolve(relative='',{directory=false}={}){
  if(typeof relative!=='string'||relative.includes('\0')||relative.includes('\\')||path.isAbsolute(relative)||relative.length>4096||relative.split('/').some(p=>p==='..')||relative.split('/')[0]==='.wtt-workbench')throw new Error('请选择当前项目内的文件或文件夹；当前工作台的数据由应用管理');
  const file=path.resolve(this.root,relative);
  if(file!==this.root&&!file.startsWith(this.root+path.sep))throw new Error('文件路径超出当前项目');
  if(realpathSync(file)!==file||lstatSync(file).isSymbolicLink())throw new Error('不能使用链接或已改变的项目路径');
  if(directory?!statSync(file).isDirectory():!statSync(file).isFile())throw new Error(directory?'所选位置不是文件夹':'所选位置不是普通文件');
  return file;
 }
 list(relative=''){
  const file=this.resolve(relative,{directory:true});
  const entries=readdirSync(file,{withFileTypes:true}).filter(e=>!e.name.startsWith('.')&&!(relative===''&&managedRootDirs.has(e.name))&&(e.isFile()||e.isDirectory()||e.isSymbolicLink())).sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name,'zh-CN',{numeric:true}));
  return {path:relative,entries:entries.slice(0,1000).map(e=>({name:e.name,path:path.posix.join(relative,e.name),directory:e.isDirectory(),...(e.isSymbolicLink()?{symbolicLink:true}:{})})),truncated:entries.length>1000};
 }
 searchReferences(query){
  const term=query.trim().normalize('NFC').toLowerCase().slice(0,180);
  const folders=[''], entries=[];
  let truncated=false;
  for(let index=0;index<folders.length&&index<80;index++){
   let listing;
   try{listing=this.list(folders[index])}catch(cause){if(index===0)throw cause;continue}
   truncated ||= listing.truncated;
   for(const entry of listing.entries){
    if(entry.symbolicLink)continue;
    if(entry.directory){if(entry.name!=='node_modules'&&folders.length<80)folders.push(entry.path);else if(entry.name!=='node_modules')truncated=true;continue}
    if(supportsMaterialImport(entry.name)&&entry.path.normalize('NFC').toLowerCase().includes(term)){
     if(entries.length===16)return {entries,truncated:true};
     entries.push(entry);
    }
   }
  }
  return {entries,truncated};
 }
 read(relative,expectedHash){
  const file=this.resolve(relative),before=statSync(file);if(before.size>IMPORT_MAX_BYTES)throw new Error('文件超过20MiB，请缩小文件后重试');
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes;
  try{const opened=fstatSync(fd);if(opened.ino!==before.ino||opened.size>IMPORT_MAX_BYTES)throw new Error('文件已变化，请重新打开');bytes=readFileSync(fd)}finally{closeSync(fd)}
  const after=statSync(file);if(before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||before.size!==after.size)throw new Error('文件正在保存，请稍后重试');
  const hash=sha(bytes);if(expectedHash&&hash!==expectedHash)throw new Error('文件已变化，请重新预览后再添加');
  return {bytes,hash,name:path.basename(file),path:relative};
 }
 create({parent='',name,kind='file',content=''}){
  const folder=this.resolve(parent,{directory:true});
  if(!['file','folder'].includes(kind)||typeof name!=='string'||!name.trim()||name!==name.trim()||name.length>180||/[\\/\0]/.test(name)||name.startsWith('.')||blocked.has(name))throw new Error('请填写有效名称，不能包含路径或以点开头');
  if(content!=='')throw new Error('新建只创建空文件，请创建后用对应应用编辑');
  const filename=name;
  const file=path.join(folder,filename);if(existsSync(file))throw new Error('同名文件或文件夹已存在，请换一个名称');
  if(kind==='folder')mkdirSync(file);
  else{
   const fd=openSync(file,'wx',0o600);closeSync(fd);
  }
  return {path:path.posix.join(parent,filename),name:filename,directory:kind==='folder'};
 }
 async preview(relative){
  const input=this.read(relative),stat=statSync(path.resolve(this.root,relative)),extension=path.extname(input.name).toLowerCase(),key=input.hash+extension;if(this.cache.has(key))return {...this.cache.get(key),path:relative,name:input.name,mtimeMs:stat.mtimeMs,size:stat.size};
  let result={hash:input.hash,name:input.name,path:relative,format:extension.slice(1),mime:'application/octet-stream',content:'',extractionStatus:'unparsed',mtimeMs:stat.mtimeMs,size:stat.size};
  if(!input.bytes.length)return {...result,empty:true,extractionStatus:'empty'};
  if(textExtensions.has(extension)){
   if(input.bytes.length>1024*1024)throw new Error('文本预览最多1MiB，请下载查看完整文件');
   result={...result,mime:'text/plain',content:new TextDecoder('utf-8',{fatal:true}).decode(input.bytes),extractionStatus:'extracted'};
  }else{
   try{const metadata=inspectMaterialImport({filename:input.name,bytes:input.bytes});result={...result,...metadata,...await extractMaterialImport(input.bytes,metadata,{python:this.service.python,ffprobe:this.service.ffprobe})}}
   catch(e){result.error=e.message}
  }
  if(this.cache.size>=8)this.cache.delete(this.cache.keys().next().value);this.cache.set(key,result);return result;
 }
 stat(relative){
  let file;
  try { file = this.resolve(relative); }
  catch (cause) { if (cause.code === 'ENOENT') throw new Error('文件已被删除或移动'); throw cause; }
  const info=statSync(file);
  return {path:relative,mtimeMs:info.mtimeMs,size:info.size};
 }
 text({relative,page=1}){
  const file=this.resolve(relative),info=statSync(file);
  if(info.size>4*1024*1024)throw new Error('文本分页预览最多 4MiB，请下载查看完整文件');
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(file));}catch{throw new Error('文件不是 UTF-8 文本，请下载查看');}
  const lines=text.split('\n');if(lines.length&&lines.at(-1)==='')lines.pop();
  const pageSize=500,pageCount=Math.max(1,Math.ceil(lines.length/pageSize)),current=Math.min(Math.max(1,Math.trunc(page)||1),pageCount),start=(current-1)*pageSize;
  return {path:relative,page:current,pageCount,startLine:start+1,lineCount:lines.length,lines:lines.slice(start,start+pageSize),mtimeMs:info.mtimeMs,size:info.size};
 }
 async reference({requirementId,path:relative,hash,position,operationId,useCurrentFile}){
  if((hash!==undefined||useCurrentFile!==true)&&(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)))throw new Error('请先读取文件再添加到画布');
  if(useCurrentFile===true&&(typeof relative!=='string'||relative.split('/').some(part=>part.startsWith('.')||part==='node_modules')||managedRootDirs.has(relative.split('/')[0])))throw new Error('请选择项目文件栏中的可见文件');
  const input=this.read(relative,hash);
  const result=await this.service.canvas.importMaterial({requirementId,filename:input.name,bytes:input.bytes,position,operationId},{python:this.service.python,ffprobe:this.service.ffprobe,projectReference:{path:relative,hash:input.hash}});
  if(this.service.recycle?.restoreNode(requirementId,`material:${result.material.id}`,position))result.board=this.service.canvas.getBoard(requirementId);
  return result;
 }
 async reveal({path:relative}){
  const file=this.resolve(relative);
  if(process.platform!=='darwin')throw new Error('本机应用打开仅支持运行 DSH 的 Mac，可先下载文件。');
  await this.launch(file,['-R',file]);
  return {opened:true,fileName:path.basename(file)};
 }
 async openExternal({path:relative}){
  const file=this.resolve(relative);
  if(process.platform!=='darwin')throw new Error('本机应用打开仅支持运行 DSH 的 Mac，可先下载文件。');
  if(!openableTextExtensions.has(path.extname(file).toLowerCase()))throw new Error('此格式请在右栏预览中使用外部应用编辑，或先下载文件。');
  await this.launch(file,[file]);
  return {opened:true,fileName:path.basename(file)};
 }
}
function openWithSystem(file,args){
 return new Promise((resolve,reject)=>{
  const child=spawn('/usr/bin/open',args,{stdio:['ignore','ignore','pipe']});let error='';
  child.stderr.on('data',chunk=>{error=(error+chunk).slice(-2000)});
  const timer=setTimeout(()=>{child.kill();reject(new Error('本机应用未及时响应，请在应用中检查文件。'))},15000);
  child.on('error',cause=>{clearTimeout(timer);reject(cause)});
  child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`本机打开失败（${code}）：${error}`))});
 });
}
