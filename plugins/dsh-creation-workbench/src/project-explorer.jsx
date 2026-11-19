import { PanelHeader, PanelToolbar, UiButton, UiIcon } from './ui/controls.jsx'
import React,{useCallback,useEffect,useId,useLayoutEffect,useMemo,useRef,useState} from 'react'
import {CanvasPopover} from './ui/canvas-popover.jsx'
import {projectFileParent,useProjectFileNavigation} from './project-file-navigation.jsx'
import {FileConflictDialog,FileOrganizeNotice,useFileOrganizer} from './project-file-organize.jsx'
import {protectedProjectFilePath,remapProjectFilePath} from './project-file-paths.mjs'
import {fileTreeRows,useFileTreeWindow} from './project-file-tree-window.jsx'
import {UserError} from './user-feedback.jsx'
import {VideoPreview} from './video-preview.jsx'
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
export function ProjectExplorer({project,request,active,onClose,onChooseProject,onOpenProject,onPreview,previewPath,onAdd,canAdd,onRecycle,refreshSignal,onChanged,revealRequest,clipboard,setClipboard,onOrganized}){
  const [selection,setSelection]=useState([])
  const [focused,setFocused]=useState('')
  const [creating,setCreating]=useState(null)
  const [name,setName]=useState('')
  const [error,setError]=useState('')
  const [feedback,setFeedback]=useState(null)
  const [busy,setBusy]=useState(false)
  const [deletePlan,setDeletePlan]=useState(null)
  const [menu,setMenu]=useState(null)
  const [match,setMatch]=useState(0)
  const [width,setWidth]=useState(()=>{try{return Math.max(200,Math.min(480,Number(localStorage.getItem('wtt-explorer-width'))||260))}catch{return 260}})
  const mounted=useRef(false),creatingBusy=useRef(false),drag=useRef(null),batch=useRef(null)
  const rowElements=useRef(new Map()),rangeAnchor=useRef('')
  const searchInput=useRef(null),searchTrigger=useRef(null),menuFirst=useRef(null)
  const [located,setLocated]=useState(null)
  const [renaming,setRenaming]=useState(null)
  const [newName,setNewName]=useState('')
  const renameInput=useRef(null)
  const importInput=useRef(null),importTarget=useRef('')
  const focusIntent=useRef(null)
  const [dragPath,setDragPath]=useState(null)
  const root={name:project.name,path:'',directory:true}
  const onLocated=useCallback(path=>{
    setLocated({path})
    focusIntent.current=path
    setFocused(path)
    rangeAnchor.current=path
    setSelection([path])
  },[])
  const navigation=useProjectFileNavigation({projectId:project.id,active,refreshSignal,revealRequest,onLocated})
  const {tree,expanded,errors,searchOpen,query,search,locating}=navigation
  const organizer=useFileOrganizer({projectId:project.id,active,disabled:busy||Boolean(creating||deletePlan),request,clipboard,setClipboard,expanded,onExpand:navigation.showDirectory,onRecovered:navigation.refresh,
    onChanged:async result=>{
      const changes=result.results.filter(item=>item.mode!=='unchanged')
      if(!changes.length){
        if(result.results.length)setRenaming(null)
        return
      }
      onOrganized(changes)
      if(!mounted.current)return
      setRenaming(null)
      await navigation.filesOrganized(changes)
      if(changes.length===1&&changes[0].to)await navigation.locate(changes[0].to)
      else setSelection(current=>current.map(path=>remapProjectFilePath(path,changes)).filter(Boolean))
    }})
  const {rows,entries}=useMemo(()=>fileTreeRows(tree,expanded,errors,creating?.parent),[tree,expanded,errors,creating?.parent])
  const selectedPaths=useMemo(()=>new Set(selection),[selection])
  const selected=useMemo(()=>entries.filter(entry=>selectedPaths.has(entry.path)),[entries,selectedPaths])
  const primary=selected.length===1?selected[0]:null
  const files=selected.filter(entry=>!entry.directory&&!entry.symbolicLink)
  const eligible=selected.filter(entry=>!entry.symbolicLink)
  const canCut=eligible.length>0&&eligible.every(entry=>!protectedProjectFilePath(entry.path))
  const locked=busy||Boolean(organizer.working)
  const focusPath=entries.some(entry=>entry.path===focused)?focused:entries[0]?.path
  const isResults=searchOpen&&Boolean(query.trim())
  const matches=search?.entries||[]
  const pinned=useMemo(()=>[
    ...[focusPath,renaming?.path,menu?.entry?.path,dragPath].filter(Boolean).map(path=>'entry:'+path),
    ...(creating?['create:'+creating.parent]:[]),
  ],[focusPath,renaming?.path,menu?.entry?.path,dragPath,creating])
  const treeWindow=useFileTreeWindow(rows,{visible:active&&!isResults,editing:renaming?.path,pinned})
  const cutPaths=useMemo(()=>new Set(clipboard?.mode==='move'?clipboard.paths:[]),[clipboard])

  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
  useEffect(()=>{if(organizer.working||organizer.feedback)setFeedback(null)},[organizer.working,organizer.feedback])
  useEffect(()=>{if(searchOpen)searchInput.current?.focus()},[searchOpen])
  useEffect(()=>{
    if(!renaming)return
    const input=renameInput.current
    if(!input)return
    const extension=renaming.directory?-1:renaming.name.lastIndexOf('.')
    treeWindow.reveal('entry:'+renaming.path)
    input.focus({preventScroll:true})
    input.setSelectionRange(0,extension>0?extension:renaming.name.length)
  },[renaming])
  useLayoutEffect(()=>{
    if(!active||isResults||focusIntent.current!==focused)return
    const target=rowElements.current.get(focused)
    if(!target)return
    focusIntent.current=null
    treeWindow.reveal('entry:'+focused)
    target.focus({preventScroll:true})
  },[active,focused,entries,isResults,located,treeWindow.reveal])
  useEffect(()=>{
    const visible=new Set(entries.map(entry=>entry.path))
    setSelection(current=>current.every(path=>visible.has(path))?current:current.filter(path=>visible.has(path)))
  },[entries])

  function focusRow(path){
    setFocused(path)
    const target=rowElements.current.get(path)
    if(!target){focusIntent.current=path;return}
    focusIntent.current=null
    treeWindow.reveal('entry:'+path)
    target.focus({preventScroll:true})
  }
  function choose(entry,event={}){
    setError('')
    if(event.shiftKey){
      const start=entries.findIndex(item=>item.path===rangeAnchor.current)
      const end=entries.findIndex(item=>item.path===entry.path)
      if(start<0)rangeAnchor.current=entry.path
      setSelection(start<0?[entry.path]:entries.slice(Math.min(start,end),Math.max(start,end)+1).map(item=>item.path))
    }else if(event.ctrlKey||event.metaKey){
      rangeAnchor.current=entry.path
      setSelection(current=>current.includes(entry.path)?current.filter(path=>path!==entry.path):[...current,entry.path])
    }else{
      rangeAnchor.current=entry.path
      setSelection([entry.path])
      if(!entry.directory&&!entry.symbolicLink&&window.innerWidth>700)onPreview(entry,{temporary:true})
    }
  }
  function expand(entry,open=!expanded.has(entry.path)){
    if(!open&&creating&&(creating.parent===entry.path||creating.parent.startsWith(entry.path+'/'))){
      if(creatingBusy.current)return
      setCreating(null)
    }
    if(!open&&focused.startsWith(entry.path+'/'))focusRow(entry.path)
    navigation.toggleDirectory(entry.path,open)
  }
  function closeMenu(restore=false){
    const anchor=menu?.anchor
    setMenu(null)
    if(restore&&anchor?.isConnected)anchor.focus?.({preventScroll:true})
  }
  function rowMenu(event,entry){
    event.preventDefault()
    if(locked)return
    if(!selection.includes(entry.path)){
      setSelection([entry.path])
      rangeAnchor.current=entry.path
    }
    setMenu({kind:'row',entry,anchor:rowElements.current.get(entry.path)||event.currentTarget})
  }
  function toggleMenu(event,kind){
    if(menu?.kind===kind)closeMenu()
    else {
      if(kind==='panel')void organizer.readStatus()
      setMenu({kind,anchor:event.currentTarget})
    }
  }
  function closeSearch({restore=true}={}){
    navigation.setSearchOpen(false)
    navigation.setComposing(false)
    navigation.editQuery('')
    if(restore)searchTrigger.current?.focus()
  }
  function searchKey(event){
    if(event.nativeEvent.isComposing)return
    if(event.key==='Escape'){event.preventDefault();closeSearch();return}
    if(!matches.length||locating)return
    if(event.key==='Enter'){event.preventDefault();void navigation.locate(matches[Math.min(match,matches.length-1)].path)}
    if(['ArrowDown','ArrowUp'].includes(event.key)){
      event.preventDefault()
      const next=Math.max(0,Math.min(matches.length-1,match+(event.key==='ArrowDown'?1:-1)))
      setMatch(next)
      document.getElementById(searchId+'-'+next)?.scrollIntoView({block:'nearest'})
    }
  }
  async function prepareDelete(entry){
    if(!entry?.path||locked||creating||renaming)return
    closeMenu(true)
    setError('')
    setBusy(true)
    try{
      const plan=await request('project-file-delete-plan',{path:entry.path})
      if(mounted.current)setDeletePlan(plan)
    }catch(cause){if(mounted.current)setError(cause.message)}
    finally{if(mounted.current)setBusy(false)}
  }
  async function deleted(plan){
    await onChanged?.(plan)
    if(!mounted.current)return
    setDeletePlan(null)
    setSelection([])
    await navigation.refresh()
  }
  function start(kind,entry=primary){
    if(creatingBusy.current||locked)return
    setRenaming(null)
    const parent=entry?.directory?entry.path:projectFileParent(entry?.path||'')
    closeSearch({restore:false})
    setCreating({kind,parent})
    setName('')
    setError('')
    closeMenu()
    navigation.showDirectory(parent)
  }
  function cancelCreate(){
    if(creatingBusy.current)return
    setCreating(null)
    setError('')
    if(focusPath)focusRow(focusPath)
  }
  async function create(event){
    event.preventDefault()
    if(creatingBusy.current||!name.trim())return
    creatingBusy.current=true
    setBusy(true)
    setError('')
    try{
      const result=await request('project-file-create',{...creating,kind:creating.kind==='project'?'folder':creating.kind,name})
      if(!mounted.current)return
      setCreating(null)
      if(creating.kind==='project')await onOpenProject(project.path+'/'+result.path)
      else {
        await navigation.load(creating.parent,{around:result.path})
        await navigation.locate(result.path)
      }
    }catch(cause){if(mounted.current)setError(cause.message)}
    finally{creatingBusy.current=false;if(mounted.current)setBusy(false)}
  }
  function switchProject(entry){
    closeMenu()
    void onOpenProject(entry.path?project.path+'/'+entry.path:project.path).catch(cause=>setError(cause.message))
  }
  function addEntries(items,references=false){
    if(!items.length||locked||batch.current)return
    closeMenu()
    organizer.setFeedback(null)
    const token=Symbol()
    batch.current=token
    setFeedback(null)
    setBusy(true)
    onAdd(items,{references,onResult:result=>{
      if(batch.current!==token)return
      batch.current=null
      if(!mounted.current)return
      setBusy(false)
      setFeedback({...result,references})
    }})
  }
  function startDrag(event,entry){
    const items=selection.includes(entry.path)?eligible:[entry]
    const referenceFiles=items.filter(item=>!item.directory&&!item.symbolicLink)
    event.dataTransfer.effectAllowed='copyMove'
    setDragPath(entry.path)
    organizer.dragStart(event,items)
    if(referenceFiles.length)event.dataTransfer.setData(PROJECT_FILE_DRAG,JSON.stringify({projectId:project.id,entries:referenceFiles.map(({path,name})=>({path,name}))}))
  }
  function startRename(entry){
    if(!entry?.path||entry.symbolicLink||protectedProjectFilePath(entry.path)||locked)return
    closeMenu()
    setCreating(null)
    setNewName(entry.name)
    setRenaming(entry)
    setError('')
    organizer.setFeedback(null)
  }
  function pasteInto(entry){
    closeMenu(true)
    organizer.paste(entry?.directory?entry.path:projectFileParent(entry?.path||''))
  }
  function chooseImport(entry){
    closeMenu(true)
    importTarget.current=entry?.directory?entry.path:projectFileParent(entry?.path||'')
    importInput.current?.click()
  }
  function changeClipboard(items,mode){
    closeMenu(true)
    organizer.copy(items,mode)
  }
  function renameRow(entry){
    return <form className="wtt-file-inline-create" aria-label="重命名文件"
      onSubmit={event=>{
        event.preventDefault()
        if(!locked&&newName.trim())void organizer.organize({mode:'rename',sources:[entry.path],name:newName})
      }}
      onKeyDown={event=>{
        if(event.key==='Escape'&&!locked){event.preventDefault();event.stopPropagation();setRenaming(null);setFocused(entry.path);requestAnimationFrame(()=>rowElements.current.get(entry.path)?.focus())}
        if(event.key==='Enter'&&event.nativeEvent.isComposing)event.preventDefault()
      }}>
      <ProjectFileIcon entry={entry}/>
      <input ref={renameInput} aria-label="新名称" value={newName} maxLength={180} readOnly={locked} onChange={event=>setNewName(event.target.value)} required/>
      <UiButton variant="ghost" size="compact" type="submit" title="确认改名" aria-label="确认改名" disabled={locked||!newName.trim()}><UiIcon name="check"/></UiButton>
    </form>
  }
  function treeKey(event){
    const button=event.target.closest?.('[data-project-file-path]')
    if(!button||event.nativeEvent.isComposing)return
    const index=entries.findIndex(entry=>entry.path===button.dataset.projectFilePath)
    const entry=entries[index]
    if(!entry)return
    const {key}=event
    if(!locked&&(event.metaKey||event.ctrlKey)&&['x','c','v','z'].includes(key.toLowerCase())&&!event.shiftKey&&!event.altKey){
      event.preventDefault()
      event.stopPropagation()
      const chosen=selection.length?eligible:[entry]
      if(key.toLowerCase()==='v')pasteInto(entry)
      else if(key.toLowerCase()==='z')void organizer.undo()
      else changeClipboard(chosen,key.toLowerCase()==='c'?'copy':'move')
      return
    }
    let target
    if(key==='ArrowUp')target=entries[index-1]
    else if(key==='ArrowDown')target=entries[index+1]
    else if(key==='Home')target=entries[0]
    else if(key==='End')target=entries.at(-1)
    else if(key==='ArrowLeft'){
      if(entry.directory&&expanded.has(entry.path))expand(entry,false)
      else target=entries.find(item=>item.path===projectFileParent(entry.path))
    }else if(key==='ArrowRight'){
      if(entry.directory&&!expanded.has(entry.path))expand(entry,true)
      else if(entry.directory&&projectFileParent(entries[index+1]?.path||'')===entry.path)target=entries[index+1]
    }else if(key===' '){
      choose(entry,{ctrlKey:true})
    }else if(key==='Enter'){
      if(entry.directory)expand(entry)
      else if(!entry.symbolicLink)onPreview(entry)
    }else if(key==='ContextMenu'||(event.shiftKey&&key==='F10')){
      rowMenu(event,entry)
    }else if(key==='F2'){
      if(selected.length<2)startRename(primary||entry)
    }else if(key==='Delete'||key==='Backspace'){
      if(selected.length<2)void prepareDelete(primary||entry)
    }else if(key==='Escape'){
      setSelection([])
    }else return
    event.preventDefault()
    event.stopPropagation()
    if(target){
      if(event.shiftKey&&['ArrowUp','ArrowDown'].includes(key)){
        if(!rangeAnchor.current)rangeAnchor.current=entry.path
        choose(target,{shiftKey:true})
      }
      focusRow(target.path)
    }
  }
  function creationRow(parent,level){
    if(!creating||creating.parent!==parent)return null
    const label=creating.kind==='file'?'文件名':creating.kind==='project'?'项目文件夹名':'文件夹名'
    const location='新建位置：'+project.name+(parent?'/'+parent:'')
    return <form className="wtt-file-inline-create" onSubmit={create} style={{paddingLeft:10+(level-1)*16}} aria-label={creating.kind==='file'?'新建文件':'新建文件夹'} title={location}
      onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancelCreate()}else if(event.key==='Enter'&&event.nativeEvent.isComposing)event.preventDefault()}}>
      <ProjectFileIcon entry={{directory:creating.kind!=='file',name:''}}/>
      <input autoFocus aria-label={label} title={location} required maxLength={180} disabled={busy} value={name} onChange={event=>setName(event.target.value)} placeholder={label}/>
      <UiButton variant="ghost" size="compact" type="submit" title="创建（Enter）" aria-label="确认创建" disabled={busy||!name.trim()}><UiIcon name="check"/></UiButton>
      <UiButton variant="ghost" size="compact" title="取消（Esc）" aria-label="取消创建" disabled={busy} onClick={cancelCreate}><UiIcon name="close"/></UiButton>
    </form>
  }
  function renderTreeRow(row){
    const {key,kind,parent,level,entry,offset,top,height}=row
    const slot={top,height}
    if(kind==='entry')return <div key={key} role="treeitem" className="wtt-file-tree-slot" style={slot}
      aria-label={entry.name} aria-level={level} aria-posinset={row.position} aria-setsize={row.total}
      aria-selected={selectedPaths.has(entry.path)} aria-expanded={entry.directory?expanded.has(entry.path):undefined}>
        <div className={'wtt-file-row'+(selectedPaths.has(entry.path)?' is-selected':'')+(organizer.dropTarget?.path===entry.path?' is-file-drop-target':'')+
          (cutPaths.has(entry.path)?' is-cut':'')}
          style={{paddingLeft:10+(level-1)*16}} onContextMenu={event=>rowMenu(event,entry)}
          onDragOver={entry.directory?event=>organizer.dragOver(event,entry.path):undefined}
          onDragLeave={entry.directory?organizer.dragLeave:undefined}
          onDrop={entry.directory?event=>organizer.drop(event,entry.path):undefined}>
          {entry.directory?<UiButton variant="custom" className="wtt-file-toggle" tabIndex={-1} aria-label={(expanded.has(entry.path)?'收起 ':'展开 ')+entry.name}
            onClick={()=>{focusRow(entry.path);expand(entry)}}><UiIcon size={12} name={expanded.has(entry.path)?'chevronDown':'chevronRight'}/></UiButton>:<span className="wtt-file-chevron"/>}
          {renaming?.path===entry.path?renameRow(entry):<UiButton variant="custom" className="wtt-file-name" title={entry.path} data-project-file-path={entry.path} tabIndex={focusPath===entry.path?0:-1}
            aria-current={previewPath===entry.path?'true':undefined}
            ref={node=>{if(node)rowElements.current.set(entry.path,node);else rowElements.current.delete(entry.path)}}
            draggable={!entry.symbolicLink&&!locked} onDragStart={event=>startDrag(event,entry)} onDragEnd={()=>{setDragPath(null);organizer.dragEnd()}}
            onFocus={()=>setFocused(entry.path)} onClick={event=>choose(entry,event)}
            onDoubleClick={()=>{if(entry.directory)expand(entry);else if(!entry.symbolicLink)onPreview(entry,{pinned:true})}}>
            <ProjectFileIcon entry={entry}/><span>{entry.name}</span>
          </UiButton>}
          {organizer.dropTarget?.path===entry.path&&<small className="wtt-file-drop-label">{organizer.dropTarget.copy?'复制到此':'移动到此'}</small>}
        </div>
    </div>
    return <div key={key} role="none" className="wtt-file-tree-slot wtt-file-tree-control" style={slot}>
      {kind==='create'&&creationRow(parent,level)}
      {kind==='error'&&<div className="wtt-file-branch-status"><span role="status" title={row.error}>{row.error}</span>
        <UiButton variant="ghost" size="compact" onClick={()=>void navigation.load(parent,{offset})}>重试</UiButton></div>}
      {kind==='loading'&&<p className="wtt-file-empty" role="status">读取中…</p>}
      {kind==='empty'&&<p className="wtt-file-empty">空文件夹</p>}
      {(kind==='previous'||kind==='next')&&<UiButton variant="ghost" className="wtt-file-page"
        onClick={async event=>{
          const keyboard=event.detail===0
          const next=await navigation.load(parent,{offset,append:true})
          if(keyboard&&next?.entries[0])focusRow(next.entries[0].path)
        }}>{kind==='previous'?'加载上页':'加载更多'}</UiButton>}
    </div>
  }
  function resizeTo(next){
    setWidth(next)
    try{localStorage.setItem('wtt-explorer-width',String(next))}catch{}
  }
  const searchId=useId()
  const rowMenuEntry=menu?.kind==='row'?menu.entry:null
  const menuItems=menu?.kind==='project'?[
    ['打开项目…',()=>{closeMenu();onChooseProject()}],
    ['新建项目',()=>start('project',root),locked],
    ['粘贴到项目根目录',()=>pasteInto(root),locked||!clipboard],
    ['从电脑导入…',()=>chooseImport(root),locked],
  ]:menu?.kind==='panel'?[
    ['刷新文件树',()=>{closeMenu(true);void navigation.refresh();if(isResults)navigation.refreshSearch()}],
    ['全部折叠',()=>{closeMenu(true);navigation.collapse();setSelection([])}],
    ['撤销文件操作',()=>{closeMenu(true);void organizer.undo()},locked||!organizer.status?.undoBatch],
    ...(onRecycle?[['项目回收站',()=>{closeMenu(true);onRecycle()}]]:[]),
  ]:rowMenuEntry?[
    ...(files.length?[
      ['添加到画布',()=>addEntries(files),!canAdd],
      ['添加为对话引用',()=>addEntries(files,true),!canAdd],
    ]:[]),
    ...(primary?.directory?[['打开为项目',()=>switchProject(primary)]]:[]),
    ...(eligible.length?[
      ['剪切',()=>changeClipboard(eligible,'move'),locked||!canCut],
      ['复制',()=>changeClipboard(eligible,'copy'),locked],
    ]:[]),
    ['粘贴',()=>pasteInto(rowMenuEntry),locked||!clipboard||protectedProjectFilePath(rowMenuEntry.path)],
    ...(rowMenuEntry.directory?[['从电脑导入…',()=>chooseImport(rowMenuEntry),locked||protectedProjectFilePath(rowMenuEntry.path)]]:[]),
    ...(selected.length<=1?[
      ...(rowMenuEntry.path&&!rowMenuEntry.symbolicLink?[['重命名',()=>startRename(rowMenuEntry),locked||protectedProjectFilePath(rowMenuEntry.path)]]:[]),
      ['在此新建文件',()=>start('file',rowMenuEntry),busy],
      ['在此新建文件夹',()=>start('folder',rowMenuEntry),busy],
      ...(rowMenuEntry.path?[['删除…',()=>void prepareDelete(rowMenuEntry),busy||Boolean(creating)]]:[]),
    ]:[]),
  ]:[]
  return <aside className="wtt-project-explorer" aria-label="项目文件" style={{width}}>
    <input type="file" hidden multiple ref={importInput} onChange={event=>{
      const files=Array.from(event.target.files)
      event.target.value=''
      void organizer.uploadFiles(files,importTarget.current)
    }}/>
    <header className="wtt-file-header">
      <UiButton variant="ghost" className="wtt-file-root" title={project.path} aria-label={'项目：'+project.name}
        aria-haspopup="menu" aria-expanded={menu?.kind==='project'} onClick={event=>toggleMenu(event,'project')}>
        <span>{project.name}</span><UiIcon name="chevronDown" size={12}/>
      </UiButton>
      <UiButton variant="ghost" size="compact" title="新建文件" aria-label="新建文件" disabled={busy} onClick={()=>start('file')}><UiIcon name="file"/></UiButton>
      <UiButton variant="ghost" size="compact" title="新建文件夹" aria-label="新建文件夹" disabled={busy} onClick={()=>start('folder')}><UiIcon name="folder"/></UiButton>
      <UiButton variant="ghost" size="compact" title="查找文件" aria-label="查找文件" aria-expanded={searchOpen} ref={searchTrigger}
        onClick={()=>searchOpen?closeSearch():navigation.setSearchOpen(true)}><UiIcon name="search"/></UiButton>
      <UiButton variant="ghost" size="compact" title="文件栏操作" aria-label="文件栏操作" aria-haspopup="menu"
        aria-expanded={menu?.kind==='panel'} onClick={event=>toggleMenu(event,'panel')}><UiIcon name="more"/></UiButton>
      <UiButton variant="ghost" size="compact" title="收起文件栏" aria-label="收起文件栏" onClick={onClose}><UiIcon name="close"/></UiButton>
    </header>
    {searchOpen&&<div className="wtt-file-search">
      <input ref={searchInput} type="text" role="combobox" aria-label="按文件名或路径查找" aria-expanded={isResults}
        aria-controls={isResults?searchId:undefined} aria-autocomplete="list" aria-activedescendant={matches.length?searchId+'-'+Math.min(match,matches.length-1):undefined}
        value={query} maxLength={180} placeholder="文件名或路径" onKeyDown={searchKey}
        onCompositionStart={()=>navigation.setComposing(true)} onCompositionEnd={()=>navigation.setComposing(false)}
        onChange={event=>{navigation.editQuery(event.target.value);setMatch(0)}}/>
    </div>}
    {menu&&<CanvasPopover anchor={menu.anchor} boundary={document.documentElement} initialFocusRef={menuFirst}
      onDismiss={()=>closeMenu()} className="wtt-file-context" role="menu" aria-label={rowMenuEntry?'所选项操作':'文件栏操作'}
      onKeyDown={event=>{
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMenu(true);return}
        if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return
        event.preventDefault()
        const items=[...event.currentTarget.querySelectorAll('[role="menuitem"]:not(:disabled)')]
        const index=items.indexOf(document.activeElement)
        const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length
        items[next]?.focus()
      }}>
      {(menuItems.length?menuItems:[['清除选择',()=>{setSelection([]);closeMenu(true)}]]).map(([label,action,disabled],index)=><UiButton key={label} ref={index===Math.max(0,menuItems.findIndex(item=>!item[2]))?menuFirst:undefined}
        variant="custom" role="menuitem" onClick={action} disabled={disabled}>{label}</UiButton>)}
    </CanvasPopover>}
    {(error||navigation.navigationError)&&<UserError error={error||navigation.navigationError}/>}
    <div hidden={isResults} ref={treeWindow.treeElement} className={'wtt-file-tree'+(organizer.dropTarget?.path===''?' is-file-drop-target':'')} role="tree"
      aria-multiselectable="true" aria-label={project.name+' 文件树'} onKeyDown={treeKey} onScroll={treeWindow.onScroll}
      data-loaded-entries={entries.length} onDragOver={event=>organizer.dragOver(event,'')} onDragLeave={organizer.dragLeave} onDrop={event=>organizer.drop(event,'')}>
      {organizer.dropTarget?.path===''&&<div className="wtt-file-root-drop-label"><small className="wtt-file-drop-label">{organizer.dropTarget.copy?'复制到项目根目录':'移动到项目根目录'}</small></div>}
      <div className="wtt-file-tree-space" role="presentation" style={{height:active&&!isResults?treeWindow.height:0}}>{treeWindow.items.map(renderTreeRow)}</div>
    </div>
    {isResults&&<div className="wtt-file-results">
      <div id={searchId} role="listbox" aria-label="查找结果">
        {matches.map((entry,index)=><UiButton key={entry.path} id={searchId+'-'+index} variant="custom"
          role="option" tabIndex={-1} aria-selected={index===match} title={entry.path} disabled={locating}
          onMouseEnter={()=>setMatch(index)} onClick={()=>void navigation.locate(entry.path)}>
          <ProjectFileIcon entry={entry}/><span><strong>{entry.name}</strong><small>{projectFileParent(entry.path)||project.name}</small></span>
        </UiButton>)}
      </div>
      {locating&&<p className="wtt-file-empty" role="status">定位中…</p>}
      {!search&&!locating&&<p className="wtt-file-empty" role="status">查找中…</p>}
      {search?.error&&<div className="wtt-file-branch-status"><UserError error={search.error}/><UiButton variant="ghost" onClick={navigation.refreshSearch}>重试</UiButton></div>}
      {search&&!search.error&&(!matches.length||search.truncated)&&<p className="wtt-file-empty" role="status">{search.truncated?'请增加文件名或路径条件，查看更准确的结果。':'没有找到文件'}</p>}
    </div>}
    {!isResults&&Boolean(selected.length)&&<footer>
      {selected.length>1&&<span role="status">已选 {selected.length} 项</span>}
      {files.length>0&&<UiButton variant="quiet" disabled={!canAdd||busy} onClick={()=>addEntries(files)}>添加到画布</UiButton>}
      {primary&&!primary.directory&&!primary.symbolicLink&&<UiButton className="wtt-file-mobile-preview" onClick={()=>onPreview(primary)}>预览</UiButton>}
      {primary?.directory&&<UiButton variant="quiet" onClick={()=>switchProject(primary)}>打开为项目</UiButton>}
      <UiButton variant="ghost" iconOnly aria-label="所选项操作" title="所选项操作" disabled={busy}
        onClick={event=>setMenu({kind:'row',anchor:event.currentTarget,entry:primary||selected[0]})}><UiIcon name="more"/></UiButton>
    </footer>}
    {!isResults&&feedback&&<div className="wtt-file-batch-status">
      <span role="status">
        {feedback.done?'已'+(feedback.references?'引用 ':'添加 ')+feedback.done+' 项':''}
        {feedback.failed.length>0&&(feedback.done?'，':'')+feedback.failed.length+' 项需重试'}
      </span>
      {feedback.failed.length>0&&<UiButton variant="ghost" size="compact" onClick={()=>addEntries(feedback.failed,feedback.references)}>重试</UiButton>}
      <UiButton variant="ghost" size="compact" iconOnly aria-label="关闭文件操作反馈" onClick={()=>setFeedback(null)}><UiIcon name="close" size={14}/></UiButton>
      {feedback.failed.length>0&&<details className="wtt-file-batch-errors"><summary>查看失败文件</summary>
        <ul>{feedback.failed.map(item=><li key={item.path}><strong>{item.name||item.path}</strong><span>{item.error}</span></li>)}</ul>
      </details>}
    </div>}
    {deletePlan&&<DeleteProjectFilesDialog plan={deletePlan} request={request} onClose={()=>setDeletePlan(null)} onDone={deleted}/>}
    <FileOrganizeNotice organizer={organizer}/>
    {organizer.conflicts&&<FileConflictDialog matches={organizer.conflicts.matches} onResolve={organizer.resolveConflicts}/>}
    <div className="wtt-file-resize" role="separator" tabIndex={0} aria-label="调整文件栏宽度" aria-orientation="vertical"
      aria-valuemin={200} aria-valuemax={480} aria-valuenow={width}
      onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);drag.current={x:event.clientX,width}}}
      onPointerMove={event=>{if(drag.current)setWidth(Math.max(200,Math.min(480,drag.current.width+event.clientX-drag.current.x)))}}
      onPointerUp={event=>{drag.current=null;resizeTo(width);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId)}}
      onPointerCancel={()=>{drag.current=null}}
      onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();resizeTo(event.key==='Home'?200:event.key==='End'?480:Math.max(200,Math.min(480,width+(event.key==='ArrowRight'?20:-20))))}}/>
  </aside>
}
function ProjectFileIcon({entry}){
  const format=entry.name.split('.').at(-1).toLowerCase()
  const icon=entry.directory?'directory':entry.symbolicLink?'link':/^(png|jpe?g|gif|webp|svg|bmp|avif|heic)$/.test(format)?'image':
    /^(mp4|mov|webm|m4v|avi|mkv)$/.test(format)?'video':/^(pptx?|odp|key)$/.test(format)?'slides':
    /^(csv|xlsx?|numbers)$/.test(format)?'table':/^(mp3|wav|m4a|aac|ogg|flac)$/.test(format)?'audio':'document'
  return <UiIcon name={icon} className={'wtt-file-type is-'+icon} size={15}/>
}
export function ProjectFilePreview({selection,endpoint,onClose,onAdd,onToggleWidth,widthExpanded,onPin,onLocate}){
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
 return <aside className="wtt-project-file-preview" data-expanded={expanded||undefined} aria-label="项目文件预览"><PanelHeader title={selection.name} subtitle={selection.path} format={data?.format?.toUpperCase()} downloadHref={href} expanded={expanded} onToggleWidth={onToggleWidth||(()=>setLocalExpanded(v=>!v))} onClose={onClose} closeLabel="关闭文件预览"/><PanelToolbar>{onPin&&<UiButton variant="quiet" aria-pressed={Boolean(selection.pinned)} onClick={onPin}>{selection.pinned?'取消固定':'固定预览'}</UiButton>}{onLocate&&<UiButton variant="quiet" onClick={onLocate}>在项目文件中定位</UiButton>}{onAdd&&<UiButton disabled={!data||data.empty||Boolean(data.error)} onClick={()=>onAdd({...selection,hash:data.hash})}>添加到画布</UiButton>}</PanelToolbar>{error&&<UserError error={error}/>}{externalNotice&&<div className="wtt-file-notice" role="status">{externalNotice}</div>}<div className="wtt-file-preview-body">{!data&&!error?<p role="status">正在预览…</p>:data?.empty?<p>空文件</p>:data?.mime.startsWith('image/')&&data.media?.validated?<img src={preview} alt={selection.name}/>:data?.mime.startsWith('video/')&&data.media?.validated?<VideoPreview src={preview} aria-label={selection.name}/>:data&&['pdf','docx','pptx'].includes(data.format)?<>{pages?<><nav aria-label="文件页码"><UiButton variant="custom" type="button" disabled={page<=1} onClick={()=>setPage(page-1)}>上一页</UiButton><span>{page} / {pages.pageCount}</span><UiButton variant="custom" type="button" disabled={page>=pages.pageCount} onClick={()=>setPage(page+1)}>下一页</UiButton></nav><img src={endpoint({projectFilePage:selection.path,hash:data.hash,page:String(page)}).href} alt={`${selection.name} 第${page}页`}/></>:pageError?<UserError error={pageError}/>:<p role="status">正在准备实际分页…</p>}</>:isMarkdown&&data?.content&&!bigMarkdown?<div className="wtt-file-md" key={data.hash}><MarkdownView content={data.content}/></div>:isText?<> {textViewBar}{textViewBody}</>:data?.content?<><small>{['docx','pptx'].includes(data.format)?'正文预览':''}</small><pre>{data.content}</pre>{data.truncated&&<p>正文已截取，下载查看完整文件。</p>}</>:data&&<p>{data.error||data.extractionError||'此格式暂无预览，可下载查看。'}</p>}</div></aside>
}
