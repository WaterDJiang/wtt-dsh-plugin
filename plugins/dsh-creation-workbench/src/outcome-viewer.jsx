import React, { useEffect, useState } from 'react'
import { PanelHeader, PanelToolbar, UiButton } from './ui/controls.jsx'
import { UserError } from './user-feedback.jsx'
import { DocumentViewer } from './document-preview.jsx'

const externalFormats = ['pptx', 'docx', 'pdf', 'csv']
export function OutcomeViewer({ target, endpoint, request, renderNativePreview, onOpenSlides, onEditPpt, onSaved, onClose, onAdd,
  onToggleWidth, widthExpanded, active = true }) {
  const [manifest, setManifest] = useState(null), [selected, setSelected] = useState(''), [sourceBinding, setSource] = useState(null)
  const [error, setError] = useState('')
  const [svgBinding,setSvgBinding]=useState(null),[svgChoice,setSvgChoice]=useState('')
  const identity = JSON.stringify(target)
  const read = async query => {
    const response = await fetch(endpoint(query), { credentials: 'same-origin' })
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '文件读取失败。'); return result
  }
  useEffect(() => {
    let live = true
    setManifest(null); setSource(null); setError('')
    const promise = target.cardId ? read({ outcomes: target.cardId, requirementId: target.requirementId,
      ...(target.versionId ? { cardVersion: target.versionId } : {}), ...(target.sourceRef ? { sourceRef: target.sourceRef } : {}) })
      : Promise.resolve({ files: [{ sourceRef: target.sourceRef || '', name: target.title || target.projectPath,
        hash: target.hash }], selectedRef: target.sourceRef || '' })
    promise.then(result => { if (live) { setManifest(result); setSelected(result.selectedRef || '') } }).catch(cause => { if (live) setError(cause.message) })
    return () => { live = false }
  }, [identity])
  const file = manifest?.files.find(item => item.sourceRef === selected)
  const selectionKey = `${identity}:${selected}:${file?.hash || ''}`
  const source = sourceBinding?.key === selectionKey ? sourceBinding.value : null
  useEffect(() => {
    if (!file) return
    let live = true
    setSource(null); setError('')
    read({ nativePreview: selected, requirementId: target.requirementId,
      ...(file.hash ? { hash: file.hash } : {}), ...(target.projectPath ? { projectPath: target.projectPath } : {}) })
      .then(value => { if (live) setSource({ key: selectionKey, value }) }).catch(cause => { if (live) setError(cause.message) })
    return () => { live = false }
  }, [selectionKey, Boolean(file)])
  // Text/HTML retain relative-asset paths; refuse a changed archived source.
  useEffect(() => {
    if (!source || !active) return
    const textLike = ['md', 'markdown', 'txt', 'csv', 'json', 'jsonl', 'yaml', 'yml', 'html', 'css', 'js', 'mjs', 'py', 'xml', 'log'].includes(source.format)
    if (target.projectPath ? !textLike : !['html', 'htm', 'md', 'markdown'].includes(source.format)) return
    let live = true
    const timer = setInterval(() => { void read({ nativePreview: selected, requirementId: target.requirementId, ...(target.projectPath ? { projectPath: target.projectPath } : { hash: source.hash }) })
      .catch(cause => { if (live) setError(cause.message) }) }, 4000)
    return () => { live = false; clearInterval(timer) }
  }, [source?.path, source?.hash, active, target.projectPath])
  const editScope = source?.format==='pptx' && file?.artifactId && manifest?.cardId ? {requirementId:target.requirementId,cardId:manifest.cardId,versionId:manifest.versionId,artifactId:file.artifactId,hash:source.hash,outcome:true} : null
  const svg=svgBinding?.key===selectionKey?svgBinding.value:null
  useEffect(()=>{
    if(!editScope)return
    let live=true;setSvgBinding(null);setSvgChoice('')
    request('ppt-svg-discover',editScope).then(value=>{if(live){setSvgBinding({key:selectionKey,value});if(value.candidates?.length===1)setSvgChoice(value.candidates[0].id)}})
      .catch(cause=>{if(live)setSvgBinding({key:selectionKey,value:{status:'error',message:cause.message,candidates:[]}})})
    return ()=>{live=false}
  },[selectionKey,source?.format])
  const canModify = source && manifest?.cardId && externalFormats.includes(source.format)
  const downloadHref = file?.artifactId ? endpoint({ downloadArtifact: file.artifactId }).href
    : source ? endpoint({ projectFileDownload: source.originalPath, hash: source.hash }).href : undefined
  const otherWebProject = source?.format === 'pptx' && manifest?.slideProject?.artifactId !== file?.artifactId
  const choices = disabled => <>
    {manifest?.files.length > 1 && <div className="wtt-outcome-picker"><select aria-label="选择成果文件" value={selected} disabled={disabled} onChange={e=>setSelected(e.target.value)}>
      {manifest.files.map(item=><option key={item.sourceRef} value={item.sourceRef}>{item.format?.toUpperCase()} · {item.name}{item.role==='attachment'?' · 附件':''}</option>)}
    </select></div>}
    {editScope && <UiButton variant="quiet" disabled={disabled||!svg||(svg.candidates?.length>0?!svgChoice:!manifest?.slideProject||otherWebProject)}
      title={!svg?'正在查找匹配源文件':svg.status==='error'?`源文件查找失败：${svg.message}`:!svg.candidates?.length&&(!manifest?.slideProject||otherWebProject)?'没有匹配的源文件，请使用“打开 PPT”':undefined}
      onClick={()=>{
        if(svg?.candidates?.length&&svgChoice)onEditPpt?.({...editScope,svgCandidateId:svgChoice,title:source.name})
        else if(manifest?.slideProject&&!otherWebProject)onOpenSlides?.(manifest)
      }}>编辑源文件</UiButton>}
    {editScope && svg?.candidates?.length>1 && <select aria-label="选择SVG源工程" value={svgChoice} disabled={disabled} onChange={e=>setSvgChoice(e.target.value)}><option value="">选择源工程…</option>{svg.candidates.map(c=><option key={c.id} value={c.id}>{c.path}</option>)}</select>}
    {!editScope&&manifest?.slideProject&&<UiButton variant="quiet" disabled={disabled} onClick={()=>onOpenSlides?.(manifest)}>编辑源文件</UiButton>}


  </>
  if (canModify) return <DocumentViewer key={selectionKey} sourceRef={selected} hash={source.hash} title={source.name} endpoint={endpoint}
    requirementId={target.requirementId} cardId={manifest.cardId} versionId={manifest.versionId} outcome active={active}
    fileActions={choices} outcomeRole={file.role} renderNativePreview={renderNativePreview} downloadHref={downloadHref} onClose={onClose} onSaved={onSaved}
    onToggleWidth={onToggleWidth} widthExpanded={widthExpanded} />
  return <aside className="wtt-outcome-viewer nodrag nopan nowheel" aria-label="成果文件预览" onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
    <PanelHeader title={file?.name || target.title || '成果文件'} format={source?.format?.toUpperCase()} downloadHref={downloadHref}
      expanded={widthExpanded} onToggleWidth={onToggleWidth} onClose={onClose} closeLabel="关闭成果预览" />
    <PanelToolbar>{choices(false)}
      {onAdd && source && <UiButton variant="quiet" onClick={() => onAdd({ path: target.projectPath, name: source.name, hash: source.hash, directory: false })}>添加到画布</UiButton>}
    </PanelToolbar>
    {file?.role === 'attachment' && <div className="wtt-outcome-status" role="status">附件 · 未作为正式版本归档</div>}
    <div className="wtt-outcome-viewer-body">{error ? <UserError error={error} /> : source
      ? source.format === 'mp4' || source.format === 'webm' ? <video src={downloadHref} controls playsInline aria-label={source.name} />
        : renderNativePreview?.(source) || <UserError error="DSH 原生文件预览尚未连接。" />
      : <p role="status">正在读取成果文件…</p>}</div>
  </aside>
}
