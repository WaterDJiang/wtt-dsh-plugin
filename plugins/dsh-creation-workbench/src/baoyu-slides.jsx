import { PanelHeader, PanelToolbar, UiButton } from './ui/controls.jsx'
import { UserError } from './user-feedback.jsx'
import React, { useEffect, useRef, useState } from 'react'
import './baoyu-slides.css'
import { BaoyuComments } from './baoyu-comments.jsx'
import {EditorExitDialog} from './editor-exit-dialog.jsx'
const editorCopies=new Map()

/** The frame bridge is advertised by the installed editor, never inferred from a DOM scrape. */
export function BaoyuSlides({ scope, api, onRestoreSession, onPublished, onClose, downloadHref, conversation, conversationSessionId, onToggleWidth, widthExpanded, closeRequestRef,renderEditorConversation,savedPreview }) {
  const copyKey=JSON.stringify([scope.projectId,scope.slideProject.id,scope.versionId||null]),copy=editorCopies.get(copyKey)||{}
  const [exitOpen,setExitOpen]=useState(false),[viewMode,setViewMode]=useState('edit'),[previewOpened,setPreviewOpened]=useState(false),[nativeDraft,setNativeDraft]=useState('')
  const [frameLoaded, setFrameLoaded] = useState(false)
  const [opened, setOpened] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState('正在打开课件编辑器…')
  const [commentState, setCommentState] = useState(null), [restoreWarning, setRestoreWarning] = useState(''), [executionOpen, setExecutionOpen] = useState(copy.executionOpen||false)
  const [commentsOpen, setCommentsOpen] = useState(copy.commentsOpen||false), [commentDraft, setCommentDraft] = useState(copy.commentDraft||null), [commentsSnapshot, setCommentsSnapshot] = useState(null), [commentBusy, setCommentBusy] = useState(false), [commentError, setCommentError] = useState('')
  const [capabilities, setCapabilities] = useState(null), [notice, setNotice] = useState('')
  useEffect(()=>{editorCopies.set(copyKey,{commentsOpen,commentDraft,executionOpen})},[copyKey,commentsOpen,commentDraft,executionOpen])
  useEffect(()=>{if(!closeRequestRef)return;closeRequestRef.current=()=>setExitOpen(true);return()=>{closeRequestRef.current=null}},[closeRequestRef])
  const frame = useRef(null), mounted = useRef(true), snapshot = useRef(null), requests = useRef(new Map()), controller = useRef(null), exportRequest = useRef(null), exportError = useRef('')
  const origin = opened ? new URL(opened.editor.url).origin : ''
  const post = message => frame.current?.contentWindow?.postMessage(message, origin)
  const nativeCall = (cmd, payload) => new Promise((resolve, reject) => {
    const request = crypto.randomUUID(), timer = setTimeout(() => { requests.current.delete(request); reject(new Error('宝玉批注接口响应超时')) }, 15_000)
    requests.current.set(request, { type: 'native', resolve: result => { clearTimeout(timer); resolve(result) }, reject: cause => { clearTimeout(timer); reject(cause) } })
    post({ __wtt_slides_command: true, cmd, request, payload })
  })
  const reloadComments = async () => {
    const result = await nativeCall('comments-list')
    if (!Array.isArray(result?.threads)) throw new Error('宝玉批注回执格式无效')
    if (!mounted.current) return
    setCommentsSnapshot(result)
    post({ type: 'editor:threads', threads: result.threads.filter(thread => thread.status === 'open').map((thread, index) => ({ id: thread.id, anchor: thread.anchor, n: index + 1, ...(thread.location?.section ? { section: thread.location.section } : {}) })) })
  }
  const closeComments = () => {
    if (commentDraft?.requestId) post({ type: 'editor:composer-closed', requestId: commentDraft.requestId })
    setCommentDraft(null); setCommentsOpen(false); post({ type: 'editor:set-mode', on: false })
  }
  const submitComment = async values => {
    setCommentBusy(true); setCommentError('')
    try {
      const payload = values.id ? values : { anchor: commentDraft?.anchor, label: commentDraft?.label || '课件批注',
        ...(commentDraft?.detail ? { detail: commentDraft.detail } : {}), ...(commentDraft?.area ? { area: true } : {}), ...(commentDraft?.section ? { section: commentDraft.section } : {}), ...values }
      await nativeCall(values.id ? 'comment-reply' : 'comment-submit', payload)
      if (commentDraft?.requestId) post({ type: 'editor:composer-closed', requestId: commentDraft.requestId })
      if (mounted.current) { setCommentDraft(null); if (values.send) setExecutionOpen(true) }
      await reloadComments(); return true
    } catch (cause) { if (mounted.current) setCommentError(cause.message); return false }
    finally { if (mounted.current) setCommentBusy(false) }
  }

  useEffect(() => {
    mounted.current = true
    const abort = new AbortController()
    void (async () => {
      // Restoring the actual original conversation makes comment delivery observable and recoverable.
      if (scope.slideProject.sessionId) {
        try { await onRestoreSession?.(scope.slideProject.sessionId) }
        catch (cause) { if (mounted.current) setRestoreWarning(`原会话暂未恢复：${cause.message}`) }
      }
      const result = await api.openSlides({ projectId: scope.slideProject.id, requirementId: scope.requirementId,
        ...(scope.versionId ? { versionId: scope.versionId } : {}) }, { signal: abort.signal })
      if (!mounted.current) return
      setOpened(result); setBusy('')
    })().catch(cause => { if (mounted.current && !abort.signal.aborted) { setError(cause.message); setBusy('') } })
    return () => { mounted.current = false; abort.abort(); controller.current?.abort(); for (const request of requests.current.values()) request.reject(new Error('编辑面板已切换')); requests.current.clear() }
  }, [])
  useEffect(() => {
    if (!origin) return
    const receive = event => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return
      const message = event.data
      if (message?.__wtt_slides_reply === true && requests.current.get(message.request)?.type === 'native') {
        const request = requests.current.get(message.request); requests.current.delete(message.request)
        if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result)
      }
      if (message?.type === 'editor:compose' && typeof message.requestId === 'string' && message.requestId.length <= 100 && typeof message.anchor === 'string' && message.anchor.length <= 65536) {
        setCommentDraft(message); setCommentsOpen(true); setCommentError(''); post({ type: 'editor:compose-result', requestId: message.requestId, opened: true })
      }
      if (message?.type === 'editor:mode') setCommentsOpen(Boolean(message.on))
      if (message?.type === 'editor:ready') void reloadComments().catch(cause => { if (mounted.current) setCommentError(cause.message) })
      if (message?.__frame_chrome_hello === true) { post({ __frame_chrome_poke: true, words: [], rows: false }); sendTheme() }
      if (message?.__frame_chrome_report === true && message.snapshot && typeof message.snapshot === 'object') {
        snapshot.current = message.snapshot; setCapabilities(message.snapshot)
        if (message.snapshot.saved === 'saved') {
          for (const [id, request] of requests.current) if (request.type === 'flush') { requests.current.delete(id); request.resolve() }
        }
      }
      if (message?.__wtt_slides_reply === true && message.request === exportRequest.current && message.error) { exportError.current = message.error; controller.current?.abort() }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [origin])
  useEffect(() => {
    if (!opened || !frameLoaded) return
    const abort = new AbortController()
    const refresh = () => { void api.slidesStatus({ projectId: opened.project.id, requirementId: scope.requirementId }, { signal: abort.signal })
      .then(status => { if (!abort.signal.aborted) setCommentState(status) }).catch(cause => { if (!abort.signal.aborted) setCommentState({ commentError: cause.message }) }) }
    const refreshBoth = () => { refresh(); void reloadComments().catch(cause => { if (!abort.signal.aborted) setCommentError(cause.message) }) }
    refreshBoth(); const timer = setInterval(refreshBoth, 3000)
    return () => { abort.abort(); clearInterval(timer) }
  }, [opened?.project.id, frameLoaded])
  const retryComments = async () => {
    try {
      if (opened.project.sessionId) await onRestoreSession?.(opened.project.sessionId)
      const status = await api.retrySlidesComments({ projectId: opened.project.id, requirementId: scope.requirementId })
      if (mounted.current) { setCommentState(status); setRestoreWarning('') }
    } catch (cause) { if (mounted.current) setCommentState({ commentError: cause.message }) }
  }
  const sendTheme = () => {
    const surface = frame.current?.closest('.wtt-course-workbench') || frame.current?.parentElement
    if (surface) post({ __wtt_slides_command: true, cmd: 'theme', theme: getComputedStyle(surface).colorScheme.includes('dark') ? 'dark' : 'light' })
  }
  useEffect(() => {
    if (!origin || !frameLoaded) return
    const observer = new MutationObserver(sendTheme), scheme = window.matchMedia('(prefers-color-scheme: dark)')
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ds-theme-source', 'data-ds-dark-theme'] })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-theme-source', 'data-ds-dark-theme'] })
    scheme.addEventListener('change', sendTheme); sendTheme()
    return () => { observer.disconnect(); scheme.removeEventListener('change', sendTheme) }
  }, [origin, frameLoaded])
  const flush = async () => {
    await new Promise((resolve, reject) => {
      const id = crypto.randomUUID(), timer = setTimeout(() => { requests.current.delete(id); reject(new Error('课件保存等待超时，请先检查编辑器中的保存状态。')) }, 20_000)
      requests.current.set(id, { type: 'flush', resolve: () => { clearTimeout(timer); resolve() }, reject: cause => { clearTimeout(timer); reject(cause) } })
      if (snapshot.current?.actions?.some(action => action.id === 'save_now')) post({ __frame_chrome_cmd: true, cmd: 'action', id: 'save_now' })
      post({ __frame_chrome_poke: true, words: [], rows: false })
    })
  }
  const save = async ({exit=false}={}) => {
    if (!opened || busy) throw new Error('编辑器尚未就绪或正在保存，请稍后重试')
    setError(''); setNotice(''); exportError.current = ''; setBusy('正在保存课件并导出 PPTX…')
    const abort = new AbortController(); controller.current = abort
    try {
      await flush()
      const format = snapshot.current?.exports?.find(item => item.format === 'pptx' && item.disabled !== true)
      if (!format) throw new Error('这个课件暂时不能导出可编辑 PPTX，请查看编辑器的导出选项。')
      const data = { projectId: opened.project.id, requirementId: scope.requirementId }
      const prepared = await api.prepareSlides({ ...data, operationId: crypto.randomUUID() }, { signal: abort.signal })
      const pending = api.publishSlides({ ...data, intentId: prepared.intentId }, { signal: abort.signal })
      exportRequest.current = crypto.randomUUID()
      post({ __wtt_slides_command: true, cmd: 'export-pptx', request: exportRequest.current })
      const result = await pending
      if (!mounted.current) return
      setNotice('新版本已保存，可下载 PPTX')
      await onPublished(result,{exit})
    } catch (cause) { if (mounted.current) setError(cause.name === 'AbortError' ? exportError.current || '导出未完成，正式版本未改动；请核对编辑器后重试' : cause.message);throw cause }
    finally { if (mounted.current) setBusy(''); if (controller.current === abort) { controller.current = null; exportRequest.current = null } }
  }
  const canExport = capabilities?.exports?.some(item => item.format === 'pptx' && item.disabled !== true && (!item.variants?.length || item.variants.some(v => ['current', 'basic'].includes(v.id) && v.disabled !== true)))
  return <aside className="wtt-ppt-editor wtt-baoyu-slides" aria-label="课件编辑器">
    <PanelHeader title={opened?.title || scope.title || '课件'} subtitle={`${scope.number ? `基于 V${String(scope.number).padStart(3,'0')} · ` : ''}可编辑课件${opened ? ` · ${opened.pages} 页` : ''}`} downloadHref={downloadHref} downloadLabel="下载已保存 PPTX" expanded={widthExpanded} expandLabel="全屏" restoreLabel="缩小" onToggleWidth={onToggleWidth} onClose={()=>setExitOpen(true)} closeLabel="关闭课件编辑器" />
    <PanelToolbar><UiButton variant="quiet" type="button" onClick={() => { setCommentsOpen(previous => !previous); post({ type: 'editor:set-mode', on: !commentsOpen }) }}>批注{commentsSnapshot?.threads?.length ? ` ${commentsSnapshot.threads.length}` : ''}</UiButton><span className="wtt-ui-toolbar-note">修改自动存草稿，保存后生成新版本。</span>
      <UiButton variant="primary" className="is-primary" type="button" disabled={!!busy || !canExport} onClick={() => void save().catch(()=>{})}>{busy || '保存新版本'}</UiButton></PanelToolbar>
    {error && <div className="wtt-baoyu-feedback is-error" role="alert"><UserError error={error} announce={false} /></div>}
    {(restoreWarning || commentState?.commentError || commentState?.pendingComments > 0) && <div className="wtt-baoyu-feedback" role="status">{restoreWarning || commentState?.commentError || `${commentState?.pendingComments || 0} 条批注等待发送到原任务`}<UiButton variant="quiet" onClick={() => void retryComments()}>重试批注连接</UiButton></div>}
    {notice && <div className="wtt-baoyu-feedback" role="status">{notice}</div>}
    <div className="wtt-baoyu-layout"><section className="wtt-baoyu-discussion" aria-label="原生课件对话">
      {opened?.project.sessionId&&renderEditorConversation?.({identity:`baoyu:${opened.project.id}`,sessionId:opened.project.sessionId,owner:{ready:Boolean(opened&&!busy&&commentDraft),autoCommand:Boolean(commentDraft),label:commentDraft?`已引用 · ${commentDraft.label||commentDraft.section||'所选页面内容'}`:'课件对话 · 在页面中选择内容并添加批注引用',uiKey:commentDraft?.requestId||'',prepare:async()=>{if(!commentDraft)throw new Error('请先在课件中选择页面或元素，点击批注引用');return structuredClone(commentDraft)},submit:async(text,attachments,frozen)=>{if(attachments.length)throw new Error('页面批注修改暂不接收附件，可切换普通对话发送，附件已保留');const saved=await submitComment({anchor:frozen.anchor,label:frozen.label||'课件批注',detail:frozen.detail,area:frozen.area,section:frozen.section,text:text.trim(),send:true});if(!saved)throw new Error('批注未能提交，请核对连接后重试')},onDraft:setNativeDraft,controls:commentDraft?<UiButton size="compact" onClick={closeComments}>取消引用</UiButton>:undefined}})}
      {!opened?.project.sessionId&&<p>正在连接原课件对话…</p>}
    </section><section className="wtt-baoyu-display" aria-label="网页课件展示">
      <PanelToolbar><UiButton size="compact" disabled={!scope.artifactId} aria-pressed={viewMode==='preview'} onClick={()=>{setViewMode('preview');setPreviewOpened(true)}}>预览</UiButton><UiButton size="compact" aria-pressed={viewMode==='edit'} onClick={()=>setViewMode('edit')}>编辑</UiButton>{viewMode==='preview'&&<span>已保存PPT</span>}</PanelToolbar>
      <div className="wtt-baoyu-native-preview" hidden={viewMode!=='preview'}>{previewOpened&&savedPreview}</div>
      <div className="wtt-baoyu-editor-body" hidden={viewMode!=='edit'}>
    {opened && <iframe ref={frame} src={opened.editor.url} title="课件编辑源文件" allow="clipboard-read; clipboard-write; fullscreen" onLoad={() => { setFrameLoaded(true); post({ __frame_chrome_poke: true, words: [], rows: false }); sendTheme() }} />}
    {!opened && <div className="wtt-baoyu-empty">{busy || '课件暂时无法打开，请关闭面板后重试'}</div>}
      {commentsOpen&&!commentDraft&&<BaoyuComments draftKey={copyKey} snapshot={commentsSnapshot} pending={commentBusy} error={commentError} onSubmit={submitComment} onClose={closeComments}/>}
      </div>
    </section></div>
    {exitOpen&&<EditorExitDialog onCancel={()=>setExitOpen(false)} onKeep={async()=>{if(opened&&frameLoaded)await flush();onClose()}} onSave={()=>save({exit:true})} canSave={Boolean(canExport)} working={Boolean(busy)} pending={Boolean(commentState?.pendingComments)}/>}
  </aside>
}
