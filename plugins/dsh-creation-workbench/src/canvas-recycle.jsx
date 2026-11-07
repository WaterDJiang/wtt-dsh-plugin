import { DialogFooter, DialogHeader, UiButton } from './ui/controls.jsx'
import React,{useEffect,useRef,useState} from 'react'
import {UserError} from './user-feedback.jsx'
import './canvas-recycle.css'
function RecycleContents({items}){
 const [page,setPage]=useState(0),count=100,pages=Math.max(1,Math.ceil(items.length/count)),current=Math.min(page,pages-1)
 return <><ul className="wtt-delete-files">{items.slice(current*count,(current+1)*count).map((item,index)=><li key={item.path||index}>{item.label&&<small>{item.label}</small>}<code>{item.path}</code>{item.target&&<code>→ {item.target}</code>}</li>)}</ul>{pages>1&&<nav className="wtt-recycle-pages" aria-label="范围清单翻页"><UiButton size="compact" disabled={current===0} onClick={()=>setPage(current-1)}>上一页</UiButton><span>{current+1} / {pages} · 共 {items.length} 项</span><UiButton size="compact" disabled={current===pages-1} onClick={()=>setPage(current+1)}>下一页</UiButton></nav>}</>
}
export function DeleteProjectFilesDialog({plan,request,onClose,onDone}){
 const dialog=useRef(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[removed,setRemoved]=useState(false)
 useEffect(()=>{dialog.current?.showModal()},[])
 useEffect(()=>{if(!busy)dialog.current?.querySelector('[data-file-delete-cancel]')?.focus()},[busy])
 async function submit(e){
  e.preventDefault();if(busy)return;setBusy(true);setError('');let completed=removed
  try{if(!completed){await request('project-file-delete',{planId:plan.id});setRemoved(true);completed=true}await onDone(plan)}
  catch(e){setError((completed?'文件已移入回收站，刷新失败：':'')+e.message)}finally{setBusy(false)}
 }
 return <dialog className="wtt-recycle-dialog" ref={dialog} aria-labelledby="wtt-file-delete-title" onCancel={e=>{e.preventDefault();if(!busy)onClose()}}>
  <form onSubmit={submit}>
   <DialogHeader title="移到回收站" titleId="wtt-file-delete-title" onClose={onClose} closeLabel="关闭文件删除确认" busy={busy}/>
   <div className="wtt-recycle-body">
    <strong>{plan.target.name}</strong>{plan.target.path!==plan.target.name&&<code>{plan.target.path}</code>}
    <p>{[plan.files.length&&`${plan.files.length} 个文件`,plan.directories.length&&`${plan.directories.length} 个文件夹`,plan.links?.length&&`${plan.links.length} 个符号链接`,plan.nodes.length&&`${plan.nodes.length} 张关联卡片`].filter(Boolean).join(' · ')}</p>
    <details open hidden={!plan.target.directory&&!plan.target.symbolicLink}><summary>包含的内容</summary>{plan.files.length===0&&!plan.links?.length&&plan.directories.length===1&&<p>文件夹为空</p>}<RecycleContents items={[...plan.directories.filter(d=>d.path!==plan.target.path).map(d=>({...d,label:'文件夹'})),...plan.files,...(plan.links||[]).map(l=>({...l,label:'符号链接 · 只删除链接，目标保留'}))]}/></details>
    {plan.nodes.length>0&&<details open><summary>同时移除的画布卡片</summary><ul className="wtt-delete-files">{plan.nodes.map(n=><li key={`${n.requirementId}:${n.nodeId}`}><strong>{n.title}</strong><small>{n.course}</small></li>)}</ul></details>}
    <p>{plan.nodes.length?'可从项目回收站一起恢复文件和卡片。':'可从项目回收站恢复。'}</p>{error&&<UserError error={error}/>} {removed&&<p role="status">文件已移入回收站。</p>}
   </div>
   <DialogFooter><UiButton data-file-delete-cancel disabled={busy} onClick={onClose}>取消</UiButton><UiButton variant={removed?'primary':'danger'} type="submit" disabled={busy}>{busy?'正在处理…':removed?'刷新列表':'移到回收站'}</UiButton></DialogFooter>
  </form>
 </dialog>
}
export function DeleteNodesDialog({plan,request,onClose,onDone}){
 const dialog=useRef(null),[deleteFiles,setDeleteFiles]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
 useEffect(()=>{dialog.current?.showModal()},[])
 const unavailable=plan.files.some(f=>f.error)
 async function remove(e){e.preventDefault();setBusy(true);setError('');try{await request('canvas-recycle-remove',{planId:plan.id,deleteFiles});await onDone()}catch(e){setError(e.message)}finally{setBusy(false)}}
 return <dialog className="wtt-recycle-dialog" ref={dialog} aria-labelledby="wtt-delete-heading" onCancel={e=>{e.preventDefault();if(!busy)onClose()}}><form onSubmit={remove}><DialogHeader title={`删除${plan.nodes.length>1?` ${plan.nodes.length} 个节点`:'节点'}`} titleId="wtt-delete-heading" onClose={onClose} closeLabel="关闭删除确认" busy={busy}/><div className="wtt-recycle-body"><ul className="wtt-delete-names">{plan.nodes.map(n=><li key={n.nodeId}>{n.title}</li>)}</ul><fieldset><legend className="wtt-visually-hidden">删除范围</legend><label><input type="radio" name="delete-scope" checked={!deleteFiles} disabled={busy} onChange={()=>setDeleteFiles(false)}/><span>只移除画布节点</span></label>{plan.files.length>0&&<label><input type="radio" name="delete-scope" checked={deleteFiles} disabled={busy||unavailable} onChange={()=>setDeleteFiles(true)}/><span>同时将源文件移到项目回收站</span></label>}</fieldset><p>{deleteFiles?'仅回收下面列出的当前文件，其他版本保留。':'文件和版本保留，可从项目回收站恢复节点。'}</p>{plan.files.length>0&&<details open={deleteFiles||unavailable}><summary>涉及文件 · {plan.files.length}</summary><ul className="wtt-delete-files">{plan.files.map(f=><li key={f.path}><code>{f.path}</code><small>{f.role}</small>{f.error&&<p role="alert">{f.error}</p>}{f.references.length>0&&<div className="wtt-recycle-shared">还有 {f.references.length} 张卡片引用此文件<ul>{f.references.map(r=><li key={`${r.requirementId}:${r.nodeId}`}>{r.course} · {r.title}</li>)}</ul></div>}</li>)}</ul></details>}{error&&<UserError error={error}/>}</div><DialogFooter><UiButton variant="quiet" type="button" disabled={busy} onClick={onClose}>取消</UiButton><UiButton variant={deleteFiles?'danger':'primary'} type="submit" className={deleteFiles?'is-danger':''} disabled={busy}>{busy?'正在删除…':deleteFiles?'回收文件并移除节点':'移除节点'}</UiButton></DialogFooter></form></dialog>
}
export function ProjectRecycleDialog({request,endpoint,onClose,onChanged}){
 const dialog=useRef(null),mounted=useRef(false)
 const [entries,setEntries]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(null)
 const [plan,setPlan]=useState(null),[confirmed,setConfirmed]=useState(false),[notice,setNotice]=useState('')
 async function load(){
  const r=await fetch(endpoint({recycleEntries:'1'}),{credentials:'same-origin'}),d=await r.json()
  if(!r.ok)throw new Error(d.error||'回收站读取失败')
  if(mounted.current)setEntries(d.entries)
 }
 useEffect(()=>{mounted.current=true;dialog.current?.showModal();void load().catch(e=>{if(mounted.current)setError(e.message)});return()=>{mounted.current=false}},[])
 useEffect(()=>{if(plan&&!busy)dialog.current?.querySelector('[data-purge-cancel]')?.focus()},[plan,busy])
 function close(){if(busy)return;if(plan){setPlan(null);setConfirmed(false)}else onClose()}
 async function restore(id){setBusy(id);setError('');setNotice('');try{await request('canvas-recycle-restore',{entryId:id});await onChanged();await load()}catch(e){if(mounted.current)setError(e.message)}finally{if(mounted.current)setBusy(null)}}
 async function prepare(entryId){
  setBusy(entryId||'all');setError('');setNotice('');setConfirmed(false)
  try{const next=await request('canvas-recycle-purge-plan',entryId?{entryIds:[entryId]}:{all:true});if(mounted.current)setPlan(next)}
  catch(e){if(mounted.current)setError(e.message)}finally{if(mounted.current)setBusy(null)}
 }
 async function purge(e){
  e.preventDefault();if(!confirmed||!plan||busy)return
  setBusy('purge');setError('')
  try{
   const result=await request('canvas-recycle-purge',{planId:plan.id,confirmation:'永久删除'})
   if(mounted.current){setPlan(null);setConfirmed(false);setNotice(`已永久删除 ${result.entryCount} 项回收记录`)}
   await onChanged();await load()
  }catch(e){if(mounted.current){setPlan(null);setConfirmed(false);setError(e.message)}try{await load()}catch(refreshError){if(mounted.current)setError(e.message+'；列表更新失败：'+refreshError.message)}}
  finally{if(mounted.current)setBusy(null)}
 }
 const available=entries?.filter(e=>['removed','error','purging'].includes(e.state))||[]
 return <dialog className="wtt-recycle-dialog" ref={dialog} aria-labelledby="wtt-recycle-heading" onCancel={e=>{e.preventDefault();close()}}>
  <DialogHeader title={plan?(plan.all?'清空回收站':'永久删除'):'项目回收站'} titleId="wtt-recycle-heading" onClose={close} closeLabel={plan?'关闭删除确认':'关闭项目回收站'} busy={!!busy}/>
  {plan?<form onSubmit={purge}>
   <div className="wtt-recycle-body">
    <p className="wtt-purge-warning" role="note">永久删除后无法恢复。</p>
    <p>{[plan.nodeCount&&`${plan.nodeCount} 个节点`,plan.fileCount&&`${plan.fileCount} 个回收文件`,plan.linkCount&&`${plan.linkCount} 个符号链接`,plan.directoryCount&&`${plan.directoryCount} 个文件夹`].filter(Boolean).join(' · ')}{plan.bytes>0?` · ${(plan.bytes/1024).toFixed(1)} KB`:''}</p>
    <ul className="wtt-purge-scope">{plan.entries.map(entry=><li key={entry.id}>
     <strong>{entry.label||entry.target?.name||entry.nodes.map(n=>n.title).join('、')||'回收记录'}</strong>
     {entry.directoryCount>0&&<small>{entry.directoryCount} 个文件夹的恢复信息</small>}
     <RecycleContents items={[...entry.files.map(f=>({path:f.originalPath,label:f.missing?'原位置 · 回收副本已缺失':'原位置',target:f.path})),...(entry.links||[]).map(l=>({...l,label:'仅清理链接恢复信息，目标保留'}))]}/>
     {!entry.files.length&&!entry.links?.length&&<small>{entry.directoryCount?'清理空目录与关联节点的恢复信息':'仅清理节点恢复记录，原文件保留'}</small>}
    </li>)}</ul>
    <p>只处理以上回收内容；未回收的源文件和其他版本保留。</p>
    <label className="wtt-purge-confirm"><input type="checkbox" checked={confirmed} disabled={!!busy} onChange={e=>setConfirmed(e.target.checked)}/><span>我确认永久删除，无法恢复</span></label>
   </div>
   <DialogFooter><UiButton data-purge-cancel disabled={!!busy} onClick={close}>取消</UiButton><UiButton variant="danger" type="submit" disabled={!confirmed||!!busy}>{busy==='purge'?'正在删除…':'确认永久删除'}</UiButton></DialogFooter>
  </form>:<>
   <div className="wtt-recycle-body">
    {error&&<UserError error={error}/>}{notice&&<p role="status">{notice}</p>}
    {entries===null?<p role="status">正在读取回收站…</p>:entries.length===0?<p>回收站为空</p>:entries.map(entry=><article key={entry.id}>
     <div><strong>{entry.label||entry.target?.name||entry.nodes.map(n=>n.title).join('、')||'回收记录'}</strong><small>{entry.target?[entry.files.length&&`${entry.files.length} 个文件`,entry.directories.length&&`${entry.directories.length} 个文件夹`,entry.links?.length&&`${entry.links.length} 个符号链接`,entry.nodes.length&&`${entry.nodes.length} 张卡片`].filter(Boolean).join(' · '):entry.deleteFiles?`含 ${entry.files.length} 个回收文件`:'仅画布节点'}</small>
      {entry.deleteFiles&&entry.files.length>0&&<details><summary>文件路径</summary><RecycleContents items={entry.files}/></details>}
      {entry.error?<p role="alert">{entry.error}</p>:entry.state==='purging'?<p>删除未完成，可重新核对后继续。</p>:!['removed','error'].includes(entry.state)&&<p role="status">正在处理，请稍后刷新。</p>}
     </div>
     <div className="wtt-recycle-entry-actions">
      <UiButton disabled={!!busy||!['removed','error'].includes(entry.state)} onClick={()=>void restore(entry.id)}>{busy===entry.id?'处理中…':'恢复'}</UiButton>
      <UiButton variant="ghost" disabled={!!busy||!['removed','error','purging'].includes(entry.state)} aria-label={`永久删除：${entry.label||entry.target?.name||entry.nodes.map(n=>n.title).join('、')||'回收记录'}`} onClick={()=>void prepare(entry.id)}>{entry.state==='purging'?'继续删除':'永久删除'}</UiButton>
     </div>
    </article>)}
   </div>
   <DialogFooter>{error&&entries===null&&<UiButton disabled={!!busy} onClick={()=>void load().catch(e=>setError(e.message))}>重新读取</UiButton>}<UiButton variant="danger" disabled={!!busy||!available.length||available.length!==entries?.length} onClick={()=>void prepare()}>{busy==='all'?'正在核对…':'清空回收站'}</UiButton><UiButton disabled={!!busy} onClick={close}>关闭</UiButton></DialogFooter>
  </>}
 </dialog>
}
