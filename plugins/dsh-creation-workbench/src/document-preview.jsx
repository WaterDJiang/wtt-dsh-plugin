import { PanelHeader, PanelToolbar, UiButton } from './ui/controls.jsx'
import React, { useEffect, useRef, useState } from 'react'
import { UserError } from './user-feedback.jsx'
import './document-editor.css'

export function DocumentViewer({sourceRef,hash,title,endpoint,requirementId,cardId,versionId,onClose,onSaved,onToggleWidth,widthExpanded,active=true,downloadHref,outcome=false,outcomeRole,fileActions,renderNativePreview}){
  const [data,setData]=useState(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(''),[menu,setMenu]=useState(false)
  const [manifest,setManifest]=useState(null),[page,setPage]=useState(1),[previewBusy,setPreviewBusy]=useState(false),[previewError,setPreviewError]=useState(''),[retry,setRetry]=useState(0)
  const mounted=useRef(true),current=useRef(null),polling=useRef(null),previewRequest=useRef(0),actions=useRef(null),attempt=useRef(null),chosenApp=useRef('default')
  const send=async(action,input)=>{
    const response=await fetch(endpoint({}),{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,data:input})})
    const result=await response.json();if(!response.ok||result.ok===false)throw new Error(result.error?.message||result.error||'文档操作失败');return result
  }
  const accept=result=>{current.current=result;if(mounted.current){setData(result);setError('')}}
  function refresh(){
    if(polling.current)return polling.current
    if(!current.current)return Promise.resolve()
    const pending=send('document-external-status',{draftId:current.current.id}).then(result=>{if(mounted.current)accept(result);return result}).catch(cause=>{if(mounted.current)setError(cause.message);throw cause}).finally(()=>{if(polling.current===pending)polling.current=null})
    polling.current=pending;return pending
  }
  useEffect(()=>{
    mounted.current=true
    send('document-external-open',{sourceRef,hash,requirementId,cardId,versionId,...(outcome?{outcome:true}:{})}).then(result=>{if(mounted.current)accept(result)}).catch(cause=>{if(mounted.current)setError(cause.message)})
    return()=>{mounted.current=false;previewRequest.current++}
  },[])
  useEffect(()=>{
    if(!active||!data?.workingFile)return
    const timer=setInterval(()=>{if(!document.hidden)void refresh().catch(()=>{})},1500)
    const focus=()=>void refresh().catch(()=>{});window.addEventListener('focus',focus)
    return()=>{clearInterval(timer);window.removeEventListener('focus',focus)}
  },[active,data?.workingFile])
  useEffect(()=>{
    if(!menu)return
    const close=event=>{if(!actions.current?.contains(event.target))setMenu(false)},key=event=>{if(event.key==='Escape')setMenu(false)}
    document.addEventListener('pointerdown',close);document.addEventListener('keydown',key)
    return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',key)}
  },[menu])
  useEffect(()=>{
    if(!data||data.format==='csv'||renderNativePreview)return
    const token=++previewRequest.current,revision=data.revision;let cancelled=false
    setPreviewBusy(true);setPreviewError('')
    send('document-preview',{draftId:data.id,revision}).then(result=>{
      if(cancelled||!mounted.current||token!==previewRequest.current)return
      const nextPage=Math.min(page,result.pageCount),image=new Image()
      image.onload=()=>{if(!cancelled&&mounted.current&&token===previewRequest.current){setManifest(result);setPage(nextPage);setPreviewBusy(false)}}
      image.onerror=()=>{if(!cancelled&&mounted.current){setPreviewError('预览图片未能读取，请点“重新预览”。');setPreviewBusy(false)}}
      image.src=endpoint({documentDraftPage:data.id,revision:String(revision),page:String(nextPage)}).href
    }).catch(cause=>{if(!cancelled&&mounted.current){setPreviewError(cause.message);setPreviewBusy(false)}})
    return()=>{cancelled=true;previewRequest.current++}
  },[data?.id,data?.revision,retry])
  async function open(application=chosenApp.current,restart=false){
    setBusy('open');setError('');setMenu(false)
    try{
      const result=await send('document-open-application',{draftId:current.current.id,application,restart});chosenApp.current=application
      if(!mounted.current)return;setNotice(result.message)
      await polling.current?.catch(()=>{});await refresh()
    }catch(cause){if(mounted.current)setError(cause.message)}finally{if(mounted.current)setBusy('')}
  }
  async function reveal(){
    setMenu(false);setBusy('folder');setError('')
    try{await send('document-reveal-file',{draftId:current.current.id})}catch(cause){if(mounted.current)setError(cause.message)}finally{if(mounted.current)setBusy('')}
  }
  async function save(){
    setBusy('save');setError('');setMenu(false);let published=false
    try{
      const selected=current.current,signature=`${selected.id}:${selected.revision}:${selected.hash}`
      if(attempt.current?.signature!==signature)attempt.current={signature,id:crypto.randomUUID()}
      const result=await send('document-external-save-version',{draftId:selected.id,revision:selected.revision,hash:selected.hash,operationId:attempt.current.id})
      published=true;if(mounted.current)setNotice('新版本已保存，原文件保留。');await onSaved?.(result)
    }catch(cause){if(mounted.current){setError(published?`新版本已保存，页面未刷新：${cause.message}。请重新打开卡片。`:cause.message);if(!published)void refresh().catch(()=>{})}}finally{if(mounted.current)setBusy('')}
  }
  const status=!data?'正在准备预览…':data.state==='writing'?'本机应用正在保存…':data.state==='invalid'?'工作副本未能更新':previewBusy?'正在更新预览…':data.dirty?'工作稿已更新 · 尚未归档':data.workingFile?'工作副本就绪 · 尚未检测到新修改':outcomeRole==='attachment'?'附件 · 原文件保留':'当前正式版本'
  const canSave=data?.dirty&&!busy&&!error&&!['writing','invalid'].includes(data.state)&&(Boolean(renderNativePreview)||data.format==='csv'||(!previewBusy&&manifest?.revision===data.revision))
  const fileHref=data?endpoint({documentDownload:data.id,revision:String(data.revision)}).href:downloadHref
  return <aside className="wtt-document-viewer wtt-document-external nodrag nopan nowheel" aria-label="文档预览" onPointerDown={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()}>
    <PanelHeader title={title} format={data?.format.toUpperCase() || '文档'} downloadHref={fileHref} downloadLabel={data?.workingFile?'下载当前工作副本':'下载当前版本'} expanded={widthExpanded} onToggleWidth={onToggleWidth} onClose={onClose} closeLabel="关闭文档预览" />
    <PanelToolbar>
      {fileActions?.(Boolean(busy))}
      <div className="wtt-document-open" ref={actions}><div className="wtt-document-open-split"><UiButton variant="quiet" type="button" disabled={!data||!!busy||!data.nativeAvailable} onClick={()=>void open()}>{busy==='open'?'正在打开…':data?.format==='pptx'?'打开 PPT':'用本机应用编辑'}</UiButton><UiButton variant="quiet" type="button" aria-label="选择打开方式" aria-expanded={menu} disabled={!data||!!busy||!data.nativeAvailable} onClick={()=>setMenu(!menu)}>⌄</UiButton></div>
      {menu&&<div className="wtt-document-open-menu" role="menu" aria-label="打开方式">{data.applications.map(app=><UiButton variant="custom" type="button" role="menuitem" key={app.id} onClick={()=>void open(app.id)}>{app.name}</UiButton>)}<hr/><UiButton variant="custom" type="button" role="menuitem" onClick={()=>void reveal()}>{data.workingFile?'打开工作稿文件夹':'打开所在文件夹'}</UiButton><a role="menuitem" href={fileHref} download onClick={()=>setMenu(false)}>下载预览文件</a>{data.state==='invalid'&&<UiButton variant="custom" type="button" role="menuitem" onClick={()=>void open('default',true)}>从当前预览另建副本</UiButton>}</div>}
      </div>    </PanelToolbar>
    <div className="wtt-document-status"><span role="status">{status}</span><UiButton variant="quiet" type="button" aria-label="检查文件更新" disabled={!data||!!busy} onClick={()=>void refresh().catch(()=>{})}>↻</UiButton>{data?.dirty&&<UiButton variant="quiet" type="button" disabled={!canSave} onClick={()=>void save()}>{busy==='save'?'保存中…':outcome&&!versionId?'保存为正式版本':'保存新版本'}</UiButton>}</div>
    {(error||data?.error)&&<UserError error={error||data.error}/>}{notice&&<p className="wtt-document-notice" role="status">{notice}<UiButton variant="ghost" size="compact" type="button" aria-label="关闭打开提示" onClick={()=>setNotice('')}>×</UiButton></p>}
    <div className="wtt-document-preview-body">
      {data&&renderNativePreview ? renderNativePreview(data.previewSource) : data?.format==='csv'?<><small>{data.rows.length} 行 × {data.rows[0]?.length||0} 列</small><div className="wtt-document-csv-readonly"><table aria-label="CSV 只读预览"><tbody>{data.rows.map((row,r)=><tr key={r}><th>{r+1}</th>{row.map((cell,c)=><td key={c}>{cell}</td>)}</tr>)}</tbody></table></div></>:data&&<>
        {previewError&&<div><UserError error={previewError}/><UiButton variant="quiet" type="button" onClick={()=>setRetry(n=>n+1)}>重新预览</UiButton></div>}
        {manifest?<><nav aria-label="文档页码"><UiButton variant="custom" type="button" disabled={page<=1} onClick={()=>setPage(page-1)}>上一页</UiButton><span>第 {page} / {manifest.pageCount} 页</span><UiButton variant="custom" type="button" disabled={page>=manifest.pageCount} onClick={()=>setPage(page+1)}>下一页</UiButton></nav><img className="wtt-document-preview-image" src={endpoint({documentDraftPage:data.id,revision:String(manifest.revision),page:String(page)}).href} alt={`${title} · 第${page}页实际预览`}/></>:!previewError&&<p role="status">正在准备实际分页…</p>}
      </>}
    </div>
    {data&&<footer className="wtt-document-file"><span title={data.workingFile||data.fileName}>{data.fileName}{data.dirty?' · 工作稿':''}</span>{data.workingFile&&<UiButton variant="quiet" type="button" onClick={()=>void reveal()}>文件位置</UiButton>}</footer>}
  </aside>
}
