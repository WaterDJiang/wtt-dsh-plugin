import { PanelHeader, PanelToolbar, UiButton } from './ui/controls.jsx'
import { SvgInlinePage } from './svg-inline-page.jsx'
import { PptTextLayer } from './ppt-inline-editor.jsx'
import { createPptPreviewQueue } from './ppt-preview-queue.mjs'
import { UserError } from './user-feedback.jsx'
import React, { useEffect, useRef, useState } from 'react'
import { checkPptDocument, patchPptText, pptDocumentChanges, pptObjectStyle, reconcilePublishedPptDraft, recoverPptLocalEdits, retainLaterPptEdits } from './ppt-editor-state.mjs'
import './ppt-editor.css'

const messageOf = cause => cause?.message || String(cause)
const stop = event => event.stopPropagation()
const editable = element => element.editable !== false
const objectLabel = element => element?.text?.replace(/\s+/g, ' ').trim().slice(0, 40) || '空文字框'
const slideLabel = slide => {
  if (slide.title && slide.title !== '未命名页面') return slide.title
  const note = slide.notes?.split('\n')[0]?.trim()
  if (/^P\d{2,4}[｜|:：\s]/i.test(note || '')) return note.replace(/^P\d{2,4}[｜|:：\s]+/i, '').slice(0, 48)
  return slide.elements?.map(item => item.text?.trim()).find(value => value && !/^\d+$/.test(value))?.slice(0, 48) || '无文字页面'
}
const POLL_LIMIT = 75
const recoveries = new Map()
const closingSaves = new Map()
const publishingJobs = new Map()
const scopeIdentity = scope => JSON.stringify([scope?.projectId, scope?.requirementId, scope?.cardId, scope?.versionId, scope?.artifactId, scope?.hash, scope?.svgCandidateId, scope?.svgSourceId])

function ActualPage({ document, slide, renderedSlide, manifest, api, selectedId, onSelect, onEdit, onCommit, onEditingChange, disabled, readOnly = false, showBounds = false, onError }) {
  if(document.sourceFormat === 'svg') return <SvgInlinePage {...{document,slide,renderedSlide,manifest,api,selectedId,onSelect,onEdit,onCommit,onEditingChange,disabled,readOnly,showBounds,onError}} />
  return <RasterPage {...{document,slide,renderedSlide,manifest,api,selectedId,onSelect,onEdit,onCommit,onEditingChange,disabled,readOnly,showBounds,onError}} />
}
function RasterPage({ document, slide, renderedSlide, manifest, api, selectedId, onSelect, onEdit, onCommit, onEditingChange, disabled, readOnly, showBounds, onError }) {
  const [failed, setFailed] = useState(null)
  const [displayed, setDisplayed] = useState(null)
  const source = slide && manifest?.status === 'ready'
    ? api.getPageHref({ draftId: manifest.draftId, revision: manifest.revision, page: slide.number }) : null
  useEffect(() => {
    if (!source) return
    let active = true
    const image = new Image()
    image.onload = () => { if (active) { setDisplayed({ source, slideId: slide.id, renderedSlide }); setFailed(null) } }
    image.onerror = () => { if (active) { setFailed(source); onError?.('此页精确预览读取失败，编辑内容已保留；可点击“更新预览”重试。') } }
    image.src = source
    return () => { active = false; image.onload = null; image.onerror = null }
  }, [source, renderedSlide, manifest])
  const visible = displayed?.slideId === slide?.id ? displayed : null
  const failedHere = Boolean(source && failed === source && !visible)
  return <div className={`wtt-ppt-page-wrap${showBounds ? ' show-object-bounds' : ''}`}>
    <div className="wtt-ppt-page" style={{ aspectRatio: `${document.width} / ${document.height}` }} aria-label={`第 ${slide?.number || 1} 页实际预览`}>
      {visible ? <img key={visible.source} src={visible.source} alt={`第 ${slide.number} 页课件预览`} draggable={false} />
        : <div className="wtt-ppt-page-empty" role="status">{failedHere ? '此页预览读取失败。' : '正在准备课件预览…'}</div>}
      {!readOnly && visible && <PptTextLayer key={slide.id} document={document} slide={slide} renderedSlide={visible.renderedSlide}
        selectedId={selectedId} onSelect={onSelect} onEdit={onEdit} onCommit={onCommit} onEditingChange={onEditingChange} disabled={disabled} />}

    </div>
  </div>
}

export function PptEditor(props) {
  const key = scopeIdentity(props.scope)
  return <PptEditorSession key={key} {...props} />
}

function PptEditorSession({ onToggleWidth, widthExpanded, scope, api, onAiTask, onPublished, onBackgroundStatus, onClose, conversation, conversationSessionId, onOpenConversation, downloadHref }) {
  const identity = scopeIdentity(scope)
  const [draft, setDraft] = useState(null)
  const [document, setDocument] = useState(null)
  const [slideId, setSlideId] = useState(null)
  const [elementId, setElementId] = useState(null)
  const [showBounds, setShowBounds] = useState(false)
  const [localExpanded, setExpanded] = useState(false)
  const expanded = onToggleWidth ? widthExpanded : localExpanded
  const [pageQuery, setPageQuery] = useState('')
  const [manifest, setManifest] = useState(null)
  const [renderedDocument, setRenderedDocument] = useState(null)
  const [inlineEditing, setInlineEditing] = useState(false)
  const inlinePreviewRequest = useRef(0)
  const previewQueue = useRef(null), editing = useRef(false)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saveState, setSaveState] = useState('loading')
  const [recoveryConflict, setRecoveryConflict] = useState(false)
  const [publicationRefreshFailed, setPublicationRefreshFailed] = useState(false)
  const [busy, setBusy] = useState(() => publishingJobs.get(identity)?.status === 'running' ? 'publish' : '')
  const [aiInstruction, setAiInstruction] = useState('')
  const [aiScope, setAiScope] = useState('page')
  const [taskId, setTaskId] = useState(null)
  const [aiPackage, setAiPackage] = useState(null)
  const [pollRound, setPollRound] = useState(0)
  const [pollError, setPollError] = useState('')
  const [candidateManifest, setCandidateManifest] = useState(null)
  const [candidateError, setCandidateError] = useState('')
  const [candidateBusy, setCandidateBusy] = useState(false)
  const [executionOpen, setExecutionOpen] = useState(false)
  const mounted = useRef(true)
  const apiRef = useRef(api)
  apiRef.current = api
  const server = useRef(null)
  const current = useRef(null)
  const saving = useRef(null)
  const pauseAutosave = useRef(false)
  const previewGeneration = useRef(0)
  const operations = useRef(new Map())
  const publication = useRef(null)
  const aiTask = aiPackage?.task
  const pending = Boolean(taskId && (!aiPackage || ['waiting', 'pending'].includes(aiPackage.status)))
  const proposal = aiPackage?.status === 'pending' ? aiPackage.proposal : null
  const page = document?.slides.find(item => item.id === slideId) || document?.slides[0]
  const element = page?.elements.find(item => item.id === elementId)
  const dirty = draft && document ? pptDocumentChanges(draft.baseDocument || server.current.document, document).length > 0 : false
  const unsaved = draft && document ? pptDocumentChanges(server.current.document, document).length > 0 : false
  const previewCurrent = manifest?.draftId === draft?.id && manifest?.revision === draft?.revision && !unsaved
  const disabled = Boolean(busy || pending || publicationRefreshFailed)
  const showConversation = Boolean(conversation && aiTask?.sessionId && aiTask.sessionId === conversationSessionId)
  const waitingMessage = aiTask?.status === 'unknown' ? '发送状态待核对，请展开任务对话查看原会话；不会自动重发。'
    : aiTask?.status === 'submitting' ? '正在发送到任务对话…'
      : aiTask?.status === 'draft' ? '修改任务已创建，等待任务对话发送。'
        : aiTask?.status === 'accepted' ? '修改请求已提交，正在等待 AI 返回结果。原课件保留。'
          : '正在等待 AI 修改结果；原课件保留。'

  function operation(kind, input) {
    const key = `${kind}:${JSON.stringify(input)}`
    if (!operations.current.has(key)) operations.current.set(key, crypto.randomUUID())
    return operations.current.get(key)
  }

  function rememberRecovery(failure) {
    if (!server.current || !current.current) return
    if (!pptDocumentChanges(server.current.document, current.current).length) { recoveries.delete(identity); return }
    recoveries.set(identity, { revision: server.current.revision, previous: server.current.document, document: current.current,
      error: failure === undefined ? recoveries.get(identity)?.error || null : failure })
  }

  async function persist() {
    if (saving.current) { await saving.current; return persist() }
    if (!server.current || !current.current) return null
    const submitted = current.current
    const pages = pptDocumentChanges(server.current.document, submitted)
    if (!pages.length) return server.current
    if (mounted.current) setSaveState('saving')
    const input = { draftId: server.current.id, revision: server.current.revision, pages }
    const promise = apiRef.current.saveDraft(input).then(result => {
      checkPptDocument(result?.document)
      if (result.id !== input.draftId || !Number.isInteger(result.revision) || result.revision < input.revision) throw new Error('草稿保存回执与当前课件不一致，请重新读取。')
      const retained = retainLaterPptEdits(submitted, current.current, result.document)
      server.current = result
      current.current = retained
      rememberRecovery(null)
      pauseAutosave.current = false
      if (mounted.current) {
        setDraft(result); setDocument(retained)
        setSaveState(pptDocumentChanges(result.document, retained).length ? 'unsaved' : 'saved')
      }
      return result
    }).catch(cause => {
      pauseAutosave.current = true
      rememberRecovery(messageOf(cause))
      if (mounted.current) { setSaveState('error'); setError(`草稿保存失败：${messageOf(cause)}。当前输入已保留，请核对后重试。`) }
      throw cause
    }).finally(() => { if (saving.current === promise) saving.current = null })
    saving.current = promise
    return promise
  }

  async function refreshPreview(target, signal, latestOnly = false) {
    const generation = ++previewGeneration.current
    if (mounted.current) { setPreviewBusy(true); setPreviewError('') }
    try {
      const result = await apiRef.current.preview({ draftId: target.id, revision: target.revision, latestOnly }, { signal })
      if (result?.status === 'superseded') return
      if (result?.status !== 'ready') throw new Error(result?.error || '课件预览未生成。')
      if (result.draftId !== target.id || result.revision !== target.revision) throw new Error('实际预览与当前草稿修订不一致。')
      if (mounted.current && generation === previewGeneration.current && server.current?.id === target.id
        && server.current.revision === target.revision && !pptDocumentChanges(server.current.document, current.current).length) {
        setManifest(result); setRenderedDocument(target.document)
      }
    } catch (cause) {
      if (mounted.current && generation === previewGeneration.current && cause.name !== 'AbortError') setPreviewError(`预览更新失败：${messageOf(cause)}`)
    } finally { if (mounted.current && generation === previewGeneration.current) setPreviewBusy(false) }
  }

  useEffect(() => {
    const controller = new AbortController()
    mounted.current = true
    previewQueue.current = createPptPreviewQueue(async target => {
      if (!mounted.current || editing.current || server.current?.id !== target.id || server.current?.revision !== target.revision
        || pptDocumentChanges(server.current.document, current.current).length) return
      return refreshPreview(target, controller.signal, true)
    })
    const publishing = publishingJobs.get(identity)
    if (publishing?.status === 'running') void publishing.promise.catch(() => {}).finally(() => {
      if (!mounted.current) return
      setBusy('')
      if (publishing.error) setError(`后台保存未完成：${messageOf(publishing.error)}。请核对文件后重试，当前草稿保留。`)
      else if (publishing.result) void refreshPublishedDraft({ submitted: publishing.submitted, result: publishing.result })
    })
    else if (publishing?.error) setError(`上次后台保存未完成：${messageOf(publishing.error)}。请核对文件后重试，当前草稿保留。`)
    Promise.resolve(closingSaves.get(identity)).catch(() => {}).then(() => apiRef.current.open(scope, { signal: controller.signal })).then(result => {
      checkPptDocument(result?.document)
      if (!result.id || !Number.isInteger(result.revision)) throw new Error('服务端未返回有效课件草稿。')
      if (!mounted.current) return
      const recovery = recoveries.get(identity)
      const restored = recovery ? recoverPptLocalEdits(recovery.previous, recovery.document, result.document) : null
      const next = restored?.document || result.document
      const needsSave = pptDocumentChanges(result.document, next).length > 0
      server.current = result; current.current = next
      setDraft(result); setDocument(next); setSlideId(next.slides[0].id); setSaveState('saved')
      if (restored?.conflicts.length || needsSave && recovery?.error) {
        pauseAutosave.current = true; setSaveState('error'); setRecoveryConflict(Boolean(restored?.conflicts.length))
        setError(restored?.conflicts.length ? '已保存的草稿也修改了相同文字或备注。未保存输入已恢复，请明确选择保留本地修改或使用已保存的草稿。'
          : `上次未保存的输入已恢复。此前保存失败：${recovery.error}。请核对后重试保存草稿。`)
      }
      rememberRecovery(restored?.conflicts.length ? '存在尚未确认的已保存的草稿冲突，请先选择保留哪份修改。' : undefined)
      if (result.pendingTaskId) setTaskId(result.pendingTaskId)
      void refreshPreview(result, controller.signal)
    }).catch(cause => { if (mounted.current && cause.name !== 'AbortError') { setError(`读取课件失败：${messageOf(cause)}`); setSaveState('error') } })
    return () => {
      mounted.current = false
      controller.abort()
      previewQueue.current?.close()
      previewGeneration.current += 1
      if (!pauseAutosave.current) {
        const previousSave = closingSaves.get(identity)
        const pendingSave = previousSave ? Promise.resolve(previousSave).catch(() => {}).then(() => persist()) : persist()
        closingSaves.set(identity, pendingSave)
        void pendingSave.catch(cause => console.error('PPT 编辑器关闭前草稿保存失败，输入保留待恢复：', cause))
          .finally(() => { if (closingSaves.get(identity) === pendingSave) closingSaves.delete(identity) })
      }
    }
  }, [])

  useEffect(() => {
    if (!document || !server.current || pauseAutosave.current || pending || busy || inlineEditing || !unsaved) return
    const timer = setTimeout(() => { void persist().catch(() => {}) }, 650)
    return () => clearTimeout(timer)
  }, [document, pending, busy, unsaved, inlineEditing])

  useEffect(() => {
    if (!taskId) return
    let ended = false, timer, count = 0
    const controller = new AbortController()
    async function query() {
      try {
        const result = await apiRef.current.proposal({ taskId }, { signal: controller.signal })
        if (ended) return
        if (result.task?.id !== taskId || !['waiting', 'pending', 'confirmed', 'discarded', 'failed', 'applied'].includes(result.status)) throw new Error('AI 修改回执与当前任务不一致。')
        setAiPackage(result); setPollError('')
        if (result.status !== 'waiting') return
        count += 1
        if (count >= POLL_LIMIT) { setPollError('本轮查询尚未取得候选。任务已保留，可继续查询；不会重新发送。'); return }
        timer = setTimeout(query, 4000)
      } catch (cause) {
        if (!ended && cause.name !== 'AbortError') setPollError(`查询 AI 修改失败：${messageOf(cause)}。任务已保留，请继续查询或展开执行记录核对。`)
      }
    }
    void query()
    return () => { ended = true; clearTimeout(timer); controller.abort() }
  }, [taskId, pollRound])

  useEffect(() => {
    if (!proposal) { setCandidateManifest(null); setCandidateError(''); return }
    let ended = false
    const controller = new AbortController()
    setCandidateBusy(true); setCandidateError(''); setCandidateManifest(null)
    apiRef.current.preview({ draftId: proposal.draftId, revision: proposal.revision }, { signal: controller.signal }).then(result => {
      if (result?.status !== 'ready') throw new Error(result?.error || 'AI 修改结果预览未生成。')
      if (result.draftId !== proposal.draftId || result.revision !== proposal.revision) throw new Error('AI 修改结果预览与当前任务不一致。')
      if (!ended) setCandidateManifest(result)
    }).catch(cause => { if (!ended && cause.name !== 'AbortError') setCandidateError(`修改预览失败：${messageOf(cause)}`) })
      .finally(() => { if (!ended) setCandidateBusy(false) })
    return () => { ended = true; controller.abort() }
  }, [proposal?.id, pollRound])

  function changeText(value, notes = false) {
    if (!page || disabled || !notes && !element) return
    try {
      const result = patchPptText(current.current, page.id, notes ? null : element.id, value)
      current.current = result; rememberRecovery(); setDocument(result); setSaveState('unsaved'); setNotice('')
    } catch (cause) { setError(messageOf(cause)) }
  }

  function changeInlineText({ slideId, elementId, text }) {
    if (disabled) return
    try {
      const result = patchPptText(current.current, slideId, elementId, text)
      current.current = result; rememberRecovery(); setDocument(result); setSaveState('unsaved'); setNotice('')
    } catch (cause) { setError(messageOf(cause)) }
  }

  function setEditing(active) {
    editing.current = active; setInlineEditing(active)
    if (active) previewQueue.current?.pause()
    else previewQueue.current?.resume()
  }

  function commitInlinePreview(result = {}) {
    if (pauseAutosave.current || disabled || !draft || !result.changed && previewCurrent) return
    const request = ++inlinePreviewRequest.current
    void persist().then(saved => {
      if (saved && mounted.current && request === inlinePreviewRequest.current) return previewQueue.current?.schedule(saved)
    }).catch(() => {})
  }

  function chooseElement(id) { setElementId(id || null); setAiScope(id ? 'element' : 'page') }
  function chooseSlide(id) { setSlideId(id); setElementId(null); setAiScope('page') }

  function reloadDraft() {
    void action('reload', async () => {
      if (publication.current) { await refreshPublishedDraft(publication.current); return }
      if (saving.current) await saving.current.catch(() => {})
      const before = server.current.document, local = current.current
      const result = await apiRef.current.open(scope)
      checkPptDocument(result.document)
      const restored = recoverPptLocalEdits(before, local, result.document)
      server.current = result; current.current = restored.document
      setDraft(result); setDocument(restored.document)
      const conflicts = restored.conflicts.length > 0
      pauseAutosave.current = conflicts; setRecoveryConflict(conflicts); setSaveState(conflicts ? 'error' : 'unsaved'); rememberRecovery(conflicts ? '存在尚未确认的已保存的草稿冲突，请先选择保留哪份修改。' : null)
      if (result.pendingTaskId) { setTaskId(result.pendingTaskId); setPollRound(value => value + 1) }
      if (conflicts) setError('已保存的草稿也修改了相同文字或备注。当前输入已保留，请选择保留我的修改或使用已保存的草稿。')
      else setNotice('已读取已保存的草稿并恢复本地输入；其他位置的修改已保留。')
    })
  }

  async function action(kind, apply) {
    if (busy) return
    setBusy(kind); setError(''); setNotice('')
    try { await apply() }
    catch (cause) { if (mounted.current) setError(messageOf(cause)) }
    finally { if (mounted.current) setBusy('') }
  }

  function updatePreview() {
    inlinePreviewRequest.current += 1
    void action('preview', async () => {
      const result = await persist()
      if (result) await previewQueue.current?.schedule(result, { immediate: true })
    })
  }

  function saveVersion() {
    if (publishingJobs.get(identity)?.status === 'running') return
    const previous = publishingJobs.get(identity)
    const job = { status: 'running', submitted: null, result: null, error: null, promise: null }
    publishingJobs.set(identity, job)
    previewQueue.current?.cancel()
    onBackgroundStatus?.({ status: 'running' })
    // Keep the request alive when this panel closes. The frozen revision and
    // operation id also let a reopened panel observe, rather than duplicate it.
    job.promise = (async () => {
      const result = await persist()
      if (!result || !result.dirty) throw new Error('当前课件没有需要保存为新版本的修改。')
      job.submitted = result.document; job.revision = result.revision
      const input = { draftId: result.id, revision: result.revision }
      job.operationId = previous?.error && previous.revision === result.revision ? previous.operationId : operation('publish', input)
      job.result = await apiRef.current.saveVersion({ ...input, operationId: job.operationId })
      job.status = 'saved'
      return job.result
    })()
    void action('publish', async () => {
      try {
        const published = await job.promise
        if (mounted.current) setNotice('已保存为同一卡片的新版本。')
        await refreshPublishedDraft({ submitted: job.submitted, result: published })
        onBackgroundStatus?.({ status: 'saved' })
        await notifyPublished(published)
      } catch (cause) {
        job.status = 'failed'; job.error = cause
        onBackgroundStatus?.({ status: 'failed', error: messageOf(cause) })
        throw cause
      } finally { if (job.status === 'saved' && publishingJobs.get(identity) === job) publishingJobs.delete(identity) }
    })
  }

  function sendAi() {
    if (!aiInstruction.trim() || !page || aiScope === 'element' && (!element || !editable(element))) return
    const target = { slideId: page.id, elementIds: aiScope === 'element' ? [element.id] : [], instruction: aiInstruction.trim() }
    void action('ai', async () => {
      const result = await persist()
      const input = { draftId: result.id, revision: result.revision, ...target }
      const created = await apiRef.current.createAiTask({ ...input, operationId: operation('ai', input) })
      if (!created.task?.id || !created.prepared) throw new Error('服务端未返回有效 AI 修改任务。')
      if (mounted.current) {
        setTaskId(created.task.id); setAiPackage({ status: 'waiting', task: created.task }); setPollError(''); setExecutionOpen(true)
        setDraft(value => ({ ...value, pendingTaskId: created.task.id }))
      }
      const reference = await onAiTask?.(created)
      if (mounted.current && reference?.sessionId) setAiPackage(value => value?.task?.id === created.task.id
        ? { ...value, task: { ...value.task, sessionId: reference.sessionId } } : value)
    })
  }

  function confirmProposal() {
    const candidate = proposal
    if (!candidate) return
    const submitted = server.current.document
    void action('confirm', async () => {
      const input = { taskId, proposalId: candidate.id }
      const result = await apiRef.current.confirm({ ...input, operationId: operation('confirm', input) })
      if (mounted.current) { setAiPackage(value => ({ ...value, status: 'confirmed', result })); setNotice('AI 修改已确认，并保存为同一卡片的新版本。') }
      await refreshPublishedDraft({ submitted, result })
      await notifyPublished(result)
    })
  }

  async function refreshPublishedDraft(checkpoint) {
    publication.current = checkpoint
    if (!mounted.current) return
    try {
      const latest = await apiRef.current.open(scope)
      if (!mounted.current) return
      if (latest.id !== checkpoint.result.draftId || latest.id !== server.current.id) throw new Error('保存后返回了其他课件草稿。')
      const restored = reconcilePublishedPptDraft(checkpoint.submitted, current.current, latest, checkpoint.result)
      server.current = latest; current.current = restored.document
      const conflicts = restored.conflicts.length > 0
      pauseAutosave.current = conflicts
      setDraft(latest); setDocument(restored.document); setRecoveryConflict(conflicts); setPublicationRefreshFailed(false)
      setSaveState(conflicts ? 'error' : restored.unsaved ? 'unsaved' : 'saved')
      if (latest.pendingTaskId && latest.pendingTaskId !== taskId) { setTaskId(latest.pendingTaskId); setAiPackage(null); setPollRound(value => value + 1) }
      if (conflicts) setError('新版已保存；已保存的草稿与发布后输入修改了相同对象。当前输入已保留，请选择保留我的修改或使用已保存的草稿。')
      else setError('')
      rememberRecovery(conflicts ? '存在尚未确认的已保存的草稿冲突，请先选择保留哪份修改。' : null)
      publication.current = null
    } catch (cause) {
      if (!mounted.current) return
      pauseAutosave.current = true
      setPublicationRefreshFailed(true); setSaveState('error')
      setError(`新版已保存，但草稿刷新失败：${messageOf(cause)}。请重新读取草稿后继续编辑，不要重复生成。`)
    }
  }

  async function notifyPublished(result) {
    try { await onPublished?.(result) }
    catch (cause) { if (mounted.current) setError(`新版已保存，但工作台刷新失败：${messageOf(cause)}。请刷新后核对已保存版本。`) }
  }

  function discardProposal() {
    if (!proposal) return
    const candidate = proposal
    void action('discard', async () => {
      const result = await apiRef.current.discard({ taskId, proposalId: candidate.id })
      if (mounted.current) {
        setAiPackage(result); setDraft(value => ({ ...value, pendingTaskId: null })); setNotice('AI 修改结果已放弃，原课件和手工草稿保留。')
      }
    })
  }

  function close() {
    if (busy === 'publish') { onClose?.(); return }
    if (publication.current) {
      void action('close', async () => {
        await refreshPublishedDraft(publication.current)
        if (!publication.current) { await persist(); onClose?.() }
      })
      return
    }
    if (!document || !unsaved) { onClose?.(); return }
    void action('close', async () => { await persist(); onClose?.() })
  }

  function keyboard(event) {
    event.stopPropagation()
    if (event.nativeEvent?.isComposing) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      if (dirty && !disabled) saveVersion()
    }
  }

  const candidateDocument = proposal?.document
  const candidateSlide = candidateDocument?.slides?.find(item => item.id === proposal?.changes?.[0]?.slideId)
    || candidateDocument?.slides?.find(item => item.id === page?.id) || candidateDocument?.slides?.[0]
  return <aside className={`wtt-ppt-editor nodrag nopan nowheel${expanded ? ' is-expanded' : ''}`} aria-label="PPT 页内编辑" onKeyDown={keyboard} onKeyUp={stop}
    onPointerDown={stop} onClick={stop} onDoubleClick={stop} onWheel={stop}>
    <PanelHeader title={scope.title || '课程课件'} subtitle={`PPT${scope.number ? ` · V${scope.number}` : ''} · 页内编辑`} downloadHref={downloadHref} downloadLabel="下载已保存版本" expanded={expanded} onToggleWidth={() => onToggleWidth ? onToggleWidth() : setExpanded(value => !value)} onClose={close} closeDisabled={Boolean(busy && busy !== 'publish')} closeLabel="关闭 PPT 编辑器" />
    <PanelToolbar>
      <UiButton onClick={updatePreview} disabled={!draft || disabled || previewBusy}>{previewBusy ? '更新预览中…' : '更新预览'}</UiButton>
      <UiButton variant="primary" onClick={saveVersion} disabled={!draft || disabled || !dirty}>{busy === 'publish' ? '保存中…' : '保存新版本'}</UiButton>
    </PanelToolbar>
    <div className="wtt-ppt-editor-status" role="status">
      <span>{saveState === 'loading' ? '正在读取课件…' : saveState === 'saving' ? '正在保存草稿…' : saveState === 'error' ? '草稿未能保存' : unsaved ? '有未保存输入' : dirty ? '草稿已保存 · 尚未保存新版本' : '与原版本一致'}</span>
      {draft && <span>{busy === 'publish' ? '正在后台生成新版本，可关闭面板继续浏览' : previewBusy ? '精确预览后台更新中，可继续编辑' : previewError ? '精确页图暂不可用，编辑内容保留' : previewCurrent ? '精确预览已更新' : '编辑画面 · 停止输入后更新精确预览'}</span>}
    </div>
    {error && <div className="wtt-ppt-message is-error" role="alert"><UserError error={error} announce={false} />{(saveState === 'error' || pauseAutosave.current) && draft && <>{!publicationRefreshFailed && <UiButton variant="quiet" type="button" onClick={() => void action('retry', async () => { pauseAutosave.current = false; await persist(); setRecoveryConflict(false) })} disabled={Boolean(busy)}>{recoveryConflict ? '保留我的修改并保存' : '重试保存草稿'}</UiButton>}{!recoveryConflict && <UiButton variant="quiet" type="button" disabled={Boolean(busy)} onClick={reloadDraft}>重新读取并保留输入</UiButton>}</>}{recoveryConflict && <UiButton variant="quiet" type="button" disabled={Boolean(busy)} onClick={() => {
      current.current = server.current.document; recoveries.delete(identity); pauseAutosave.current = false; setDocument(server.current.document); setSaveState('saved'); setError(''); setRecoveryConflict(false)
    }}>使用已保存的草稿</UiButton>}</div>}
    {notice && <div className="wtt-ppt-message" role="status">{notice}</div>}
    {!document ? <div className="wtt-ppt-loading">{saveState === 'loading' ? '正在读取课件中的文字…' : '课件暂时无法打开；原文件保留。'}</div>
      : <div className="wtt-ppt-editor-body">
        <nav className="wtt-ppt-slides" aria-label="课件页列表"><input aria-label="搜索课件页面" placeholder="搜索页面" value={pageQuery} onChange={event => setPageQuery(event.target.value)} />{document.slides.filter(slide => !pageQuery || `${slide.number} ${slideLabel(slide)} ${slide.elements.map(item => item.text).join(' ')}`.toLowerCase().includes(pageQuery.toLowerCase())).map(slide => <UiButton variant="custom" key={slide.id} type="button"
          className={page?.id === slide.id ? 'is-selected' : ''} aria-current={page?.id === slide.id ? 'page' : undefined}
          onClick={() => chooseSlide(slide.id)} aria-label={`选择第 ${slide.number} 页`}>
          {manifest?.status === 'ready' && <img src={api.getPageHref({ draftId: manifest.draftId, revision: manifest.revision, page: slide.number })} alt="" loading="lazy" draggable={false} />}
          <span>第 {slide.number} 页</span><small>{slideLabel(slide)}</small>
        </UiButton>)}</nav>
        <div className="wtt-ppt-editor-workspace">
          <div className="wtt-ppt-section-heading"><strong>第 {page.number} 页</strong><span>{page.elements.filter(editable).length} 个可编辑文字框</span></div>
          <label className="wtt-ppt-bounds-toggle"><input type="checkbox" checked={showBounds} onChange={event => setShowBounds(event.target.checked)} />显示可编辑区域</label>
          <ActualPage document={document} slide={page} renderedSlide={renderedDocument?.slides.find(item => item.id === page.id)} manifest={manifest} api={api}
            selectedId={elementId} onSelect={chooseElement} onEdit={changeInlineText} onCommit={commitInlinePreview} onEditingChange={setEditing}
            disabled={disabled} showBounds={showBounds} onError={setPreviewError} />
          <p className="wtt-ppt-preview-note">{inlineEditing ? '直接输入文字 · Enter 换行 · Esc 取消本次输入' : '单击改字，草稿自动保存；精确预览在后台更新。'}</p>
          {previewError && <UserError className="wtt-ppt-message is-error" error={previewError} />}
          {!!manifest?.warnings?.length && <details className="wtt-ppt-render-warnings"><summary>渲染提示 · {manifest.warnings.length}</summary>{manifest.warnings.map((warning, index) => <p key={index}>{typeof warning === 'string' ? warning : [warning.source, warning.message].filter(Boolean).join('：')}</p>)}</details>}
          <details className="wtt-ppt-text-section" aria-label="更多文字编辑"><summary>更多文字编辑</summary>
            <label className="wtt-ppt-field"><span>文字对象</span><select value={element?.id || ''} onChange={event => chooseElement(event.target.value)}>
              <option value="">选择页内文字对象</option>{page.elements.map(item => <option key={item.id} value={item.id}>{objectLabel(item)}{editable(item) ? '' : ' · 只读'}</option>)}
            </select></label>
            {element ? <><div className="wtt-ppt-object-meta"><span title={element.name}>{objectLabel(element)}</span><span>{editable(element) ? '可编辑文字' : '只读'}</span></div>
              <textarea className="wtt-ppt-text-input" aria-label="编辑所选 PPT 文字" value={element.text} maxLength={100000}
                readOnly={disabled || !editable(element)} onChange={event => changeText(event.target.value)} spellCheck={false} />
              {!editable(element) && <p className="wtt-ppt-readonly-reason" role="status">{element.reason || '此对象暂不能安全修改，原内容保留。'}</p>}
            </> : <p className="wtt-ppt-hint">从页图或列表选文字。图片中的字不能直接编辑。</p>}
          </details>
          <details className="wtt-ppt-notes"><summary>讲师备注</summary><textarea aria-label="编辑本页讲师备注" value={page.notes || ''}
            maxLength={100000} readOnly={disabled || page.notesEditable === false} onChange={event => changeText(event.target.value, true)} spellCheck={false} placeholder="补充本页讲师备注…" />
            {page.notesEditable === false && <p className="wtt-ppt-readonly-reason" role="status">{page.notesReason || '此页讲师备注暂不能安全修改，原备注保留。'}</p>}</details>
          <section className="wtt-ppt-ai" aria-label="局部 AI 修改">
            <div className="wtt-ppt-section-heading"><strong>交给 AI 修改</strong><span>先检查修改结果，再确认保存</span></div>
            <div className="wtt-ppt-ai-scope" role="group" aria-label="AI 修改范围">
              <UiButton variant="quiet" type="button" aria-pressed={aiScope === 'page'} onClick={() => setAiScope('page')} disabled={disabled}>当前整页</UiButton>
              <UiButton variant="quiet" type="button" aria-pressed={aiScope === 'element'} onClick={() => setAiScope('element')} disabled={disabled || !element || !editable(element)}>所选文字</UiButton>
            </div>
            <textarea aria-label="本页 AI 修改要求" value={aiInstruction} maxLength={8000} onChange={event => setAiInstruction(event.target.value)}
              readOnly={disabled} placeholder={aiScope === 'element' ? '描述希望如何修改所选文字…' : '描述希望如何调整本页文字或讲师备注…'} />
            <div className="wtt-ppt-ai-submit"><span>{aiScope === 'element' ? element?.name || '请先选择文字对象' : `仅第 ${page.number} 页；保留其他页和版式`}</span>
              <UiButton variant="primary" type="button" className="is-primary" disabled={disabled || !aiInstruction.trim() || aiScope === 'element' && (!element || !editable(element)) || !onAiTask} onClick={sendAi}>{busy === 'ai' ? '提交中…' : proposal ? '等待确认修改' : pending ? 'AI 修改处理中' : '生成待确认修改'}</UiButton></div>
            {taskId && <div className="wtt-ppt-ai-status" role="status">{aiPackage?.status === 'pending' ? 'AI 修改结果已准备，确认后才生成新版本。' : aiPackage?.status === 'confirmed' ? '这次修改已确认保存。' : aiPackage?.status === 'applied' ? '这次修改已应用到源稿草稿，尚未保存新版PPT。' : aiPackage?.status === 'discarded' ? '这次修改已放弃。' : aiPackage?.status === 'failed' ? `AI 修改失败：${aiPackage.error || aiTask?.error || '请展开执行记录核对。'}` : waitingMessage}</div>}
            {pollError && <div className="wtt-ppt-message is-error" role="alert"><UserError error={pollError} announce={false} /><UiButton variant="quiet" type="button" onClick={() => { setPollError(''); setPollRound(value => value + 1) }}>继续查询</UiButton></div>}
            {aiTask?.sessionId && !showConversation && onOpenConversation && <UiButton variant="quiet" type="button" disabled={Boolean(busy)} onClick={() => void action('restore-session', async () => { setExecutionOpen(true); await onOpenConversation(aiTask.sessionId) })}>打开任务对话</UiButton>}
            {showConversation && <details className="wtt-ppt-execution" open={executionOpen} onToggle={event => setExecutionOpen(event.currentTarget.open)}><summary>任务对话</summary><div>{conversation}</div></details>}
          </section>
          {proposal && <section className="wtt-ppt-proposal" aria-label="AI 待确认修改">
            <div className="wtt-ppt-section-heading"><strong>待确认修改</strong><span>尚未保存新版本</span></div>
            {proposal.changes.map((change, index) => <div key={`${change.slideId}:${change.elementId || 'notes'}:${index}`} className="wtt-ppt-change">
              <h3>第 {change.slideNumber} 页 · {change.kind === 'notes' ? '讲师备注' : change.name || '文字对象'}</h3><div className="wtt-ppt-change-columns"><div><span>修改前</span><pre>{change.before || '（空）'}</pre></div><div><span>修改后</span><pre>{change.after || '（空）'}</pre></div></div>
            </div>)}
            {candidateDocument && <><div className="wtt-ppt-section-heading"><strong>修改预览 · 第 {candidateSlide?.number} 页</strong><span>{candidateBusy ? '正在渲染…' : candidateManifest ? '已按候选 PPTX 渲染' : '预览未就绪'}</span></div><ActualPage document={candidateDocument} slide={candidateSlide} manifest={candidateManifest} api={api} readOnly onError={setCandidateError} /></>}
            {candidateError && <div className="wtt-ppt-message is-error" role="alert"><UserError error={candidateError} announce={false} /><UiButton variant="quiet" type="button" onClick={() => setPollRound(value => value + 1)} disabled={Boolean(busy)}>重新读取修改预览</UiButton></div>}
            <div className="wtt-ppt-proposal-actions"><UiButton variant="quiet" type="button" onClick={discardProposal} disabled={Boolean(busy)}>放弃这次修改</UiButton><UiButton variant="primary" type="button" className="is-primary" onClick={confirmProposal} disabled={Boolean(busy) || candidateBusy || !candidateManifest}>{busy === 'confirm' ? '正在保存…' : '确认保存新版本'}</UiButton></div>
          </section>}
        </div>
      </div>}
  </aside>
}
