import React,{useCallback,useEffect,useId,useRef,useState} from 'react'
import {DialogBody,DialogFooter,DialogHeader,UiButton,UiIcon} from './ui/controls.jsx'
import {UserError} from './user-feedback.jsx'
import {protectedProjectFilePath,withinProjectPath} from './project-file-paths.mjs'

export const PROJECT_TREE_DRAG='application/x-wtt-project-tree'
const chunkSize=4*1024*1024
const parentName=path=>path.split('/').at(-1)

export function useFileOrganizer({projectId,active,disabled,request,clipboard,setClipboard,onChanged,onExpand,expanded,onRecovered}){
  const [status,setStatus]=useState(null)
  const [working,setWorking]=useState('')
  const [feedback,setFeedback]=useState(null)
  const [conflicts,setConflicts]=useState(null)
  const [dropTarget,setDropTarget]=useState(null)
  const mounted=useRef(false),lock=useRef(false),hover=useRef(null),dragging=useRef(null)
  const uploadAbort=useRef(null)
  const activeRef=useRef(active)
  activeRef.current=active
  const statusVersion=useRef(0)

  const readStatus=useCallback(async()=>{
    const version=++statusVersion.current
    const url=new URL('api/wtt-creation-workbench',document.baseURI)
    url.searchParams.set('projectId',projectId)
    url.searchParams.set('projectFileOrganization','1')
    try{
      const response=await fetch(url,{credentials:'same-origin'})
      const data=await response.json()
      if(!response.ok)throw new Error(data.error||'文件整理记录读取失败。')
      if(mounted.current&&version===statusVersion.current)setStatus(data)
      return data
    }catch(cause){
      if(mounted.current&&version===statusVersion.current)setFeedback({error:cause.message})
      return null
    }
  },[projectId])

  useEffect(()=>{
    mounted.current=true
    return ()=>{mounted.current=false;window.clearTimeout(hover.current?.timer);uploadAbort.current?.abort()}
  },[])
  useEffect(()=>{
    if(active)void readStatus()
    else uploadAbort.current?.abort()
  },[active,readStatus])

  function clearDrop(){
    window.clearTimeout(hover.current?.timer)
    hover.current=null
    setDropTarget(null)
  }

  async function apply(input,{plan=true}={}){
    if(lock.current||disabled||!activeRef.current)return null
    lock.current=true
    setWorking(input.mode==='rename'?'正在重命名…':'正在整理文件…')
    setFeedback(null)
    try{
      let result
      if(plan){
        result=await request('project-file-organize-plan',input)
        const matches=result.failed.filter(item=>item.conflict)
        if(matches.length){
          if(mounted.current&&activeRef.current)setConflicts({input,matches})
          return null
        }
      }
      if(!activeRef.current)return null
      result=await request('project-file-organize',input)
      if(input.mode==='move'){
        setClipboard(current=>{
          if(current?.mode!=='move')return current
          const paths=current.paths.filter(path=>!result.results.some(item=>item.mode==='move'&&withinProjectPath(path,item.from)))
          return paths.length?{...current,paths}:null
        })
      }
      await onChanged(result)
      if(mounted.current)setFeedback({result,mode:input.mode})
      return result
    }catch(cause){
      if(mounted.current)setFeedback({error:cause.message,retry:()=>apply(input,{plan:false})})
      return null
    }finally{
      lock.current=false
      if(mounted.current){setWorking('');void readStatus()}
    }
  }
  function organize(input){
    return apply({operationId:crypto.randomUUID(),...input})
  }

  async function undo(){
    if(lock.current||disabled||!activeRef.current)return
    lock.current=true
    setWorking('正在撤销…')
    try{
      const current=await readStatus()
      if(!current?.undoBatch)return
      const result=await request('project-file-undo',{operationId:current.undoBatch})
      await onChanged(result)
      if(mounted.current)setFeedback({result,mode:'undo'})
    }catch(cause){if(mounted.current)setFeedback({error:cause.message})}
    finally{
      lock.current=false
      if(mounted.current){setWorking('');void readStatus()}
    }
  }

  async function recover(id){
    if(lock.current||disabled)return
    lock.current=true
    setWorking('正在恢复文件…')
    try{
      const result=await request('project-file-recover',{id})
      await onRecovered()
      if(mounted.current){setStatus(result);setFeedback({message:result.attention.some(item=>item.id===id)?'仍有冲突，请核对文件位置。':'已恢复中断的文件操作。'})}
    }catch(cause){if(mounted.current)setFeedback({error:cause.message})}
    finally{
      lock.current=false
      if(mounted.current)setWorking('')
    }
  }

  function copy(entries,mode){
    const paths=entries.filter(item=>item.path&&!item.symbolicLink&&(mode==='copy'||!protectedProjectFilePath(item.path))).map(item=>item.path)
    if(!paths.length)return
    setClipboard({mode,paths})
    setFeedback({clipboard:{mode,count:paths.length}})
  }
  function paste(target){
    if(clipboard?.paths.length)void organize({mode:clipboard.mode,sources:clipboard.paths,target})
  }

  async function uploadFiles(files,target){
    if(lock.current||disabled||!files.length)return
    if(files.length>100){setFeedback({error:'每批最多导入 100 个文件。'});return}
    lock.current=true
    setFeedback(null)
    const controller=new AbortController()
    uploadAbort.current=controller
    const failed=[],uploads=[]
    try{
      for(const [index,file] of files.entries()){
        if(controller.signal.aborted)return
        setWorking('正在导入 '+(index+1)+' / '+files.length)
        try{
          const id=crypto.randomUUID()
          let offset=0
          do{
            const url=new URL('api/wtt-creation-workbench-upload',document.baseURI)
            const chunk=file.slice(offset,offset+chunkSize)
            for(const [key,value] of Object.entries({projectId,projectFileUpload:id,name:file.name,size:file.size,offset,length:chunk.size}))url.searchParams.set(key,value)
            const response=await fetch(url,{method:'POST',credentials:'same-origin',body:chunk,signal:controller.signal})
            const data=await response.json()
            if(!response.ok||data.offset!==Math.min(offset+chunkSize,file.size))throw new Error(data.error||'文件分片上传失败。')
            offset=data.offset
          }while(offset<file.size)
          uploads.push(id)
        }catch(cause){
          if(controller.signal.aborted)return
          failed.push({name:file.name,error:cause.message})
        }
      }
    }finally{
      lock.current=false
      uploadAbort.current=null
      if(mounted.current)setWorking('')
    }
    if(!activeRef.current||!mounted.current)return
    if(uploads.length){
      const result=await organize({mode:'import',uploads,target})
      if(result&&failed.length)setFeedback({result:{...result,failed:[...failed,...result.failed]},mode:'import'})
    }else if(failed.length)setFeedback({result:{results:[],failed},mode:'import'})
  }

  function dragStart(event,entries){
    const paths=entries.filter(item=>item.path&&!item.symbolicLink).map(item=>item.path)
    if(!paths.length)return
    dragging.current=paths
    event.dataTransfer.setData(PROJECT_TREE_DRAG,JSON.stringify({projectId,paths}))
  }
  function dragEnd(){
    dragging.current=null
    clearDrop()
  }
  function dragOver(event,target){
    const types=Array.from(event.dataTransfer.types)
    const internal=types.includes(PROJECT_TREE_DRAG)
    if(!internal&&!types.includes('Files'))return
    event.preventDefault()
    event.stopPropagation()
    const isCopy=!internal||event.altKey||event.ctrlKey||event.metaKey
    if(lock.current||disabled||protectedProjectFilePath(target)||dragging.current?.some(source=>withinProjectPath(target,source))
      ||(!isCopy&&dragging.current?.some(protectedProjectFilePath))){
      event.dataTransfer.dropEffect='none'
      clearDrop()
      return
    }
    event.dataTransfer.dropEffect=isCopy?'copy':'move'
    setDropTarget(current=>current?.path===target&&current.copy===isCopy?current:{path:target,copy:isCopy})
    if(hover.current?.path===target)return
    window.clearTimeout(hover.current?.timer)
    const timer=target&&!expanded.has(target)?window.setTimeout(()=>onExpand(target),450):null
    hover.current={path:target,timer}
  }
  function dragLeave(event){
    if(event.relatedTarget instanceof Node&&event.currentTarget.contains(event.relatedTarget))return
    clearDrop()
  }
  function drop(event,target){
    const raw=event.dataTransfer.getData(PROJECT_TREE_DRAG)
    const localFiles=Array.from(event.dataTransfer.files)
    if(!raw&&!localFiles.length)return
    event.preventDefault()
    event.stopPropagation()
    const isCopy=event.altKey||event.ctrlKey||event.metaKey
    dragEnd()
    if(lock.current||disabled||protectedProjectFilePath(target))return
    if(raw){
      try{
        const {projectId:sourceProject,paths}=JSON.parse(raw)
        if(sourceProject!==projectId)throw new Error('请在同一个项目里整理文件。')
        if(!Array.isArray(paths))throw new Error('拖入的文件数据无效。')
        void organize({mode:isCopy?'copy':'move',sources:paths,target})
      }catch(cause){setFeedback({error:cause.message})}
    }else{
      if(Array.from(event.dataTransfer.items).some(item=>item.webkitGetAsEntry?.()?.isDirectory)){
        setFeedback({error:'请拖入本机文件。文件夹可先打开为项目，再在文件树中整理。'})
        return
      }
      void uploadFiles(localFiles,target)
    }
  }

  function resolveConflicts(choice){
    const current=conflicts
    setConflicts(null)
    if(choice&&current)void apply({...current.input,conflict:choice},{plan:false})
  }

  return {working,feedback,setFeedback,status,readStatus,conflicts,resolveConflicts,copy,paste,undo,recover,organize,uploadFiles,
    dropTarget,dragStart,dragEnd,dragOver,dragLeave,drop}
}

export function FileOrganizeNotice({organizer}){
  const {working,feedback,status}=organizer
  if(working)return <div className="wtt-file-batch-status" role="status">{working}</div>
  if(!feedback&&!status?.attention.length)return null
  const labels={move:'已移动',copy:'已复制',rename:'已重命名',import:'已导入',undo:'已撤销'}
  const changed=feedback?.result?.results.filter(item=>item.mode!=='unchanged')||[]
  const failed=feedback?.result?.failed||[]
  return <div className="wtt-file-batch-status wtt-file-organize-feedback">
    {feedback?.error&&<UserError error={feedback.error}/>}
    {feedback?.message&&<span role="status">{feedback.message}</span>}
    {feedback?.clipboard&&<span role="status">{feedback.clipboard.mode==='move'?'已剪切 ':'已复制 '}{feedback.clipboard.count} 项，可粘贴到目录</span>}
    {feedback?.result&&<span role="status">{changed.length?(labels[feedback.mode]||'已完成')+' '+changed.length+' 项':failed.length?'文件整理未完成':feedback.mode==='undo'?'当前没有待撤销的文件操作':'文件已在目标位置'}
      {changed.length&&failed.length?'，'+failed.length+' 项未处理':''}</span>}
    {feedback?.retry&&<UiButton variant="ghost" size="compact" onClick={feedback.retry}>重试</UiButton>}
    {changed.length>0&&feedback.mode!=='undo'&&status?.undoBatch&&<UiButton variant="ghost" size="compact" onClick={organizer.undo}>撤销</UiButton>}
    {feedback&&<UiButton variant="ghost" size="compact" iconOnly aria-label="关闭整理结果" onClick={()=>organizer.setFeedback(null)}><UiIcon name="close" size={14}/></UiButton>}
    {failed.length>0&&<details className="wtt-file-batch-errors"><summary>查看未处理的文件</summary>
      <ul>{failed.map((item,index)=><li key={index}><strong>{item.name||parentName(item.source)}</strong><span>{item.error}</span></li>)}</ul>
    </details>}
    {status?.attention.length>0&&<details className="wtt-file-batch-errors"><summary>待核对的文件操作</summary>
      <ul>{status.attention.map(item=><li key={item.id}><strong>{item.from||item.to}</strong><span>{item.reason}</span><code>{item.staging}</code>
        <UiButton variant="ghost" size="compact" onClick={()=>void organizer.recover(item.id)}>重试恢复</UiButton></li>)}</ul>
    </details>}
  </div>
}

export function FileConflictDialog({matches,onResolve}){
  const dialog=useRef(null),title=useId()
  useEffect(()=>{dialog.current?.showModal()},[])
  return <dialog ref={dialog} className="wtt-recycle-dialog" aria-labelledby={title}
    onCancel={event=>{event.preventDefault();onResolve(null)}}>
    <DialogHeader title="目标位置含同名文件" titleId={title} onClose={()=>onResolve(null)}/>
    <DialogBody>
      <ul className="wtt-file-conflict-list">{matches.map(item=><li key={item.source}>{item.targetPath||item.name||parentName(item.source)}</li>)}</ul>
      <p>保留副本会为新文件添加副本后缀。</p>
    </DialogBody>
    <DialogFooter>
      <UiButton autoFocus variant="ghost" onClick={()=>onResolve(null)}>取消</UiButton>
      <UiButton onClick={()=>onResolve('skip')}>跳过同名</UiButton>
      <UiButton variant="primary" onClick={()=>onResolve('keep-both')}>保留副本</UiButton>
    </DialogFooter>
  </dialog>
}
