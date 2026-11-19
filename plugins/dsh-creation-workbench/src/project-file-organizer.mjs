import {createHash,randomUUID} from 'node:crypto'
import {constants} from 'node:fs'
import {chmod,copyFile,link,lstat,mkdir,open,readdir,realpath,rename,rm,rmdir,unlink} from 'node:fs/promises'
import path from 'node:path'
import {protectedProjectFilePath,withinProjectPath} from './project-file-paths.mjs'

const posix=path.posix
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const uploadChunkSize=4*1024*1024
const maxUploadSize=4*1024*1024*1024
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const identity=stat=>[stat.dev,stat.ino].join(':')
const stillSame=(before,after)=>identity(before)===identity(after)&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs
const physical=(a,b)=>Boolean(a&&b&&identity(a)===identity(b))
const getStat=async file=>{try{return await lstat(file)}catch(error){if(error.code==='ENOENT')return null;throw error}}
const entryName=relative=>posix.basename(relative)
const childPath=(parent,name)=>parent?parent+'/'+name:name
const taskSourcePaths=sources=>sources.flatMap(source=>[source.path,source.sourcePath,source.projectRelativePath,source.file?.path,
  ...(source.relatedFiles||[]).map(file=>file.path)]).filter(value=>typeof value==='string')

function relativePath(value,{root=false,writable=false}={}){
  if(value===''&&root)return value
  if(typeof value!=='string'||!value||value.length>4096||value.includes('\\')||value.includes('\0')
    ||path.isAbsolute(value)||path.win32.isAbsolute(value)||value.split('/').some(part=>!part||part.startsWith('.')))
    throw new Error('请选择当前项目中可见的文件或目录。')
  const [first]=value.split('/')
  if(first==='courses'||(writable&&protectedProjectFilePath(value)))throw new Error('归档目录只支持复制到普通项目目录。')
  return value
}
function filename(value){
  if(typeof value!=='string'||!value||value.length>180||value.trim()!==value||value.startsWith('.')||value.endsWith('.')
    ||/[\\/:*?"<>|\x00-\x1f]/.test(value)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value))
    throw new Error('请输入可用的文件名。')
  return value
}
function ownerAlive(pid){
  try{process.kill(pid,0);return true}catch(error){return error.code!=='ESRCH'}
}

async function hashFile(file,expected,buffer){
  const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0))
  try{
    const before=await handle.stat()
    if(!before.isFile()||!stillSame(expected,before))throw new Error('文件在操作期间发生变化。')
    const hash=createHash('sha256')
    let position=0
    while(position<before.size){
      const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,before.size-position),position)
      if(!bytesRead)throw new Error('文件在读取期间发生变化。')
      hash.update(buffer.subarray(0,bytesRead))
      position+=bytesRead
    }
    if(!stillSame(before,await handle.stat())||!stillSame(before,await lstat(file)))throw new Error('文件在读取期间发生变化。')
    return hash.digest('hex')
  }finally{await handle.close()}
}
async function manifest(root){
  const entries=[]
  const buffer=Buffer.allocUnsafe(256*1024)
  async function visit(relative){
    const file=path.join(root,relative),stat=await lstat(file)
    if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory()))throw new Error('链接和系统特殊文件请在本机文件管理器中处理。')
    const item={relative,kind:stat.isDirectory()?'folder':'file',identity:identity(stat),mode:stat.mode&0o777}
    if(stat.isDirectory()){
      entries.push(item)
      for(const name of (await readdir(file)).sort()){
        if(name==='.wtt-workbench')throw new Error('目录包含另一个工作台项目，请先在该项目中整理文件。')
        await visit(relative?relative+'/'+name:name)
      }
      if(!stillSame(stat,await lstat(file)))throw new Error('目录内容在操作期间发生变化。')
    }else{
      entries.push({...item,bytes:stat.size,hash:await hashFile(file,stat,buffer)})
    }
  }
  await visit('')
  return entries
}
function manifestStamp(entries,includeIdentity){
  const hash=createHash('sha256')
  let segment='['
  for(const [index,entry] of entries.entries()){
    const {identity:_,...content}=entry
    segment+=(index?',':'')+JSON.stringify(includeIdentity?entry:content)
    if(segment.length>=64*1024){
      hash.update(segment)
      segment=''
    }
  }
  return hash.update(segment+']').digest('hex')
}
const contentStamp=entries=>manifestStamp(entries,false)
const exactStamp=entries=>manifestStamp(entries,true)

export class ProjectFileOrganizer {
  constructor(files){
    this.files=files
    this.service=files.service
    this.db=this.service.store.db
    this.root=files.root
    this.db.exec(`CREATE TABLE IF NOT EXISTS project_file_operations (
      id TEXT PRIMARY KEY, batch TEXT NOT NULL, slot INTEGER NOT NULL, binding TEXT NOT NULL, state TEXT NOT NULL,
      owner_pid INTEGER NOT NULL, record TEXT NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(batch,slot)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS project_file_operation_writer ON project_file_operations((1)) WHERE state='working';
    CREATE INDEX IF NOT EXISTS project_file_operations_history ON project_file_operations(state,updated_at);
    CREATE TABLE IF NOT EXISTS project_file_operation_entries (
      id TEXT NOT NULL, relative TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY(id,relative)
    );
    CREATE TABLE IF NOT EXISTS project_file_uploads (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );`)
  }

  async directory(relative){
    relativePath(relative,{root:true})
    const location=path.join(this.root,relative)
    const info=await lstat(location)
    if(!info.isDirectory()||info.isSymbolicLink()||await realpath(location)!==location)throw new Error('目标路径已变化或经过链接。')
    for(let folder=location;folder!==this.root;folder=path.dirname(folder)){
      if(await getStat(path.join(folder,'.wtt-workbench')))throw new Error('请在文件所属项目中整理。')
    }
    return {location,info}
  }

  async source(relative){
    const parent=posix.dirname(relative)
    const folder=await this.directory(parent==='.'?'':parent)
    const location=path.join(folder.location,entryName(relative))
    const info=await lstat(location)
    if(info.isSymbolicLink()||(!info.isFile()&&!info.isDirectory())||await realpath(location)!==location)
      throw new Error('请选择普通文件或目录，链接不参与整理。')
    return {location,info}
  }

  async stage(id,{upload=false,create=false}={}){
    if(!uuid(id))throw new Error('操作标识无效。')
    let folder=this.root
    for(const component of ['.wtt-workbench',upload?'file-uploads':'file-operations',id]){
      folder=path.join(folder,component)
      if(create)await mkdir(folder,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error})
      const stat=await getStat(folder)
      if(!stat)return null
      if(stat.isSymbolicLink()||!stat.isDirectory()||await realpath(folder)!==folder)throw new Error('文件整理暂存位置不可用。')
    }
    return folder
  }

  save(record,state='working'){
    this.db.prepare('UPDATE project_file_operations SET record=?, state=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(record),state,Date.now(),record.id)
  }

  async status(){
    await this.recover()
    const row=this.db.prepare("SELECT batch FROM project_file_operations WHERE state='done' AND json_extract(record,'$.undoOf') IS NULL ORDER BY updated_at DESC,rowid DESC LIMIT 1").get()
    const blockers=this.db.prepare("SELECT record FROM project_file_operations WHERE state='attention' ORDER BY updated_at DESC LIMIT 10").all()
    return {undoBatch:row?.batch||null,attention:blockers.map(item=>{
      const record=JSON.parse(item.record)
      return {id:record.id,from:record.from,to:record.to,reason:record.issue,staging:'.wtt-workbench/file-operations/'+record.id}
    })}
  }

  async recover(){
    if(this.recovery)return this.recovery
    this.recovery=this.recoverPending()
    try{await this.recovery}finally{this.recovery=null}
  }

  async recoverPending(){
    const rows=this.db.prepare("SELECT * FROM project_file_operations WHERE state='working'").all()
    for(const row of rows){
      if(ownerAlive(row.owner_pid))continue
      const claimed=this.db.prepare("UPDATE project_file_operations SET owner_pid=? WHERE id=? AND state='working' AND owner_pid=?")
        .run(process.pid,row.id,row.owner_pid).changes
      if(claimed)await this.rollback(JSON.parse(row.record),'上次操作中断。')
    }
  }

  async retryRecovery({id}={}){
    if(!uuid(id))throw new Error('恢复记录无效。')
    const row=this.db.prepare("SELECT record FROM project_file_operations WHERE id=? AND state='attention'").get(id)
    if(!row)return this.status()
    const record=JSON.parse(row.record)
    try{
      if(!this.db.prepare("UPDATE project_file_operations SET state='working',owner_pid=? WHERE id=? AND state='attention'").run(process.pid,id).changes)
        return this.status()
    }catch(error){
      if(error.message.includes('UNIQUE'))throw new Error('当前项目正在整理文件，请稍后重试。')
      throw error
    }
    await this.rollback(record,'重试恢复。')
    this.files.clearFileIndex()
    return this.status()
  }

  liveReferences(relative){
    const imports=this.db.prepare('SELECT material_id,requirement_id,source_path FROM canvas_project_references WHERE source_path=? OR instr(source_path,?)=1').all(relative,relative+'/')
    const materials=this.db.prepare('SELECT id,requirement_id,source_path FROM canvas_materials WHERE source_path=? OR instr(source_path,?)=1').all(relative,relative+'/')
    return {imports,materials}
  }

  checkTaskPaths(...relativePaths){
    const paths=relativePaths.filter(Boolean)
    const rows=this.db.prepare("SELECT id,input_json,kind,status FROM course_tasks WHERE status IN ('submitting','accepted','unknown','output') OR (kind='media' AND status NOT IN ('failed','cancelled'))").all()
    for(const row of rows){
      const input=JSON.parse(row.input_json)
      const sources=[...(input.sources||[]),input.revision].filter(Boolean)
      const matches=taskSourcePaths(sources).some(value=>paths.some(relative=>withinProjectPath(value,relative)||withinProjectPath(value,path.join(this.root,relative))))
      if(!matches)continue
      const task=this.service.tasks.get(row.id)
      const phase=task.runtimeState?.phase
      const running=task.mediaJob?!['succeeded','failed','cancelled'].includes(task.mediaJob.status)
        : ['generating','awaiting-input','awaiting-approval'].includes(phase)
          || (!['idle','failed'].includes(phase)&&['submitting','accepted','unknown'].includes(row.status))
      if(running)throw new Error('「'+task.title+'」仍在使用该文件，请在任务结束后重试。')
    }
  }

  assertAvailableForTask(sources){
    const row=this.db.prepare("SELECT record FROM project_file_operations WHERE state='working'").get()
    if(!row)return
    const {from,to,mode}=JSON.parse(row.record)
    const affected=(mode==='move'||mode==='remove-copy'?[from,to]:[to]).filter(Boolean)
    if(taskSourcePaths(sources).some(value=>affected.some(relative=>withinProjectPath(value,relative)||withinProjectPath(value,path.join(this.root,relative)))))
      throw new Error('所选资料正在整理，请等文件操作完成后再创建任务。')
  }

  async guardPublished(record){
    const claims=this.db.prepare('SELECT relative,identity FROM project_file_operation_entries WHERE id=?').all(record.id)
    if(!claims.length){
      if(record.to&&await getStat(path.join(this.root,record.to))&&record.publishing)
        throw new Error('目标路径已有内容，无法确认其归属。')
      return
    }
    const destination=path.join(this.root,record.to)
    if(!await getStat(destination))return
    const actual=await manifest(destination)
    const owned=new Map(claims.map(item=>[item.relative,item.identity]))
    const expected=new Map((record.expected||[]).map(item=>[item.relative,item]))
    for(const item of actual){
      const planned=expected.get(item.relative)
      if(owned.get(item.relative)!==item.identity||!planned||item.kind!==planned.kind||item.hash!==planned.hash)
        throw new Error('目标含外部新增或修改，已保留现场。')
    }
    for(const item of actual.reverse()){
      const location=path.join(destination,item.relative)
      if(identity(await lstat(location))!==item.identity)throw new Error('目标在恢复时发生变化。')
      if(item.kind==='folder')await rmdir(location)
      else await unlink(location)
    }
  }

  async rollback(record,issue){
    try{
      const folder=await this.stage(record.id)
      const staged=folder&&await getStat(path.join(folder,'payload'))
      if(record.publishing)await this.guardPublished(record)
      if(staged&&(record.mode==='move'||record.mode==='remove-copy')){
        if(!record.original||record.original!==identity(staged))throw new Error('暂存源身份无法核对。')
        const folder=posix.dirname(record.from)
        await this.directory(folder==='.'?'':folder)
        const original=path.join(this.root,record.from)
        if(await getStat(original))throw new Error('原位置已被占用，暂存源已保留。')
        const payload=path.join(await this.stage(record.id),'payload')
        await this.materialize(original,payload,await manifest(payload))
      }
      if(folder)await rm(folder,{recursive:true})
      this.db.prepare('DELETE FROM project_file_operation_entries WHERE id=?').run(record.id)
      record.issue=issue
      this.save({...record,expected:undefined},'failed')
      return true
    }catch(error){
      record.issue=issue+' '+error.message
      this.save(record,'attention')
      return false
    }
  }

  async destination(target,name,{source,from,mode,conflict,reserved}={}){
    const parent=await this.directory(target)
    const tryPath=async next=>({relative:childPath(target,next),stat:await getStat(path.join(parent.location,next))})
    const initial=await tryPath(name)
    if(!initial.stat&&!reserved.has(initial.relative.normalize('NFC').toLowerCase()))return initial.relative
    if(mode==='move'&&physical(source,initial.stat)&&from!==initial.relative&&
      !(await readdir(parent.location)).includes(name)&&posix.dirname(from)===posix.dirname(initial.relative))return initial.relative
    if(conflict!=='keep-both')throw Object.assign(new Error('目标已存在同名文件或目录。'),{code:'WTT_FILE_CONFLICT',targetPath:initial.relative})
    const ext=source?.isDirectory()?'':posix.extname(name)
    const stem=name.slice(0,name.length-ext.length)
    for(let index=1;index<=999;index++){
      const suffix=index===1?' 副本':' 副本 '+index
      const candidate=await tryPath(stem.slice(0,180-ext.length-suffix.length)+suffix+ext)
      if(!candidate.stat&&!reserved.has(candidate.relative.normalize('NFC').toLowerCase()))return candidate.relative
    }
    throw new Error('已达到同名副本数量上限。')
  }

  async copyOriginal(source,staged,entries){
    for(const entry of entries){
      const original=path.join(source,entry.relative),target=path.join(staged,entry.relative)
      const current=await lstat(original)
      if(identity(current)!==entry.identity||current.isSymbolicLink())throw new Error('复制源在操作期间发生变化。')
      if(entry.kind==='folder')await mkdir(target,{mode:entry.mode|0o700})
      else await copyFile(original,target,constants.COPYFILE_EXCL)
    }
    await this.restoreModes(staged,entries)
  }

  async restoreModes(root,entries){
    for(const entry of [...entries].reverse())if(entry.kind==='folder')
      await chmod(path.join(root,entry.relative),entry.mode)
  }

  async materialize(dest,staged,entries,onClaim){
    const owned=new Map()
    for(const entry of entries){
      const location=path.join(dest,entry.relative)
      if(entry.relative){
        const parentEntry=posix.dirname(entry.relative)
        const parent=path.join(dest,parentEntry)
        const known=owned.get(parentEntry==='.'?'':parentEntry)
        if(!known||identity(await lstat(parent))!==known||await realpath(parent)!==parent)throw new Error('目标目录在写入期间发生变化。')
      }else{
        const parent=path.relative(this.root,path.dirname(dest)).split(path.sep).join('/')
        await this.directory(parent)
      }
      if(entry.kind==='folder')await mkdir(location,{mode:entry.mode|0o700})
      else await link(path.join(staged,entry.relative),location)
      const claimed=await lstat(location)
      if(claimed.isSymbolicLink()||(entry.kind==='file'&&identity(claimed)!==entry.identity))
        throw new Error('目标文件在创建期间发生变化。')
      const owner=identity(claimed)
      owned.set(entry.relative,owner)
      onClaim?.(entry.relative,owner)
    }
    await this.restoreModes(dest,entries)
  }

  async publish(record,staged){
    record.publishing=true
    this.save(record)
    const insert=this.db.prepare('INSERT INTO project_file_operation_entries VALUES (?,?,?)')
    let claimed=false
    try{
      await this.materialize(path.join(this.root,record.to),staged,record.expected,(relative,owner)=>{
        claimed=true
        insert.run(record.id,relative,owner)
      })
    }catch(error){
      if(!claimed&&['EEXIST','EXDEV','EACCES','EPERM'].includes(error.code)){
        record.publishing=false
        this.save(record)
      }
      throw error
    }
  }

  patchReferences(record){
    const requirements=new Set()
    if(record.from&&(record.mode==='move'||record.mode==='remove-copy')){
      this.checkTaskPaths(record.from,record.to)
      const {imports,materials}=this.liveReferences(record.from)
      if(record.mode==='remove-copy'&&(imports.length||materials.length))throw new Error('该副本已被画布引用，请先处理关联卡片。')
      const relocate=row=>record.to+row.source_path.slice(record.from.length)
      for(const row of imports){
        this.db.prepare('UPDATE canvas_project_references SET source_path=? WHERE material_id=?').run(relocate(row),row.material_id)
        requirements.add(row.requirement_id)
      }
      for(const row of materials){
        this.db.prepare('UPDATE canvas_materials SET source_path=? WHERE id=?').run(relocate(row),row.id)
        requirements.add(row.requirement_id)
      }
    }
    return [...requirements]
  }

  async execute(item,batch,slot,binding){
    const previous=this.db.prepare('SELECT * FROM project_file_operations WHERE batch=? AND slot=?').get(batch,slot)
    if(previous){
      if(previous.binding!==binding)throw new Error('操作标识已用于不同内容。')
      const record=JSON.parse(previous.record)
      if(['done','undone'].includes(previous.state))return record.result
      throw new Error(record.issue||'文件操作正在执行，请稍后查看结果。')
    }
    const record={...item,id:randomUUID()}
    const input=record.from?await this.source(record.from):null
    if(input)record.original=identity(input.info)
    if(record.mode==='move'||record.mode==='remove-copy')this.checkTaskPaths(record.from,record.to)
    try{
      this.db.prepare("INSERT INTO project_file_operations VALUES (?,?,?,?, 'working',?,?,?)")
        .run(record.id,batch,slot,binding,process.pid,JSON.stringify(record),Date.now())
    }catch(error){
      if(error.code?.includes('SQLITE')&&error.message.includes('UNIQUE'))throw new Error('当前项目正在整理文件，请稍后重试。')
      throw error
    }
    try{
      const folder=await this.stage(record.id,{create:true})
      const staged=path.join(folder,'payload')
      if(record.mode==='move'||record.mode==='remove-copy'){
        if(!stillSame(input.info,await lstat(input.location)))throw new Error('源已变化，请重新选择。')
        const originalStamp=exactStamp(await manifest(input.location))
        if(record.expectedStamp&&originalStamp!==record.expectedStamp)throw new Error('文件已被修改、替换或添加内容，无法撤销。')
        this.checkTaskPaths(record.from,record.to)
        await rename(input.location,staged)
        record.expected=await manifest(staged)
        if(exactStamp(record.expected)!==originalStamp)throw new Error('源在移动期间发生变化。')
      }else{
        const origin=input?.location||path.join(await this.stage(record.uploadId,{upload:true}),'payload')
        const original=await manifest(origin)
        await this.copyOriginal(origin,staged,original)
        record.expected=await manifest(staged)
        // A copied directory may temporarily be owner-writable during staging.
        if(contentStamp(original)!==contentStamp(record.expected))throw new Error('复制期间原文件发生变化。')
      }
      this.save(record)
      if(record.to)await this.publish(record,staged)
      const current=record.to?await manifest(path.join(this.root,record.to)):await manifest(staged)
      if(contentStamp(current)!==contentStamp(record.expected))throw new Error('目标在操作完成前发生变化。')
      record.result={from:record.from,to:record.to,mode:record.mode,requirements:[],name:entryName(record.to||record.from)}
      record.destinationStamp=exactStamp(current)
      this.db.exec('BEGIN IMMEDIATE')
      try{
        record.result.requirements=this.patchReferences(record)
        if(record.undoOf)this.db.prepare("UPDATE project_file_operations SET state='undone' WHERE id=? AND state='done'").run(record.undoOf)
        this.db.prepare('DELETE FROM project_file_operation_entries WHERE id=?').run(record.id)
        this.save({...record,expected:undefined},'done')
        this.db.exec('COMMIT')
      }catch(error){this.db.exec('ROLLBACK');throw error}
      this.files.clearFileIndex()
      await rm(folder,{recursive:true}).catch(()=>{})
      return record.result
    }catch(error){
      if(error.code==='EXDEV')error.message='暂时只支持同一磁盘内整理文件。'
      if(error.message.startsWith('UNIQUE constraint failed: canvas_project_references'))error.message='目标路径仍有关联卡片，请先处理关联卡片或更换文件名。'
      if(!await this.rollback(record,error.message))throw new Error(record.issue+' 暂存源已保留，请在文件栏查看核对信息。')
      throw error
    }
  }

  async organize({operationId,mode,sources,target='',name,conflict='skip',uploads}={}, {preview=false}={}){
    if(!uuid(operationId)||!['move','copy','rename','import'].includes(mode)||!['skip','keep-both'].includes(conflict))
      throw new Error('文件整理请求无效。')
    await this.recover()
    if(mode==='import'&&!Array.isArray(uploads)||mode!=='import'&&!Array.isArray(sources))throw new Error('请选择文件。')
    const requested=mode==='import'?uploads:sources
    if(!requested.length||requested.length>100||mode==='rename'&&requested.length!==1)throw new Error('每批请选择 1 到 100 个文件或文件夹。')
    if(mode==='rename'){
      filename(name)
      relativePath(sources[0],{writable:true})
      target=posix.dirname(sources[0])
      if(target==='.')target=''
    }
    relativePath(target,{root:true,writable:true})
    const binding=fingerprint({mode,requested,target,name,conflict})
    const seen=this.db.prepare('SELECT binding FROM project_file_operations WHERE batch=? LIMIT 1').get(operationId)
    if(seen&&seen.binding!==binding)throw new Error('操作标识已用于不同内容。')
    const paths=mode==='import'?[]:[...new Set(sources)]
    const items=mode==='import'?[...new Set(uploads)]:paths.filter(value=>typeof value!=='string'||!paths.some(parent=>typeof parent==='string'&&parent!==value&&withinProjectPath(value,parent)))
    const results=[],failed=[],reserved=new Set()
    for(const [index,value] of items.entries()){
      let label=value
      try{
        const previous=!preview&&this.db.prepare('SELECT record FROM project_file_operations WHERE batch=? AND slot=?').get(operationId,index)
        if(previous){results.push(await this.execute(JSON.parse(previous.record),operationId,index,binding));continue}
        const upload=mode==='import'?this.db.prepare('SELECT * FROM project_file_uploads WHERE id=?').get(value):null
        if(mode==='import'){
          if(!upload||!uuid(value))throw new Error('该上传已结束或不存在。')
          label=upload.name
          const folder=await this.stage(value,{upload:true})
          if(!folder||(await getStat(path.join(folder,'payload')))?.size!==upload.size)throw new Error('文件尚未完整上传。')
        }
        const from=mode==='import'?null:relativePath(value,{writable:mode!=='copy'})
        const source=from?await this.source(from):null
        if(source?.info.isDirectory()&&withinProjectPath(target,from))throw new Error('目录不能放进自身或下级目录。')
        const nextName=filename(mode==='rename'?name:upload?.name||entryName(from))
        if(from===childPath(target,nextName)&&mode!=='copy'){results.push({from,to:from,name:nextName,mode:'unchanged',requirements:[]});continue}
        const to=await this.destination(target,nextName,{source:source?.info,from,mode:mode==='rename'?'move':mode,conflict,reserved})
        relativePath(to,{writable:true})
        reserved.add(to.normalize('NFC').toLowerCase())
        if(preview){results.push({from,to,name:nextName});continue}
        const result=await this.execute({from,to,mode:mode==='rename'?'move':mode,uploadId:upload?.id},operationId,index,binding)
        results.push(result)
        if(upload)await this.clearUpload(upload.id).catch(()=>{})
      }catch(error){
        failed.push({source:value,name:label,error:error.message,conflict:error.code==='WTT_FILE_CONFLICT',targetPath:error.targetPath})
      }
    }
    return {operationId,results,failed}
  }

  async undo({operationId}={}){
    if(!uuid(operationId))throw new Error('撤销记录无效。')
    await this.recover()
    const rows=this.db.prepare("SELECT * FROM project_file_operations WHERE batch=? AND state='done' AND json_extract(record,'$.undoOf') IS NULL ORDER BY slot DESC").all(operationId)
    const mostRecent=(await this.status()).undoBatch
    if(rows.length&&mostRecent!==operationId)throw new Error('请先撤销最新的文件操作。')
    const batch=randomUUID(),results=[],failed=[]
    for(const [index,row] of rows.entries()){
      const original=JSON.parse(row.record)
      const from=original.to,to=original.mode==='move'?original.from:null
      try{
        relativePath(from,{writable:true})
        if(to)relativePath(to,{writable:true})
        if(to){
          const parent=posix.dirname(to)
          await this.directory(parent==='.'?'':parent)
          const there=await getStat(path.join(this.root,to))
          const here=await getStat(path.join(this.root,from))
          if(there&&(!physical(here,there)||(await readdir(path.dirname(path.join(this.root,to)))).includes(entryName(to))))
            throw new Error('原位置已被其他文件占用，无法撤销。')
        }
        results.push(await this.execute({from,to,mode:to?'move':'remove-copy',expectedStamp:original.destinationStamp,undoOf:original.id},batch,index,operationId))
      }catch(error){failed.push({source:from,name:entryName(from),error:error.message})}
    }
    return {operationId,results,failed}
  }

  async clearUpload(id){
    const folder=await this.stage(id,{upload:true})
    if(folder)await rm(folder,{recursive:true})
    this.db.prepare('DELETE FROM project_file_uploads WHERE id=?').run(id)
  }

  upload({bytes,...input}){
    return this.uploadStream({...input,length:bytes.length,chunks:[bytes]})
  }

  async uploadStream({id,name,size,offset,length,chunks,signal}){
    if(!uuid(id)||!Number.isSafeInteger(size)||size<0||size>maxUploadSize||!Number.isSafeInteger(offset)||offset<0||
      !Number.isSafeInteger(length)||length<0||length>uploadChunkSize||offset+length>size||(!length&&size>0))throw new Error('上传分片或文件大小无效。')
    filename(name)
    if(offset===0){
      const expired=this.db.prepare('SELECT id FROM project_file_uploads WHERE updated_at<? LIMIT 20').all(Date.now()-24*60*60*1000)
      for(const row of expired)await this.clearUpload(row.id).catch(()=>{})
      this.db.prepare('INSERT OR IGNORE INTO project_file_uploads VALUES (?,?,?,?)').run(id,name,size,Date.now())
    }
    const row=this.db.prepare('SELECT * FROM project_file_uploads WHERE id=?').get(id)
    if(!row||row.name!==name||row.size!==size)throw new Error('上传状态已变化，请重新拖入文件。')
    const folder=await this.stage(id,{upload:true,create:offset===0})
    if(!folder)throw new Error('上传暂存已过期，请重新拖入文件。')
    const target=path.join(folder,'payload')
    if(!this.uploading)this.uploading=new Set()
    if(this.uploading.has(id))throw new Error('该文件仍在上传，请等待分片完成。')
    this.uploading.add(id)
    try{
      const noFollow=constants.O_NOFOLLOW||0
      const handle=await open(target,constants.O_RDWR|noFollow|(offset===0?constants.O_CREAT:0),0o600)
      try{
        const stat=await handle.stat()
        if(!stat.isFile())throw new Error('上传暂存不可用。')
        const appending=stat.size===offset
        if(!appending&&stat.size<offset+length)throw new Error('分片顺序已变化，请重新拖入文件。')
        let received=0
        const replay=appending?null:Buffer.allocUnsafe(Math.min(length,256*1024))
        try{
          for await(const piece of chunks){
            signal?.throwIfAborted()
            if(received+piece.byteLength>length)throw new Error('收到的分片超出声明大小。')
            let consumed=0
            while(consumed<piece.byteLength){
              const position=offset+received+consumed
              if(appending){
                const {bytesWritten}=await handle.write(piece,consumed,piece.byteLength-consumed,position)
                if(!bytesWritten)throw new Error('无法写入上传分片。')
                consumed+=bytesWritten
              }else{
                const count=Math.min(replay.length,piece.byteLength-consumed)
                const {bytesRead}=await handle.read(replay,0,count,position)
                if(!bytesRead||!replay.subarray(0,bytesRead).equals(piece.subarray(consumed,consumed+bytesRead)))
                  throw new Error('上传的内容已变化，请重新拖入文件。')
                consumed+=bytesRead
              }
            }
            received+=piece.byteLength
          }
          signal?.throwIfAborted()
          if(received!==length)throw new Error('分片传输中断，请重试。')
        }catch(error){
          if(appending)await handle.truncate(offset)
          throw error
        }
        this.db.prepare('UPDATE project_file_uploads SET updated_at=? WHERE id=?').run(Date.now(),id)
      }finally{await handle.close()}
      return {offset:offset+length}
    }finally{this.uploading.delete(id)}
  }
}
