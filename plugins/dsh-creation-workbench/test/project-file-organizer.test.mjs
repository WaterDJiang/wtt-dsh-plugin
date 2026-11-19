import assert from 'node:assert/strict'
import test from 'node:test'
import {createHash,randomUUID} from 'node:crypto'
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {WorkbenchService} from '../src/service.mjs'

function fixture(t){
  const root=mkdtempSync(path.join(tmpdir(),'wtt-file-organize-'))
  const service=new WorkbenchService({workspaceRoot:root})
  t.after(()=>{service.close();rmSync(root,{recursive:true,force:true})})
  const organizer=service.projectFiles.organizer
  const put=(file,value)=>{
    mkdirSync(path.dirname(path.join(root,file)),{recursive:true})
    writeFileSync(path.join(root,file),value)
  }
  const read=file=>readFileSync(path.join(root,file),'utf8')
  const exists=file=>existsSync(path.join(root,file))
  const apply=(input,operationId=randomUUID())=>organizer.organize({operationId,...input})
  return {root,service,organizer,apply,put,read,exists}
}

test('batch plans keep equal names apart, skip preserves current files, and rollback refuses a changed copy',async t=>{
  const f=fixture(t)
  f.put('分镜/说明.md','第一份')
  f.put('素材/说明.md','第二份')
  mkdirSync(path.join(f.root,'目标'))
  const input={operationId:randomUUID(),mode:'copy',sources:['分镜/说明.md','素材/说明.md'],target:'目标'}
  const plan=await f.organizer.organize(input,{preview:true})
  assert.equal(plan.failed[0].conflict,true)
  assert(!f.exists('目标/说明.md'))
  const result=await f.organizer.organize({...input,conflict:'keep-both'})
  assert.deepEqual(result.results.map(item=>item.to),['目标/说明.md','目标/说明 副本.md'])
  assert.equal(f.read('目标/说明.md'),'第一份')
  assert.equal(f.read('目标/说明 副本.md'),'第二份')
  assert.deepEqual(await f.organizer.organize({...input,conflict:'keep-both'}),result)
  f.put('目标/说明 副本.md','外部改动')
  const undone=await f.organizer.undo({operationId:input.operationId})
  assert.equal(undone.results.length,1)
  assert.match(undone.failed[0].error,/修改|替换/)
  assert.equal(f.read('目标/说明 副本.md'),'外部改动')
  assert(!f.exists('目标/说明.md'))
  assert.equal(f.read('素材/说明.md'),'第二份')
})

test('moving nested assets updates live card paths across canvases and preserves frozen task input and snapshots',async t=>{
  const f=fixture(t)
  f.put('素材/子文件夹/镜头.md','原文件正文')
  mkdirSync(path.join(f.root,'归整'))
  const reqs=['画布一','画布二'].map(title=>f.service.store.createCanvas({title,operationId:randomUUID()}))
  const source='素材/子文件夹/镜头.md'
  const material=[]
  for(const req of reqs)material.push((await f.service.projectFiles.reference({requirementId:req.id,path:source,useCurrentFile:true,operationId:randomUUID()})).material)
  const cardId='material:'+material[0].id
  const task=f.service.createTask({requirementId:reqs[0].id,outputType:'text',selectedCardIds:[cardId],selectedSkills:[],
    instruction:'验收冻结来源',operationId:randomUUID()}).task
  const frozen=f.service.tasks.get(task.id).input
  f.service.tasks.bindSession({taskId:task.id,sessionId:'file-organizer-test'})
  f.service.tasks.setDispatch({taskId:task.id,status:'accepted'})
  const input={mode:'move',sources:['素材',source],target:'归整'}
  const refused=await f.apply(input)
  assert.match(refused.failed[0].error,/仍在使用/)
  assert(f.exists(source))
  f.service.tasks.runtimeStateReader=()=>({phase:'idle',settled:true})
  const moved=await f.apply(input)
  const destination='归整/'+source
  assert.equal(moved.results.length,1)
  assert.deepEqual(new Set(moved.results[0].requirements),new Set(reqs.map(req=>req.id)))
  for(const [index,req] of reqs.entries()){
    const node=f.service.canvas.getBoard(req.id).nodes.find(node=>node.refId===material[index].id)
    assert.equal(node.projectFile.path,destination)
    assert.equal(f.service.canvas.readImportedFile(node.refId).bytes.toString(),'原文件正文')
  }
  assert.deepEqual(f.service.tasks.get(task.id).input,frozen)
  assert(!f.exists(source))
  const restored=await f.organizer.undo({operationId:moved.operationId})
  assert.equal(restored.results.length,1)
  assert.equal(f.read(source),'原文件正文')
  assert(!f.exists(destination))
  assert.equal(f.service.canvas.getBoard(reqs[0].id).nodes.find(node=>node.id===cardId).projectFile.path,source)
})

test('case-only rename, occupied undo, source protection and symbol links keep existing filesystem entries',async t=>{
  const f=fixture(t)
  f.put('Take.md','first')
  const result=await f.apply({mode:'rename',sources:['Take.md'],name:'take.md'})
  assert.equal(result.results.length,1)
  assert.equal(f.read('take.md'),'first')
  const undo=await f.organizer.undo({operationId:result.operationId})
  assert.equal(undo.results.length,1)
  const moved=await f.apply({mode:'rename',sources:['Take.md'],name:'Moved.md'})
  f.put('Take.md','external original position')
  const refused=await f.organizer.undo({operationId:moved.operationId})
  assert.match(refused.failed[0].error,/占用/)
  assert.equal(f.read('Take.md'),'external original position')
  assert.equal(f.read('Moved.md'),'first')
  f.put('产物/V001/正式.md','保留版本')
  assert.match((await f.apply({mode:'move',sources:['产物/V001/正式.md'],target:''})).failed[0].error,/归档/)
  assert.equal((await f.apply({mode:'copy',sources:['产物/V001/正式.md'],target:''})).results.length,1)
  assert.equal(f.read('正式.md'),'保留版本')
  symlinkSync(path.join(f.root,'Moved.md'),path.join(f.root,'链接.md'))
  assert.match((await f.apply({mode:'copy',sources:['链接.md'],target:''})).failed[0].error,/链接/)
  const traversal=await f.apply({mode:'copy',sources:['../Moved.md'],target:''})
  assert.equal(traversal.results.length,0)
})

test('upload chunks are replayable, preserve exact bytes, and can be undone',async t=>{
  const f=fixture(t)
  const id=randomUUID(),name='剪辑.mp4',a=Buffer.alloc(4*1024*1024,13),b=Buffer.from([0,1,2,3])
  assert.deepEqual(await f.organizer.upload({id,name,size:a.length+b.length,offset:0,bytes:a}),{offset:a.length})
  await f.organizer.upload({id,name,size:a.length+b.length,offset:0,bytes:a})
  await f.organizer.upload({id,name,size:a.length+b.length,offset:a.length,bytes:b})
  const result=await f.apply({mode:'import',uploads:[id],target:''})
  assert.equal(result.results.length,1)
  const location=path.join(f.root,name),bytes=readFileSync(location),info=lstatSync(location)
  assert.deepEqual(bytes,Buffer.concat([a,b]))
  const previousManifest=[{relative:'',kind:'file',identity:[info.dev,info.ino].join(':'),mode:info.mode&0o777,
    bytes:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')}]
  const previousStamp=createHash('sha256').update(JSON.stringify(previousManifest)).digest('hex')
  const row=f.service.store.db.prepare('SELECT record FROM project_file_operations WHERE batch=?').get(result.operationId)
  assert.equal(JSON.parse(row.record).destinationStamp,previousStamp,'old durable undo fingerprints must still match')
  await f.organizer.undo({operationId:result.operationId})
  assert(!f.exists(name))
})

test('interrupted and oversized stream chunks roll back their partial writes and replay verifies smaller buffers',async t=>{
  const f=fixture(t)
  const id=randomUUID(),name='可恢复.bin',size=12
  const base={id,name,size,offset:0,length:8}
  await assert.rejects(f.organizer.uploadStream({...base,chunks:[Buffer.from('1234')]}),/中断/)
  await assert.rejects(f.organizer.uploadStream({...base,chunks:[Buffer.from('1234'),Buffer.from('56789')]}),/超出/)
  assert.deepEqual(await f.organizer.uploadStream({...base,chunks:[Buffer.from('1234'),Buffer.from('5678')]}),{offset:8})
  await assert.rejects(f.organizer.uploadStream({...base,chunks:[Buffer.from('12345679')]}),/已变化/)
  assert.deepEqual(await f.organizer.uploadStream({...base,chunks:[Buffer.from('1'),Buffer.from('2345678')]}),{offset:8})
  const controller=new AbortController()
  await assert.rejects(f.organizer.uploadStream({...base,offset:8,length:4,signal:controller.signal,chunks:(async function*(){
    yield Buffer.from('9')
    controller.abort()
  })()}),{name:'AbortError'})
  await f.organizer.uploadStream({...base,offset:8,length:4,chunks:[Buffer.from('90ab')]})
  const result=await f.apply({mode:'import',uploads:[id],target:''})
  assert.equal(result.results.length,1)
  assert.equal(f.read(name),'1234567890ab')
})

test('concurrent attempts cannot overwrite each other or remove either source',async t=>{
  const f=fixture(t)
  f.put('A/文件.txt','first')
  f.put('B/文件.txt','second')
  mkdirSync(path.join(f.root,'目标'))
  const results=await Promise.all(['A/文件.txt','B/文件.txt'].map(source=>f.apply({mode:'copy',sources:[source],target:'目标'})))
  assert.equal(results.flatMap(result=>result.results).length,1)
  assert.equal(results.flatMap(result=>result.failed).length,1)
  const written=f.read('目标/文件.txt')
  assert(['first','second'].includes(written))
  assert.equal(f.read('A/文件.txt'),'first')
  assert.equal(f.read('B/文件.txt'),'second')
})

test('interrupted source staging survives process restart and refuses to overwrite external replacement',async t=>{
  const f=fixture(t)
  f.put('待恢复.txt','原字节')
  const id=randomUUID(),folder=await f.organizer.stage(id,{create:true})
  const original=lstatSync(path.join(f.root,'待恢复.txt'))
  renameSync(path.join(f.root,'待恢复.txt'),path.join(folder,'payload'))
  f.put('待恢复.txt','外部替换')
  const record={id,from:'待恢复.txt',to:'不同位置.txt',mode:'move',original:[original.dev,original.ino].join(':')}
  f.service.store.db.prepare("INSERT INTO project_file_operations VALUES (?,?,?,?, 'working',?,?,?)")
    .run(id,randomUUID(),0,'simulated interruption',2147483647,JSON.stringify(record),Date.now())
  const status=await f.organizer.status()
  assert.equal(status.attention[0].id,id)
  assert.equal(f.read('待恢复.txt'),'外部替换')
  assert.equal(readFileSync(path.join(folder,'payload'),'utf8'),'原字节')
  renameSync(path.join(f.root,'待恢复.txt'),path.join(f.root,'外部保存.txt'))
  assert.deepEqual((await f.organizer.retryRecovery({id})).attention,[])
  assert.equal(f.read('待恢复.txt'),'原字节')
  assert.equal(f.read('外部保存.txt'),'外部替换')
})
