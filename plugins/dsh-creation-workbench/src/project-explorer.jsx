import { PanelHeader, PanelToolbar, UiButton, UiIcon } from './ui/controls.jsx'
import React,{useEffect,useRef,useState} from 'react'
import {UserError} from './user-feedback.jsx'
import {DeleteProjectFilesDialog} from './canvas-recycle.jsx'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from '@tiptap/markdown'
import './project-explorer.css'
export const PROJECT_FILE_DRAG='application/x-wtt-project-file'
function MarkdownView({content}){
 const editor=useEditor({editable:false,extensions:[StarterKit,TableKit,Markdown.configure({html:false})],content,contentType:'markdown'})
 return <EditorContent editor={editor} className="wtt-file-md tiptap"/>
}
export function ProjectExplorer({project,request,active,onClose,onChooseProject,onOpenProject,onPreview,onAdd,canAdd,onRecycle,refreshSignal,onChanged}){
 const [tree,setTree]=useState({}),[expanded,setExpanded]=useState(new Set([''])),[selected,setSelected]=useState(null),[error,setError]=useState(''),[creating,setCreating]=useState(null),[name,setName]=useState(''),[busy,setBusy]=useState(false),[width,setWidth]=useState(()=>{try{return Math.max(200,Math.min(480,Number(localStorage.getItem('wtt-explorer-width'))||260))}catch{return 260}})
 const [deletePlan,setDeletePlan]=useState(null)
 const [context,setContext]=useState(null);const contextRef=useRef(null)
 const mounted=useRef(false),epochs=useRef(new Map()),drag=useRef(null),creatingBusy=useRef(false)
 async function load(path=''){
  const token=Symbol();epochs.current.set(path,token)
  try{const url=new URL('api/wtt-creation-workbench',document.baseURI);url.searchParams.set('projectId',project.id);url.searchParams.set('projectFiles',path);const res=await fetch(url,{credentials:'same-origin'}),data=await res.json();if(!res.ok)throw new Error(data.error||'文件夹读取失败');if(mounted.current&&epochs.current.get(path)===token)setTree(t=>({...t,[path]:data}))}
  catch(e){if(mounted.current&&epochs.current.get(path)===token){
   // 外部删除（Finder）后剪除失效分支：目录已不存在就不再显示，也不把枝叶错误顶到全局
   if(path){setTree(t=>{if(!(path in t))return t;const next={...t};delete next[path];return next});setExpanded(prev=>{if(!prev.has(path))return prev;const next=new Set(prev);next.delete(path);return next})}
   else setError(e.message)
  }}
 }
 async function refresh(){setError('');await Promise.all([...expanded].map(p=>load(p)))}
 useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;epochs.current.clear()}},[])
 useEffect(()=>{if(!active)return;const focus=()=>void refresh();window.addEventListener('focus',focus);return()=>window.removeEventListener('focus',focus)},[active,expanded])
 useEffect(()=>{if(mounted.current&&refreshSignal)void refresh()},[refreshSignal])
 useEffect(()=>{if(!context)return;const close=e=>{if(!contextRef.current?.contains(e.target))setContext(null)},key=e=>{if(e.key==='Escape')setContext(null)};document.addEventListener('pointerdown',close);document.addEventListener('keydown',key);contextRef.current?.querySelector('button')?.focus();return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',key)}},[context])
 function select(entry){setSelected(entry);setError('');setContext(null);if(!entry.directory&&!entry.symbolicLink&&window.innerWidth>700)onPreview(entry)}
 function expand(entry,open=!expanded.has(entry.path)){if(!open&&creating&&(creating.parent===entry.path||creating.parent.startsWith(entry.path+'/'))){if(creatingBusy.current)return;setCreating(null);setError('')}setExpanded(prev=>{const next=new Set(prev);open?next.add(entry.path):next.delete(entry.path);return next});if(open&&!tree[entry.path])void load(entry.path)}
 function showContext(e,entry){e.preventDefault();if(busy)return;setSelected(entry);setError('');const rect=e.currentTarget.getBoundingClientRect();setContext({entry,x:Math.max(4,Math.min(window.innerWidth-216,e.clientX||rect.left)),y:Math.max(4,Math.min(window.innerHeight-180,e.clientY||rect.bottom))})}
 async function prepareDelete(entry){
  if(!entry?.path||busy||creating)return
  setContext(null);setError('');setBusy(true)
  try{const plan=await request('project-file-delete-plan',{path:entry.path});if(mounted.current)setDeletePlan(plan)}catch(e){if(mounted.current)setError(e.message)}finally{if(mounted.current)setBusy(false)}
 }
 async function deleted(plan){
  await onChanged?.(plan);if(!mounted.current)return
  setDeletePlan(null);setSelected(null)
  const outside=new Set([...expanded].filter(p=>p!==plan.target.path&&!p.startsWith(plan.target.path+'/')));setExpanded(outside)
  await Promise.all([...outside].map(p=>load(p)))
 }
 function start(kind,entry=selected){
  if(creatingBusy.current)return
  const parent=entry?.directory?entry.path:entry?.path.includes('/')?entry.path.slice(0,entry.path.lastIndexOf('/')):''
  setCreating({kind,parent});setName('');setError('');setContext(null)
  setExpanded(s=>new Set([...s,parent]));if(!tree[parent])void load(parent)
 }
 function cancelCreate(){if(creatingBusy.current)return;setCreating(null);setError('')}
 async function create(e){
  e.preventDefault();if(creatingBusy.current||!name.trim())return
  creatingBusy.current=true;setBusy(true);setError('')
  try{
   const result=await request('project-file-create',{...creating,kind:creating.kind==='project'?'folder':creating.kind,name})
   if(!mounted.current)return
   await load(creating.parent);setSelected(result);setCreating(null)
   if(creating.kind==='project')await onOpenProject(`${project.path}/${result.path}`)
  }catch(e){if(mounted.current)setError(e.message)}finally{creatingBusy.current=false;if(mounted.current)setBusy(false)}
 }
 function creationRow(parent,level){
  if(!creating||creating.parent!==parent)return null
  const label=creating.kind==='file'?'文件名':creating.kind==='project'?'项目文件夹名':'文件夹名'
  return <form className="wtt-file-inline-create" onSubmit={create} style={{paddingLeft:10+(level-1)*16}} aria-label={`新建${creating.kind==='file'?'文件':'文件夹'}`} title={`新建位置：${project.name}${parent?'/'+parent:''}`} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancelCreate()}else if(e.key==='Enter'&&e.nativeEvent.isComposing)e.preventDefault()}}>
   <span className="wtt-file-chevron"/><span className={creating.kind==='file'?'wtt-file-icon':'wtt-file-folder'} aria-hidden="true">{creating.kind==='file'?'▤':'▰'}</span>
   <input autoFocus aria-label={label} title={`新建位置：${project.name}${parent?'/'+parent:''}`} required maxLength={180} disabled={busy} value={name} onChange={e=>setName(e.target.value)} placeholder={creating.kind==='file'?'文件名（含后缀）':label}/>
   <UiButton variant="ghost" size="compact" type="submit" title="创建（Enter）" aria-label="确认创建" disabled={busy||!name.trim()}><UiIcon name="check"/></UiButton><UiButton variant="ghost" size="compact" type="button" title="取消（Esc）" aria-label="取消创建" disabled={busy} onClick={cancelCreate}><UiIcon name="close"/></UiButton>
  </form>
 }
 function rows(parent='',level=1){const data=tree[parent];return <div role="group">{creationRow(parent,level)}{!data?<p role="status">读取中…</p>:<>{data.entries.map(entry=><div key={entry.path} role="treeitem" aria-label={entry.name} aria-level={level} aria-selected={selected?.path===entry.path} aria-expanded={entry.directory?expanded.has(entry.path):undefined}>
  <div className={`wtt-file-row${selected?.path===entry.path?' is-selected':''}`} style={{paddingLeft:10+(level-1)*16}} onContextMenu={e=>showContext(e,entry)}>
   {entry.directory?<UiButton variant="custom" type="button" className="wtt-file-toggle" aria-label={`${expanded.has(entry.path)?'收起':'展开'} ${entry.name}`} onClick={()=>expand(entry)}>{expanded.has(entry.path)?'⌄':'›'}</UiButton>:<span className="wtt-file-chevron"/>}
   <UiButton variant="custom" type="button" className="wtt-file-name" title={entry.directory?entry.path:`${entry.path} · 单击预览内容，拖入画布可创建卡片`} draggable={!entry.directory&&!entry.symbolicLink} onDragStart={e=>{e.dataTransfer.effectAllowed='copy';e.dataTransfer.setData(PROJECT_FILE_DRAG,JSON.stringify({projectId:project.id,path:entry.path}))}} onClick={()=>select(entry)} onKeyDown={e=>{if(['Delete','Backspace'].includes(e.key)&&!e.nativeEvent.isComposing){e.preventDefault();e.stopPropagation();void prepareDelete(entry);return}if(e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10')){e.preventDefault();showContext(e,entry);return}if(entry.directory&&['ArrowRight','ArrowLeft'].includes(e.key)){e.preventDefault();expand(entry,e.key==='ArrowRight')}}}>
    <span className={entry.directory?'wtt-file-folder':'wtt-file-icon'} aria-hidden="true">{entry.directory?'▰':entry.symbolicLink?'↗':'▤'}</span><span>{entry.name}</span>
   </UiButton>
  </div>{entry.directory&&expanded.has(entry.path)&&rows(entry.path,level+1)}</div>)}{!data.entries.length&&creating?.parent!==parent&&<p className="wtt-file-empty">空文件夹</p>}{data.truncated&&<p role="status">仅显示前1000项</p>}</>}</div>}
 return <aside className="wtt-project-explorer" aria-label="项目文件" style={{width}}>
  <header><strong>文件</strong><UiButton variant="ghost" size="compact" type="button" title="新建文件" aria-label="新建文件" disabled={busy} onClick={()=>start('file')}><UiIcon name="file"/></UiButton><UiButton variant="ghost" size="compact" type="button" title="新建文件夹" aria-label="新建文件夹" disabled={busy} onClick={()=>start('folder')}><UiIcon name="folder"/></UiButton><UiButton variant="ghost" size="compact" type="button" title="刷新文件树" aria-label="刷新文件树" onClick={()=>void refresh()}><UiIcon name="refresh"/></UiButton><UiButton variant="ghost" size="compact" type="button" title="收起文件栏" aria-label="收起文件栏" onClick={onClose}><UiIcon name="close"/></UiButton></header>
  <div className="wtt-file-project"><UiButton variant="custom" type="button" className="wtt-file-root" title={project.path} aria-label="选择项目根目录" onClick={()=>select({name:project.name,path:'',directory:true})} onContextMenu={e=>showContext(e,{name:project.name,path:'',directory:true})}>{project.name}</UiButton><UiButton variant="quiet" type="button" onClick={onChooseProject}>打开…</UiButton><UiButton variant="quiet" type="button" aria-label="新建项目" title="新建项目" disabled={busy} onClick={()=>start('project',{path:'',directory:true})}>＋</UiButton></div>
  {context&&<div className="wtt-file-context" ref={contextRef} role="menu" aria-label={context.entry.directory?'文件夹操作':'文件操作'} style={{left:context.x,top:context.y}}><UiButton variant="custom" type="button" role="menuitem" onClick={()=>start('file',context.entry)}>在此新建文件</UiButton><UiButton variant="custom" type="button" role="menuitem" onClick={()=>start('folder',context.entry)}>在此新建文件夹</UiButton>{context.entry.path&&<UiButton variant="custom" type="button" role="menuitem" disabled={busy||!!creating} onClick={()=>void prepareDelete(context.entry)}>删除…</UiButton>}</div>}
  {error&&<UserError error={error}/>}

  <div className="wtt-file-tree" onContextMenu={e=>{if(e.target===e.currentTarget)showContext(e,{name:project.name,path:'',directory:true})}} role="tree" aria-label={`${project.name} 文件树`}>{rows()}</div>
  {selected&&<footer><span title={selected.path}>{selected.name}</span>{selected.directory?<UiButton variant="quiet" type="button" onClick={()=>onOpenProject(`${project.path}/${selected.path}`).catch(e=>setError(e.message))}>打开为项目</UiButton>:<UiButton variant="quiet" type="button" disabled={!canAdd||selected.symbolicLink} title={selected.symbolicLink?'链接仅支持管理，不读取目标':!canAdd?'先创建课程需求':undefined} onClick={()=>onAdd(selected)}>添加到画布</UiButton>}{!selected.directory&&!selected.symbolicLink&&<UiButton className="wtt-file-mobile-preview" type="button" onClick={()=>onPreview(selected)}>预览</UiButton>}<UiButton variant="ghost" iconOnly type="button" aria-label="所选项操作" title="所选项操作" disabled={busy} onClick={e=>showContext(e,selected)}><UiIcon name="more"/></UiButton></footer>}
  {onRecycle&&<div className="wtt-file-recycle"><UiButton variant="quiet" type="button" onClick={onRecycle}>项目回收站</UiButton></div>}
  {deletePlan&&<DeleteProjectFilesDialog plan={deletePlan} request={request} onClose={()=>setDeletePlan(null)} onDone={deleted}/>}
  <div className="wtt-file-resize" role="separator" tabIndex={0} aria-label="调整文件栏宽度" aria-orientation="vertical" aria-valuemin={200} aria-valuemax={480} aria-valuenow={width} onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);drag.current={x:e.clientX,width}}} onPointerMove={e=>{if(drag.current)setWidth(Math.max(200,Math.min(480,drag.current.width+e.clientX-drag.current.x)))}} onPointerUp={e=>{drag.current=null;try{localStorage.setItem('wtt-explorer-width',String(width))}catch{}if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId)}} onPointerCancel={()=>{drag.current=null}} onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const next=e.key==='Home'?200:e.key==='End'?480:Math.max(200,Math.min(480,width+(e.key==='ArrowRight'?20:-20)));setWidth(next);try{localStorage.setItem('wtt-explorer-width',String(next))}catch{}}}/>
 </aside>
}
export function ProjectFilePreview({selection,endpoint,onClose,onAdd,onToggleWidth,widthExpanded}){
 const [localExpanded,setLocalExpanded]=useState(false)
 const expanded=onToggleWidth?widthExpanded:localExpanded
 const [data,setData]=useState(null),[error,setError]=useState(''),[pages,setPages]=useState(null),[page,setPage]=useState(1),[pageError,setPageError]=useState('')
 const [refreshTick,setRefreshTick]=useState(0),[externalNotice,setExternalNotice]=useState(''),[statInfo,setStatInfo]=useState(null)
 const [textView,setTextView]=useState(null),[textPageNo,setTextPageNo]=useState(1),[textError,setTextError]=useState(''),[wrap,setWrap]=useState(false)
 useEffect(()=>{let live=true;setData(null);setError('');setExternalNotice('');setStatInfo(null);setTextView(null);setTextError('');setPageNo(1);fetch(endpoint({projectFilePreview:selection.path}),{credentials:'same-origin'}).then(async res=>{const d=await res.json();if(!res.ok)throw new Error(d.error||'文件预览失败');if(live){setData(d);setStatInfo({mtimeMs:d.mtimeMs,size:d.size})}}).catch(e=>{if(live)setError(e.message)});return()=>{live=false}},[selection.path,selection.token,refreshTick])
 useEffect(()=>{let live=true;setPages(null);setPage(1);setPageError('');if(data&&!data.empty&&['pdf','docx','pptx'].includes(data.format))fetch(endpoint({projectFilePages:selection.path,hash:data.hash}),{credentials:'same-origin'}).then(async res=>{const d=await res.json();if(!res.ok)throw new Error(d.error||'分页预览失败');if(live)setPages(d)}).catch(e=>{if(live)setPageError(e.message)});return()=>{live=false}},[data?.hash,selection.path])
 const isMarkdown=data?.format==='md'||data?.format==='markdown'
 const bigMarkdown=isMarkdown&&data?.content&&data.content.length>150000
 const isText=(data?.mime==='text/plain'&&data.content!==undefined&&!data.empty&&!isMarkdown)||Boolean(bigMarkdown)
 useEffect(()=>{setPageNo(1);setTextView(null)},[selection.path,data?.hash,refreshTick])
 useEffect(()=>{if(!isText)return;let live=true;setTextError('');fetch(endpoint({projectFileText:selection.path,page:String(textPageNo)}),{credentials:'same-origin'}).then(async res=>{const d=await res.json();if(!res.ok)throw new Error(d.error||'文本分页读取失败');if(live)setTextView(d)}).catch(e=>{if(live)setTextError(e.message)});return()=>{live=false}},[isText,textPageNo,selection.path,data?.hash,refreshTick])
 useEffect(()=>{if(!statInfo)return;let live=true;const timer=setInterval(async()=>{try{const res=await fetch(endpoint({projectFileStat:selection.path}),{credentials:'same-origin'});const d=await res.json();if(!live)return;if(!res.ok){setStatInfo(null);setExternalNotice(d.error||'文件已被删除或不可访问，预览已停止自动刷新。');return}if(d.mtimeMs!==statInfo.mtimeMs||d.size!==statInfo.size){setStatInfo({mtimeMs:d.mtimeMs,size:d.size});setExternalNotice('文件已被外部修改，预览已刷新。');setRefreshTick(t=>t+1)}}catch{if(live){setStatInfo(null);setExternalNotice('文件已被删除或不可访问，预览已停止自动刷新。')}}},5000);return()=>{live=false;clearInterval(timer)}},[selection.path,statInfo])
 const href=data?endpoint({projectFileDownload:data.path,hash:data.hash}).href:null,preview=data?endpoint({projectFileDownload:data.path,hash:data.hash,preview:'1'}).href:null
 const textViewBar=<div className="wtt-file-textbar"><span className="wtt-file-textbar-info" role="status">{textView?`${textView.startLine}–${textView.startLine+textView.lines.length-1} 行 · 共 ${textView.lineCount} 行`:'正在读取文本…'}</span><UiButton variant="custom" type="button" size="compact" aria-pressed={wrap} title="切换自动换行" onClick={()=>setWrap(v=>!v)}>自动换行</UiButton><nav aria-label="文本页码" className="wtt-file-textnav"><UiButton variant="custom" type="button" size="compact" disabled={!textView||textView.page<=1} onClick={()=>setTextPageNo(textView.page-1)}>上一页</UiButton><span>{textView?`${textView.page} / ${textView.pageCount}`:''}</span><UiButton variant="custom" type="button" size="compact" disabled={!textView||textView.page>=textView.pageCount} onClick={()=>setTextPageNo(textView.page+1)}>下一页</UiButton></nav></div>
 const textViewBody=textError?<UserError error={textError}/>:!textView?<p role="status">正在读取文本…</p>:<div className={`wtt-file-textview${wrap?' is-wrap':''}`} role="document">{textView.lines.map((line,i)=><div key={i} className="wtt-file-line"><span className="wtt-file-line-no" aria-hidden="true">{textView.startLine+i}</span><span className="wtt-file-line-text">{line||'​'}</span></div>)}</div>
 return <aside className="wtt-project-file-preview" data-expanded={expanded||undefined} aria-label="项目文件预览"><PanelHeader title={selection.name} subtitle={selection.path} format={data?.format?.toUpperCase()} downloadHref={href} expanded={expanded} onToggleWidth={onToggleWidth||(()=>setLocalExpanded(v=>!v))} onClose={onClose} closeLabel="关闭文件预览"/><PanelToolbar><UiButton disabled={!data||data.empty||Boolean(data.error)||!onAdd} onClick={()=>onAdd({...selection,hash:data.hash})}>添加到画布</UiButton></PanelToolbar>{error&&<UserError error={error}/>}{externalNotice&&<div className="wtt-file-notice" role="status">{externalNotice}</div>}<div className="wtt-file-preview-body">{!data&&!error?<p role="status">正在预览…</p>:data?.empty?<p>空文件</p>:data?.mime.startsWith('image/')&&data.media?.validated?<img src={preview} alt={selection.name}/>:data?.mime.startsWith('video/')&&data.media?.validated?<video src={preview} controls playsInline preload="metadata"/>:data&&['pdf','docx','pptx'].includes(data.format)?<>{pages?<><nav aria-label="文件页码"><UiButton variant="custom" type="button" disabled={page<=1} onClick={()=>setPage(page-1)}>上一页</UiButton><span>{page} / {pages.pageCount}</span><UiButton variant="custom" type="button" disabled={page>=pages.pageCount} onClick={()=>setPage(page+1)}>下一页</UiButton></nav><img src={endpoint({projectFilePage:selection.path,hash:data.hash,page:String(page)}).href} alt={`${selection.name} 第${page}页`}/></>:pageError?<UserError error={pageError}/>:<p role="status">正在准备实际分页…</p>}</>:isMarkdown&&data?.content&&!bigMarkdown?<div className="wtt-file-md" key={data.hash}><MarkdownView content={data.content}/></div>:isText?<> {textViewBar}{textViewBody}</>:data?.content?<><small>{['docx','pptx'].includes(data.format)?'正文预览':''}</small><pre>{data.content}</pre>{data.truncated&&<p>正文已截取，下载查看完整文件。</p>}</>:data&&<p>{data.error||data.extractionError||'此格式暂无预览，可下载查看。'}</p>}</div></aside>
}
