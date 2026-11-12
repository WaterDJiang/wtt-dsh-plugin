import { UiButton } from './ui/controls.jsx'
import { skillLabel, skillSearchText } from './skill-presentation.mjs'
import { UserError } from './user-feedback.jsx'
import React, { useEffect, useId, useRef, useState } from 'react'
import { extractSkillNames, skillQueryAtCursor, pptEngineForSelection } from './skill-commands.mjs'
import { SkillSettings } from './skill-settings.jsx'
import { ApiMediaPrompt, mediaJobPending, mediaOptionsFor, mediaSizeLabel } from './media-creation.jsx'
import { ModelSelection } from './model-selection.jsx'
import { TaskInputSummary } from './task-input-summary.jsx'
import { pendingContinueAllowed, pendingLabel, pendingRetryAllowed } from './pending-card-state.mjs'
import { ReferencePromptInput } from './reference-prompt-input.jsx'
import { cardDisplayTitle } from './card-capabilities.mjs'
import { reviewDraftFromQuestion, reviewImagesFromQuestion } from './conversation-file.mjs'
import { ReviewImageGallery } from './review-image-gallery.jsx'
import './card-creation.css'
import './task-stage.css'

const KIND_LABELS = { requirement: '需求', material: '素材', excerpt: '摘录', outline: '大纲', word: 'Word', artifact: '成果文件', text: '文本', pptx: 'PPT', image: '图片', video: '视频', exercise: '练习', script: '逐字稿', whiteboard: '白板内容' }
const ACTION_TYPES = new Set(['material', 'excerpt', 'word'])
const ACTIVE_NATIVE_QUESTION = '[data-question-key] > section:has([data-question-scroll])'
const DEFAULT_ACCEPTED_FILES = '.txt,.md,.csv,.json,.jsonl,.pdf,.docx,.pptx,.png,.jpg,.jpeg,.webp,.gif,.mp4,.webm'




function uniqueCards(cards) {
  const result = new Map()
  for (const card of cards) if (card?.id && !result.has(card.id)) result.set(card.id, card)
  return [...result.values()]
}

function sameReference(reference, candidate) {
  if (!reference?.id || !candidate?.id) return false
  if (reference.id === candidate.id) return true
  const referenceElement = reference.whiteboardSource?.elementId || (reference.kind === 'whiteboard' ? reference.id : undefined)
  const candidateElement = candidate.whiteboardSource?.elementId || (candidate.kind === 'whiteboard' ? candidate.id : undefined)
  if (!referenceElement || referenceElement !== candidateElement) return false
  const referenceHash = reference.whiteboardSource?.contentHash
  const candidateHash = candidate.whiteboardSource?.contentHash
  if (referenceHash && candidateHash) return referenceHash === candidateHash
  const normalize = card => String(card.content ?? card.text ?? '').replace(/\r\n?/g, '\n')
  return normalize(reference) === normalize(candidate)
}

function referenceErrorMessage(error) { return error?.rpcError?.message || error?.message || String(error) }

function CreationIcon({ type = 'outline', size = 17 }) {
  const paths = {
    image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8" cy="9" r="1.5" /><path d="m4 18 6-6 4 4 3-3 4 4" /></>,
    video: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m10 8 6 4-6 4Z" /></>,
    outline: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h4" /></>,
    pptx: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M12 17v4M8 21h8M7 13V9M12 13V7M17 13v-3" /></>,
    exercise: <><rect x="4" y="4" width="16" height="17" rx="2" /><path d="M9 4V2h6v2M8 10l1.5 1.5L12 9M14 10h3M8 16l1.5 1.5L12 15M14 16h3" /></>,
    script: <><path d="M5 4h14v16H5zM9 8h6M9 12h6M9 16h3" /><path d="m3 8-1 1v6l1 1M21 8l1 1v6l-1 1" /></>,
    material: <><path d="M3 7V5h7l2 2h9v13H3Z" /><path d="M12 11v6M9 14h6" /></>,
    whiteboard: <><path d="M5 3h14v12l-6 6H5Z" /><path d="M13 21v-6h6M8 8h8M8 11h5" /></>,
    computer: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M12 17v4M8 21h8M9 10l3-3 3 3M12 7v7" /></>,
    excerpt: <><path d="M7 5h12v16H7Z" /><path d="M4 17V2h12M10 9h6M10 13h6M10 17h4" /></>,
    word: <><path d="M5 3h10l4 4v14H5Z" /><path d="M15 3v5h4M8 12l1 5 3-4 3 4 1-5" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    send: <><path d="m5 11 7-7 7 7M12 5v15" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    collapse: <path d="m7 14 5-5 5 5" />,
    expand: <path d="m7 10 5 5 5-5" />,
    check: <path d="m5 12 4 4L19 6" />,
    spark: <><path d="m12 3 2 7 7 2-7 2-2 7-2-7-7-2 7-2Z" /><path d="m20 2 .5 2 2 .5-2 .5-.5 2-.5-2-2-.5 2-.5Z" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[type] || paths.outline}</svg>
}

function cardTitle(card) { return card?.displayTitle || cardDisplayTitle(card) || `${KIND_LABELS[card?.kind] || '资料'}${card?.number ? ` v${card.number}` : ''}` }
function referenceFormat(card) {
  const name=card.importedFile?.name||card.generatedFile?.name||card.path||card.sourcePath||card.title||'';
  const ext=name.match(/\.([a-z0-9]{1,8})(?:[?#].*)?$/i)?.[1]?.toLowerCase();
  if(ext&&/^(txt|md|markdown|pdf|docx?|pptx?|csv|xlsx?|jsonl?|png|jpe?g|webp|gif|svg|mp4|webm|mov)$/.test(ext))return ext.toUpperCase();
  return {requirement:'文本',whiteboard:'文本',material:'文本',excerpt:'摘录',outline:'MD',word:'DOCX',image:'图片',video:'视频'}[card.kind]||'文件';
}

function unavailableReason(card) {
  if (card?.disabled) return card.reason || '该资料暂不可引用'
  return { missing: '文件已缺失', changed: '文件已在外部修改', modified: '文件已在外部修改', unavailable: '文件暂不可用' }[card?.status] || (card?.unavailable ? '原引用当前不可用' : '')
}

function selectionLabel(context) {
  const selection = context?.selection
  if (!selection) return ''
  if (selection.rangeLabel) return selection.rangeLabel
  const source = context.references?.find(card => card.id === selection.sourceCardId) || context.anchor
  const content = String(source?.content ?? '').replace(/\r\n?/g, '\n')
  if (!Number.isInteger(selection.start) || !Number.isInteger(selection.end) || selection.start < 0 || selection.end <= selection.start || selection.end > content.length) return '已锁定片段'
  const first = content.slice(0, selection.start).split('\n').length
  const last = content.slice(0, selection.end - 1).split('\n').length
  return first === last ? `第 ${first} 行` : `第 ${first}–${last} 行`
}

function SkillCommandInput({ instruction, onChange, disabled, catalog, loading, error, onRefresh, onOpenSettings, onSubmit, mentionProps, footer }) {
  const id = useId()
  const root = useRef(null)
  const textarea = useRef(null)
  const search = useRef(null)
  const options = useRef(null)
  const selection = useRef({ start: instruction.length, end: instruction.length })
  const [popup, setPopup] = useState(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [localError, setLocalError] = useState('')
  const skills = [...new Map((catalog?.skills || []).map(skill => [skill.name, skill])).values()]
  const favoriteNames = new Set(catalog?.settings?.favorites || [])
  const favorites = [...favoriteNames].map(name => skills.find(skill => skill.name === name)).filter(Boolean)
  const favoritesOnly = popup?.mode === 'browse' && !popup.query && !popup.all && favorites.length > 0
  const candidates = favoritesOnly ? favorites : skills.filter(skill => skillSearchText(skill).includes((popup?.query || '').toLowerCase()))
    .sort((a, b) => Number(favoriteNames.has(b.name)) - Number(favoriteNames.has(a.name)) || a.name.localeCompare(b.name))
  const explicitSkills = extractSkillNames(instruction)
  const displayError = localError || (error ? referenceErrorMessage(error) : '')

  useEffect(() => {
    if (!popup) return
    const dismiss = event => { if (!root.current?.contains(event.target)) setPopup(null) }
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [Boolean(popup)])
  useEffect(() => { setActiveIndex(0) }, [popup?.query, popup?.all, catalog])
  useEffect(() => { if (disabled) setPopup(null) }, [disabled])
  useEffect(() => {
    const list = options.current
    const option = list?.querySelector(`[data-skill-index="${activeIndex}"]`)
    if (!option) return
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight
  }, [activeIndex])

  function remember(element) { selection.current = { start: element.selectionStart ?? instruction.length, end: element.selectionEnd ?? instruction.length } }
  function updateQuery(element) {
    remember(element)
    const query = skillQueryAtCursor(element.value, element.selectionStart)
    setPopup(query ? { ...query, mode: 'inline' } : null)
  }
  function openPicker() {
    if (disabled) return
    if (popup?.mode === 'browse') { closePicker(); return }
    const query = skillQueryAtCursor(instruction, selection.current.start)
    setPopup({ ...(query || selection.current), query: '', mode: 'browse' })
    requestAnimationFrame(() => search.current?.focus({ preventScroll: true }))
  }
  function closePicker() {
    const fromButton = popup?.mode === 'browse'
    setPopup(null)
    requestAnimationFrame(() => {
      const target = fromButton ? root.current?.querySelector('.wcc-creation-skill-trigger') : textarea.current
      target?.focus({ preventScroll: true })
    })
  }
  function insertSkill(skill) {
    if (!skill || disabled) return
    const range = popup || skillQueryAtCursor(instruction, selection.current.start) || selection.current
    const start = Math.max(0, Math.min(instruction.length, range.start))
    const end = Math.max(start, Math.min(instruction.length, range.end))
    const before = instruction.slice(0, start)
    const after = instruction.slice(end)
    const token = `${before && !/\s$/.test(before) ? ' ' : ''}/${skill.name}`
    const next = `${before}${token}${/^\s/.test(after) ? '' : ' '}${after}`
    if (next.length > 8000) { setLocalError('创作要求最多 8000 个字符，请先缩短正文再插入技能。'); return }
    const cursor = before.length + token.length + 1
    setLocalError('')
    setPopup(null)
    onChange?.(next)
    requestAnimationFrame(() => {
      if (textarea.current?.value !== next) return
      textarea.current.focus({ preventScroll: true })
      textarea.current.setSelectionRange(cursor, cursor)
      selection.current = { start: cursor, end: cursor }
    })
  }
  function keyboard(event) {
    if (!popup || event.nativeEvent?.isComposing) return false
    if (event.key === 'Escape') {
      event.preventDefault(); closePicker()
      return true
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (candidates.length) setActiveIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length)
      return true
    }
    if ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey) || (event.key === 'Tab' && popup.mode === 'inline' && !event.shiftKey)) {
      if (candidates[activeIndex]) { event.preventDefault(); insertSkill(candidates[activeIndex]); return true }
      if (event.key === 'Tab') setPopup(null)
    }
    return false
  }
  async function refresh() {
    if (!onRefresh || refreshing || loading) return
    setRefreshing(true); setLocalError('')
    try { await onRefresh() }
    catch (cause) { setLocalError(referenceErrorMessage(cause)) }
    finally { setRefreshing(false) }
  }

  return <div ref={root} className="wcc-creation-instruction" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPopup(null) }}
    onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) keyboard(event) }}>
    <ReferencePromptInput textareaRef={textarea} id={`${id}-instruction`} aria-label="创作要求" value={instruction} disabled={disabled} rows={2}
      onValueChange={onChange} onCursor={updateQuery} onSelect={element => { remember(element); if (popup?.mode === 'inline') updateQuery(element) }}
      aria-autocomplete="list" aria-controls={popup ? `${id}-skills` : undefined} aria-activedescendant={popup && candidates[activeIndex] ? `${id}-skill-${activeIndex}` : undefined}
      placeholder="想创作什么？@ 加引用，/ 选技能" spellCheck={false} onKeyDown={keyboard} onSubmit={onSubmit} {...mentionProps} />
    <div className="wcc-creation-instruction-toolbar">
      <UiButton variant="ghost" size="compact" className="wcc-creation-skill-trigger" disabled={disabled} aria-label="选择技能" aria-expanded={popup?.mode === 'browse'} aria-controls={popup?.mode === 'browse' ? `${id}-skill-picker` : undefined} title={explicitSkills.length ? explicitSkills.join('、') : '选择常用技能或搜索全部技能'} onMouseDown={event => event.preventDefault()} onClick={openPicker}>技能{explicitSkills.length > 0 && <span>{explicitSkills.length}</span>}<CreationIcon type={popup?.mode === 'browse' ? 'collapse' : 'expand'} size={13} /></UiButton>
      {footer}
    </div>
    {popup && <div id={`${id}-skill-picker`} className="wcc-creation-skill-picker">
      <div className="wcc-creation-skill-picker-heading">{popup.mode === 'browse' ? <input ref={search} role="combobox" aria-label="搜索技能" aria-expanded="true" aria-controls={`${id}-skills`} aria-activedescendant={candidates[activeIndex] ? `${id}-skill-${activeIndex}` : undefined} value={popup.query} onChange={event => setPopup(current => ({ ...current, query: event.target.value }))} onKeyDown={keyboard} placeholder="搜索全部技能" /> : <span>/{popup.query || '…'}</span>}<UiButton variant="ghost" size="compact" disabled={refreshing || loading || !onRefresh} onClick={() => void refresh()}>{refreshing || loading ? '读取中…' : '刷新'}</UiButton><UiButton variant="ghost" size="compact" aria-label="设置常用技能" onClick={() => { setPopup(null); onOpenSettings?.() }}>管理常用</UiButton></div>
      {popup.mode === 'browse' && !popup.query && favorites.length > 0 && <div className="wcc-creation-skill-picker-heading"><span>{favoritesOnly ? '常用技能' : '全部技能'}</span><UiButton variant="ghost" size="compact" onClick={() => setPopup(current => ({ ...current, all: !current.all }))}>{favoritesOnly ? '查看全部' : '只看常用'}</UiButton></div>}
      <div ref={options} id={`${id}-skills`} className={`wcc-creation-skill-options${favoritesOnly ? ' is-favorites' : ''}`} role="listbox" aria-label={favoritesOnly ? '常用技能' : '可选技能'}>{candidates.map((skill, index) => <UiButton variant="custom" id={`${id}-skill-${index}`} key={skill.name} data-skill-index={index} type="button" role="option" title={`/${skill.name}`} tabIndex={-1} aria-selected={index === activeIndex} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActiveIndex(index)} onClick={() => insertSkill(skill)}><strong>{skillLabel(skill)}{!favoritesOnly && favoriteNames.has(skill.name) && <small>常用</small>}</strong>{!favoritesOnly && skill.description && <span>{skill.description}</span>}</UiButton>)}{!candidates.length && <p>{loading ? '正在读取技能列表…' : '未找到技能，试试其他关键词。'}</p>}</div>
      {!!catalog?.warnings?.length && <p className="wcc-creation-preview-note">有 {catalog.warnings.length} 项技能来源提示，可在设置中查看。</p>}
    </div>}
    {displayError && <UserError className="wcc-creation-error" error={displayError} />}
  </div>
}

function ImportedReferenceFile({ card, getHref }) {
  const [videoError, setVideoError] = useState(false)
  const file = card.importedFile || card.generatedFile
  const href = getHref(card)
  const preview = getHref(card, true)
  useEffect(() => { setVideoError(false) }, [preview])
  return <div className="wcc-creation-imported-file">
    <a href={href} download={file.name || true}>下载{card.generatedFile ? '生成文件' : '原文件'}{file.name ? ` · ${file.name}` : ''}</a>
    {mediaSizeLabel(file) && <small>实际文件：{mediaSizeLabel(file)}</small>}
    {file.mime?.startsWith('image/') && (card.sourceStatus || card.status) === 'ready' && <img className="wcc-creation-imported-preview" src={preview} alt={`文件预览：${cardTitle(card)}`} loading="lazy" decoding="async" />}
    {file.mime?.startsWith('video/') && !card.referenceNote?.includes('转写') && <p className="wcc-creation-preview-note">视频文件，尚未转写或解析画面。</p>}
    {file.mime?.startsWith('video/') && (card.sourceStatus || card.status) === 'ready' && <>
      <video className="wcc-creation-imported-video" src={preview} controls preload="metadata" playsInline aria-label={`视频预览：${cardTitle(card)}`} onError={() => setVideoError(true)} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} />
      {videoError && <p className="wcc-creation-preview-note" role="status">浏览器无法播放此视频，可下载原文件在本机查看。</p>}
    </>}
  </div>
}

export function NodeCreateMenu({ caption, position = { x: 0, y: 0 }, items = [], onAction, onClose }) {
  const menu = useRef(null)
  const previousFocus = useRef(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    previousFocus.current = document.activeElement
    const first = menu.current?.querySelector('button:not(:disabled)')
    ;(first || menu.current)?.focus()
    const dismiss = event => { if (!menu.current?.contains(event.target)) closeRef.current?.() }
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [])

  function closeWithFocus() {
    previousFocus.current?.focus?.()
    onClose?.()
  }

  function keyboard(event) {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); closeWithFocus(); return }
    if (event.key === 'Tab') { closeWithFocus(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = [...menu.current.querySelectorAll('button:not(:disabled)')]
    if (!buttons.length) return
    const index = buttons.indexOf(document.activeElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length
    buttons[next].focus()
  }

  return <div ref={menu} className="wcc-node-create-menu nodrag nopan nowheel" style={{ left: position.x, top: position.y }} role="menu" aria-label={caption || "从卡片创建内容"} tabIndex={-1}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={keyboard}>
    <p className="wcc-create-menu-caption">{caption || '用这张卡创作'}</p>
    {items.map(item => <UiButton variant="custom" key={item.id} type="button" role="menuitem" disabled={item.disabled} title={(item.disabled && item.reason) || item.description || item.label}
      onClick={() => { onAction?.(item.id); onClose?.() }}>
      <span className={`wcc-create-menu-icon is-${item.id}`}><CreationIcon type={item.id} size={15} /></span><span><strong>{item.label || KIND_LABELS[item.id] || item.id}</strong>{item.disabled && item.reason && <small>{item.reason}</small>}</span>
    </UiButton>)}
  </div>
}

export function CardComposer({
  visible = true, suspended = false, position = { x: 0, y: 0 }, context, references: referenceItems = [], availableReferences = [], creationTypes = [],
  instruction = '', onInstructionChange, onReferencesChange, onImportFiles, acceptedFileTypes = DEFAULT_ACCEPTED_FILES, getReferenceFileHref, onClose, onSend, onAction,
  searchProjectReferences, onReferenceProjectFile, projectRoot, onOpenReviewDraft, getReviewImageHref,
  busy = false, error, sendLabel, canSend = true, sendDisabledReason, conversation, conversationVisible = true, onOpenConversation, onPrepareContinuation, onTaskControl, actionContent, hideSubmit = false,
  skillCatalog, skillCatalogLoading = false, skillCatalogError, onRefreshSkills, onSaveSkillSettings, onUpdateSkillPreference,
  mediaCapabilities, mediaLoading = false, mediaError, onRefreshMedia, onMediaOptionsChange, onGenerationMethodChange, onMediaProviderChange, onGenerateMedia, onResumeMedia, onNewMedia,
  modelCatalog, modelSelection, onModelChange, onRefreshModels, onOpenModelSettings, onOpenMediaSettings, modelLoading, modelError,
}) {
  const id = useId()
  const composer = useRef(null)
  const scrollBody = useRef(null)
  const conversationPanel = useRef(null)
  const picker = useRef(null)
  const addButton = useRef(null)
  const referenceDetails = useRef(new Map())
  const previewTrigger = useRef(null)
  const [previewOpen,setPreviewOpen] = useState(false)
  const fileInput = useRef(null)
  const boardSourceButton = useRef(null)
  const boardSearch = useRef(null)
  const mounted = useRef(true)
  const referenceOperations = useRef(new Map())
  const currentContextKey = useRef(context?.key)
  currentContextKey.current = context?.key
  const [referencesOpen, setReferencesOpen] = useState(false)
  const [referenceSource, setReferenceSource] = useState(null)
  const [referenceWork, setReferenceWork] = useState(() => new Map())
  const [referenceErrors, setReferenceErrors] = useState(() => new Map())
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const [skillSettingsOpen, setSkillSettingsOpen] = useState(false)
  const [conversationOpen, setConversationOpen] = useState(false)
  const [conversationOpening, setConversationOpening] = useState(null)
  const [conversationError, setConversationError] = useState(null)
  const [reviewQuestion, setReviewQuestion] = useState(null)
  const [revisionEditing, setRevisionEditing] = useState(false)
  const conversationAutoScope = useRef(null)
  const [nativeComposerHeight, setNativeComposerHeight] = useState(0)
  const conversationScope = `${context?.key || ''}:${context?.sessionId || ''}`
  const liveConversationScope = useRef(conversationScope)
  liveConversationScope.current = conversationScope
  const outputType = context?.outputType || creationTypes[0]?.id || 'outline'
  const headingCard = context?.targetCard || context?.anchor
  const revising = context?.intent === 'revise'
  const inputLocked = Boolean(context?.pendingTaskId)
  const mediaCard = outputType === 'image' || outputType === 'video'
  const legacyMedia = mediaCard && Boolean(context?.mediaJob) && context?.generationMethod !== 'api' && Boolean(context?.pendingTaskId)
  const isMedia = mediaCard && (context?.generationMethod === 'api' || legacyMedia)
  const apiProvider = mediaCapabilities?.providers?.find(provider => provider.id === context?.providerId)
  const activeMediaCapabilities = legacyMedia ? mediaCapabilities : apiProvider
  const taskMode = (inputLocked || context?.pendingGeneration?.published) && !isMedia
  const canContinue = taskMode && pendingContinueAllowed(context.pendingGeneration) && Boolean(onPrepareContinuation)
  const reviewingResult = revising && !isMedia && !ACTION_TYPES.has(outputType) && !taskMode && !revisionEditing
  const showInitialInput = !taskMode && !reviewingResult
  const stageStatus = taskMode ? pendingLabel(context.pendingGeneration) : reviewingResult ? '已保存' : ''
  const mediaOptions = mediaOptionsFor(outputType, activeMediaCapabilities, context?.mediaOptions)
  const mediaModel = activeMediaCapabilities?.models?.find(model => model.type === outputType && model.id === mediaOptions.model)
  const mediaPending = isMedia && mediaJobPending(context?.mediaJob)
  const recoveringMedia = Boolean(isMedia && context?.mediaJob?.canResume && ['download_failed', 'registration_failed'].includes(context.mediaJob.status))
  const hasConversation = !isMedia && Boolean(conversation) && conversationVisible
  const hasExecution = !isMedia && (hasConversation || Boolean(context?.sessionId))
  const executionExpanded = hasConversation && conversationOpen && !collapsed
  const reviewDraft = reviewQuestion?.scope === conversationScope && reviewDraftFromQuestion(projectRoot, reviewQuestion.text)
  const reviewImages = reviewQuestion?.scope === conversationScope ? reviewImagesFromQuestion(projectRoot, reviewQuestion.text) : []
  const frameTop = executionExpanded && Number.isFinite(position.canvasHeight)
    ? Math.max(12, Math.min(position.y, position.canvasHeight - Math.min(560, position.canvasHeight - 24))) : position.y
  const references = uniqueCards(referenceItems)
  const activeReferenceWork = referenceWork.get(context?.key)
  const referencePending = Boolean(activeReferenceWork)
  const referencesBusy = busy || referencePending || inputLocked
  const displayError = error || referenceErrors.get(context?.key) || ''
  // Original tasks resume their frozen input; the placeholder is not a new source.
  const selectedType = inputLocked ? { id: outputType, label: KIND_LABELS[outputType] || '创作任务', available: true } : creationTypes.find(type => type.id === outputType)
  const isAction = ACTION_TYPES.has(outputType)
  const heading = stageStatus || collapsed ? cardTitle(headingCard) : isAction ? selectedType?.label || KIND_LABELS[outputType] : revising ? '修改此版本' : 'AI 创作'
  const headingDetail = stageStatus || (!isAction && !revising ? KIND_LABELS[outputType] : '')
  const generation = context?.generation
  const allowsEmptyReferences = generation?.mode === 'new' || generation?.mode === 'revise' && Boolean(generation.cardId && generation.baseVersionId)
  const sourcesAvailable = inputLocked || isAction || references.length > 0 || allowsEmptyReferences
  const sourceReason = sourcesAvailable ? '' : '请至少添加一份已保存资料作为来源。'
  const chosenSkills = extractSkillNames(instruction)
  let engineSummary = '', engineDetail = '', engineError = ''
  if (outputType === 'pptx') {
    try {
      const engine = inputLocked ? context.pptEngine : pptEngineForSelection({ pptEngine: context.pptEngine, selectedSkills: chosenSkills })
      engineSummary = engine === 'baoyu' ? '宝玉制作' : !inputLocked && chosenSkills.includes('wtt-course-pptx-generator') && !chosenSkills.includes('wtt-course-pptx-builder') ? '仅分镜' : '原生 PPT'
      engineDetail = inputLocked ? '沿用原任务冻结的制作方式' : chosenSkills.length ? `仅所选技能：${chosenSkills.join('、')}` : engine === 'baoyu' ? '默认制作引擎：claude-slides；不添加分镜技能' : '未选技能，按指令处理'
    } catch (cause) { engineError = cause.message }
  }
  const referenceNotes = [...new Set((context?.referenceNotes || []).map(note => typeof note === 'string' ? note : note?.message || note?.note || '').filter(Boolean))]
  const imageReferences = references.filter(card => (card.importedFile || card.generatedFile)?.mime?.startsWith('image/'))
  const hasVideoReference = references.some(card => (card.importedFile || card.generatedFile)?.mime?.startsWith('video/'))
  const mediaReason = chosenSkills.length && !legacyMedia ? 'API 生成不执行 Skill，请移除技能指令或切换 Skill 生成' : !legacyMedia && !mediaCapabilities?.providers?.length ? '尚未接入 API 服务' : !activeMediaCapabilities ? '请选择 API 服务' : !activeMediaCapabilities.healthy ? activeMediaCapabilities.error || 'API 服务未连接，请核对提供商配置' : !activeMediaCapabilities.credentialConfigured ? '尚未配置服务认证' : !mediaModel ? '请选择可用模型' : hasVideoReference ? '此 API 接口暂不支持视频参考，请切换 Skill 生成或移除视频引用' : mediaModel.requiresReference && !imageReferences.length ? '此模型需要参考图片' : imageReferences.length > (mediaModel.maxReferences || 0) ? `此模型最多支持 ${mediaModel.maxReferences || 0} 张参考图片` : mediaModel.sizes?.length && !mediaModel.sizes.includes(mediaOptions.size) ? '请选择图片或视频尺寸' : mediaModel.qualities?.length && !mediaModel.qualities.includes(mediaOptions.quality) ? '请选择生成质量' : mediaModel.ratios?.length && !mediaModel.ratios.includes(mediaOptions.ratio) ? '请选择画面比例' : mediaModel.resolutions?.length && !mediaModel.resolutions.includes(mediaOptions.resolution) ? '请选择分辨率' : outputType === 'video' && mediaModel.durations?.length && !mediaModel.durations.includes(Number(mediaOptions.duration)) ? '请选择视频时长' : context?.mediaJob?.status === 'unknown' ? '提交结果未知，请先核对原任务' : ''
  const ready = recoveringMedia ? !busy && !referencePending && Boolean(onResumeMedia) : !engineError && !busy && !referencePending && (!inputLocked || !isMedia && pendingRetryAllowed(context?.pendingGeneration)) && sourcesAvailable && canSend !== false && selectedType?.available !== false && (isAction || Boolean(instruction.trim())) && (!isMedia || (!mediaReason && !mediaPending && !mediaLoading))
  const reason = recoveringMedia ? '' : engineError || sourceReason || (isMedia ? mediaReason : sendDisabledReason || (selectedType?.available === false ? selectedType.message || '该创作能力暂不可用。' : ''))
  const isChosen = candidate => references.some(reference => sameReference(reference, candidate))
  const candidates = uniqueCards(availableReferences).filter(card => [cardTitle(card), card.title, card.defaultOutcome?.name, KIND_LABELS[card.kind]].join(' ').toLowerCase().includes(search.toLowerCase()))
  const projectReferences = new Map(availableReferences.filter(card => card.projectFile).map(card => [card.id, card.projectFile]))
  const referenceOptions = uniqueCards([...references, ...availableReferences])
    .filter(card => !unavailableReason(card) && !(isMedia && (card.importedFile || card.generatedFile)?.mime?.startsWith('video/')))
    .map(card => {
      const projectFile = projectReferences.get(card.id)
      const projectPath = projectFile?.path
      const label = cardTitle(card)
      const detail = [isChosen(card) ? '已引用' : '画布', referenceFormat(card), projectPath].filter(Boolean).join(' · ')
      const readyProjectPath = projectFile?.status === 'ready' ? projectPath : undefined
      return { key: card.id, card, label, detail, mentionLabel: projectPath, path: readyProjectPath,
        searchText: [label, card.title, card.defaultOutcome?.name, card.path, detail].join(' ').normalize('NFC').toLowerCase() }
    })
  const mentionProps = {
    referenceOptions, searchReferences: searchProjectReferences,
    acceptProjectFile: entry => !isMedia || !/\.(mp4|webm)$/i.test(entry.name),
    onMention: mentionReference,
  }
  const label = recoveringMedia ? '取回生成结果' : inputLocked ? pendingRetryAllowed(context?.pendingGeneration) && !isMedia ? '重试原任务' : pendingLabel(context?.pendingGeneration) : isAction ? sendLabel || { material: '添加素材', excerpt: '选择原文摘录', word: '导出 Word' }[outputType] : revising ? '生成新版本' : `生成${['outline', 'exercise', 'script'].includes(outputType) ? '文本' : KIND_LABELS[outputType] || '文本'}`
  const acceptedFiles = Array.isArray(acceptedFileTypes) ? acceptedFileTypes.join(',') : acceptedFileTypes
  const submitFooter = !hideSubmit && showInitialInput && <footer className={`wcc-creation-submit${isMedia ? ' is-media' : ''}`}>
    {isMedia ? (recoveringMedia ? <p>取回原结果，不重复生成。</p> : <span />) : <div className="wcc-creation-footer-model">{!isAction && (inputLocked && !modelSelection ? <span title="继续沿用原任务会话">原任务模型</span> : <ModelSelection key={`model:${context?.key}`} compact catalog={modelCatalog} selection={modelSelection} onChange={busy || inputLocked ? undefined : onModelChange} onRefresh={onRefreshModels} onOpenSettings={onOpenModelSettings} loading={modelLoading} error={modelError} />)}{engineSummary && <span className="wcc-creation-engine-summary" aria-label={`PPT制作方式：${engineSummary}`} title={engineDetail}>{engineSummary}</span>}</div>}
    <UiButton variant="custom" type="button" className="wcc-creation-send" disabled={!ready} aria-label={busy ? '提交中…' : mediaPending ? '生成中…' : label} aria-busy={busy} title={`${busy ? '提交中…' : mediaPending ? '生成中…' : label} · ⌘ / Ctrl + Enter`} onClick={submit}><CreationIcon type="send" size={18} /><span className="wcc-send-label">{busy ? '提交中…' : mediaPending ? '生成中…' : label}</span></UiButton>
  </footer>

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (visible) setCollapsed(false)
    else { setReferencesOpen(false); setSkillSettingsOpen(false) }
  }, [visible])

  useEffect(() => {
    if (!visible) return
    setCollapsed(false)
    const frame = requestAnimationFrame(() => {
      const root = composer.current
      if (!root) return
      const form = root.querySelector('.wcc-creation-action-content') || root.querySelector('.wcc-creation-instruction')
      const editable = [...(form?.querySelectorAll('input:not([disabled]):not([readonly]):not([type="hidden"]), textarea:not([disabled]):not([readonly])') || [])]
        .find(element => !element.closest('[hidden]') && element.getClientRects().length > 0)
      const target = editable || root.querySelector('.wcc-creation-window-actions button:last-child')
      target?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [visible, context?.key, context?.focusRequest])

  useEffect(() => { setPreviewOpen(false); setReferencesOpen(false); setReferenceSource(null); setSearch(''); setCollapsed(false); setSkillSettingsOpen(false) }, [context?.key])
  useEffect(() => { setConversationOpen(false); setRevisionEditing(false) }, [context?.key, context?.sessionId])
  useEffect(() => {
    if (scrollBody.current) scrollBody.current.scrollTop = 0
  }, [visible, collapsed, executionExpanded, conversationScope])

  function scrollToQuestion(question, showHistory = false) {
    const scrollport = question?.closest('[data-conversation-scroll]')
    if (!scrollport) return
    const questionTop = question.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
    scrollport.scrollTop += questionTop - (showHistory ? scrollport.clientHeight * .8 : 12)
  }

  function jumpToReview(showHistory) {
    scrollToQuestion(conversationPanel.current?.querySelector(ACTIVE_NATIVE_QUESTION), showHistory)
  }

  function openReviewDraft() {
    const question = conversationPanel.current?.querySelector(ACTIVE_NATIVE_QUESTION)
    const draft = reviewDraftFromQuestion(projectRoot, question?.querySelector('h2')?.textContent)
    if (draft?.path === reviewDraft.path && draft.hash === reviewDraft.hash) onOpenReviewDraft(draft)
  }

  function canOpenReviewImage(image) {
    const question = conversationPanel.current?.querySelector(ACTIVE_NATIVE_QUESTION)
    if (question?.getAttribute('aria-labelledby') !== reviewQuestion?.questionId
      || question?.querySelector('h2')?.textContent !== reviewQuestion?.text) return false
    return reviewImagesFromQuestion(projectRoot, question?.querySelector('h2')?.textContent)
      .some(current => current.path === image.path && current.hash === image.hash)
  }

  useEffect(() => {
    if (!visible || !executionExpanded || !conversationPanel.current) return
    const panel = conversationPanel.current
    let seat = null
    let question = null
    let questionId = null
    let frame = null
    const resize = new ResizeObserver(measure)
    const mutation = new MutationObserver(measure)
    // The native composer (including queue and confirmations) must fit inside its lane.
    // Only measure the installed slot; its messages, controls and handlers remain native.
    function measure() {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        const next = panel.querySelector('[data-composer-seat]')
        if (next !== seat) {
          if (seat) resize.unobserve(seat)
          seat = next
          if (seat) resize.observe(seat)
        }
        const activeQuestion = seat?.querySelector(ACTIVE_NATIVE_QUESTION) || null
        const activeId = activeQuestion?.getAttribute('aria-labelledby') || null
        if (activeQuestion && (activeQuestion !== question || activeId !== questionId)) scrollToQuestion(activeQuestion)
        const text = activeQuestion?.querySelector('h2')?.textContent
        setReviewQuestion(previous => previous?.scope === conversationScope && previous.text === text && previous.questionId === activeId
          ? previous : { scope: conversationScope, text, questionId: activeId })
        question = activeQuestion
        questionId = activeId
        const height = Math.ceil(seat?.getBoundingClientRect().height || 0)
        setNativeComposerHeight(previous => previous === height ? previous : height)
      })
    }
    mutation.observe(panel, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['aria-labelledby'] })
    measure()
    return () => {
      resize.disconnect()
      mutation.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [visible, executionExpanded, conversationScope])
  useEffect(() => {
    if (displayError) setCollapsed(false)
  }, [displayError])

  useEffect(() => {
    if (!referencesOpen) return
    const frame = requestAnimationFrame(() => (referenceSource === 'board' ? boardSearch : boardSourceButton).current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [referencesOpen, referenceSource])

  useEffect(() => {
    if (!referencesOpen) return
    const dismiss = event => {
      if (!picker.current?.contains(event.target) && !addButton.current?.contains(event.target)) setReferencesOpen(false)
    }
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [referencesOpen])

  function isPinned(card) { return inputLocked || !revising && !context?.blank && Boolean(card?.pinned || sameReference(card, context?.anchor)) }
  async function runReferenceOperation(operation, kind = 'selection', count = 0) {
    const key = context?.key
    if (busy || referenceOperations.current.has(key)) return false
    const ticket = { key, kind, count }
    referenceOperations.current.set(key, ticket)
    setReferenceWork(previous => new Map(previous).set(key, ticket))
    setReferenceErrors(previous => { const next = new Map(previous); next.delete(key); return next })
    try {
      const result = await operation()
      if (result?.ok === false) throw new Error(referenceErrorMessage(result.error || '引用资料未能更新。'))
      return true
    } catch (cause) {
      if (mounted.current) setReferenceErrors(previous => new Map(previous).set(key, referenceErrorMessage(cause)))
      return false
    } finally {
      if (referenceOperations.current.get(key) === ticket) referenceOperations.current.delete(key)
      if (mounted.current) setReferenceWork(previous => {
        if (previous.get(key) !== ticket) return previous
        const next = new Map(previous)
        next.delete(key)
        return next
      })
    }
  }

  function changeReferences(cards) {
    void runReferenceOperation(() => {
      if (!onReferencesChange) throw new Error('引用选择暂不可用，请稍后重试。')
      return onReferencesChange(uniqueCards(cards))
    })
  }

  async function mentionReference(option) {
    if (referencesBusy) return false
    if (option.card && isChosen(option.card)) return true
    setReferencesOpen(false)
    setPreviewOpen(false)
    return runReferenceOperation(() => {
      if (option.projectFile && onReferenceProjectFile) return onReferenceProjectFile(option.projectFile)
      if (option.card && onReferencesChange) return onReferencesChange([...references, option.card])
      throw new Error('引用选择暂不可用，请稍后重试。')
    })
  }

  function removeReference(card) {
    if (referencesBusy) return
    if (isPinned(card)) return
    changeReferences(references.filter(reference => !sameReference(reference, card)))
  }
  function toggleReference(card) {
    if (referencesBusy || isPinned(card)) return
    changeReferences(isChosen(card) ? references.filter(reference => !sameReference(reference, card)) : [...references, card])
  }
  async function importFiles(event) {
    const files = [...new Set(Array.from(event.currentTarget.files || []))]
    event.currentTarget.value = ''
    if (!files.length) return
    const key = context?.key
    const succeeded = await runReferenceOperation(() => {
      if (!onImportFiles) throw new Error('电脑素材导入暂不可用，请稍后重试。')
      return onImportFiles(files)
    }, 'import', files.length)
    if (succeeded && mounted.current && currentContextKey.current === key) {
      setReferencesOpen(false)
      setReferenceSource(null)
      requestAnimationFrame(() => addButton.current?.focus({ preventScroll: true }))
    }
  }
  function submit() {
    if (!ready || referenceOperations.current.has(context?.key)) return
    if (recoveringMedia) onResumeMedia?.()
    else if (isMedia) onGenerateMedia?.()
    else if (isAction) onAction?.(outputType)
    else onSend?.()
  }

  async function toggleConversation(forceOpen = false, prepareContinuation = false) {
    if (conversationOpen && !forceOpen) { setConversationOpen(false); return }
    if (conversationOpening === conversationScope) return
    const scope = conversationScope
    setConversationOpening(scope)
    setConversationError(null)
    try {
      await onOpenConversation?.()
      if (mounted.current && liveConversationScope.current === scope) {
        const focus = prepareContinuation ? onPrepareContinuation(context.sessionId) : null
        setConversationOpen(true)
        if (focus) requestAnimationFrame(() => {
          if (mounted.current && liveConversationScope.current === scope) focus()
        })
      }
    } catch (cause) {
      if (mounted.current && liveConversationScope.current === scope) setConversationError({ scope, message: referenceErrorMessage(cause) })
    } finally {
      if (mounted.current) setConversationOpening(previous => previous === scope ? null : previous)
    }
  }

  useEffect(() => {
    if (visible && context?.openExecutionRequest) void toggleConversation()
  }, [context?.openExecutionRequest])

  useEffect(() => {
    if (!visible || suspended || !taskMode || !context?.sessionId || conversationAutoScope.current === conversationScope) return
    conversationAutoScope.current = conversationScope
    void toggleConversation(true)
  }, [visible, suspended, taskMode, conversationScope])

  useEffect(() => {
    if (!revisionEditing || !visible) return
    const frame = requestAnimationFrame(() => composer.current?.querySelector('.wcc-creation-instruction textarea')?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [revisionEditing, visible])

  return <section ref={composer} className={`wcc-card-composer nodrag nopan nowheel${isMedia && !legacyMedia && !inputLocked ? ' is-api-media' : ''}${taskMode || reviewingResult ? ' is-task-stage' : ''}${collapsed ? ' is-collapsed' : ''}${hasConversation ? ' has-task-conversation' : ''}${executionExpanded ? ' is-conversation-open' : ''}`} hidden={!visible || suspended}
    style={{ left: position.x, top: frameTop, ...(Number.isFinite(position.width) && position.width > 0 ? { width: `min(${Math.max(240, position.width)}px, calc(100% - 24px))` } : {}), '--wcc-creation-y': `${Math.max(0, frameTop)}px`, '--wcc-native-conversation-min': `${Math.max(360, nativeComposerHeight + 96)}px` }} aria-labelledby={`${id}-title`}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Escape' && referencesOpen) { event.preventDefault(); setReferencesOpen(false); addButton.current?.focus() }
      else if(event.key==='Escape'&&previewOpen){event.preventDefault();setPreviewOpen(false);previewTrigger.current?.focus()}
    }}>
    <header className="wcc-creation-heading">
      <div className="wcc-creation-title-row"><h3 id={`${id}-title`} title={heading}>{heading}</h3>{headingDetail && <span className="wcc-creation-current-type" title={headingDetail} role={stageStatus ? 'status' : undefined}>{headingDetail}</span>}</div>
      <div className="wcc-creation-window-actions">{onTaskControl && (context?.pendingTaskId || context?.pendingGeneration?.taskId || context?.mediaJob?.taskId) && <UiButton variant="quiet" size="compact" onClick={onTaskControl}>任务控制</UiButton>}{collapsed && headingCard?.kind === 'outline' && onAction && <UiButton variant="custom" className="wcc-creation-edit" aria-label="专注编辑当前大纲" disabled={busy} onClick={() => onAction('edit')}>编辑</UiButton>}<UiButton variant="custom" aria-label={collapsed ? '展开卡片创作框' : '收起卡片创作框'} aria-expanded={!collapsed} aria-controls={`${id}-body`} onClick={() => { setCollapsed(value => !value); setReferencesOpen(false) }}><CreationIcon type={collapsed ? 'expand' : 'collapse'} size={15} /></UiButton><UiButton variant="custom" aria-label="关闭卡片创作框" onClick={onClose}><CreationIcon type="close" size={15} /></UiButton></div>
    </header>
    <div ref={scrollBody} id={`${id}-body`} className="wcc-creation-scroll-body" hidden={collapsed}>
    {(taskMode || reviewingResult) && <>
      <TaskInputSummary instruction={instruction} references={references} skills={(context?.selectedSkills || chosenSkills).map(name => skillLabel(skillCatalog?.skills?.find(skill => skill.name === name) || { name }))} model={context?.modelSelection || (taskMode ? modelSelection : undefined)} engine={engineSummary}
        renderFile={getReferenceFileHref ? reference => (reference.importedFile || reference.generatedFile) && <ImportedReferenceFile card={reference} getHref={getReferenceFileHref} /> : undefined} />
      {context?.pendingGeneration?.error && <UserError className="wcc-creation-error" error={context.pendingGeneration.error} />}
      {displayError && displayError !== context?.pendingGeneration?.error && <UserError className="wcc-creation-error" error={displayError} />}
      {canContinue && <div className="wcc-task-stage-actions"><UiButton variant="primary" size="compact" disabled={busy || conversationOpening === conversationScope}
        onClick={() => void toggleConversation(true, true)}>继续任务</UiButton></div>}
      {taskMode && pendingRetryAllowed(context.pendingGeneration) && <div className="wcc-task-stage-actions"><UiButton variant="primary" disabled={!ready} onClick={submit}>重试原任务</UiButton></div>}
      {taskMode && pendingRetryAllowed(context.pendingGeneration) && reason && <p className="wcc-creation-disabled-reason" role="status">{reason}</p>}
      {taskMode && !context?.sessionId && <p className="wcc-creation-execution-note" role="status">{context?.pendingGeneration?.status === 'unknown' ? '提交结果待核对，请从创作任务查看；不要重复发送。' : '尚未连接原任务对话。'}</p>}
    </>}
    {showInitialInput && <>
    <div id={`${id}-setup`} className="wcc-creation-main" hidden={collapsed}>
      {context?.recorded === false && <p className="wcc-creation-history-note" role="status">这份历史文件没有保存提示词。填写修改要求，可生成新版本。</p>}
      {referenceNotes.map(note => <p key={note} className="wcc-creation-history-note" role="status">{note}</p>)}
      {context?.selection && <div className="wcc-creation-selection-scope" role="status"><span>仅引用所选片段 · {selectionLabel(context)} · {Array.from(context.selection.quote || '').length} 个字符</span><UiButton variant="custom" type="button" disabled={busy || inputLocked || !onAction} onClick={() => onAction('whole-source')}>使用整份原文</UiButton></div>}
      <section className={`wcc-creation-reference-area${references.length ? '' : ' is-empty'}`} aria-label="引用资料">
        {!!references.length && <UiButton variant="ghost" size="compact" className="wcc-reference-preview-toggle" aria-label="查看本次引用内容" aria-expanded={previewOpen} aria-controls={`${id}-reference-preview`} onClick={event=>{previewTrigger.current=event.currentTarget;setPreviewOpen(value=>!value);setReferencesOpen(false)}}>{references.length} 份引用<CreationIcon type={previewOpen ? 'collapse' : 'expand'} size={13} /></UiButton>}
        <div className="wcc-creation-reference-chips">{references.map(card => <span key={card.id} className={`wcc-creation-reference-chip${unavailableReason(card) ? ' is-unavailable' : ''}`} title={`${cardTitle(card)}${unavailableReason(card) || card.referenceNote ? ` · ${unavailableReason(card) || card.referenceNote}` : ''}`}>
          <span className="wcc-reference-format">{referenceFormat(card)}</span><UiButton variant="custom" className="wcc-reference-name" type="button" aria-label={`查看引用 ${cardTitle(card)}`} aria-expanded={previewOpen} aria-controls={`${id}-reference-preview`} onClick={event=>{previewTrigger.current=event.currentTarget;setPreviewOpen(true);setReferencesOpen(false);const detail=referenceDetails.current.get(card.id);if(detail)detail.open=true}}>{cardTitle(card)}</UiButton>
          {isPinned(card) ? <span className="wcc-creation-reference-lock" title="已关联到来源卡片" role="img" aria-label="已关联到来源卡片"><CreationIcon type="lock" size={11} /></span> : <UiButton variant="custom" type="button" className="wcc-reference-remove" disabled={referencesBusy} aria-label={`移除引用 ${cardTitle(card)}`} onClick={() => removeReference(card)}><CreationIcon type="close" size={12} /></UiButton>}
        </span>)}</div>
        <UiButton variant="ghost" size="compact" ref={addButton} className="wcc-creation-add-reference" aria-label="添加引用资料" aria-expanded={referencesOpen} aria-controls={`${id}-references`} disabled={referencesBusy} onClick={() => { setReferencesOpen(value => !value); setReferenceSource(null);setPreviewOpen(false) }}><CreationIcon type="plus" size={14} />加引用</UiButton>
        <input ref={fileInput} type="file" hidden multiple accept={acceptedFiles || undefined} aria-label="选择电脑素材文件" onChange={event => void importFiles(event)} />
        <div ref={picker} id={`${id}-references`} hidden={!referencesOpen} className="wcc-creation-reference-picker" aria-label="选择引用资料">
          <div className="wcc-creation-reference-sources" hidden={referenceSource === 'board'}>
            <UiButton variant="custom" ref={boardSourceButton} type="button" disabled={referencesBusy} onClick={() => { setReferenceSource('board'); setSearch('') }}><CreationIcon type="whiteboard" size={16} /><span>从画布选择</span><span aria-hidden="true">›</span></UiButton>
            <UiButton variant="custom" type="button" disabled={referencesBusy || !onImportFiles} title={!onImportFiles ? '电脑素材导入尚未就绪' : '添加本机资料'} onClick={() => fileInput.current?.click()}><CreationIcon type="computer" size={16} /><span>从电脑添加</span><span aria-hidden="true">›</span></UiButton>
          </div>
          <div className="wcc-creation-board-picker" hidden={referenceSource !== 'board'}>
          <div className="wcc-creation-reference-picker-heading"><UiButton variant="custom" type="button" aria-label="返回引用来源" disabled={referencesBusy} onClick={() => setReferenceSource(null)}>‹</UiButton><span>从画布选择</span></div>
          <input ref={boardSearch} aria-label="搜索引用资料" value={search} disabled={referencesBusy} onChange={event => setSearch(event.target.value)} placeholder="搜索当前画布内的资料" spellCheck={false} />
          <div className="wcc-creation-reference-options">{candidates.map(card => {
            const unavailable = unavailableReason(card)
            return <label key={card.id} title={cardTitle(card)}><input type="checkbox" checked={isChosen(card)} disabled={referencesBusy || isPinned(card) || Boolean(unavailable && !isChosen(card))} onChange={() => toggleReference(card)} /><CreationIcon type={card.kind} size={14} /><span><strong>{cardTitle(card)}</strong><small>{unavailable || card.referenceNote || (isPinned(card) ? '来源卡片 · 保留引用' : KIND_LABELS[card.kind] || '资料')}</small></span></label>
          })}{!candidates.length && <p>{search ? '没有匹配的引用资料。' : '当前画布没有可添加的资料。'}</p>}</div>
          <UiButton variant="custom" type="button" className="wcc-creation-reference-done" onClick={() => { setReferencesOpen(false); addButton.current?.focus() }}>完成选择</UiButton>
          </div>
        </div>
        {referencePending && <p className="wcc-creation-reference-pending" role="status">{activeReferenceWork.kind === 'import' ? `正在添加 ${activeReferenceWork.count} 份电脑资料…` : activeReferenceWork.kind === 'media' ? `正在导入 ${activeReferenceWork.count} 份${KIND_LABELS[outputType]}文件…` : '正在更新引用…'}</p>}
        {!!references.length && <div className="wcc-creation-reference-preview" id={`${id}-reference-preview`} hidden={!previewOpen}><div>{references.map(card => <details key={card.id} ref={element=>element?referenceDetails.current.set(card.id,element):referenceDetails.current.delete(card.id)}>
          <summary><span>{referenceFormat(card)}</span>{cardTitle(card)}</summary>
          {card.truncated && <p className="wcc-creation-preview-note">本次引用为节选{Number.isFinite(card.fullLength) ? `，原文共 ${card.fullLength} 字符` : ''}。</p>}
          {card.kind === 'word' && <p className="wcc-creation-preview-note">正文来自此 Word 绑定的大纲版本。</p>}
          {card.referenceNote && <p className="wcc-creation-preview-note">{card.referenceNote}</p>}
          {(card.importedFile || card.generatedFile) && getReferenceFileHref && <ImportedReferenceFile card={card} getHref={getReferenceFileHref} />}
          <pre>{card.previewText ?? card.content ?? '本次未提供正文预览。'}</pre>
          {(card.excerptInfo?.annotation || card.annotation) && <div className="wcc-creation-preview-annotation"><span>注释</span><pre>{card.excerptInfo?.annotation || card.annotation}</pre></div>}
        </details>)}</div></div>}
      </section>
      {inputLocked && <div className={`wcc-creation-pending-state is-${context?.pendingGeneration?.phase || 'unknown'}`} role="status"><strong>{pendingLabel(context?.pendingGeneration)}</strong><p>{context?.pendingGeneration?.error || context?.pendingGeneration?.message || '成果文件保存后会原位更新卡片。'}</p><small>任务已提交。需要补充要求或确认时，请打开「任务对话」。</small></div>}
      {mediaCard && !inputLocked && !reviewingResult && <div className="wcc-media-method" role="group" aria-label="生成方式">
        <UiButton variant="ghost" size="compact" aria-pressed={!isMedia} disabled={busy} onClick={() => onGenerationMethodChange?.('skill')}>Skill 生成</UiButton>
        <UiButton variant="ghost" size="compact" aria-pressed={isMedia} disabled={busy} onClick={() => onGenerationMethodChange?.('api')}>API 生成</UiButton>
      </div>}
      {isMedia && inputLocked ? <div className="wcc-creation-frozen-media"><label>原提示词<textarea value={instruction} readOnly rows={4} /></label><p>{[context?.mediaOptions?.model, context?.mediaOptions?.ratio, context?.mediaOptions?.resolution, context?.mediaOptions?.duration && `${context.mediaOptions.duration} 秒`].filter(Boolean).join(' · ')}</p>{context?.mediaJob?.error && <p className="wcc-creation-error">{context.mediaJob.error}</p>}{context?.mediaJob?.canResume && <UiButton variant="custom" type="button" disabled={busy} onClick={onResumeMedia}>查看进度或取回文件</UiButton>}{['unknown', 'download_failed', 'registration_failed'].includes(context?.mediaJob?.status) && <UiButton variant="custom" type="button" disabled={busy} onClick={onNewMedia}>确认后重新生成</UiButton>}</div>
        : isMedia && !legacyMedia ? <ApiMediaPrompt type={outputType} instruction={instruction} onChange={onInstructionChange} options={mediaOptions} onOptionsChange={onMediaOptionsChange} providers={mediaCapabilities?.providers || []} providerId={context?.providerId} onProviderChange={onMediaProviderChange} onOpenSettings={onOpenMediaSettings} capabilities={activeMediaCapabilities} loading={mediaLoading} error={mediaError} onRefresh={onRefreshMedia} onSubmit={submit} disabled={referencesBusy} mentionProps={mentionProps} /> : isAction ? (actionContent != null ? <div className="wcc-creation-action-content">{actionContent}</div> : <label className="wcc-creation-instruction"><span>处理说明</span><textarea value={instruction} onChange={event => onInstructionChange?.(event.target.value)} disabled={busy} rows={4} maxLength={8000} /></label>) : <SkillCommandInput key={context?.key} instruction={instruction} onChange={onInstructionChange} disabled={busy || inputLocked} catalog={skillCatalog} loading={skillCatalogLoading} error={skillCatalogError} onRefresh={onRefreshSkills} onOpenSettings={() => setSkillSettingsOpen(true)} onSubmit={submit} mentionProps={mentionProps} footer={submitFooter} />}

      {reason && <p className="wcc-creation-disabled-reason" role="status">{reason}</p>}
      {displayError && <UserError className="wcc-creation-error" error={displayError} />}
    </div>
    {(isMedia || isAction) && submitFooter}
    </>}
    <div className="wcc-creation-conversation-heading" hidden={(!hasExecution && !reviewingResult) || (revisionEditing && !taskMode)}>
      {reviewingResult && <UiButton variant="quiet" size="compact" onClick={() => { setConversationOpen(false); setRevisionEditing(true); requestAnimationFrame(() => composer.current?.querySelector('textarea')?.focus({ preventScroll: true })) }}>基于此版修改</UiButton>}
      {hasExecution && <UiButton variant="ghost" size="compact" aria-expanded={conversationOpen} aria-controls={`${id}-conversation`} disabled={conversationOpening === conversationScope} onClick={() => void toggleConversation()}>{conversationOpening === conversationScope ? '正在打开…' : reviewingResult ? '原对话' : '任务对话'}<CreationIcon type={conversationOpen ? 'collapse' : 'expand'} size={13} /></UiButton>}
      {executionExpanded && <div className="wcc-review-jumps">
        {onOpenReviewDraft && reviewDraft && <UiButton variant="quiet" size="compact"
          title={reviewDraft.name} onClick={openReviewDraft}>查看待审稿</UiButton>}
        <UiButton variant="quiet" size="compact" onClick={() => jumpToReview(true)}>查看过程</UiButton>
        <UiButton variant="quiet" size="compact" onClick={() => jumpToReview(false)}>前往确认</UiButton>
      </div>}
    </div>
    {!collapsed && conversationError?.scope === conversationScope && <UserError className="wcc-creation-error wcc-creation-task-error" error={conversationError.message} />}
    {!collapsed && conversationOpen && !hasConversation && <p className="wcc-creation-execution-note" role="status">此版本的执行会话尚未恢复，请重新展开或从任务中核对。</p>}
    {executionExpanded && visible && !suspended && reviewImages.length > 0 && getReviewImageHref && <ReviewImageGallery
      key={`${conversationScope}:${reviewQuestion.questionId}:${reviewQuestion.text}`} images={reviewImages} getHref={getReviewImageHref} onOpen={canOpenReviewImage} />}
    <div ref={conversationPanel} id={`${id}-conversation`} className="wcc-creation-conversation" hidden={!visible || collapsed || !conversationOpen || !hasConversation}>{conversation}</div>
    </div>
    <SkillSettings open={visible && skillSettingsOpen} catalog={skillCatalog} loading={skillCatalogLoading} error={skillCatalogError} onRefresh={onRefreshSkills} onSave={onSaveSkillSettings} onPreference={onUpdateSkillPreference} onClose={() => setSkillSettingsOpen(false)} />
  </section>
}
