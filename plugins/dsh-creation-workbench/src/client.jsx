import { MediaServiceSettings } from './media-service-settings.jsx';
import { createMediaSettingsOperations } from './media-service-operations.mjs';
import { DialogBody, DialogFooter, DialogHeader, UiButton } from './ui/controls.jsx'
import { UserError } from './user-feedback.jsx'
import React, { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import './workbench.css'
import './theme.css'
import { startCourseSession } from './session.mjs'
import { acquireCourseConversation,createEditorSessionAcquirer } from './session.mjs'
import {createNativeEditorBridge} from './native-editor-bridge.mjs'
import {NativeEditorConversation,NativeEditorInputDock} from './native-editor-conversation.jsx'
import { restoreCourseConversation, watchCourseTaskSessions, createPreviewSessionAcquirer, isMissingCourseSession } from './session.mjs'
import { NATIVE_PREVIEW_CHILDREN, registerNativePreview, HostFilePreview } from './native-preview.jsx'
import { CourseCanvas } from './canvas.jsx'
import { ProjectRecycleDialog } from './canvas-recycle.jsx'
import { ProjectExplorer, ProjectFilePreview } from './project-explorer.jsx'
import { ProjectPicker } from './project-picker.jsx'
import { normalizeModelCatalog, openNativeModelSettings } from './model-selection.mjs'
import { CANVAS_CONVERSATION_SLOT, CANVAS_CONVERSATION_CHILDREN, registerCanvasConversation } from './embedded-conversation.jsx'
import { conversationFileSelection, nativeConversationFilePath } from './conversation-file.mjs'
import './ui/controls.css'
import './card-reference-ui.css'

const PANEL_ID = 'wtt-creation-workbench'
const EMPTY_SESSION_STATUSES = new Map()

export const name = 'wtt-creation-workbench-client'
export const inject = ['slots', 'layout', 'remote', 'remote.session', 'remote.workspace', 'remote.skills', 'uiWorkspace', 'sessions', 'uiSession', 'uiConversation', 'inputTriggers', 'remote.userQuestions','locale','sidebarRightTabs','remote.workspaceFiles','configForms','resources','remote.settings','remote.credentials','settingsSchema']

function endpoint(query = {}, projectId) {
  const url = new URL('api/wtt-creation-workbench', document.baseURI)
  if (projectId) url.searchParams.set('projectId', projectId)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url
}

async function apiRequest(action, data, projectId, query, signal) {
  const response = await fetch(endpoint(query, projectId), {
    credentials: 'same-origin',
    signal,
    ...(action ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, data }),
    } : {}),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || body?.ok === false) {
    const error = body?.error
    throw new Error(typeof error === 'string' ? error : error?.message || body?.message || `请求失败（${response.status}）`)
  }
  if (body === null) throw new Error('服务器未返回有效数据，请刷新后重试。')
  return body
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function operationId(attempt, payload) {
  const signature = JSON.stringify(payload)
  if (attempt.current?.signature !== signature) {
    attempt.current = { signature, id: crypto.randomUUID() }
  }
  return attempt.current.id
}

function formatTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未记录' : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

function BookIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 5.5C9 3.7 5.5 3.7 3 4.5v15c2.5-.8 6-.8 9 1 3-1.8 6.5-1.8 9-1v-15c-2.5-.8-6-.8-9 1Z" />
    <path d="M12 5.5v15M6 8h3M15 8h3" />
  </svg>
}

function CanvasProjectBar({ workspace, project, onToggleFiles, filesOpen, selectedId, busy, loading, onSelect, onNew, onList, onRefresh, onRename, onModelSettings, onSyncDeliverables, onBackground }) {
  const menuId = useId()
  const [menuOpen, setMenuOpen] = useState(false)
  const menu = useRef(null)
  useEffect(() => {
    if (!menuOpen) return
    const dismissOutside = event => { if (!menu.current?.contains(event.target)) setMenuOpen(false) }
    const dismissOnEscape = event => { if (event.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [menuOpen])
  return <header className="wtt-project-bar" aria-label="当前画布">
    <h1 className="wtt-visually-hidden">创作画布</h1>
    {!filesOpen&&<UiButton variant="ghost" type="button" className="wtt-open-files" aria-label={`打开文件栏 · ${project.name}`} title={`打开文件栏 · ${project.name}`} onClick={onToggleFiles} aria-expanded={false}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M3 7V5h7l2 2h9v13H3Z" /></svg>
      <span className="wtt-open-files-name">{project.name||'文件栏'}</span>
    </UiButton>}
    <select className="wtt-project-select" aria-label="当前画布" title={workspace?.requirements?.find(item => item.id === selectedId)?.title || '选择画布'} value={selectedId || ''} disabled={!workspace || Boolean(busy)} onChange={event => onSelect(workspace.requirements.find(item => item.id === event.target.value))}>
      {!selectedId && <option value="">{loading ? '正在读取画布…' : '选择一张画布'}</option>}
      {(workspace?.requirements || []).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
    </select>
    <span className="wtt-project-divider" aria-hidden="true" />
    <UiButton variant="quiet" type="button" className="wtt-project-button" aria-label="新建画布" title="新建画布" disabled={!workspace || Boolean(busy)} onClick={onNew}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
    </UiButton>
    <div className="wtt-project-menu" ref={menu}>
      <UiButton variant="quiet" type="button" className="wtt-project-button" aria-label="画布菜单" title="画布菜单" aria-expanded={menuOpen} aria-controls={menuId} aria-haspopup="menu" onClick={() => setMenuOpen(open => !open)}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
      </UiButton>
      {menuOpen && <div className="wtt-project-options" id={menuId} role="menu" aria-label="画布菜单">
        <UiButton variant="custom" type="button" role="menuitem" onClick={() => { setMenuOpen(false); onList() }}>列表编辑<span>查看大纲与版本</span></UiButton>
        <UiButton variant="custom" type="button" role="menuitem" disabled={!selectedId || Boolean(busy)} onClick={() => { setMenuOpen(false); onRename() }}>重命名画布</UiButton>
        <UiButton variant="custom" type="button" role="menuitem" disabled={!selectedId || Boolean(busy)} onClick={() => { setMenuOpen(false); onBackground() }}>背景资料</UiButton>
        <UiButton variant="custom" type="button" role="menuitem" disabled={Boolean(busy)} onClick={() => { setMenuOpen(false); onSyncDeliverables() }}>整理成果文件夹<span>按白板名称整理全部已保存版本</span></UiButton>
        <UiButton variant="custom" type="button" role="menuitem" onClick={() => { setMenuOpen(false); onModelSettings() }}>模型设置<span>连接第三方模型或自定义 API</span></UiButton>
        <UiButton variant="custom" type="button" role="menuitem" onClick={() => { setMenuOpen(false); onRefresh() }} disabled={loading || Boolean(busy)}>{loading ? '读取中…' : '刷新画布'}</UiButton>
      </div>}
    </div>
  </header>
}

function dependencyRows(dependencies) {
  if (Array.isArray(dependencies)) return dependencies.map((item, index) => [String(index), item])
  return Object.entries(dependencies || {}).filter(([key]) => key !== 'creationTypes')
}

function EnvironmentStatus({ dependencies }) {
  const rows = dependencyRows(dependencies)
  if (!rows.length) return null
  const labels = { python: 'Python', word: 'Word 转换', docx: 'Word 转换', skill: '课程技能', courseSkill: '课程技能', converter: 'Word 转换器' }
  return <details className="wtt-environment">
    <summary>环境检查</summary>
    <ul>
      {rows.map(([key, value]) => {
        const item = value && typeof value === 'object' ? value : {}
        const available = typeof value === 'boolean' ? value : item.available ?? item.ok ?? item.ready
        const status = available === true ? '可用' : available === false ? '待配置' : item.status || '已检测'
        const detail = item.message || item.error || item.path || (typeof value === 'string' ? value : '')
        return <li key={key}>
          <span>{item.label || item.name || labels[key] || key}</span>
          <span className={available === false ? 'wtt-status-warning' : 'wtt-muted'}>{status}</span>
          {detail && <span className="wtt-environment-detail">{detail}</span>}
        </li>
      })}
    </ul>
  </details>
}

const EMPTY_FORM = { title: '' }

function BackgroundDialog({ values, setValues, busy, error, onClose, onSubmit }) {
  const dialog = useRef(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return <dialog ref={dialog} className="wtt-dialog" aria-labelledby="wtt-new-title" onCancel={event => {
    event.preventDefault()
    if (!busy) onClose()
  }}>
    <form onSubmit={onSubmit}>
      <DialogHeader title="背景资料" titleId="wtt-new-title" onClose={onClose} busy={busy}/><DialogBody>
      <label className="wtt-field">
        <span>背景信息（选填）</span>
        <textarea autoFocus rows={6} maxLength={30000} value={values.background} onChange={event => setValues(previous => ({ ...previous, background: event.target.value }))} placeholder="直接描述这次需求，或粘贴对方发来的原话、资料和要求。" />
      </label>
      <p className="wtt-muted">只补充本次创作需要的背景，也可以直接引用文件。</p>
      {error && <UserError className="wtt-inline-error" error={error} />}
      </DialogBody><DialogFooter>
        <UiButton variant="quiet" type="button" className="wtt-button" disabled={busy} onClick={onClose}>取消</UiButton>
        <UiButton variant="primary" type="submit" className="wtt-button wtt-button-primary" disabled={busy}>{busy ? '正在保存…' : '保存背景'}</UiButton>
      </DialogFooter>
    </form>
  </dialog>
}

function RequirementBrief({ requirement }) {
  return <details className="wtt-brief">
    <summary>背景信息</summary>
    <div className="wtt-brief-content">
      <p>{requirement.background || '暂未填写背景信息'}</p>
    </div>
  </details>
}

function RenameRequirementDialog({ value, onChange, busy, error, onClose, onSubmit, creating = false }) {
  const dialog = useRef(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} className="wtt-dialog" aria-labelledby="wtt-rename-title" onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <form onSubmit={onSubmit}>
      <DialogHeader title={creating ? '新建画布' : '重命名画布'} titleId="wtt-rename-title" onClose={onClose} busy={busy}/><DialogBody>
      <label className="wtt-field"><span>画布名称{creating ? '（选填）' : ''}</span><input autoFocus required={!creating} maxLength={200} value={value} onChange={event => onChange(event.target.value)} /></label>
      {error && <UserError className="wtt-inline-error" error={error} />}
      </DialogBody><DialogFooter><UiButton variant="quiet" type="button" className="wtt-button" disabled={busy} onClick={onClose}>取消</UiButton><UiButton variant="primary" type="submit" className="wtt-button wtt-button-primary" disabled={busy || !creating && !value.trim()}>{busy ? '正在保存…' : creating ? '创建画布' : '保存名称'}</UiButton></DialogFooter>
    </form>
  </dialog>
}

function WorkbenchPage({ project, active, onChooseProject, onOpenProject, onStart, onStartCanvas, onRestoreCanvas, onPrepareContinuation, onWatchTaskSessions, acquirePreviewSession, acquireEditingSession,nativeEditorBridge,SessionProvider, renderSlot,
  modelCatalog, modelSelection, onModelChange, onRefreshModels, onOpenModelSettings, onOpenMediaSettings, onWatchMediaSettings, modelLoading, modelError, nativeSessionStatuses }) {
  const outlineTitleId = useId()
  const activeRef = useRef(active)
  activeRef.current = active
  const request = useCallback((action, data) => apiRequest(action, data, project.id), [project.id])
  const renderNativePreview = source => <HostFilePreview key={`${source.path}:${source.hash}`} source={source} project={project} active={active}
    acquire={acquirePreviewSession} SessionProvider={SessionProvider} renderSlot={renderSlot} />
  const renderEditorConversation=props=><NativeEditorConversation {...props} project={project} acquire={acquireEditingSession} bridge={nativeEditorBridge} SessionProvider={SessionProvider} renderSlot={renderSlot} onFileClick={openConversationFile} fileError={conversationFileError}/>
  const [deliverableFeedback, setDeliverableFeedback] = useState(null)
  const [workspace, setWorkspace] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [versionId, setVersionId] = useState(null)
  const [markdown, setMarkdown] = useState('')
  const [filter, setFilter] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [rename, setRename] = useState(null)
  const [renameError, setRenameError] = useState('')
  const [form, setForm] = useState(EMPTY_FORM)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')
  const [view, setView] = useState('canvas')
  const [filesOpen,setFilesOpen]=useState(false)
  const [projectFileSelection,setProjectFileSelection]=useState(null)
  const [conversationFileError,setConversationFileError]=useState(null)
  const [fileAddRequest,setFileAddRequest]=useState(null)
  const [recycleRequest,setRecycleRequest]=useState(null)
  const [fileRefresh,setFileRefresh]=useState(0)
  const [fileRecycleSignal,setFileRecycleSignal]=useState(null)
  const [backgroundEdit,setBackgroundEdit]=useState(null)
  const [backgroundError,setBackgroundError]=useState('')
  const backgroundAttempt=useRef(null)
  const previewProjectFile=entry=>{setProjectFileSelection({...entry,token:crypto.randomUUID()});if(window.innerWidth<=700)setFilesOpen(false)}
  function openConversationFile(event, sessionId = reference?.sessionId) {
    const file = nativeConversationFilePath(event.target.closest?.('button'))
    if (!file) return
    event.preventDefault()
    event.stopPropagation()
    try {
      previewProjectFile(conversationFileSelection(project.path, file))
      setConversationFileError(null)
    } catch (cause) {
      setConversationFileError({ sessionId, message: messageOf(cause) })
    }
  }
  const addProjectFile=entry=>{setFileAddRequest({...entry,projectId:project.id,requirementId:selectedId,token:crypto.randomUUID()});setProjectFileSelection(null);if(window.innerWidth<=700)setFilesOpen(false)}
  const [sessionGeneration, setSessionGeneration] = useState(0)
  const [sessionErrors, setSessionErrors] = useState({})
  const [canvasSignals, setCanvasSignals] = useState({})
  const canvasSessions = useRef(new Map())
  const retiredSessions = useRef(new Set())
  const sessionNavigation = useRef(new Map())
  const canvasDrafts = useRef(new Map())
  const creationDrafts = useRef(new Map())
  const createAttempt = useRef(null)
  const courseAttempt = useRef(null)
  const renameAttempt = useRef(null)
  const saveAttempt = useRef(null)
  const mounted = useRef(true)
  const selected = workspace?.requirements?.find(item => item.id === selectedId)
  if (selectedId && !canvasDrafts.current.has(selectedId)) canvasDrafts.current.set(selectedId, new Map())
  const draftCache = canvasDrafts.current.get(selectedId)
  if (selectedId && !creationDrafts.current.has(selectedId)) creationDrafts.current.set(selectedId, { drafts: new Map(), attempts: new Map(), activeKey: null, visible: false })
  const creationCache = creationDrafts.current.get(selectedId)
  const versions = selected?.versions || []
  const activeVersion = versions.find(version => version.id === versionId)
  const filtered = (workspace?.requirements || []).filter(item => `${item.title} ${item.customer || ''} ${item.audience || ''}`.toLowerCase().includes(filter.toLowerCase()))
  const dirty = markdown !== (activeVersion?.markdown || '')
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  async function chooseRequirement(requirement) {
    await creationDrafts.current.get(selectedId)?.beforeDocumentLeave?.()
    const latest = [...(requirement.versions || [])].sort((a, b) => b.number - a.number)[0]
    setSelectedId(requirement.id)
    setVersionId(latest?.id || null)
    setMarkdown(latest?.markdown || '')
    setError('')
    setNotice('')
    saveAttempt.current = null
  }

  async function load(initial = false) {
    setLoading(true)
    setLoadError('')
    try {
      const opened = await apiRequest(undefined, undefined, project.id, { canvasWorkspace: '1' })
      const { canvases, ...details } = opened
      const data = { ...details, requirements: canvases }
      if (!mounted.current) return
      setWorkspace(data)
      if (initial && data.requirements?.length) await chooseRequirement(data.requirements[0])
    } catch (cause) {
      if (mounted.current) setLoadError(messageOf(cause))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    void load(true)
    return () => {
      mounted.current = false
      const references = new Set([...canvasSessions.current.values(), ...retiredSessions.current])
      canvasSessions.current.clear()
      retiredSessions.current.clear()
      // SessionProvider does not own its reference. Let its scopes unmount first.
      queueMicrotask(() => { for (const reference of references) reference.release() })
    }
  }, [])

  useEffect(() => {
    const warnBeforeReload = event => {
      const hasCreationDraft = [...creationDrafts.current.values()].some(cache => [...cache.drafts.values()].some(draft => (draft.instruction?.trim() && draft.instruction.trim() !== (draft.originalInput?.instruction || '').trim()) || draft.materialContent?.trim() || draft.excerptDraft?.annotation?.trim() || (draft.excerptDraft?.selection && !draft.excerptDraft.saved)))
      if (!dirtyRef.current && !hasCreationDraft && ![...canvasDrafts.current.values()].some(cache => cache.size)) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeReload)
    return () => window.removeEventListener('beforeunload', warnBeforeReload)
  }, [])

  async function restoreCanvasSession(sessionId, requirementId, { automatic = false } = {}) {
    const generation = Symbol()
    sessionNavigation.current.set(requirementId, generation)
    if (canvasSessions.current.get(requirementId)?.sessionId === sessionId) {
      setSessionErrors(previous => ({ ...previous, [requirementId]: '' }))
      return { sessionId }
    }
    try {
      const reference = await onRestoreCanvas(sessionId, project)
      if (!mounted.current || sessionNavigation.current.get(requirementId) !== generation) { reference.release(); return }
      const replaced = canvasSessions.current.get(requirementId)
      if (replaced && replaced !== reference) retiredSessions.current.add(replaced)
      canvasSessions.current.set(requirementId, reference)
      setSessionGeneration(value => value + 1)
      setSessionErrors(previous => ({ ...previous, [requirementId]: '' }))
      return { sessionId }
    } catch (cause) {
      if (automatic && isMissingCourseSession(cause)) return
      if (mounted.current && sessionNavigation.current.get(requirementId) === generation) setSessionErrors(previous => ({ ...previous, [requirementId]: `恢复 AI 对话失败：${messageOf(cause)}` }))
      throw cause
    }
  }

  async function startCanvas(prepared) {
    const previous = canvasSessions.current.get(prepared.requirementId)
    const generation = Symbol()
    sessionNavigation.current.set(prepared.requirementId, generation)
    let identifiedSession
    let reference
    try {
      reference = await onStartCanvas(prepared, prepared.sessionId || (prepared.taskId ? undefined : previous?.sessionId), {
        beforePrompt: async ({ sessionId }) => {
          identifiedSession = sessionId
          if (prepared.taskId) {
            await request('set-task-dispatch', { taskId: prepared.taskId, status: 'submitting' })
            await request('bind-task-session', { taskId: prepared.taskId, sessionId })
          }
          await request('bind-canvas-session', { requirementId: prepared.requirementId, sessionId })
        },
      })
    } catch (cause) {
      let stateError = ''
      if (prepared.taskId) {
        try {
          await request('set-task-dispatch', { taskId: prepared.taskId,
            status: cause.submissionState === 'unknown' ? 'unknown' : 'failed', error: messageOf(cause) })
        } catch (journalError) { stateError = `；任务状态未保存：${messageOf(journalError)}` }
      }
      if (identifiedSession) cause.sessionId = identifiedSession
      if (identifiedSession && mounted.current && sessionNavigation.current.get(prepared.requirementId) === generation) {
        await restoreCanvasSession(identifiedSession, prepared.requirementId).catch(error => { stateError += `；恢复任务对话失败：${messageOf(error)}` })
      }
      if (stateError) throw Object.assign(new Error(`${messageOf(cause)}${stateError}`), { sessionId: identifiedSession, submissionState: cause.submissionState })
      throw cause
    }
    let stateError = ''
    if (prepared.taskId) {
      try { await request('set-task-dispatch', { taskId: prepared.taskId, status: 'accepted' }) }
      catch (cause) { stateError = `消息已受理，任务状态未保存，请核对会话：${messageOf(cause)}` }
    }
    const result = { sessionId: reference.sessionId }
    if (!mounted.current || sessionNavigation.current.get(prepared.requirementId) !== generation) { reference.release(); return result }
    const replaced = canvasSessions.current.get(prepared.requirementId)
    if (replaced && replaced !== reference) retiredSessions.current.add(replaced)
    canvasSessions.current.set(prepared.requirementId, reference)
    setSessionGeneration(value => value + 1)
    setSessionErrors(errors => ({ ...errors, [prepared.requirementId]: stateError }))
    return result
  }

  async function createRequirement(event) {
    event.preventDefault()
    const data = Object.fromEntries(Object.entries(form).map(([key, value]) => [key, value.trim()]))
    setBusy('create')
    setFormError('')
    try {
      const requirement = await request('create-canvas', { ...data, operationId: operationId(createAttempt, data) })
      setWorkspace(previous => ({ ...previous, requirements: [requirement, ...(previous?.requirements || []).filter(item => item.id !== requirement.id)] }))
      await chooseRequirement(requirement)
      setForm(EMPTY_FORM)
      createAttempt.current = null
      setShowNew(false)
      setNotice('画布已创建。')
    } catch (cause) {
      setFormError(messageOf(cause))
    } finally {
      setBusy('')
    }
  }

  function showBackground() {
    if (!selected) return
    backgroundAttempt.current = null
    setBackgroundError('')
    setBackgroundEdit({ canvasId: selected.id, background: selected.background, expectedBackground: selected.background })
  }

  async function saveBackground(event) {
    event.preventDefault()
    const data = { ...backgroundEdit }
    setBusy('background'); setBackgroundError('')
    try {
      const result = await request('save-canvas-background', { ...data, operationId: operationId(backgroundAttempt, data) })
      if (!mounted.current) return
      setWorkspace(previous => ({ ...previous, requirements: previous.requirements.map(item => item.id === result.id ? result : item) }))
      setFileRecycleSignal({token:crypto.randomUUID(),requirements:[result.id]})
      setBackgroundEdit(null)
    } catch (cause) { if (mounted.current) setBackgroundError(messageOf(cause)) }
    finally { if (mounted.current) setBusy('') }
  }

  function showRename() {
    if (!selected) return
    renameAttempt.current = null
    setRenameError('')
    setRename({ id: selected.id, title: selected.title })
  }

  async function renameRequirement(event) {
    event.preventDefault()
    if (!rename?.title.trim()) return
    const data = { canvasId: rename.id, title: rename.title.trim() }
    setBusy('rename'); setRenameError('')
    try {
      const result = await request('rename-canvas', { ...data, operationId: operationId(renameAttempt, data) })
      if (!mounted.current) return
      setWorkspace(previous => ({ ...previous, requirements: previous.requirements.map(item => item.id === result.id ? result : item) }))
      setCanvasSignals(signals => ({ ...signals, [result.id]: (signals[result.id] || 0) + 1 }))
      setRename(null)
    } catch (cause) {
      if (mounted.current) setRenameError(messageOf(cause))
    } finally {
      if (mounted.current) setBusy('')
    }
  }

  function rememberVersion(version) {
    setWorkspace(previous => ({
      ...previous,
      requirements: previous.requirements.map(requirement => requirement.id !== version.requirementId ? requirement : {
        ...requirement,
        versions: [...(requirement.versions || []).filter(item => item.id !== version.id), version].sort((a, b) => b.number - a.number),
      }),
    }))
  }

  async function saveOutline() {
    if (!selected || !markdown.trim()) return
    setBusy('save-outline')
    setError('')
    setNotice('')
    const data = { requirementId: selected.id, markdown }
    try {
      const version = await request('save-outline', { ...data, operationId: operationId(saveAttempt, data) })
      rememberVersion(version)
      setVersionId(version.id)
      setMarkdown(version.markdown)
      saveAttempt.current = null
      setNotice(`大纲 v${version.number} 已保存，已有版本保持不变。`)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy('')
    }
  }

  async function syncDeliverables() {
    setBusy('sync-deliverables'); setError(''); setNotice('正在整理成果文件夹，原文件保留…');
    setDeliverableFeedback({ status: 'pending', text: '正在整理成果文件夹，原文件保留…' });
    try {
      const result = await request('sync-deliverables', {});
      setNotice(`成果文件夹：${result.ready}/${result.total} 份已整理${result.failed ? `，${result.failed} 份需处理` : ''}。原文件保留。`);
      const failure = result.files.find(item => item.status !== 'ready')?.error;
      setDeliverableFeedback({ status: result.failed ? 'failed' : 'ready', text: `成果文件夹：${result.ready}/${result.total} 份已整理。${failure || '原文件保留。'}` });
      if (result.failed) setError(failure || '部分成果文件整理失败');
      setCanvasSignals(signals => ({ ...signals, [selectedId]: (signals[selectedId] || 0) + 1 }));
    } catch (cause) { setError(messageOf(cause)); setDeliverableFeedback({ status: 'failed', text: messageOf(cause) }); }
    finally { setBusy('') }
  }

  async function exportWord() {
    if (!activeVersion) return
    setBusy('export-word')
    setError('')
    setNotice('')
    try {
      const version = await request('export-word', { versionId: activeVersion.id })
      rememberVersion(version)
      setNotice(`Word 已导出，对应大纲 v${version.number}。`)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy('')
    }
  }

  async function startCourse() {
    setBusy('prepare-course')
    setError('')
    setNotice('')
    try {
      if (modelLoading) throw new Error('模型目录正在读取，请稍后再试。')
      const outline = await request('course-outline-skill', {})
      if (!outline?.name) throw new Error('未找到课程大纲技能：请先安装对应本机 Skill，或在插件设置中配置 courseSkillDir 后重试。')
      const data = { requirementId: selected.id, selectedCardIds: [`requirement:${selected.id}`],
        instruction: `/${outline.name}\n根据背景信息开发课程大纲，保留课题与大纲确认步骤。`,
        selectedSkills: [outline.name], outputType: 'outline', generation: { mode: 'new' },
        ...(modelSelection ? { modelSelection } : {}) }
      const created = await request('create-task', { ...data, operationId: operationId(courseAttempt, data) })
      if (!mounted.current) return
      setView('canvas')
      await startCanvas({ ...created.prepared, ...(created.task.sessionId ? { sessionId: created.task.sessionId } : {}) })
      courseAttempt.current = null
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      if (mounted.current) setBusy('')
    }
  }

  function chooseVersion(version) {
    if (dirty && !window.confirm('当前编辑尚未保存。切换版本会放弃这次编辑，继续切换？')) return
    setVersionId(version.id)
    setMarkdown(version.markdown)
    setError('')
    setNotice('')
  }

  async function selectRequirement(requirement) {
    if (requirement.id === selectedId) return
    if (dirty && !window.confirm('当前编辑尚未保存。切换画布会放弃这次编辑，继续切换？')) return
    try{await chooseRequirement(requirement)}catch(cause){setError(`文档草稿尚未保存：${messageOf(cause)}。请先在右栏保存。`)}
  }
  async function showList(){try{await creationCache?.beforeDocumentLeave?.();setView('list')}catch(cause){setError(`文档草稿尚未保存：${messageOf(cause)}。请先在右栏保存。`)}}

  const reference = canvasSessions.current.get(selectedId)
  useEffect(() => {
    // Only retire refs outside this committed Provider; a newer async reply may
    // already have replaced the map while this render's effect is still pending.
    for (const retired of retiredSessions.current) {
      if (retired === reference) continue
      retiredSessions.current.delete(retired)
      retired.release()
    }
  }, [sessionGeneration, reference])
  const conversation = reference || sessionErrors[selectedId] ? <>
    {sessionErrors[selectedId] && <UserError className="wtt-inline-error" error={sessionErrors[selectedId]} />}
    {reference && <div className="wtt-native-conversation" data-generation={sessionGeneration} onClickCapture={openConversationFile}>
      {conversationFileError?.sessionId === reference.sessionId && <UserError className="wtt-inline-error" error={conversationFileError.message} />}
      <SessionProvider key={reference.sessionId} session={reference}>{renderSlot(CANVAS_CONVERSATION_SLOT, {
        onSettled: () => setCanvasSignals(signals => ({ ...signals, [selectedId]: (signals[selectedId] || 0) + 1 })),
      })}</SessionProvider>
    </div>}
  </> : null

  async function fileTreeChanged(plan){
    setProjectFileSelection(previous=>previous&&(previous.path===plan.target.path||previous.path.startsWith(plan.target.path+'/'))?null:previous)
    setFileRefresh(value=>value+1)
    setFileRecycleSignal({token:crypto.randomUUID(),requirements:plan.courses.map(c=>c.requirementId)})
    await load()
  }
  const projectBar = <CanvasProjectBar workspace={workspace} project={project} onToggleFiles={()=>setFilesOpen(true)} filesOpen={filesOpen} selectedId={selectedId} busy={busy} loading={loading} onSelect={selectRequirement} onNew={() => { setFormError(''); setShowNew(true) }} onList={showList} onRefresh={() => load()} onRename={showRename} onBackground={showBackground} onSyncDeliverables={syncDeliverables} onModelSettings={onOpenModelSettings} />

  return <div className="wtt-project-layout">{filesOpen&&<ProjectExplorer onChanged={fileTreeChanged} refreshSignal={fileRefresh} onRecycle={()=>setRecycleRequest(crypto.randomUUID())} project={project} request={request} active={active} onClose={()=>setFilesOpen(false)} onChooseProject={onChooseProject} onOpenProject={onOpenProject} onPreview={previewProjectFile} onAdd={addProjectFile} canAdd={Boolean(selected)}/>}<div className="wtt-project-main"><div className={`wtt-course-workbench ${view === 'canvas' ? 'wtt-canvas-mode' : ''}`}>
    {view === 'canvas' && !selected && projectBar}
    {view !== 'canvas' && <>
      <header className="wtt-page-heading">
      <div>
        <h1>WTT 创作工作台</h1>
        {!filesOpen&&<UiButton variant="ghost" onClick={()=>setFilesOpen(true)} aria-label="打开文件栏">打开文件栏</UiButton>}
      </div>
      <div className="wtt-heading-actions">
        <UiButton variant="quiet" className="wtt-button wtt-button-text" onClick={() => load()} disabled={loading || Boolean(busy)}>{loading ? '读取中…' : '刷新'}</UiButton>
        <UiButton variant="primary" className="wtt-button wtt-button-primary" disabled={!workspace || Boolean(busy)} onClick={() => { setFormError(''); setShowNew(true) }}>新建画布</UiButton>
      </div>
    </header>

    {workspace && <div className="wtt-view-toolbar">
      <div className="wtt-view-toggle" aria-label="工作台视图">
        <UiButton variant="quiet" className="wtt-button" aria-pressed={view === 'canvas'} onClick={() => setView('canvas')}>自由画布</UiButton>
        <UiButton variant="quiet" className="wtt-button" aria-pressed={view === 'list'} onClick={showList}>列表编辑</UiButton>
      </div>
    </div>}
    </>}

    {view === 'canvas' && deliverableFeedback && <div className={`wtt-deliverable-feedback is-${deliverableFeedback.status}`} role={deliverableFeedback.status === 'failed' ? 'alert' : 'status'}><span>{deliverableFeedback.text}</span><UiButton variant="ghost" size="compact" type="button" aria-label="关闭文件整理提示" onClick={() => setDeliverableFeedback(null)}>×</UiButton></div>}
    {loadError && <div className="wtt-feedback wtt-feedback-error" role="alert"><UserError error={loadError} announce={false} /><UiButton variant="quiet" className="wtt-button" onClick={() => load(!workspace)} disabled={loading}>重新读取</UiButton></div>}
    {modelError && <div className="wtt-feedback wtt-feedback-error wtt-model-feedback" role="alert"><UserError error={modelError} announce={false} /><UiButton variant="quiet" className="wtt-button" onClick={onRefreshModels} disabled={modelLoading}>刷新模型</UiButton></div>}

    {view === 'canvas' && selected && <CourseCanvas renderEditorConversation={renderEditorConversation} renderNativePreview={renderNativePreview} fileRecycleSignal={fileRecycleSignal} key={selected.id} onCloseRecycle={()=>setRecycleRequest(null)} recycleRequest={recycleRequest} onFilesChanged={()=>setFileRefresh(v=>v+1)} projectFileSelection={projectFileSelection} onCloseProjectFile={()=>setProjectFileSelection(null)} onAddProjectFile={addProjectFile} fileAddRequest={fileAddRequest} projectBar={projectBar} project={project} projectId={project.id} dependencies={workspace.dependencies} active={active} requirement={selected} request={request} draftCache={draftCache} creationCache={creationCache} onChanged={() => load()} onStart={startCanvas} conversation={conversation} conversationSessionId={reference?.sessionId} refreshSignal={canvasSignals[selected.id] || 0} onSessionRestore={(sessionId, options) => restoreCanvasSession(sessionId, selected.id, options)}
      onPreviewProjectFile={previewProjectFile}
      onAssetNavigate={(requirementId, cardId, versionId) => { const target = workspace.requirements.find(item => item.id === requirementId); if (!target) return; if (!creationDrafts.current.has(requirementId)) creationDrafts.current.set(requirementId, { drafts: new Map(), attempts: new Map(), activeKey: null, visible: false }); creationDrafts.current.get(requirementId).pendingAsset = { cardId, versionId }; selectRequirement(target) }}
      onOpenMediaSettings={onOpenMediaSettings} onWatchMediaSettings={onWatchMediaSettings} modelCatalog={modelCatalog} modelSelection={modelSelection} onModelChange={onModelChange} onRefreshModels={onRefreshModels} onOpenModelSettings={onOpenModelSettings} modelLoading={modelLoading} modelError={modelError} nativeSessionStatuses={nativeSessionStatuses} onWatchTaskSessions={onWatchTaskSessions} onPrepareContinuation={onPrepareContinuation} />}
    {!selected&&recycleRequest&&<ProjectRecycleDialog request={request} endpoint={q=>endpoint(q,project.id)} onClose={()=>setRecycleRequest(null)} onChanged={()=>setFileRefresh(v=>v+1)}/>}
    {view==='canvas'&&!selected&&projectFileSelection&&<div className="wtt-empty-file-preview"><ProjectFilePreview selection={projectFileSelection} endpoint={q=>endpoint(q,project.id)} onClose={()=>setProjectFileSelection(null)}/></div>}
    {view === 'canvas' && workspace && !selected && <div className="wtt-page-empty"><BookIcon /><h2>创建一张画布</h2><p>拖入文件，继续创作。</p><UiButton variant="primary" className="wtt-button wtt-button-primary" onClick={() => setShowNew(true)}>新建画布</UiButton></div>}
    {loading && !workspace ? <div className="wtt-page-empty" role="status"><p>正在读取画布和已保存版本…</p></div> : workspace && view === 'list' && <div className="wtt-workspace-layout">
      <aside className="wtt-requirements" aria-label="项目画布">
        <div className="wtt-list-heading"><h2>画布</h2><span>{workspace.requirements?.length || 0}</span></div>
        {(workspace.requirements?.length || 0) > 0 && <input className="wtt-search" aria-label="搜索画布" value={filter} onChange={event => setFilter(event.target.value)} placeholder="搜索名称、客户或受众" />}
        <div className="wtt-requirement-list">
          {filtered.map(requirement => <UiButton variant="custom" key={requirement.id} className={`wtt-requirement-item ${requirement.id === selectedId ? 'is-selected' : ''}`} aria-current={requirement.id === selectedId ? 'true' : undefined} disabled={Boolean(busy)} onClick={() => selectRequirement(requirement)}>
            <strong>{requirement.title}</strong>
            <span>{requirement.background?.slice(0, 70) || '暂未填写背景信息'}</span>
            <small>{requirement.versions?.length ? `${requirement.versions.length} 个大纲版本` : '尚无大纲'}</small>
          </UiButton>)}
          {!filtered.length && <p className="wtt-list-empty">{filter ? '没有匹配的画布' : '还没有画布。'}</p>}
        </div>
        <EnvironmentStatus dependencies={workspace.dependencies} />
      </aside>

      <main className="wtt-detail">
        {!selected ? <div className="wtt-page-empty"><BookIcon /><h2>创建一张画布</h2><p>使用已有资料继续创作。</p><UiButton variant="primary" className="wtt-button wtt-button-primary" onClick={() => setShowNew(true)}>新建画布</UiButton></div> : <>
          <div className="wtt-detail-heading">
            <div><h2>{selected.title}</h2><UiButton variant="quiet" className="wtt-button wtt-button-text" disabled={Boolean(busy)} onClick={showRename}>重命名画布</UiButton></div>
            <UiButton variant="primary" className="wtt-button wtt-button-primary" disabled={Boolean(busy)} onClick={startCourse}>{busy === 'prepare-course' ? '正在准备会话…' : '生成课程大纲'}</UiButton>
          </div>
          <p className="wtt-session-hint">根据画布背景生成大纲，确认步骤在 DSH 对话中完成。</p>
          <RequirementBrief requirement={selected} />

          <section className="wtt-outline-section" aria-labelledby={outlineTitleId}>
            <div className="wtt-outline-heading"><h3 id={outlineTitleId}>课程大纲</h3><span className="wtt-muted">{activeVersion ? `正在查看 v${activeVersion.number}${dirty ? ' · 有未保存修改' : ''}` : '尚未保存版本'}</span></div>
            {versions.length > 0 && <div className="wtt-versions" aria-label="大纲版本">
              {[...versions].sort((a, b) => b.number - a.number).map(version => <UiButton variant="custom" key={version.id} className={`wtt-version ${version.id === versionId ? 'is-selected' : ''}`} aria-pressed={version.id === versionId} title={formatTime(version.createdAt)} disabled={Boolean(busy)} onClick={() => chooseVersion(version)}>v{version.number}<span>{formatTime(version.createdAt)}</span></UiButton>)}
            </div>}
            <label className="wtt-outline-editor"><span className="wtt-visually-hidden">大纲 Markdown 内容</span><textarea value={markdown} disabled={Boolean(busy)} onChange={event => { setMarkdown(event.target.value); setError(''); setNotice('') }} spellCheck={false} placeholder="粘贴已有大纲，或通过「生成课程大纲」调用课程技能。支持 Markdown；保存时会创建独立版本。" /></label>
            <div className="wtt-editor-footer">
              <p>{activeVersion ? `v${activeVersion.number} · ${formatTime(activeVersion.createdAt)}` : '保存后可以导出对应的 Word 文件。'}</p>
              <div className="wtt-editor-actions">
                <UiButton variant="quiet" className="wtt-button" disabled={Boolean(busy) || !activeVersion} onClick={exportWord}>{busy === 'export-word' ? '正在导出…' : '导出 Word'}</UiButton>
                <UiButton variant="primary" className="wtt-button wtt-button-primary" disabled={Boolean(busy) || !markdown.trim() || Boolean(activeVersion && !dirty)} onClick={saveOutline}>{busy === 'save-outline' ? '正在保存…' : '保存新版本'}</UiButton>
              </div>
            </div>
            {dirty && activeVersion && <p className="wtt-unsaved-hint">编辑内容尚未保存；导出 Word 使用当前已保存的 v{activeVersion.number}。保存新版本后再导出，可包含本次修改。</p>}
            {activeVersion?.wordPath && <div className="wtt-word-file"><div><strong>Word · 大纲 v{activeVersion.number}</strong><p title={activeVersion.wordPath}>{activeVersion.wordPath}</p></div><a className="wtt-button" href={endpoint({ download: activeVersion.id }, project.id).toString()} download>下载 Word</a></div>}
          </section>
          {error && <div className="wtt-feedback wtt-feedback-error" role="alert"><UserError error={error} announce={false} /></div>}
          {notice && <div className="wtt-feedback wtt-feedback-success" role="status">{notice}</div>}
        </>}
      </main>
    </div>}
    {showNew && <RenameRequirementDialog creating value={form.title} onChange={title => setForm({title})} busy={busy === 'create'} error={formError} onClose={() => setShowNew(false)} onSubmit={createRequirement} />}
    {backgroundEdit && <BackgroundDialog values={backgroundEdit} setValues={setBackgroundEdit} busy={busy === 'background'} error={backgroundError} onClose={() => setBackgroundEdit(null)} onSubmit={saveBackground} />}
    {rename && <RenameRequirementDialog value={rename.title} onChange={title => setRename(previous => ({ ...previous, title }))} busy={busy === 'rename'} error={renameError} onClose={() => setRename(null)} onSubmit={renameRequirement} />}
  </div></div></div>
}

function ProjectWorkbench(props) {
  const [registry, setRegistry] = useState(null)
  const [opened, setOpened] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const mounted = useRef(true)
  const [modelCatalog, setModelCatalog] = useState(null)
  const [modelSelection, setModelSelection] = useState(null)
  const [modelLoading, setModelLoading] = useState(true)
  const [modelError, setModelError] = useState('')
  const modelLoadEpoch = useRef(0)
  const subscribeStatuses = useCallback(listener => props.nativeSessionStatus?.subscribe(listener) || (() => {}), [props.nativeSessionStatus])
  const readStatuses = useCallback(() => props.nativeSessionStatus?.getSnapshot() || EMPTY_SESSION_STATUSES, [props.nativeSessionStatus])
  const nativeSessionStatuses = useSyncExternalStore(subscribeStatuses, readStatuses, readStatuses)

  const loadModels = useCallback(async () => {
    const epoch = ++modelLoadEpoch.current
    setModelLoading(true); setModelError('')
    try {
      const catalog = await props.onLoadModels()
      if (!mounted.current || epoch !== modelLoadEpoch.current) return
      setModelCatalog(catalog)
      setModelSelection(previous => previous || catalog.default || null)
    } catch (cause) {
      if (mounted.current && epoch === modelLoadEpoch.current) setModelError(messageOf(cause))
    } finally {
      if (mounted.current && epoch === modelLoadEpoch.current) setModelLoading(false)
    }
  }, [props.onLoadModels])

  const openModelSettings = useCallback(async () => {
    try { await props.onOpenModelSettings(); setModelError('') }
    catch (cause) { setModelError(messageOf(cause)) }
  }, [props.onOpenModelSettings])

  async function loadProjects() {
    setLoading(true)
    setError('')
    try {
      const data = await apiRequest(undefined, undefined, undefined, { projects: 1 })
      if (!mounted.current) return
      const project = data.projects?.find(item => item.id === data.activeProjectId)
      if (!project) throw new Error('未找到当前项目，请重新选择项目目录。')
      setRegistry(data)
      setOpened(previous => previous.some(item => item.id === project.id) ? previous : [...previous, project])
      setError(data.error || '')
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    void loadProjects()
    void loadModels()
    return () => { mounted.current = false }
  }, [])

  async function openProject(path) {
    const result = await apiRequest('open-project', { path })
    if (!mounted.current) return
    const project = result.project
    if (!project?.id || !project.path) throw new Error('服务器未返回有效项目，请保留当前内容后重试。')
    setRegistry(previous => ({ ...previous, activeProjectId: project.id,
      projects: [project, ...(previous?.projects || []).filter(item => item.id !== project.id)] }))
    setOpened(previous => previous.some(item => item.id === project.id) ? previous : [...previous, project])
    setError('')
    setPickerOpen(false)
  }

  const project = registry?.projects.find(item => item.id === registry.activeProjectId)
  return <div className="wtt-project-workbench">
    {!registry && <div className="wtt-project-boot">
      <BookIcon /><h1>WTT 创作工作台</h1>
      <p role={error ? 'alert' : 'status'}>{error || (loading ? '正在打开项目目录…' : '选择项目文件夹，开始创作。')}</p>
      {!loading && <div><UiButton variant="quiet" onClick={() => void loadProjects()}>重新读取</UiButton><UiButton variant="quiet" onClick={() => setPickerOpen(true)}>选择项目目录</UiButton></div>}
    </div>}
    {registry && error && <div className="wtt-project-warning" role="alert">{error}<UiButton variant="ghost" size="compact" onClick={() => setError('')} aria-label="关闭项目提示">×</UiButton></div>}
    {opened.map(item => <div key={item.id} className="wtt-project-surface" hidden={registry?.activeProjectId !== item.id}>
      <WorkbenchPage {...props} project={item} active={registry?.activeProjectId === item.id} onChooseProject={() => setPickerOpen(true)} onOpenProject={openProject}
        modelCatalog={modelCatalog} modelSelection={modelSelection} onModelChange={setModelSelection} onRefreshModels={loadModels} onOpenModelSettings={openModelSettings} modelLoading={modelLoading} modelError={modelError} nativeSessionStatuses={nativeSessionStatuses} />
    </div>)}
    {pickerOpen && <ProjectPicker currentProject={project} projects={registry?.projects || []}
      browseDirectory={props.browseDirectory} onOpenProject={openProject} onClose={() => setPickerOpen(false)} />}
  </div>
}

export function apply(ctx) {
  const mediaSettings = createMediaSettingsOperations(ctx);
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer', id: 'wtt-media-services', order: 20,
    inject: () => ({ operations: mediaSettings }),
  }, MediaServiceSettings));
  let useLocalDirectoryBrowser = false
  const browseDirectory = async (path, signal) => {
    if (!useLocalDirectoryBrowser) {
      try { return await ctx.uiWorkspace.listDirectory(path, signal) }
      catch (cause) {
        if (signal?.aborted || !String(cause?.rpcError?.message || cause?.message || cause).includes('needs the browse capability')) throw cause
        useLocalDirectoryBrowser = true
      }
    }
    return apiRequest(undefined, undefined, undefined, { directory: path || '' }, signal)
  }
  const nativeEditorBridge=createNativeEditorBridge()
  ctx.effect(()=>ctx.inputTriggers.registerSource(nativeEditorBridge.source))
  ctx.effect(()=>ctx.slots.inject('conversation.input.dock',()=>ctx.slots.register({name:'conversation.input.dock',id:'wtt-course-edit-reference',order:5},props=><NativeEditorInputDock {...props} bridge={nativeEditorBridge}/>)))
  registerCanvasConversation(ctx)
  const acquirePreviewSession = createPreviewSessionAcquirer(ctx)
  const acquireEditingSession=createEditorSessionAcquirer(ctx)
  registerNativePreview(ctx)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    children: { ...CANVAS_CONVERSATION_CHILDREN, ...NATIVE_PREVIEW_CHILDREN },
    inject: () => ({
      onStart: (prepared, shouldOpen) => startCourseSession(ctx, prepared, shouldOpen),
      onStartCanvas: (prepared, sessionId, lifecycle) => acquireCourseConversation(ctx, prepared, sessionId, lifecycle),
      onRestoreCanvas: (sessionId, project) => restoreCourseConversation(ctx, { sessionId, cwd: project.path, projectId: project.id }),
      onPrepareContinuation: sessionId => {
        const binding = ctx.sessions.binding(sessionId)
        if (!binding) throw new Error('请重新打开原任务对话，再继续任务。')
        const status = ctx.uiSession.sessionStatus.getSnapshot().get(sessionId)
        if (status?.pendingInteraction) throw new Error('任务已有待处理的问题或授权，请在原对话中处理。')
        if (status?.running) throw new Error('任务正在执行，请等待本轮结束。')
        const input = binding.ctx.get('conversation')?.input
        if (!input) throw new Error('请在原任务对话的输入框填写续办要求。')
        const result = input.requestDraftInitialization(binding, {
          prompt: '请从上次停下的步骤继续，沿用已写入的文件。若有待确认的内容或需要授权，请先发起确认，等我明确回复后再推进。',
          whenDraftExists: 'keep',
        })
        if (result === 'blocked') throw new Error('原对话正在处理输入，请稍后再试。')
        return () => input.for(binding.ctx).focus()
      },
      acquirePreviewSession,acquireEditingSession,nativeEditorBridge,
      onWatchTaskSessions: (scope, onChange, onError) => watchCourseTaskSessions(ctx, scope, onChange, onError),
      browseDirectory,
      onLoadModels: async () => {
        const result = await ctx.remote.session.modelCatalog()
        if (result?.ok !== true) throw new Error(result?.error?.message || 'DSH 模型目录读取失败，请检查连接后刷新。')
        return normalizeModelCatalog(result.value)
      },
      onOpenModelSettings: () => openNativeModelSettings(ctx),
      onOpenMediaSettings: () => {
        openNativeModelSettings(ctx);
        let remaining = 30;
        const focus = () => { const section = document.getElementById('wtt-media-services'); if (section) { section.scrollIntoView({ block: 'start' }); const opener = section.querySelector('[data-media-settings-open]'); if (opener) opener.click(); else section.focus({ preventScroll: true }); } else if (remaining-- > 0) requestAnimationFrame(focus); };
        requestAnimationFrame(focus);
      },
      onWatchMediaSettings: listener => {
        const form = mediaSettings.form;
        let previous = form.getSnapshot().revision;
        const stop = form.subscribe(() => { const revision = form.getSnapshot().revision; if (revision !== previous) { previous = revision; listener(); } });
        const stopCredentials = mediaSettings.watchCredentials(listener);
        return () => { stop(); stopCredentials(); };
      },
      nativeSessionStatus: ctx.uiSession.sessionStatus,
    }),
  }, ProjectWorkbench))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 10,
    label: 'WTT 创作工作台',
  }, BookIcon))
}
