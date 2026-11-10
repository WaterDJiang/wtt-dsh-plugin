import { DialogBody, DialogFooter, DialogHeader, PanelHeader, UiButton, UiIcon } from './ui/controls.jsx'
import {DeleteNodesDialog,ProjectRecycleDialog} from './canvas-recycle.jsx'
import {PROJECT_FILE_DRAG, ProjectFilePreview} from './project-explorer.jsx'
import { SvgSourceView } from './svg-source-view.jsx'
import {SavedPptPreview} from './saved-ppt-preview.jsx'
import { OutcomeViewer } from './outcome-viewer.jsx'
import { UserError } from './user-feedback.jsx'
import React, { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Background, ConnectionLineType, Handle, MiniMap, NodeResizer, NodeToolbar, Position, ReactFlow, ReactFlowProvider,
  SelectionMode, applyEdgeChanges, applyNodeChanges, useReactFlow, useViewport,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './canvas.css'
import { CanvasChrome, CanvasSearch, SelectionActions, CanvasContextMenu } from './canvas-chrome.jsx'
import { WhiteboardNode, WhiteboardStyleControls } from './whiteboard-nodes.jsx'
import { createLayoutHistory } from './canvas-history.mjs'
import { OutlineDesk } from './outline-desk.jsx'
import { SourceReader } from './source-reader.jsx'
import { CourseTasks } from './course-tasks.jsx'
import { normalizeLineEndings } from './text-diff.mjs'
import { NodeCreateMenu, CardComposer } from './card-creation.jsx'
import { mediaJobPending, mediaOptionsFor, mediaSizeLabel } from './media-creation.jsx'
import { createCardContext, createCompositionContext, createRevisionContext, creationSource, updateCreationReferences, creationTaskInput, adjacentCreationPosition, visibleCreationPosition, usableCreationSource } from './creation-context.mjs'
import { OutputPreview, DeckPreview } from './output-preview.jsx'
import { SlideDraftCover } from './slide-draft-cover.jsx'
import { AssetBoard } from './asset-board.jsx'
import { DocumentViewer } from './document-preview.jsx'
import { RichTextEditor } from './rich-text-editor.jsx'
import './studio-polish.css'
import { useDockLayout } from './dock-layout.jsx'
import { PptEditor } from './ppt-editor.jsx'
import { BaoyuSlides } from './baoyu-slides.jsx'
import { createPendingContext, generationStateSignature, isActiveTaskPhase, nativePendingState, pendingCardTitle, pendingContinueAllowed, pendingLabel, pendingRetryAllowed, publishedTaskGeneration } from './pending-card-state.mjs'

import { taskInteractions, interactionLabel } from './skill-interactions.mjs'
import { SkillConfirmation } from './skill-confirmation.jsx'
import { attachCanvasGestures } from './canvas-gestures.mjs'
import { cardCapabilities, cardTextDraftKey } from './card-capabilities.mjs'
import { VersionSelect } from './version-select.jsx'

const CARD_WIDTH = 258
const CARD_HEIGHT = 208
const LABELS = { requirement: '背景', material: '素材', excerpt: '摘录', outline: '课程大纲', word: 'Word 文档', whiteboard: '白板', artifact: '成果文件', generation: '创作任务' }
const OUTPUT_LABELS = { text: '文本', image: '图片', video: '视频', outline: '课程大纲', pptx: 'PPT', exercise: '课堂练习', script: '讲师逐字稿', storyboard: 'PPT 分镜', support: '制作资料', material: '素材卡', excerpt: '摘录卡', word: 'Word 文档' }
const EMPTY_MATERIAL = { title: '', content: '', sourcePath: '' }
const REFERENCE_FILE_TYPES = /\.(txt|md|csv|json|jsonl|pdf|docx|pptx|png|jpe?g|webp|gif|mp4|webm)$/i
const REFERENCE_FILE_LIMIT = 20 * 1024 * 1024

async function referenceHash(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
}

function apiEndpoint(query, projectId) {
  const url = new URL('api/wtt-creation-workbench', document.baseURI)
  if (projectId) url.searchParams.set('projectId', projectId)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function stableOperation(attempt, payload) {
  const signature = JSON.stringify(payload)
  if (attempt.current?.signature !== signature) attempt.current = { signature, id: crypto.randomUUID() }
  return attempt.current.id
}

function stateLabel(card) {
  if (card.kind === 'generation') return pendingLabel(card.pendingGeneration)
  const labels = {
    ready: '可查看正文', available: '可查看正文', missing: '文件缺失', unavailable: '文件不可用',
    modified: '文件已变化', changed: '文件已变化',
    unextracted: '未提取正文', not_extracted: '未提取正文', linked: '已关联文件',
  }
  if (card.status && card.status !== 'ready') return labels[card.status] || card.status
  if (card.sourceStatus && card.sourceStatus !== 'ready') return `素材已保存 · 原${labels[card.sourceStatus] || card.sourceStatus}`
  if (card.kind === 'word') return '已导出 · 绑定原版本'
  if (card.kind === 'outline') return '已保存 · 独立版本'
  if (card.kind === 'material') return card.importedFile?.mime?.startsWith('video/') ? '视频素材 · 原件已保存' : card.importedFile?.mime?.startsWith('image/') ? '图片素材 · 原图已保存' : card.sourcePath && card.extracted === false ? '未提取正文' : '已保存素材'
  if (card.kind === 'excerpt') return '摘录已保存 · 可查看来源'
  if (card.kind === 'artifact') return card.generatedFile ? `已生成 · ${mediaSizeLabel(card.generatedFile) || '可下载文件'}` : card.artifactKind === 'pptx' ? '已保存 · 可编辑 PPT' : '已保存 · 可下载'
  if (card.kind === 'whiteboard') return '可编辑白板元素'
  return '背景资料'
}


export const ContentCard = memo(function ContentCard({ id, data, selected, isConnectable }) {
  const [videoError, setVideoError] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState('')
  const [openMenu, setOpenMenu] = useState(false)
  const [openApps, setOpenApps] = useState(null)
  const editor = useRef(null)
  const wasEditing = useRef(false)
  const cancelled = useRef(false)
  const openMenuRef = useRef(null)
  const officeDraft = useRef(null)
  const caps = cardCapabilities(data)
  const writeBack = ['project-file', 'snapshot'].includes(caps.writeBack.mode)
  const textDraft = caps.writeBack.mode === 'draft'
  const openTarget = caps.openWith ? { ...caps.openWith, hash: data.sourceHash,
    ...(data.refId && !caps.openWith.sourceRef && ['material', 'artifact', 'word', 'outline'].includes(data.kind) ? { sourceRef: `${data.kind}:${data.refId}` } : {}),
    ...(data.outputCard ? { cardId: data.outputCard.id, versionId: data.outputCard.versionId } : {}) } : null
  useEffect(() => {
    if (!openMenu) return
    const close = event => { if (!openMenuRef.current?.contains(event.target)) setOpenMenu(false) }
    const key = event => { if (event.key === 'Escape') setOpenMenu(false) }
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key) }
  }, [openMenu])
  function loadOpenApps() {
    if (!openTarget || openApps) return
    setOpenApps('loading')
    data.onLoadOpenApps?.(openTarget).then(result => {
      officeDraft.current = result.mode === 'office' ? { draftId: result.draftId } : null
      setOpenApps(result.applications || [])
    }).catch(() => setOpenApps([]))
  }
  useEffect(()=>{if(wasEditing.current&&!editing){if(!cancelled.current&&writeBack&&draft.trim()&&draft!==text)void saveText();data.onEditEnd?.()}wasEditing.current=editing},[editing])
  useEffect(()=>()=>{if(wasEditing.current)data.onEditEnd?.()},[])
  const documentExtension = (data.importedFile?.name || data.path || '').match(/\.(csv|docx|pdf)$/i)?.[1]?.toUpperCase()
  const text = caps.editableText.base
  const draftKey = cardTextDraftKey(data)
  useEffect(() => { setEditing(false); setEditError('') }, [draftKey])
  useEffect(() => { if (!selected && !saving) setEditing(false) }, [selected, saving])
  useEffect(() => { if (editing) editor.current?.focus({ preventScroll: true }) }, [editing])
  useEffect(() => { if (data.autoEdit && selected) beginEdit() }, [data.autoEdit, selected])
  function beginEdit(event) {
    if (text === null || saving) return
    event?.preventDefault(); event?.stopPropagation()
    cancelled.current = false
    data.onEditStart?.()
    setDraft(data.getTextDraft?.(draftKey) ?? text); setEditError(''); setEditing(true)
  }
  async function saveText() {
    if (saving || !draft.trim() || draft === text) return
    setSaving(true); setEditError('')
    try { await data.onSaveText?.(data, draft); data.setTextDraft?.(draftKey, null); setEditing(false) }
    catch (cause) { setEditError(messageOf(cause)); if (writeBack) setEditing(true) }
    finally { setSaving(false) }
  }
  const execution = data.publishedGeneration || nativePendingState(data.pendingGeneration, data.nativeSessionStatus)
  const pending = execution?.published && !isActiveTaskPhase(execution.phase) ? undefined : execution
  const format = caps.format
  const fileDeck = data.defaultOutcome?.format === 'pptx' ? data.defaultOutcome : null
  const purpose = caps.purpose
  const formatLabel = data.defaultOutcome?.format?.toUpperCase() || (format === 'document' && documentExtension ? documentExtension : { text: '文本', pptx: 'PPT', image: '图片', video: '视频', document: '文档' }[format] || '内容')
  useEffect(() => { setVideoError(false) }, [data.videoPreview])
  const warning = data.delivery?.status === 'failed' || /missing|modified|changed|unavailable|缺失|变化|外改/.test(`${data.status || ''} ${data.sourceStatus || ''} ${data.projectFile?.status || ''}`)
  return <article className={`wcc-card wcc-card-${data.kind}${selected ? ' is-selected' : ''}${editing ? ' is-editing' : ''}${data.skillTodo ? ' has-skill-todo' : ''}`} aria-label={`${formatLabel}${purpose ? ` · ${purpose}` : ''}卡：${data.title}`} data-card-format={format || undefined} data-card-id={id} data-card-draft={data.composition ? true : undefined} onDoubleClick={beginEdit}>
    <NodeResizer nodeId={id} isVisible={selected && !saving} minWidth={200} minHeight={160} maxWidth={1200} maxHeight={1200}
      color="var(--wtt-ui-accent)" handleClassName="wcc-content-resize-handle" lineClassName="wcc-content-resize-line"
      onResizeStart={() => data.onResizeStart?.()} onResizeEnd={(_event, size) => data.onResizeEnd?.(id, size)} />
    <Handle type="target" position={Position.Left} isConnectable={isConnectable} aria-label={`连接到 ${data.title}`} />
    <header className="wcc-card-grip">
      <div className="wcc-card-heading"><h3 title={data.defaultOutcome?.name || data.title}>{data.defaultOutcome?.name || data.title || pendingCardTitle(data)}</h3><div className="wcc-card-metadata"><span className="wcc-card-kind">{formatLabel}</span>{purpose && <span className="wcc-card-purpose">{purpose}</span>}</div></div>
      <div className="wcc-card-heading-actions">{caps.versioned && <VersionSelect className="wtt-version-compact" ariaLabel={`选择 ${data.title} 的版本`}
        versions={data.outputCard?.versions?.length ? data.outputCard.versions : data.materialVersions}
        value={data.outputCard?.versionId || data.currentMaterialVersionId}
        onChange={value => data.outputCard ? data.onVersionChange?.(value) : data.onMaterialVersionView?.(value)} />}
        {!caps.versioned && data.number != null && <span className="wcc-version">v{String(data.number).padStart(3, '0')}</span>}
      {openTarget && <span className="wcc-card-open-wrap" ref={openMenuRef}>
        <UiButton variant="ghost" size="compact" iconOnly type="button" className="nodrag nopan" aria-label={`打开方式：${data.title}`} title="打开方式" aria-haspopup="menu" aria-expanded={openMenu || undefined}
          onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setOpenMenu(value => { const next = !value; if (next) loadOpenApps(); return next }) }}><UiIcon name="more" /></UiButton>
        {openMenu && <div className="wcc-card-open-menu nodrag nopan" role="menu" aria-label={`打开方式：${data.title}`} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
          <UiButton variant="custom" type="button" role="menuitem" onClick={() => { setOpenMenu(false); data.onOpenInspect?.() }}>查看内容</UiButton>
          {data.projectFile?.status === 'missing' && <UiButton variant="custom" type="button" role="menuitem" onClick={() => { setOpenMenu(false); data.onRestoreFile?.() }}>重新生成源文件</UiButton>}
          <div className="wcc-card-open-divider" role="separator" />
          {openApps === 'loading' && <p className="wcc-card-open-status" role="status">正在获取应用列表…</p>}
          {Array.isArray(openApps) && openApps.map(app => <UiButton variant="custom" type="button" role="menuitem" key={app.id} onClick={() => { setOpenMenu(false); data.onOpenWithApp?.(openTarget, app.id, officeDraft.current?.draftId) }}>{app.name}</UiButton>)}
          {Array.isArray(openApps) && !openApps.length && <p className="wcc-card-open-status">未检测到其他本机应用。</p>}
          <div className="wcc-card-open-divider" role="separator" />
          <UiButton variant="custom" type="button" role="menuitem" onClick={() => { setOpenMenu(false); data.onRevealFile?.(openTarget) }}>打开所在文件夹</UiButton>
        </div>}
      </span>}
      <span className="wcc-grip" aria-hidden="true">⠿</span></div>
    </header>
    {editing ? <div className="wcc-card-inline-editor nodrag nopan nowheel" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => {
      event.stopPropagation()
      if (event.nativeEvent?.isComposing || saving) return
      if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; data.setTextDraft?.(draftKey, null); setEditing(false) }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void saveText() }
    }}>
      <RichTextEditor ref={editor} label={`编辑 ${data.title} 的正文`} value={draft} disabled={saving} markdown={textDraft||data.kind==='outline'||/\.md$/i.test(data.path||data.importedFile?.name||'')} onChange={value=>{setDraft(value);data.setTextDraft?.(draftKey,value)}} />
      {editError && <UserError error={editError} />}
      <div><UiButton variant="quiet" type="button" disabled={saving} onClick={() => { cancelled.current = true; data.setTextDraft?.(draftKey, null); setEditing(false) }}>取消</UiButton><UiButton variant="quiet" type="button" disabled={saving || !draft.trim() || draft === text} onClick={() => void saveText()}>{saving ? '保存中…' : textDraft ? '保存正文' : data.kind === 'requirement' ? '保存背景' : writeBack ? '保存到文件' : data.outputCard ? '保存新版本' : '另存素材'}</UiButton></div>
    </div> : <div className="wcc-card-body">
      {data.projectFile?.status === 'missing' && <p className="wcc-card-missing" role="status">源文件已被删除，可在「打开方式」菜单重新生成。</p>}
      {data.skillTodo && <UiButton variant="custom" type="button" className="wcc-skill-todo nodrag nopan" onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); data.onOpenSkillTodo?.() }}><strong>待办 · {interactionLabel(data.skillTodo.interaction)}</strong><span>{data.skillTodo.interaction.questions?.[0]?.question || '核对执行权限'} →</span></UiButton>}
      {textDraft && <div className="wcc-text-draft-actions nodrag nopan" onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
        <UiButton variant="quiet" size="compact" type="button" onClick={beginEdit}>编辑正文</UiButton>
        <UiButton variant="quiet" size="compact" type="button" onClick={event => { event.stopPropagation(); data.onOpenPending?.() }}>用 AI 创作</UiButton>
      </div>}
      {pending && !data.skillTodo && !textDraft && <UiButton variant="custom" className={`wcc-card-generation-status nodrag nopan is-${pending.phase || 'unknown'}`} type="button"
        onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); data.onOpenPending?.() }} title={pending.error || pending.message}>
        <span className="wcc-generation-indicator" aria-hidden="true" /><strong>{pending.phase === 'idle' && data.slideProject && !fileDeck ? '工程草稿待保存' : pending.phase === 'generating' && data.kind !== 'generation' && !pending.published ? '新版生成中' : pendingLabel(pending)}</strong><span>{data.composition ? '填写要求 →' : pendingContinueAllowed(pending) ? '继续任务 →' : '查看任务 →'}</span>
      </UiButton>}
      {textDraft ? null : fileDeck ? <OutputPreview compact type="pptx" title={fileDeck.name} status={fileDeck.status} artifactId={fileDeck.artifactId} hash={fileDeck.hash} loadPreview={data.loadDeckPreview} getPageHref={data.getDeckPageHref} onOpenDeck={()=>data.onOpenOutcome?.(fileDeck.sourceRef)} /> : data.kind === 'generation' && data.slideProject ? <SlideDraftCover project={data.slideProject} title={data.title} loadCover={data.loadSlideCover} onOpen={data.onOpenDeck} running={pending?.phase === 'generating'} /> : data.kind === 'generation' ? <p className="wcc-card-generation-message">{pending?.error || (pending?.nativeLabel ? '在原任务的「任务对话」中继续。' : pending?.message) || '成果文件保存后将在这里显示。'}</p> : data.outputCard ? <OutputPreview compact type={data.outputCard.type} title={data.title} content={data.content || data.excerpt}
        extracted={data.extracted !== false} mime={data.generatedFile?.mime || data.importedFile?.mime} src={data.videoPreview || data.imagePreview}
        status={data.status || 'ready'} downloadHref={data.downloadHref} artifactId={data.artifactKind === 'pptx' ? data.refId : undefined}
        hash={data.sourceHash} loadPreview={data.loadDeckPreview} getPageHref={data.getDeckPageHref} onOpenDeck={data.onOpenDeck} />
        : data.videoPreview ? <><video className="wcc-imported-thumbnail nodrag nopan" aria-label={`预览视频：${data.title}`} src={data.videoPreview} controls preload="metadata" playsInline onError={() => setVideoError(true)} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} />{videoError && <small>此浏览器无法播放，可下载原件。</small>}</> : data.imagePreview ? <img className="wcc-imported-thumbnail" src={data.imagePreview} alt={data.title} loading="lazy" draggable={false} /> : <p className="wcc-card-excerpt">{data.kind === 'requirement' && typeof data.requirementBackground === 'string' ? data.requirementBackground.slice(0, 260) || '暂无背景信息。' : data.excerpt || (data.kind === 'word' ? '选中查看所属版本与下载文件。' : data.content?.slice(0, 260)) || '选中查看详细内容。'}</p>}
    </div>}
    {!editing && (fileDeck || data.slideProject) && <div className="wcc-outcome-actions nodrag nopan" onPointerDown={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()}>
      {fileDeck && <UiButton variant="quiet" size="compact" onClick={e=>{e.stopPropagation();data.onOpenOutcome?.(fileDeck.sourceRef)}}>查看 PPTX{fileDeck.role==='attachment'?' · 附件':''}</UiButton>}
      {data.slideProject && <UiButton variant="quiet" size="compact" onClick={e=>{e.stopPropagation();data.onOpenWeb?.()}} title={fileDeck && data.slideProject.artifactId !== fileDeck.artifactId ? '同任务的其他网页工程，未关联当前PPTX' : undefined}>{fileDeck && data.slideProject.artifactId !== fileDeck.artifactId ? '其他网页工程' : '编辑网页课件'}</UiButton>}
    </div>}
    <footer hidden={data.kind === 'generation' && Boolean(data.slideProject)} className={warning ? 'wcc-card-footer is-warning' : 'wcc-card-footer'} title={data.projectFile?.path || data.sourcePath || data.path || ''}>
      <span className="wcc-state-dot" />{['artifact', 'outline', 'word'].includes(data.kind) ? <UiButton variant="custom" type="button" className="wcc-card-file nodrag nopan" aria-label={`打开所在文件夹：${data.delivery?.fileName || data.title}`} title={data.delivery?.error || data.delivery?.path || '将此版本整理为同名文件并在 Finder 中显示'} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); data.onOpenFile?.() }}>
        <span>{data.delivery?.fileName || '整理并定位文件'}</span><small>{data.delivery?.version === 0 ? '制作资料' : `V${String(data.delivery?.version || data.outputCard?.number || 1).padStart(3, '0')}`}</small><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M3 7V5h7l2 2h9v13H3Z" /></svg>
      </UiButton> : data.projectFile ? <span>{data.projectFile.status==='ready'?'文件引用':'原文件已变化 · 引用保留'}</span> : stateLabel({ ...data, pendingGeneration: pending })}
    </footer>
    <Handle type="source" position={Position.Right} isConnectable={isConnectable} aria-label={`从 ${data.title} 连线`} />
    <NodeToolbar isVisible={selected && data.kind !== 'generation'} position={Position.Right} offset={12}>
      <UiButton variant="custom" className="wcc-card-create nodrag nopan" aria-label={`从 ${data.title} 新建关联内容`} title="新增关联内容" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); data.onCreate?.(id) }}>＋</UiButton>
    </NodeToolbar>
  </article>
})

const CardGroup = memo(function CardGroup({ data, selected }) {
  return <div className={`wcc-group${selected ? ' is-selected' : ''}`}>
    <div className="wcc-group-title"><span aria-hidden="true">▧</span> {data.title}<span>{data.count} 张卡片</span></div>
  </div>
})

const NODE_TYPES = { content: ContentCard, courseGroup: CardGroup, whiteboard: WhiteboardNode }
const isObject = node => node.type === 'content' || node.type === 'whiteboard'
const nodeSize = node => ({ width: Number(node.width || node.style?.width || node.data?.width || CARD_WIDTH), height: Number(node.height || node.style?.height || node.data?.height || CARD_HEIGHT) })

function absolutePosition(node, nodes) {
  const parent = node.parentId && nodes.find(item => item.id === node.parentId)
  return parent ? { x: parent.position.x + node.position.x, y: parent.position.y + node.position.y } : node.position
}

function resizeGroups(nodes) {
  const absolute = new Map(nodes.filter(isObject).map(node => [node.id, absolutePosition(node, nodes)]))
  const bounds = new Map()
  for (const group of nodes.filter(node => node.type === 'courseGroup')) {
    const members = nodes.filter(node => node.parentId === group.id)
    if (!members.length) continue
    const minX = Math.min(...members.map(node => absolute.get(node.id).x))
    const minY = Math.min(...members.map(node => absolute.get(node.id).y))
    bounds.set(group.id, {
      x: minX - 24, y: minY - 44,
      width: Math.max(...members.map(node => absolute.get(node.id).x + nodeSize(node).width)) - minX + 48,
      height: Math.max(...members.map(node => absolute.get(node.id).y + nodeSize(node).height)) - minY + 66,
    })
  }
  let changed = false
  const next = nodes.map(node => {
    const ownBounds = bounds.get(node.id)
    if (ownBounds) {
      if (node.position.x === ownBounds.x && node.position.y === ownBounds.y && node.style?.width === ownBounds.width && node.style?.height === ownBounds.height) return node
      changed = true
      return { ...node, position: { x: ownBounds.x, y: ownBounds.y }, style: { ...node.style, width: ownBounds.width, height: ownBounds.height } }
    }
    const parentBounds = bounds.get(node.parentId)
    if (!parentBounds) return node
    const position = { x: absolute.get(node.id).x - parentBounds.x, y: absolute.get(node.id).y - parentBounds.y }
    if (node.position.x === position.x && node.position.y === position.y) return node
    changed = true
    return { ...node, position }
  })
  return changed ? next : nodes
}

function flowFromBoard(board, selectedIds = []) {
  const selected = new Set(selectedIds)
  const membership = new Map()
  const groups = []
  for (const group of board.groups || []) {
    const members = board.nodes.filter(node => group.nodeIds.includes(node.id))
    if (!members.length) continue
    const minX = Math.min(...members.map(node => node.position.x))
    const minY = Math.min(...members.map(node => node.position.y))
    const position = { x: minX - 24, y: minY - 44 }
    groups.push({
      id: group.id, type: 'courseGroup', position, data: { title: group.title, count: members.length },
      style: {
        width: Math.max(...members.map(node => node.position.x + (node.width || CARD_WIDTH))) - minX + 48,
        height: Math.max(...members.map(node => node.position.y + (node.height || CARD_HEIGHT))) - minY + 66,
      },
      dragHandle: '.wcc-group-title', selectable: true, deletable: false, zIndex: -1,
    })
    for (const node of members) membership.set(node.id, { id: group.id, position })
  }
  const cards = board.nodes.map(card => {
    const group = membership.get(card.id)
    return {
      id: card.id, type: card.kind === 'whiteboard' ? 'whiteboard' : 'content', data: card,
      position: group ? { x: card.position.x - group.position.x, y: card.position.y - group.position.y } : card.position,
      ...(group ? { parentId: group.id } : {}),
      selected: selected.has(card.id), deletable: false, dragHandle: card.kind === 'whiteboard' ? '.wcc-element-grip' : undefined,
      width: card.width || CARD_WIDTH, height: card.height || CARD_HEIGHT,
      style: { width: card.width || CARD_WIDTH, height: card.height || CARD_HEIGHT },
    }
  })
  return [...groups, ...cards]
}

function flowEdges(edges) {
  return (edges || []).map(edge => ({
    ...edge, type: 'default', pathOptions: { curvature: 0.35 }, deletable: !edge.provenance,
    className: edge.provenance ? 'wcc-provenance-edge' : 'wcc-user-edge',
    ...(edge.provenance ? { label: '来源', labelBgPadding: [5, 3], labelBgBorderRadius: 3 } : {}),
    ariaLabel: edge.provenance ? '来源关系，随业务记录保留' : '手动关联线，可选中删除',
  }))
}

function MaterialDialog({ initial, busy, error, onClose, onSubmit }) {
  const [values, setValues] = useState(initial || EMPTY_MATERIAL)
  const dialog = useRef(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} className="wcc-material-dialog" aria-labelledby="wcc-material-title" onCancel={event => {
    event.preventDefault()
    if (!busy) onClose()
  }}>
    <form onSubmit={event => { event.preventDefault(); onSubmit(values) }}>
      <DialogHeader title="添加素材" titleId="wcc-material-title" onClose={onClose} busy={busy}/><DialogBody>
      <label><span>素材名称</span><input autoFocus required maxLength={200} value={values.title} onChange={event => setValues({ ...values, title: event.target.value })} placeholder="例如：客户反馈、参考案例" /></label>
      <label><span>文字内容</span><textarea rows={7} value={values.content} onChange={event => setValues({ ...values, content: event.target.value })} placeholder="粘贴客户原话、背景资料或课堂案例。" /></label>
      <label><span>关联工作目录内文件 <small>可选，相对路径</small></span><input value={values.sourcePath} onChange={event => setValues({ ...values, sourcePath: event.target.value })} placeholder="例如：参考资料/客户需求.pdf" /></label>
      <p className="wcc-muted">{initial?.snapshot ? '将当前文字另存为素材，原文件保留。需要关联文件时可填写路径。' : '原文件会保留。PDF、Word 等文件先建立关联，正文提取状态以实际结果为准。'}</p>
      {error && <UserError className="wcc-error" error={error} />}
      </DialogBody><DialogFooter><UiButton variant="quiet" type="button" disabled={busy} onClick={onClose}>取消</UiButton><UiButton variant="primary" type="submit" className="wcc-primary" disabled={busy}>{busy ? '保存中…' : '保存素材'}</UiButton></DialogFooter>
    </form>
  </dialog>
}

function GroupDialog({ busy, onClose, onSubmit }) {
  const [title, setTitle] = useState('课程素材')
  const dialog = useRef(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} className="wcc-group-dialog" aria-labelledby="wcc-group-title" onCancel={onClose}>
    <form onSubmit={event => { event.preventDefault(); if (title.trim()) onSubmit(title.trim()) }}>
      <DialogHeader title="将所选卡片分组" titleId="wcc-group-title" onClose={onClose} busy={busy}/><DialogBody>
      <label><span>分组名称</span><input autoFocus required maxLength={100} value={title} onChange={event => setTitle(event.target.value)} /></label>
      </DialogBody><DialogFooter><UiButton variant="quiet" type="button" disabled={busy} onClick={onClose}>取消</UiButton><UiButton variant="primary" type="submit" className="wcc-primary" disabled={busy}>创建分组</UiButton></DialogFooter>
    </form>
  </dialog>
}

function CanvasContent({ fileRecycleSignal, projectFileSelection, onCloseProjectFile, onAddProjectFile, fileAddRequest, recycleRequest, onCloseRecycle, onFilesChanged, projectBar, project, projectId, dependencies, active = true, requirement, request, onChanged, onStart, conversation, conversationSessionId, onSessionRestore, onPrepareContinuation, refreshSignal, draftCache, creationCache, onAssetNavigate, renderNativePreview,renderEditorConversation,
  modelCatalog, modelSelection, onModelChange, onRefreshModels, onOpenModelSettings, modelLoading, modelError, nativeSessionStatuses, onWatchTaskSessions, onPreviewProjectFile }) {
  const panelId = useId()
  const endpoint = query => apiEndpoint(query, projectId)
  const flow = useReactFlow()
  const modelSelectionRef = useRef(modelSelection)
  modelSelectionRef.current = modelSelection
  const [watchedStatuses, setWatchedStatuses] = useState(new Map())
  const effectiveStatuses = new Map([...(nativeSessionStatuses || []), ...watchedStatuses])
  const nativeStatusesRef = useRef(effectiveStatuses)
  nativeStatusesRef.current = effectiveStatuses
  const liveViewport = useViewport()
  const cache = useRef(creationCache || { drafts: new Map(), attempts: new Map(), activeKey: null, visible: false })
  if (!cache.current.textDrafts) cache.current.textDrafts = new Map()
  if (!cache.current.textAttempts) cache.current.textAttempts = new Map()
  if (!cache.current.documentDrafts) cache.current.documentDrafts = new Map()
  if (!cache.current.reservations) cache.current.reservations = new Map()
  if (!cache.current.cardKeys) cache.current.cardKeys = new Map()
  if (!cache.current.sourceDraftKeys) cache.current.sourceDraftKeys = new Map()
  if (!cache.current.referenceOperations) cache.current.referenceOperations = new Map()
  if (!cache.current.versionViews) cache.current.versionViews = new Map()
  if (!cache.current.compositionSaving) cache.current.compositionSaving = new Set()
  if (!cache.current.outputTracking) cache.current.outputTracking = new Map()
  const [creation, setCreation] = useState(() => cache.current.drafts.get(cache.current.activeKey) || null)
  const creationRef = useRef(creation)
  const creationIntent = useRef(0)
  const cardOpenTimer = useRef(null)
  const nodeDragging = useRef(false)
  const [draggingCard, setDraggingCard] = useState(false)
  creationRef.current = creation
  const [creationVisible, setCreationVisible] = useState(() => cache.current.visible)
  const [creationMenu, setCreationMenu] = useState(null)
  const [deletePlan,setDeletePlan]=useState(null)
  const [recycleOpen,setRecycleOpen]=useState(false)
  useEffect(()=>{if(recycleRequest&&active)setRecycleOpen(true)},[recycleRequest,active])
  const [deckPreview, setDeckPreviewState] = useState(null)
  const [editorFullscreen,setEditorFullscreen]=useState(false),editorCloseRequest=useRef(null)
  const [outcomeView, setOutcomeView] = useState(null)
  const deckPreviewRef = useRef(null)
  const [pptConversationOwner, setPptConversationOwner] = useState(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const [canvasSize, setCanvasSize] = useState({ width: 900, height: 700 })
  const canvasSizeRef = useRef(canvasSize)
  canvasSizeRef.current = canvasSize
  const [board, setBoard] = useState(null)
  const [nodes, setNodes] = useState([])
  const [edges, setEdges] = useState([])
  const [loading, setLoading] = useState(true)
  const loadingRef = useRef(loading)
  loadingRef.current = loading
  const viewportRequest = useRef(null)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [skillCatalog, setSkillCatalog] = useState({ skills: [], settings: { directories: [], favorites: [] } })
  const [skillCatalogLoading, setSkillCatalogLoading] = useState(false)
  const [skillCatalogError, setSkillCatalogError] = useState('')
  const [mediaCapabilities, setMediaCapabilities] = useState(null)
  const [mediaLoading, setMediaLoading] = useState(false)
  const [mediaError, setMediaError] = useState('')
  const mediaBoardRefresh = useRef(false)
  const mediaTracking = useRef(new Map())
  const mediaRestores = useRef(new Map())
  const [saveStatus, setSaveStatus] = useState('saved')
  const [busy, setBusy] = useState('')
  const [sidebar, setSidebar] = useState(false)
  const [editingTextCard,setEditingTextCard] = useState(null)
  const [tool, setTool] = useState('select')
  const paneInsertTimer = useRef(null)
  function cancelPaneInsert() {
    clearTimeout(paneInsertTimer.current)
    paneInsertTimer.current = null
  }
  useEffect(() => cancelPaneInsert, [active, requirement.id, tool, busy, loading])
  const [zoom, setZoom] = useState(1)
  const [showMap, setShowMap] = useState(false)
  const [contextMenu, setContextMenu] = useState(null)
  const [focusOpen, setFocusOpen] = useState(false)
  const [tasks, setTasks] = useState([])
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  const creationTask = creation?.taskId && tasks.find(task => task.id === creation.taskId && task.sessionId === creation.sessionId)
  const publishedExecution = publishedTaskGeneration(creationTask, effectiveStatuses.get(creationTask?.sessionId))
  const [skillReview, setSkillReview] = useState(null)
  const [skillDeckPreview, setSkillDeckPreview] = useState(null)
  const skillDrafts = useRef(new Map())
  const interactions = taskInteractions(tasks, effectiveStatuses, requirement.id)
  const interactionsRef = useRef(interactions)
  interactionsRef.current = interactions
  const taskSessionIds = JSON.stringify([...new Set(tasks.filter(task => task.kind === 'ai').map(task => task.sessionId).filter(Boolean))].sort())
  useEffect(() => {
    setWatchedStatuses(new Map())
    if (!active || !onWatchTaskSessions || taskSessionIds === '[]') return
    return onWatchTaskSessions({ projectId, cwd: project.path, sessionIds: JSON.parse(taskSessionIds) }, setWatchedStatuses, setError)
  }, [active, projectId, project.path, taskSessionIds, onWatchTaskSessions])
  const [readerRange, setReaderRange] = useState(null)
  const [excerptError, setExcerptError] = useState('')
  const [, setHistoryGeneration] = useState(0)
  const rootRef = useRef(null)
  const dock = useDockLayout(rootRef, active, Boolean(deckPreview&&(deckPreview.slideProject||deckPreview.svgCandidateId||deckPreview.svgSourceId)))
  const graphRef = useRef(null)
  const elementsRef = useRef([])
  const historyRef = useRef(createLayoutHistory())
  const gestureBefore = useRef(null)
  const resizingRef = useRef(false)
  const [tab, setTab] = useState('inspect')
  const [assetsOpen, setAssetsOpen] = useState(false)
  const [documentView, setDocumentViewState] = useState(null)
  const documentViewRef = useRef(null)
  const documentNavigation = useRef(0)
  documentViewRef.current = documentView
  function setDocumentView(value){
    const intent=++documentNavigation.current,leave=cache.current.beforeDocumentLeave
    if(!leave){documentViewRef.current=value;setDocumentViewState(value);return}
    void leave().then(()=>{if(mounted.current&&intent===documentNavigation.current){documentViewRef.current=value;setDocumentViewState(value)}})
      .catch(cause=>{if(mounted.current)setError(`文档草稿尚未保存：${messageOf(cause)}。请在右栏重试或下载草稿。`)})
  }
  const [searchQuery, setSearchQuery] = useState('')
  const [allRelations, setAllRelations] = useState(false)
  const [materialDialog, setMaterialDialog] = useState(null)
  const [materialError, setMaterialError] = useState('')
  const [groupDialog, setGroupDialog] = useState(false)
  const [outline, setOutline] = useState('')
  const [draggingFile, setDraggingFile] = useState(false)
  const [selectionKey, setSelectionKey] = useState('')
  const [edgeSelection, setEdgeSelection] = useState([])
  const [loadedViewport, setLoadedViewport] = useState(null)
  const nodesRef = useRef([])
  const edgesRef = useRef([])
  const boardRef = useRef(null)
  const groupsRef = useRef([])
  const viewportRef = useRef({ x: 0, y: 0, zoom: 1 })
  const gestureViewportActive = useRef(false)
  const chainRef = useRef(Promise.resolve())
  const queuedSignature = useRef('')
  const pendingCount = useRef(0)
  const epochRef = useRef(0)
  const mounted = useRef(true)
  const conflictRef = useRef(false)
  const operationLock = useRef(false)
  const materialAttempt = useRef(null)
  const outlineAttempt = useRef(null)
  const excerptAttempt = useRef(null)
  const requestRef = useRef(request)
  const finishPositionRef = useRef(null)
  const appliedViewport = useRef(null)
  const restoringViewport = useRef(null)
  const restoredSession = useRef(false)
  const restoreRef = useRef(onSessionRestore)
  const draftsRef = useRef(draftCache || new Map())
  const resumeViewport = useRef(null)
  const previousRefreshSignal = useRef({ initialized: false, value: undefined })
  requestRef.current = request
  restoreRef.current = onSessionRestore

  useEffect(() => {
    if (loading || !flow.viewportInitialized || !graphRef.current) return
    return attachCanvasGestures(graphRef.current, {
      enabled: () => activeRef.current && Boolean(boardRef.current) && !resizingRef.current,
      getViewport: () => flow.getViewport(),
      setViewport: viewport => flow.setViewport(viewport, { duration: 0 }),
      onStart: () => { gestureViewportActive.current = true; cancelCardOpen() },
      onMultiTouch: () => cancelCardOpen(),
      onEnd: (save, viewport) => {
        gestureViewportActive.current = false
        if (save && mounted.current) { viewportRef.current = viewport; setZoom(viewport.zoom); void saveLayout() }
      },
      onError: cause => { if (mounted.current) setError(`画布手势失败：${messageOf(cause)}`) },
    })
  }, [loading, flow.viewportInitialized])

  const selectedNodes = nodes.filter(node => isObject(node) && node.selected)
  const selectedCard = selectedNodes.length === 1 ? selectedNodes[0].data : null
  const selectedSourceId = selectedCard?.sourceId || selectedCard?.id
  const pptOwnsConversation = Boolean(deckPreview && pptConversationOwner?.sessionId === conversationSessionId
    && pptConversationOwner?.cardId === deckPreview.cardId && pptConversationOwner?.hash === deckPreview.hash)
  const selectedGroups = nodes.filter(node => node.type === 'courseGroup' && node.selected)
  const outlineDirty = selectedCard?.kind === 'outline' && normalizeLineEndings(outline) !== normalizeLineEndings(selectedCard.content)
  const draftCount = draftsRef.current.size
  const selectedIds = selectedNodes.map(node => node.id)
  const hasSelectedGroup = selectedGroups.length > 0 || selectedNodes.some(node => node.parentId)
  const onlyWhiteboard = selectedNodes.length > 0 && selectedNodes.every(node => node.type === 'whiteboard')
  const deskVisible = focusOpen && selectedCard?.kind === 'outline'
  const dockOpen = !assetsOpen && !deskVisible && Boolean(sidebar || deckPreview || documentView || projectFileSelection || outcomeView)
  const finishEditorClose = () => { onCloseProjectFile?.();setOutcomeView(null);setSidebar(false);setDeckPreview(null);setDocumentView(null);closeCreation();rootRef.current?.focus({preventScroll:true}) }
  const closeDock = () => {
    if (projectFileSelection?.fromConversation) onCloseProjectFile?.()
    else if (deckPreview && editorCloseRequest.current) editorCloseRequest.current()
    else finishEditorClose()
  }
  const outlineVersions = (board?.nodes || []).filter(card => card.kind === 'outline').map(card => ({
    id: card.refId, number: card.number, markdown: card.content, sourceHash: card.sourceHash,
    wordPath: card.wordPath || (board?.nodes || []).find(node => node.kind === 'word' && node.refId === card.refId)?.path,
  }))
  const deskVersion = selectedCard?.kind === 'outline' ? outlineVersions.find(version => version.id === selectedCard.refId) : null
  const productionTypes = dependencies?.creationTypes || ['outline', 'pptx', 'exercise', 'script'].map(id => ({ id, label: OUTPUT_LABELS[id], available: false, message: '正在检查课程技能…' }))
  const availableReferences = [
    ...(board?.nodes || []).filter(usableCreationSource).map(creationSource).map(card => ({ ...card,
      ...(card.importedFile ? { referenceNote: card.importedFile.extractionStatus === 'extracted'
        ? (card.importedFile.truncated ? '已提取正文节选' : '已提取正文')
        : card.importedFile.mime?.startsWith('video/') ? '视频文件，仅引用附件；尚未转写或解析画面' : card.importedFile.mime?.startsWith('image/') ? '图片文件，尚未提取文字' : '文件已保存，尚未提取正文' } : {}) })),
    ...nodes.filter(node => node.type === 'whiteboard').map(node => ({ ...node.data, id: node.id, kind: 'whiteboard',
      content: String(node.data.text ?? node.data.content ?? ''),
      title: String(node.data.text ?? node.data.content ?? '').trim().slice(0, 36) || '空白图形',
      referenceNote: '引用时自动保存素材快照',
      ...(!String(node.data.text ?? node.data.content ?? '').trim() ? { disabled: true, reason: '此白板元素没有文字内容' } : {}) })),
  ]
  const sourceNode = creation && nodes.find(node => node.id === (creation.composerNodeId || creation.anchor.nodeId || creation.anchor.id))
  const sourcePoint = (!creation?.composerNodeId && creation?.blankPosition) || (sourceNode ? absolutePosition(sourceNode, nodes) : { x: 80, y: 80 })
  const sourceScreen = !creation?.composerNodeId && creation?.blankPosition ? {left:sourcePoint.x*liveViewport.zoom+liveViewport.x,right:sourcePoint.x*liveViewport.zoom+liveViewport.x,top:sourcePoint.y*liveViewport.zoom+liveViewport.y,bottom:sourcePoint.y*liveViewport.zoom+liveViewport.y} : sourceNode ? {
    left: sourcePoint.x * liveViewport.zoom + liveViewport.x,
    right: (sourcePoint.x + nodeSize(sourceNode).width) * liveViewport.zoom + liveViewport.x,
    top: sourcePoint.y * liveViewport.zoom + liveViewport.y,
    bottom: (sourcePoint.y + nodeSize(sourceNode).height) * liveViewport.zoom + liveViewport.y,
  } : { left: 40, right: 220, top: 100, bottom: 240 }
  const creationAvailableWidth = canvasSize.width
  const creationWidth = Math.min(creation?.pendingTaskId || creation?.intent === 'revise' && creation.sessionId ? 600 : 480, creationAvailableWidth - 24)
  const composerPosition = {
    x: Math.max(12, Math.min(creationAvailableWidth - creationWidth - 12, (sourceScreen.left + sourceScreen.right - creationWidth) / 2)),
    y: Math.max(76, Math.min(sourceScreen.bottom + 14, Math.max(76, canvasSize.height - 260))), width: creationWidth, canvasHeight: canvasSize.height,
  }
  if (composerPosition.y < sourceScreen.bottom + 14) {
    if (sourceScreen.right + creationWidth + 26 <= creationAvailableWidth) composerPosition.x = sourceScreen.right + 14
    else if (sourceScreen.left - creationWidth - 14 >= 12) composerPosition.x = sourceScreen.left - creationWidth - 14
    else composerPosition.y = Math.max(composerPosition.y, Math.min(sourceScreen.top + 44, canvasSize.height - 120))
  }
  // 来源卡可能已移出视口；侧边避让之后仍需把操作入口留在可见画布内。
  composerPosition.x = Math.max(12, Math.min(creationAvailableWidth - creationWidth - 12, composerPosition.x))
  let creationBudget = 60_000 - (creation?.selection?.quote.length || 0)
  const creationReferences = (creation?.references || []).map(card => {
    const selectedPassage = creation?.selection?.sourceCardId === card.id
    const content = selectedPassage ? creation.selection.quote : String(card.content || card.excerpt || '')
    const allowed = selectedPassage ? content.length : Math.min(12_000, creationBudget)
    if (!selectedPassage) creationBudget -= Math.min(content.length, allowed)
    return { ...card, previewText: content.slice(0, allowed), truncated: content.length > allowed, fullLength: content.length }
  })

  function setDeckPreview(value) {
    if (value) setOutcomeView(null)
    setEditorFullscreen(Boolean(value&&(value.slideProject||value.svgCandidateId||value.svgSourceId)))
    deckPreviewRef.current = value
    setDeckPreviewState(value)
  }

  function openOutcomes(card, sourceRef, versionId) {
    setDeckPreview(null); setOutcomeView(null);setDocumentView(null); setSidebar(false); setFocusOpen(false); setAssetsOpen(false)
    onCloseProjectFile?.()
    setOutcomeView({ requirementId: requirement.id, title: card.title,
      ...(card.outputCard ? { cardId: card.outputCard.id, versionId: versionId || card.outputCard.versionId || undefined } : {}),
      ...(sourceRef ? { sourceRef } : !card.outputCard && card.refId ? { sourceRef: `${card.kind}:${card.refId}`, hash: card.importedFile?.hash || card.sourceHash } : {}) })
  }

  useEffect(() => {
    const target = graphRef.current
    if (!target) return
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect
      if (rect?.width && rect?.height) setCanvasSize({ width: rect.width, height: rect.height })
    })
    observer.observe(target)
    return () => observer.disconnect()
  }, [])

  async function openCreationConversation() {
    const context = creationRef.current
    if (!active || !context?.sessionId || context.sessionId === conversationSessionId) return
    try { await restoreRef.current?.(context.sessionId) }
    catch (cause) { updateCreation(context.key, { error: `恢复此任务对话失败：${messageOf(cause)}` }); throw cause }
  }

  function updateCreation(key, patch) {
    const original = cache.current.drafts.get(key)
    if (!original) return
    const next = typeof patch === 'function' ? patch(original) : { ...original, ...patch }
    cache.current.drafts.set(key, next)
    if (creationRef.current?.key === key) creationRef.current = next
    if (cache.current.onDraftChanged) cache.current.onDraftChanged(key, next)
    else if (mounted.current && creationRef.current?.key === key) setCreation(next)
  }

  useEffect(() => {
    const draftChanged = (key, next) => {
      if (mounted.current && creationRef.current?.key === key) { creationRef.current = next; setCreation(next) }
    }
    const materialsChanged = () => mounted.current ? loadBoard({ preserveViewport: true }) : Promise.resolve()
    cache.current.onDraftChanged = draftChanged
    cache.current.onMaterialsChanged = materialsChanged
    return () => {
      if (cache.current.onDraftChanged === draftChanged) delete cache.current.onDraftChanged
      if (cache.current.onMaterialsChanged === materialsChanged) delete cache.current.onMaterialsChanged
    }
  }, [])

  function cancelCardOpen() {
    clearTimeout(cardOpenTimer.current)
    cardOpenTimer.current = null
  }

  async function loadDeckPreview({ artifactId, hash, signal }) {
    const response = await fetch(endpoint({ artifactPreview: artifactId, hash }), { credentials: 'same-origin', signal })
    const result = await response.json()
    if (!response.ok) throw new Error(result?.error || `PPT 预览失败（${response.status}）`)
    return result
  }

  const getDeckPageHref = ({ artifactId, hash, page }) => endpoint({ artifactPreviewPage: artifactId, hash, page: String(page) }).href

  const pptApi = useMemo(() => {
    const read = async (query, { signal } = {}) => {
      const response = await fetch(apiEndpoint(query, projectId), { credentials: 'same-origin', signal })
      const result = await response.json()
      if (!response.ok) throw new Error(result?.error || `PPT 编辑请求失败（${response.status}）`)
      return result
    }
    const post = async (action, data, { signal } = {}) => {
      const response = await fetch(apiEndpoint({}, projectId), { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, data }), signal })
      const result = await response.json()
      if (!response.ok) throw new Error(result?.error || `PPT 编辑请求失败（${response.status}）`)
      return result
    }
    return {
      slidesStatus: (data, options) => post('slides-status', data, options),
      retrySlidesComments: (data, options) => post('slides-retry-comments', data, options),
      openSlides: (data, options) => post('slides-open', data, options),
      prepareSlides: (data, options) => post('slides-prepare-publish', data, options),
      publishSlides: (data, options) => post('slides-publish', data, options),
      open: (scope, options) => {
        const { requirementId, cardId, versionId, artifactId, hash, outcome, svgCandidateId, svgSourceId } = scope
        const data={requirementId,cardId,...(versionId?{versionId}:{}),artifactId,hash,...(outcome?{outcome:true}:{}),...(svgSourceId?{svgSourceId}:{})};
        return svgCandidateId ? post('ppt-open-svg',{scope:data,candidateId:svgCandidateId},options) : post('ppt-open',data,options)
      },
      saveDraft: data => post('ppt-save-draft', data),
      preview: (data, options) => post('ppt-preview', data, options),
      saveVersion: data => post('ppt-save-version', data),
      createAiTask: data => post('ppt-create-ai', { ...data, ...(modelSelectionRef.current ? { modelSelection: { ...modelSelectionRef.current } } : {}) }),
      proposal: async ({ taskId }, options) => {
        const result = await read({ pptProposal: taskId }, options)
        const taskScope = result.task?.input?.pptEdit?.scope
        if (mounted.current && result.task?.sessionId && taskScope) setPptConversationOwner(previous => {
          const next = { sessionId: result.task.sessionId, cardId: taskScope.cardId, hash: taskScope.hash }
          return previous?.sessionId === next.sessionId && previous.cardId === next.cardId && previous.hash === next.hash ? previous : next
        })
        return result
      },
      confirm: data => post('ppt-confirm', data),
      discard: data => post('ppt-discard', data),
      getPageHref: ({ draftId, revision, page }) => apiEndpoint({ pptPreviewPage: draftId, revision: String(revision), page: String(page) }, projectId).href,
    }
  }, [projectId])

  const svgApi=useMemo(()=>{
    const post=async(action,data)=>{const response=await fetch(apiEndpoint({},projectId),{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,data})});const value=await response.json();if(!response.ok)throw new Error(value.error||'源文件操作失败');return value}
    return {
      open:scope=>{const {requirementId,cardId,versionId,artifactId,hash,outcome,svgCandidateId}=scope;return post('svg-editor-open',{scope:{requirementId,cardId,...(versionId?{versionId}:{}),artifactId,hash,...(outcome?{outcome:true}:{})},candidateId:svgCandidateId})},
      state:data=>post('svg-editor-state',data),view:data=>post('svg-editor-view',data),editText:data=>post('svg-editor-text',data),
      bindConversation:data=>post('svg-editor-conversation',data),
      createTask:({nativeSessionId,...data})=>post('svg-editor-task',{...data,...(nativeSessionId?{nativeSessionId}:{}),...(!nativeSessionId&&modelSelectionRef.current?{modelSelection:{...modelSelectionRef.current}}:{})}),
      apply:data=>post('svg-editor-apply',data),endTurn:data=>post('svg-editor-end-turn',data),discard:data=>post('svg-editor-discard',data),applyLegacy:data=>post('svg-editor-legacy',data),save:data=>post('svg-editor-save',data),undo:data=>post('svg-editor-undo',data),
      pageHref:({draftId,sourceId,page})=>apiEndpoint({svgEditorPage:draftId,sourceId,page:String(page)},projectId).href,
      upload:async({draftId,operationId,filename,file})=>{const response=await fetch(apiEndpoint({svgEditorImage:draftId,operationId,filename},projectId),{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/octet-stream'},body:file});const value=await response.json();if(!response.ok)throw new Error(value.error||'图片引用失败');return value},
    }
  },[projectId])

  async function startPptEditAi(created) {
    if (!created?.task || !created.prepared || created.task.requirementId !== requirement.id) throw new Error('PPT 修改任务不属于当前课程')
    if (!['draft', 'failed'].includes(created.task.status)) throw new Error('这项修改任务已提交或状态待核对，请打开任务对话，不要重复发送')
    if (!onStart) {
      await requestRef.current('set-task-dispatch', { taskId: created.task.id, status: 'failed', error: '任务对话暂时无法连接。请重新打开工作台后查看任务状态。' })
      throw new Error('任务对话暂时无法连接。请重新打开工作台后查看任务状态。')
    }
    try {
      const started = await onStart({ ...created.prepared, ...(created.task.sessionId ? { sessionId: created.task.sessionId } : {}) })
      const taskScope = created.task.input?.pptEdit?.scope
      if (mounted.current && started?.sessionId && taskScope) setPptConversationOwner({ sessionId: started.sessionId, cardId: taskScope.cardId, hash: taskScope.hash })
      return started
    } finally {
      await refreshTasks().catch(cause => { if (mounted.current) setNotice(`PPT 修改任务列表暂未更新：${messageOf(cause)}`) })
    }
  }

  function pptBackgroundStatus(status,scope){
    if(!mounted.current||scope.viewEpoch!==epochRef.current)return
    if(status.status==='failed')setError(`“${scope.title}”后台保存未完成：${status.error}。请重新打开课件核对，草稿保留。`)
    else setNotice(status.status==='running'?`“${scope.title}”正在后台生成新版本，可继续浏览。`:`“${scope.title}”新版本已保存。`)
  }
  async function publishedPptEdit(result, scope, options={}) {
    if (!mounted.current || scope.viewEpoch !== epochRef.current) return
    if (result?.deliveryWarning) setError(`课件已保存，但目录整理失败：${result.deliveryWarning}`)
    const versionId = result?.descriptor?.version?.id
    const cardId = result?.descriptor?.card?.id || scope.cardId
    if (!versionId || !cardId) throw new Error('PPT 文件已返回，但没有准确的新版本标识，请刷新后核对')
    const epoch = scope.viewEpoch, intent = scope.viewIntent
    const isCurrent = () => mounted.current && activeRef.current && epoch === epochRef.current && intent === creationIntent.current
      && deckPreviewRef.current?.viewIntent === scope.viewIntent && deckPreviewRef.current?.artifactId === scope.artifactId && deckPreviewRef.current?.hash === scope.hash
    const follow = isCurrent()
    if (follow) cache.current.versionViews.delete(cardId)
    await onChanged?.()
    if (!mounted.current || epoch !== epochRef.current) return
    await loadBoard({ preserveViewport: true, selectionIntent: intent })
    if (!follow || !isCurrent()) return
    if(options.exit){finishEditorClose();return}
    if(options.stayOpen)return
    const node = nodesRef.current.find(item => item.data?.outputCard?.id === cardId)
    if (node) await openOutputCard(node.data, versionId)
  }

  function versionedBoard(raw) {
    const nodes = raw.nodes.map(node => {
      const selected = node.outputCard && cache.current.versionViews.get(node.outputCard.id)
      if (!selected || !node.outputCard.versions.some(version => version.id === selected.versionId)) return node
      return { ...selected.node, id: node.id, position: node.position, width: node.width, height: node.height, pendingGeneration: node.pendingGeneration,
        outputCard: { ...node.outputCard, versionId: selected.versionId, number: selected.node.outputCard.number } }
    })
    const ownerOf = ref => nodes.find(node => node.id === ref || node.sourceId === ref || node.outputCard?.versions.some(version => version.primaryRef === ref || version.outputs?.some(output => output.sourceId === ref)))
    let edges = raw.edges || []
    for (const node of nodes) {
      const view = node.outputCard && cache.current.versionViews.get(node.outputCard.id)
      if (!Array.isArray(view?.provenanceEdges)) continue
      edges = edges.filter(edge => !edge.provenance || edge.target !== node.id)
      for (const edge of view.provenanceEdges) {
        const source = ownerOf(edge.source)
        if (!source || source.id === node.id) continue
        edges.push({ ...edge, source: source.id, target: node.id, sourceRef: edge.source, targetRef: edge.target })
      }
    }
    return { ...raw, nodes, edges }
  }

  function openSkillReview(entry) {
    if (!entry) return
    cancelCardOpen()
    closeCreation()
    setDeckPreview(null)
    setSkillDeckPreview(null)
    const node = nodesRef.current.find(node => (entry.task.outputCardId && node.data?.outputCard?.id === entry.task.outputCardId) || node.data?.outputCard?.versions?.some(version => version.taskId === entry.task.id))
    if (node) selectCard(node.id)
    const size = canvasSizeRef.current, viewport = flow.getViewport()
    const point = node ? absolutePosition(node, nodesRef.current) : { x: 0, y: 0 }
    const x = node ? point.x * viewport.zoom + viewport.x + nodeSize(node).width * viewport.zoom + 14 : size.width - 516
    setSkillReview({ entry, position: { x: Math.max(12, Math.min(x, size.width - Math.min(500, size.width - 24) - 12)), y: 76, maxHeight: Math.max(160, size.height - 88) } })
  }

  async function loadSkillReviewOutputs(task) {
    const response = await fetch(endpoint({ taskReview: task.id, requirementId: requirement.id }), { credentials: 'same-origin' })
    const result = await response.json()
    if (!response.ok || result.taskId !== task.id || result.requirementId !== requirement.id || !Array.isArray(result.outputs)) throw new Error(result.error || '待审成果文件读取失败')
    return result.outputs.map(output => ({ ...output, taskId: task.id,
      downloadHref: output.node.kind === 'artifact' ? endpoint({ downloadArtifact: output.node.refId }).href : undefined,
      src: ['image', 'video'].includes(output.type) ? endpoint({ downloadArtifact: output.node.refId, preview: '1' }).href : undefined }))
  }

  async function verifySkillReviewOutputs(outputs) {
    if (!outputs.length) return
    const current = await loadSkillReviewOutputs({ id: outputs[0].taskId })
    for (const output of outputs) {
      const actual = current.find(item => item.versionId === output.versionId)
      if (!actual || actual.node.sourceHash !== output.node.sourceHash || ['missing', 'changed', 'modified', 'unavailable'].includes(actual.node.status)) throw new Error('待审文件已变化或不可用，请重新核对原任务。')
    }
  }

  async function openPendingCard(card, { showDeck = true } = {}) {
    cancelCardOpen()
    if (card.composition) return openComposition({card:card.outputCard,node:card,composition:card.composition})
    if (!card.outputCard?.id || !card.pendingGeneration) return
    selectCard(card.id)
    const intent = ++creationIntent.current, epoch = epochRef.current
    const selectedAtOpen = nodesRef.current.filter(node => node.selected).map(node => node.id).sort().join('|')
    try {
      const response = await fetch(endpoint({ outputPending: card.outputCard.id, requirementId: requirement.id }), { credentials: 'same-origin' })
      const descriptor = await response.json()
      if (!response.ok) throw new Error(descriptor?.error || '原任务读取失败')
      if (!mounted.current || !activeRef.current || epoch !== epochRef.current || intent !== creationIntent.current
        || nodesRef.current.filter(node => node.selected).map(node => node.id).sort().join('|') !== selectedAtOpen) return
      const node = nodesRef.current.find(item => item.id === card.id)
      if (!node || node.data.outputCard?.id !== descriptor.card?.id) return
      descriptor.node.position = absolutePosition(node, nodesRef.current)
      const next = createPendingContext({ projectId, projectName: project?.name || '当前项目', projectPath: project?.path || '', requirement, descriptor })
      next.focusRequest = (cache.current.drafts.get(next.key)?.focusRequest || 0) + 1
      cache.current.drafts.set(next.key, next)
      cache.current.cardKeys.set(node.id, next.key)
      cache.current.activeKey = next.key
      cache.current.visible = true
      creationRef.current = next
      setCreation(next)
      setCreationVisible(true)
      setCreationMenu(null)
      setContextMenu(null)
      setSidebar(false)
      setFocusOpen(false)
      if (showDeck && descriptor.node.outcomeFiles?.length) openOutcomes(descriptor.node)
      else setDeckPreview(showDeck && descriptor.node.slideProject ? { slideProject: descriptor.node.slideProject, title: descriptor.node.title,
        cardId: descriptor.card.id, requirementId: requirement.id, viewIntent: intent, viewEpoch: epoch } : null)
      trackOutput(descriptor.task, next, intent)
      return next
    } catch (cause) {
      if (mounted.current && epoch === epochRef.current && intent === creationIntent.current) setError(`读取原任务失败：${messageOf(cause)}`)
    }
  }

  async function openOutputCard(card, versionId, { showDeck = true, expectedFrame } = {}) {
    if (card.composition) return openComposition({card:card.outputCard,node:card,composition:card.composition})
    if (card.kind === 'generation') return openPendingCard(card, { showDeck })
    cancelCardOpen()
    const intent = ++creationIntent.current, epoch = epochRef.current
    const selectedAtOpen = nodesRef.current.filter(node => node.selected).map(node => node.id).sort().join('|')
    const outputCard = card.outputCard
    if (!outputCard) return
    try {
      const response = await fetch(endpoint({ outputCard: outputCard.id, requirementId: requirement.id,
        ...(versionId ? { cardVersion: versionId } : {}) }), { credentials: 'same-origin' })
      const descriptor = await response.json()
      if (!response.ok || !descriptor?.version || !descriptor.node) throw new Error(descriptor?.error || '成果文件版本读取失败')
      if (!mounted.current || !activeRef.current || epoch !== epochRef.current || intent !== creationIntent.current) return
      if (nodesRef.current.filter(node => node.selected).map(node => node.id).sort().join('|') !== selectedAtOpen) return
      if (expectedFrame && (creationRef.current?.key !== expectedFrame.key || frameSignature(creationRef.current) !== expectedFrame.signature)) return
      const node = nodesRef.current.find(item => item.id === card.id)
      if (!node || node.data.outputCard?.id !== descriptor.card.id) return
      descriptor.node.position = absolutePosition(node, nodesRef.current)
      cache.current.versionViews.set(descriptor.card.id, { versionId: descriptor.version.id, node: descriptor.node, provenanceEdges: descriptor.provenanceEdges })
      if (boardRef.current) {
        const projected = versionedBoard(boardRef.current)
        boardRef.current = projected
        setBoard(projected)
        replaceEdges(flowEdges(projected.edges))
      }
      replaceNodes(decorate(nodesRef.current.map(item => item.id === node.id ? { ...item, selected: true, data: descriptor.node } : { ...item, selected: false })))
      setSelectionKey(node.id)
      const initial = createRevisionContext({ projectId, projectName: project?.name || '当前项目', projectPath: project?.path || '', requirement, descriptor })
      const previous = cache.current.drafts.get(initial.key)
      const next = previous ? { ...initial, ...previous, anchor: initial.anchor, targetCard: initial.targetCard, baseVersion: initial.baseVersion,
        recorded: initial.recorded, referenceNotes: initial.referenceNotes } : initial
      next.focusRequest = (previous?.focusRequest || 0) + 1
      cache.current.drafts.set(next.key, next)
      cache.current.cardKeys.set(node.id, next.key)
      cache.current.activeKey = next.key
      cache.current.visible = true
      creationRef.current = next
      setCreation(next)
      setCreationVisible(true)
      setCreationMenu(null)
      setContextMenu(null)
      setSidebar(false)
      setFocusOpen(false)
      const nativeFile = showDeck && descriptor.node.path && !/\.(md|txt)$/i.test(descriptor.node.path)
      if (showDeck && (descriptor.card.type === 'pptx' || nativeFile)) {
        openOutcomes(descriptor.node, descriptor.version.primaryRef, descriptor.version.id)
        return descriptor
      }
      const deck = false
      setDeckPreview(deck ? { artifactId: descriptor.node.refId, hash: descriptor.node.sourceHash, title: descriptor.node.title,
        cardId: descriptor.card.id, versionId: descriptor.version.id, number: descriptor.version.number, requirementId: requirement.id,
        ...(descriptor.node.slideProject ? { slideProject: descriptor.node.slideProject } : {}),
        viewIntent: intent, viewEpoch: epoch } : null)
      const documentFile = descriptor.node.importedFile?.name || descriptor.node.path || ''
      const documentRef = descriptor.version.primaryRef
      setDocumentView(showDeck && /\.(csv|pdf|docx)$/i.test(documentFile) ? { sourceRef: documentRef,
        format: documentFile.split('.').pop().toLowerCase(),
        hash: descriptor.node.importedFile?.hash || descriptor.node.sourceHash, requirementId: requirement.id,
        cardId: descriptor.card.id, versionId: descriptor.version.id, title: descriptor.node.title,
        downloadHref: endpoint(documentRef.startsWith('material:') ? { materialFile: descriptor.node.refId } : documentRef.startsWith('word:') ? { download: descriptor.node.refId } : { downloadArtifact: descriptor.node.refId }).href } : null)
      if (['image', 'video'].includes(next.outputType)) void restoreMediaCreation(next)
      return descriptor
    } catch (cause) {
      if (mounted.current && epoch === epochRef.current && intent === creationIntent.current) setError(`读取成果文件版本失败：${messageOf(cause)}`)
    }
  }

  useEffect(() => {
    const target = cache.current.pendingAsset
    if (!target || loading || !board) return
    const card = board.nodes.find(node => node.outputCard?.id === target.cardId)
    if (!card) return
    delete cache.current.pendingAsset
    void openOutputCard(card, target.versionId)
  }, [loading, board?.nodes?.length])

  function openClickedCard(event, node) {
    onCloseProjectFile?.()
    cancelCardOpen()
    if(nodeDragging.current||event.target.closest?.('.wcc-card.is-editing,.wcc-card-inline-editor'))return
    if (!isObject(node) || event.shiftKey || event.metaKey || event.ctrlKey || event.detail > 1) return
    if (creationVisible && !deckPreview && !documentView && !sidebar && (creationRef.current?.composerNodeId || creationRef.current?.anchor.nodeId || creationRef.current?.anchor.id) === node.id
      && (!node.data.outputCard || creationRef.current?.intent === 'revise')) return
    const selectionBlocked = operationLock.current
    const openIntent = ++creationIntent.current
    cardOpenTimer.current = setTimeout(() => {
      cardOpenTimer.current = null
      if (!mounted.current || !activeRef.current || nodeDragging.current || openIntent !== creationIntent.current) return
      const card = nodesRef.current.find(item => item.id === node.id)?.data
      if (!card) return
      if (card.kind === 'whiteboard') { void openWhiteboardCreation(node.id); return }
      if (card.outputCard) { void openOutputCard(card, card.outputCard.versionId, { showDeck: false }); return }
      if (!usableCreationSource(card)) {
        closeCreation()
        setError(`「${card.title}」当前没有可用的已保存来源，请先核对文件状态。`)
        return
      }
      const previous = cache.current.drafts.get(cache.current.cardKeys.get(card.id))
      const outputType = previous?.outputType || ({ pptx: 'pptx', image: 'image', video: 'video' }[cardCapabilities(card).format] || (card.kind === 'word' ? 'word' : 'text'))
      if (selectionBlocked) selectCard(card.id)
      openCreation(card, outputType, previous?.anchor.sourceHash === card.sourceHash ? previous.selection : undefined)
    }, 240)
  }

  function closeCreation() {
    cancelCardOpen()
    creationIntent.current += 1
    cache.current.visible = false
    setCreationVisible(false)
  }

  function openComposition(descriptor){
    cancelCardOpen();creationIntent.current+=1;selectCard(descriptor.node.id);
    const live=nodesRef.current.find(node=>node.id===descriptor.node.id);
    const node={...descriptor.node,...(live?{position:absolutePosition(live,nodesRef.current),...nodeSize(live)}:{})};
    const initial=createCompositionContext({projectId,projectName:project?.name||'当前项目',projectPath:project?.path||'',requirement,descriptor:{...descriptor,node}});
    const previous=cache.current.drafts.get(initial.key);
    if(previous?.pendingTaskId){void openPendingCard({...node,composition:undefined});return}
    const next={...initial,...previous,outputPosition:{...node.position},targetCard:node,focusRequest:(previous?.focusRequest||0)+1};
    cache.current.drafts.set(next.key,next);cache.current.cardKeys.set(node.id,next.key);cache.current.activeKey=next.key;cache.current.visible=true;
    creationRef.current=next;setCreation(next);setCreationVisible(true);setCreationMenu(null);setSidebar(false);setFocusOpen(false);setDeckPreview(null);setOutcomeView(null);setDocumentView(null);
  }

  async function beginComposition(card,outputType,{blank=false,outputPosition,seed}={}){
    cancelCardOpen();const intent=++creationIntent.current,epoch=epochRef.current;
    setBusy('create-draft');setCreationMenu(null);
    try{
      await saveLayout();
      const live=nodesRef.current.find(node=>node.id===card.id);
      const anchor={...card,position:live?absolutePosition(live,nodesRef.current):card.position||{x:80,y:80},...(live?nodeSize(live):{})};
      const occupied=nodesRef.current.filter(isObject).map(node=>({...node.data,position:absolutePosition(node,nodesRef.current),...nodeSize(node)}));
      const position=outputPosition||visibleCreationPosition(anchor,occupied,viewportRef.current,canvasSizeRef.current);
      const frame=createCardContext({projectId,requirement,anchor,blank,outputType,outputPosition:position});
      if(seed)frame.references=JSON.parse(JSON.stringify(seed.references));
      const result=await request('create-output-draft',{requirementId:requirement.id,outputType,position,
        selectedCardIds:frame.references.map(source=>source.id),sourceRefs:frame.references.map(source=>({cardId:source.id,hash:source.sourceHash})),operationId:crypto.randomUUID()});
      if(!mounted.current||epoch!==epochRef.current)return;
      const editText = blank && outputType === 'text';
      await loadBoard({selectIds:[result.node.id],preserveViewport:true,selectionIntent:intent,autoEditId:editText ? result.node.id : undefined});
      if(creationIntent.current!==intent||!activeRef.current)return;
      if(editText)return;
      openComposition(result);
      if(seed)updateCreation(creationRef.current.key,{instruction:seed.instruction,mediaOptions:seed.mediaOptions,selectedSkills:seed.selectedSkills||[]});
    }catch(cause){if(mounted.current&&epoch===epochRef.current)setError(messageOf(cause))}
    finally{if(mounted.current&&epoch===epochRef.current)setBusy('')}
  }

  useEffect(()=>{
    if(!creation?.composerNodeId||!creation.generation?.cardId||creation.pendingTaskId)return;
    const frame=creation,signature=JSON.stringify([frame.instruction,frame.references.map(r=>[r.id,r.sourceHash])]);
    if(signature===frame.draftSaved)return;
    let cancelled=false;
    const timer=setTimeout(async()=>{
      if(cache.current.compositionSaving.has(frame.key))return;
      cache.current.compositionSaving.add(frame.key);
      try{
        const result=await request('save-output-draft',{requirementId:frame.requirementId,cardId:frame.generation.cardId,
          instruction:frame.instruction,selectedCardIds:frame.references.map(r=>r.id),sourceRefs:frame.references.map(r=>({cardId:r.id,hash:r.sourceHash})),expectedRevision:cache.current.drafts.get(frame.key)?.draftRevision ?? frame.draftRevision});
        updateCreation(frame.key,current=>({...current,draftRevision:result.revision,draftSaved:signature,...(current.error?.startsWith('草稿尚未保存：')?{error:''}:{})}));
      }catch(cause){if(!cancelled&&mounted.current)updateCreation(frame.key,{error:`草稿尚未保存：${messageOf(cause)}`})}
      finally{cache.current.compositionSaving.delete(frame.key)}
    },500);
    return()=>{cancelled=true;clearTimeout(timer)};
  },[creation?.key,creation?.instruction,creation?.references,creation?.draftRevision,creation?.pendingTaskId]);

  function openCreation(card, outputType = 'text', selection, { explicitNew = false, outputPosition, blank = false } = {}) {
    if(explicitNew){void beginComposition(card,outputType,{blank,outputPosition});return}
    cancelCardOpen()
    creationIntent.current += 1
    try {
      const node = nodesRef.current.find(item => item.id === card.id)
      const anchor = { ...card, position: node ? absolutePosition(node, nodesRef.current) : card.position || { x: 80, y: 80 }, ...(node ? nodeSize(node) : {}) }
      const cards = [...nodesRef.current.filter(isObject).map(item => ({ ...item.data, position: absolutePosition(item, nodesRef.current), ...nodeSize(item) })), ...[...cache.current.reservations.values()].map(position => ({ position }))]
      const initial = createCardContext({ projectId, projectName: project?.name || '当前项目', projectPath: project?.path || '', requirement, anchor,
        outputType, blank, outputPosition: outputPosition || adjacentCreationPosition(anchor, cards), selection, generation: { mode: 'new' } })
      const baseKey = initial.key
      let previous = cache.current.drafts.get(cache.current.sourceDraftKeys.get(baseKey) || baseKey)
      if (explicitNew && (previous?.taskId || previous?.pendingTaskId || previous?.mediaJob?.taskId)) {
        // The original frame still owns its task, operation and late receipts.
        // An explicit plus creates a separate draft; it does not retry that task.
        initial.key = `${baseKey}:draft:${crypto.randomUUID()}`
        previous = null
      }
      const next = previous && previous.anchor.sourceHash === initial.anchor.sourceHash
        ? { ...previous, ...(selection ? { selection } : {}) }
        : { ...initial, instruction: previous?.instruction || '', materialTitle: previous?.materialTitle || `${card.title} · 补充素材`, materialContent: previous?.materialContent || '' }
      if (explicitNew) next.explicitNewDraft = true
      if(outputPosition){next.outputPosition={...outputPosition};next.blankPosition={...outputPosition}}
      next.focusRequest = (previous?.focusRequest || 0) + 1
      cache.current.drafts.set(next.key, next)
      cache.current.sourceDraftKeys.set(baseKey, next.key)
      cache.current.cardKeys.set(card.id, next.key)
      cache.current.activeKey = next.key
      cache.current.visible = true
      creationRef.current = next
      setCreation(next)
      setCreationVisible(true)
      setCreationMenu(null)
      setContextMenu(null)
      setSidebar(false)
      setFocusOpen(false)
      setDeckPreview(null)
      setOutcomeView(null);setDocumentView(null)
      if (['image', 'video'].includes(next.outputType)) void restoreMediaCreation(next)
    } catch (cause) { setError(messageOf(cause)) }
  }

  function rememberMediaTask(result) {
    const task = result?.task
    const job = result?.job || task?.mediaJob
    if (!task || task.requirementId !== requirement.id || !job || job.taskId !== task.id) return
    mediaTracking.current.set(task.id, { projectId, requirementId: task.requirementId, job })
    const position = task.input?.outputPosition
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) cache.current.reservations.set(task.id, { ...position })
  }

  function frameSignature(frame) {
    return JSON.stringify({ instruction: frame.instruction, generation: frame.generation,
      references: frame.references.map(source => [source.id, source.sourceHash]),
      ...(['image', 'video'].includes(frame.outputType) ? { media: frame.mediaOptions } : {}) })
  }

  function trackOutput(task, frame, intent) {
    if (!task.outputCardId) return
    cache.current.outputTracking.set(task.id, { taskId: task.id, cardId: task.outputCardId, projectId,
      requirementId: requirement.id, key: frame.key, intent, signature: frameSignature(frame) })
  }

  async function followOutputResults(result) {
    for (const [taskId, pending] of cache.current.outputTracking) {
      if (pending.projectId !== projectId || pending.requirementId !== requirement.id) continue
      const node = result.nodes.find(card => card.outputCard?.id === pending.cardId)
      const version = node?.outputCard.versions.find(value => value.taskId === taskId)
      if (!node || !version) continue
      const task = result.tasks?.find(item => item.id === taskId)
      if ((node.pendingGeneration?.published && node.pendingGeneration.taskId === taskId)
        || publishedTaskGeneration(task, nativeStatusesRef.current.get(task?.sessionId))) continue
      cache.current.outputTracking.delete(taskId)
      cache.current.reservations.delete(taskId)
      const frame = creationRef.current
      const selected = nodesRef.current.filter(node => isObject(node) && node.selected)
      const follow = activeRef.current && cache.current.visible && frame?.key === pending.key && frame.taskId === taskId && creationIntent.current === pending.intent
        && frameSignature(frame) === pending.signature && selected.length === 1 && selected[0].id === (frame.composerNodeId || frame.anchor.nodeId || frame.anchor.id)
      const submitted = cache.current.drafts.get(pending.key)
      if (submitted?.taskId === taskId && submitted.originalInput && frameSignature(submitted) === pending.signature) {
        updateCreation(pending.key, { ...JSON.parse(JSON.stringify(submitted.originalInput)),
          mediaOptions: submitted.originalInput.mediaOptions, mediaJob: submitted.originalInput.mediaJob || null,
          referencesEdited: false, pendingTaskId: null, pendingGeneration: null, error: '', mediaPollError: '' })
      }
      if (follow) await openOutputCard(node, version.id, { expectedFrame: { key: pending.key, signature: frameSignature(creationRef.current) } })
    }
  }

  function mediaNeedsDecision(job) {
    return ['unknown', 'download_failed', 'registration_failed'].includes(job?.status)
  }

  async function restoreMediaCreation(frame) {
    if (frame.explicitNewDraft && !frame.taskId) return
    if (mediaJobPending(frame.mediaJob) || mediaNeedsDecision(frame.mediaJob) || cache.current.attempts.get(frame.key)?.current) return
    const candidates = tasksRef.current.filter(task => task.kind === 'media' && task.requirementId === frame.requirementId
      && task.mediaJob?.type === frame.outputType && (mediaJobPending(task.mediaJob) || mediaNeedsDecision(task.mediaJob))
      && !frame.dismissedMediaTaskIds?.includes(task.id))
    if (!candidates.length) return
    const token = Symbol()
    const epoch = epochRef.current
    mediaRestores.current.set(frame.key, token)
    updateCreation(frame.key, { mediaRestoring: true, mediaRecoveryError: false })
    const snapshot = cache.current.drafts.get(frame.key)
    const current = () => mounted.current && epoch === epochRef.current && mediaRestores.current.get(frame.key) === token
      && cache.current.drafts.get(frame.key) === snapshot
    try {
      for (const summary of candidates) {
        const task = summary.input ? summary : await loadTask(summary.id)
        if (!current()) return
        const refs = task.input?.sourceRefs || task.input?.sources?.map(source => ({ cardId: source.cardId, hash: source.hash })) || []
        // sourceRefs are canonicalized by id; sources retain the selected anchor first.
        const anchor = task.input?.sources?.[0] || refs[0]
        const revision = frame.intent === 'revise'
        if (revision ? task.outputCardId !== frame.generation?.cardId || task.baseCardVersionId !== frame.generation?.baseVersionId
          : anchor?.cardId !== frame.anchor.id || anchor?.hash !== frame.anchor.sourceHash) continue
        const cards = revision ? (task.input?.sources || []).map(source => {
          const owner = boardRef.current?.nodes.find(card => card.id === source.cardId || card.sourceId === source.cardId || card.outputCard?.versions.some(version => version.primaryRef === source.cardId))
          return { ...source, id: source.cardId, sourceHash: source.hash, nodeId: owner?.id || source.cardId,
            refId: source.cardId.split(':')[1], referenceNote: source.note || '本次使用的资料版本' }
        }) : refs.map(ref => boardRef.current?.nodes.find(card => (card.sourceId || card.id) === ref.cardId && card.sourceHash === ref.hash
          && usableCreationSource(card) && (!card.sourceStatus || card.sourceStatus === 'ready')))
        if (cards.some(card => !card)) continue
        const job = task.mediaJob
        if (!mediaJobPending(job) && !mediaNeedsDecision(job)) continue
        rememberMediaTask({ task, job })
        const untouched = !snapshot.referencesEdited && (revision && snapshot.originalInput
          ? frameSignature(snapshot) === frameSignature({ ...snapshot, ...snapshot.originalInput }) : !snapshot.instruction.trim())
        updateCreation(frame.key, value => ({ ...value,
          ...(untouched ? updateCreationReferences(value, cards) : {}),
          ...(untouched ? { instruction: task.instruction, mediaOptions: task.input.media } : {}),
          taskId: task.id, mediaJob: job, mediaRestoring: false, mediaRecoveryError: false, mediaPollError: '',
          outputPosition: nextMediaPosition(value), error: '' }))
        const restored = cache.current.drafts.get(frame.key)
        if (untouched && restored) trackOutput(task, restored, creationIntent.current)
        return
      }
      if (current()) updateCreation(frame.key, { mediaRestoring: false })
    } catch (cause) {
      if (current()) updateCreation(frame.key, { mediaRestoring: false, mediaRecoveryError: true,
        error: `核对原媒体任务失败：${messageOf(cause)}。请重新打开此卡片核对后再生成。` })
    } finally {
      if (mediaRestores.current.get(frame.key) === token) {
        mediaRestores.current.delete(frame.key)
        if (mounted.current && epoch === epochRef.current && cache.current.drafts.get(frame.key)?.mediaRestoring) updateCreation(frame.key, { mediaRestoring: false })
      }
    }
  }

  function openSelectedCreation() {
    const selected = nodesRef.current.filter(node => isObject(node) && node.selected)
    if (selected.length === 1 && selected[0].type === 'whiteboard') { void openWhiteboardCreation(selected[0].id); return }
    if (selected.some(node => node.type === 'whiteboard')) { setError('白板文字请先保存为素材，再作为创作来源。'); return }
    const anchor = selected[0]?.data || (boardRef.current?.nodes || []).find(card => card.kind === 'requirement')
    if (!anchor) return
    if (selected.length === 1 && anchor.outputCard) { void openOutputCard(anchor, anchor.outputCard.versionId); return }
    openCreation(anchor, (creationRef.current?.anchor.nodeId || creationRef.current?.anchor.id) === anchor.id ? creationRef.current.outputType : 'text')
    if (selected.length > 1 && (creationRef.current?.anchor.nodeId || creationRef.current?.anchor.id) === anchor.id) {
      try { updateCreation(creationRef.current.key, context => updateCreationReferences(context, selected.map(node => node.data))) }
      catch (cause) { setError(messageOf(cause)) }
    }
  }

  function openNodeMenu(id) {
    cancelCardOpen()
    creationIntent.current += 1
    const node = nodesRef.current.find(item => item.id === id)
    if (!node) return
    selectCard(id)
    const point = absolutePosition(node, nodesRef.current), viewport = viewportRef.current
    const size = canvasSizeRef.current
    setCreationMenu({ anchor: { ...node.data }, position: {
      x: Math.max(12, Math.min(size.width - 272, (point.x + nodeSize(node).width) * viewport.zoom + viewport.x + 30)),
      y: Math.max(76, Math.min(size.height - 390, (point.y + 30) * viewport.zoom + viewport.y)),
    } })
  }

  function creationMenuItems(card) {
    const usable = card?.kind === 'canvas' || usableCreationSource(card)
    return [
      { id: 'text', label: '文本', description: '写内容，使用 / 调用本机技能', disabled: !usable, reason: '请先核对已保存来源' },
      { id: 'pptx', label: 'PPT', description: '按指令制作，可选择本机技能', disabled: !usable, reason: '请先核对已保存来源' },
      { id: 'image', label: '图片', description: '提示词生图，可添加参考图片', disabled: !usable, reason: '请先核对已保存来源' },
      { id: 'video', label: '视频', description: '提示词生视频，可添加参考图片', disabled: !usable, reason: '请先核对已保存来源' },
    ]
  }

  async function refreshSkillCatalog() {
    setSkillCatalogLoading(true)
    try {
      const response = await fetch(endpoint({ skills: '1' }), { credentials: 'same-origin' })
      const result = await response.json()
      if (!response.ok || !Array.isArray(result?.skills)) throw new Error(result?.error || '技能列表读取失败，请刷新后重试。')
      if (mounted.current) { setSkillCatalog(result); setSkillCatalogError('') }
      return result
    } catch (cause) { if (mounted.current) setSkillCatalogError(messageOf(cause)); throw cause }
    finally { if (mounted.current) setSkillCatalogLoading(false) }
  }

  async function saveSkillSettings(settings) {
    const result = await request('save-skill-settings', settings)
    if (mounted.current) { setSkillCatalog(result); setSkillCatalogError('') }
    return result
  }

  async function updateSkillPreference(value) {
    const result = await request('update-skill-preference', value)
    if (mounted.current) { setSkillCatalog(result); setSkillCatalogError('') }
    return result
  }
  useEffect(() => { if (active) void refreshSkillCatalog().catch(() => {}) }, [projectId, active])

  async function refreshMediaCapabilities() {
    setMediaLoading(true)
    try {
      const response = await fetch(endpoint({ mediaCapabilities: '1' }), { credentials: 'same-origin' })
      const result = await response.json()
      if (!response.ok || !Array.isArray(result?.models)) throw new Error(result?.error || '即梦服务检测失败')
      if (mounted.current) { setMediaCapabilities(result); setMediaError(result.error || '') }
      return result
    } catch (cause) { if (mounted.current) setMediaError(messageOf(cause)); return null }
    finally { if (mounted.current) setMediaLoading(false) }
  }

  async function saveMediaSettings(settings) {
    const result = await request('save-media-settings', settings)
    if (mounted.current) { setMediaCapabilities(result); setMediaError(result.error || '') }
    return result
  }

  useEffect(() => {
    if (creationVisible && ['image', 'video'].includes(creation?.outputType)) void refreshMediaCapabilities()
  }, [projectId, creationVisible, creation?.outputType])

  useEffect(() => {
    let stopped = false
    let timer
    async function poll() {
      const nativeWaiting = tasksRef.current.some(task => task.kind === 'ai' && task.outputCardId && !['draft', 'failed'].includes(task.dispatchStatus || task.status)
        && (!task.cardVersionId || isActiveTaskPhase(task.runtimeState?.phase) || publishedTaskGeneration(task, nativeStatusesRef.current.get(task.sessionId))))
        || [...cache.current.outputTracking.values()].some(entry => entry.projectId === projectId && entry.requirementId === requirement.id
          && tasksRef.current.some(task => task.id === entry.taskId && task.kind === 'ai' && !['draft', 'failed'].includes(task.dispatchStatus || task.status)))
        || generationStateSignature(tasksRef.current) !== generationStateSignature(boardRef.current?.tasks)
      if (nativeWaiting) {
        try {
          const nextTasks = await refreshTasks()
          if (stopped) return
          if (generationStateSignature(nextTasks) !== generationStateSignature(boardRef.current?.tasks)) mediaBoardRefresh.current = true
        } catch (cause) { if (!stopped) setNotice(`任务状态查询失败：${messageOf(cause)}`) }
      }
      const jobs = new Map()
      const include = (job, ownerProject, ownerRequirement) => {
        if (!job?.taskId || ownerProject !== projectId || ownerRequirement !== requirement.id) return
        const previous = jobs.get(job.taskId)
        if (!previous || (job.updatedAt || '') >= (previous.updatedAt || '')) jobs.set(job.taskId, job)
      }
      for (const task of tasksRef.current) if (task.kind === 'media') include(task.mediaJob, projectId, task.requirementId)
      for (const entry of mediaTracking.current.values()) include(entry.job, entry.projectId, entry.requirementId)
      for (const frame of cache.current.drafts.values()) include(frame.mediaJob, frame.projectId, frame.requirementId)
      let finished = false
      for (const [taskId, job] of jobs) {
        if (!mediaJobPending(job)) continue
        const frames = () => [...cache.current.drafts].filter(([, frame]) => frame.projectId === projectId && frame.requirementId === requirement.id && frame.mediaJob?.taskId === taskId)
        try {
          const response = await fetch(endpoint({ mediaJob: taskId }), { credentials: 'same-origin' })
          const result = await response.json()
          if (!response.ok || result.job?.taskId !== taskId || result.task?.requirementId !== requirement.id) throw new Error(result.error || '生成状态读取失败')
          if (stopped) return
          rememberMediaTask(result)
          setTasks(previous => previous.map(task => task.id === taskId ? { ...task, ...result.task, mediaJob: result.job } : task))
          for (const [key] of frames()) updateCreation(key, { mediaJob: result.job, mediaPollError: '' })
          mediaBoardRefresh.current = true
          if (!mediaJobPending(result.job)) finished = true
        } catch (cause) {
          if (!stopped) {
            const message = `状态查询失败：${messageOf(cause)}`
            for (const [key] of frames()) updateCreation(key, { mediaPollError: message })
            if (!frames().length) setNotice(message)
          }
        }
      }
      if (!stopped && finished) await refreshTasks().catch(cause => { if (!stopped) setNotice(`任务列表暂未更新：${messageOf(cause)}`) })
      if (!stopped && mediaBoardRefresh.current && boardRef.current && !conflictRef.current && !operationLock.current && !gestureBefore.current && !resizingRef.current && !pendingCount.current) {
        try {
          await saveLayout()
          if (stopped) return
          if (!conflictRef.current && !operationLock.current && !gestureBefore.current && !resizingRef.current && !pendingCount.current
            && await loadBoard({ preserveViewport: true, requireStableLayout: true })) mediaBoardRefresh.current = false
        }
        catch (cause) { if (!stopped) setNotice(`生成文件已保存，画布更新失败：${messageOf(cause)}`) }
      }
      if (!stopped) timer = setTimeout(() => void poll(), 2000)
    }
    timer = setTimeout(() => void poll(), 1000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [projectId, requirement.id])

  function replaceNodes(next) {
    nodesRef.current = next
    setNodes(next)
  }

  function replaceEdges(next) {
    edgesRef.current = next
    setEdges(next)
  }

  function layoutSnapshot() {
    return {
      sizes: Object.fromEntries(nodesRef.current.filter(node => node.type === 'content').map(node => [node.id, nodeSize(node)])),
      positions: Object.fromEntries(nodesRef.current.filter(isObject).map(node => [node.id, absolutePosition(node, nodesRef.current)])),
      edges: edgesRef.current.filter(edge => !edge.provenance).map(({ id, source, target }) => ({ id, source, target })),
      groups: groupsRef.current.map(group => ({ ...group, nodeIds: [...group.nodeIds] })),
      viewport: { ...viewportRef.current },
      elements: elementsRef.current.map(element => ({ ...element })),
    }
  }

  function beginGesture() { if (!gestureBefore.current) gestureBefore.current = layoutSnapshot() }
  function beginNodeDrag() {
    cancelCardOpen();creationIntent.current += 1
    nodeDragging.current = true;setDraggingCard(true);setCreationMenu(null);setContextMenu(null)
    beginGesture()
  }
  function finishNodeDrag() {
    if (!nodeDragging.current) return
    nodeDragging.current = false;setDraggingCard(false)
    finishPositionChange()
  }
  useEffect(() => {
    if (!draggingCard) return
    const finish = () => finishNodeDrag()
    window.addEventListener('blur', finish);window.addEventListener('pointercancel', finish);window.addEventListener('touchcancel', finish)
    return () => { window.removeEventListener('blur', finish);window.removeEventListener('pointercancel', finish);window.removeEventListener('touchcancel', finish) }
  }, [draggingCard])
  function beginResize() { cancelCardOpen(); beginGesture(); resizingRef.current = true }

  function finishCardResize(id, { width, height }) {
    replaceNodes(nodesRef.current.map(node => node.id === id ? { ...node, width, height,
      style: { ...node.style, width, height }, data: { ...node.data, width, height } } : node))
    resizingRef.current = false
    finishPositionChange()
  }

  async function documentSaved(result, scope) {
    if (!mounted.current) return
    const epoch = epochRef.current
    const follow = documentViewRef.current?.sourceRef === scope.sourceRef && documentViewRef.current?.hash === scope.hash
    cache.current.versionViews.delete(result.cardId)
    await onChanged?.()
    if (!mounted.current || epoch !== epochRef.current) return
    await loadBoard({ preserveViewport: true })
    if (!mounted.current || epoch !== epochRef.current || !follow || documentViewRef.current?.sourceRef !== scope.sourceRef) return
    const node = nodesRef.current.find(item => item.data.outputCard?.id === result.cardId)
    if (node) await openOutputCard(node.data, result.versionId)
  }

  async function rewriteDocument(created) {
    if (!['draft', 'failed'].includes(created.task.status)) throw new Error('改写任务已提交或状态待核对，请在任务列表打开原对话，不要重复发送。')
    if (!onStart) throw new Error('任务对话不可用，改写任务已保留，请在任务列表继续。')
    const epoch = epochRef.current
    await onStart({ ...created.prepared, ...(created.task.sessionId ? { sessionId: created.task.sessionId } : {}) })
    if (!mounted.current || epoch !== epochRef.current) return
    await onChanged?.()
    await loadBoard({ preserveViewport: true })
    if (mounted.current && epoch === epochRef.current) { setOutcomeView(null);setDocumentView(null); setSidebar(true); setTab('tasks') }
  }

  async function openProjectFileAction(action, entry) {
    if (!entry?.path) return
    try {
      const file = await request(action, { path: entry.path })
      setNotice(action === 'project-file-reveal' ? `已在 Finder 定位 ${file.fileName}` : `已用默认应用打开 ${file.fileName}`)
    } catch (cause) { setError(messageOf(cause)) }
  }

  const [materialVersionView, setMaterialVersionView] = useState(null)
  async function viewMaterialVersion(card, versionId) {
    try { setMaterialVersionView(await request('material-version', { requirementId: requirement.id, materialId: card.refId, versionId })) }
    catch (cause) { setError(messageOf(cause)) }
  }
  async function restoreMaterialFile(card) {
    try {
      const result = await request('material-restore-project-file', { requirementId: requirement.id, materialId: card.refId })
      setNotice(`已从卡片内容重建源文件「${result.fileName}」，链接已恢复。`)
      await loadBoard({ preserveViewport: true })
      onFilesChanged?.()
    } catch (cause) { setError(messageOf(cause)) }
  }

  async function saveCardText(card, content) {
    const intent = creationIntent.current
    const key = cardTextDraftKey(card)
    const payload = { requirementId: requirement.id, cardId: card.outputCard?.id || card.id,
      ...(card.outputCard ? { versionId: card.outputCard.versionId } : {}), sourceHash: card.sourceHash, content }
    const signature = JSON.stringify(payload)
    if (cache.current.textAttempts.get(key)?.signature !== signature) cache.current.textAttempts.set(key, { signature, id: crypto.randomUUID() })
    const outcome = await perform('text-edit', async epoch => {
      await saveLayout()
      const result = await request('save-card-text', { ...payload, operationId: cache.current.textAttempts.get(key).id })
      if (!mounted.current || epoch !== epochRef.current) return
      if (result.cardId && result.versionId) {
        const response = await fetch(endpoint({ outputCard: result.cardId, requirementId: requirement.id, cardVersion: result.versionId }), { credentials: 'same-origin' })
        const descriptor = await response.json()
        if (!mounted.current || epoch !== epochRef.current) return
        if (!response.ok || !descriptor?.node) throw new Error(descriptor?.error || '新版本已保存，读取失败，请刷新')
        if (intent === creationIntent.current) cache.current.versionViews.set(result.cardId, { versionId: result.versionId, node: descriptor.node, provenanceEdges: descriptor.provenanceEdges })
      }
      cache.current.textAttempts.delete(key)
      await onChanged?.()
      if (!mounted.current || epoch !== epochRef.current) return
      await loadBoard({ preserveViewport: true })
      onFilesChanged?.()
      setNotice(result.savedTo ? `已保存到「${result.savedTo}」。` : card.kind === 'requirement' ? '背景信息已保存。' : card.composition ? '正文已保存为 Markdown。' : card.outputCard ? '已保存同卡新版本，原文件保留。' : '已另存素材，原件保留。')
    })
    if (!outcome.ok) throw outcome.error
  }

  async function openWhiteboardCreation(id) {
    cancelCardOpen()
    const intent = ++creationIntent.current, epoch = epochRef.current
    const node = nodesRef.current.find(node => node.id === id)
    if (!node?.data.text?.trim()) return
    try {
      await saveLayout()
      const result = await request('snapshot-whiteboard', { requirementId: requirement.id, elementId: id,
        expectedContent: node.data.text, operationId: crypto.randomUUID() })
      if (!mounted.current || epoch !== epochRef.current || intent !== creationIntent.current) return
      const card = referenceResultCard(result)
      openCreation({ ...card, nodeId: id, position: absolutePosition(node, nodesRef.current), ...nodeSize(node) }, 'text')
      await loadBoard({ preserveViewport: true })
      onFilesChanged?.()
    } catch (cause) { if (mounted.current && epoch === epochRef.current && intent === creationIntent.current) setError(messageOf(cause)) }
  }

  function remember(before) {
    if (before && historyRef.current.record(before, layoutSnapshot())) setHistoryGeneration(value => value + 1)
  }

  function decorate(flowNodes, autoEditId) {
    const taskById = new Map(tasksRef.current.map(task => [task.id, task]))
    return flowNodes.map(node => {
      if (node.type === 'whiteboard') return {
        ...node, data: { ...node.data, onChange: changeElement, onResizeStart: beginResize, onEditStart: closeCreation, autoEdit: node.id === autoEditId },
      }
      if (node.type !== 'content') return node
      const card = node.data.outputCard
      const head = card?.versions.find(version => version.id === card.latestVersionId)
      const task = taskById.get(head?.taskId)
      const publishedGeneration = (!node.data.pendingGeneration || node.data.pendingGeneration.published)
        ? publishedTaskGeneration(task, nativeStatusesRef.current.get(task?.sessionId)) : undefined
      return { ...node, data: { ...node.data, onCreate: openNodeMenu,
      publishedGeneration,
      autoEdit: node.id === autoEditId,
      onEditStart: () => { if (node.data.composition && !node.selected) selectCard(node.id);setEditingTextCard(node.id);closeCreation(); setFocusOpen(false); setSidebar(false); setDeckPreview(null); setOutcomeView(null);setDocumentView(null) },
      onEditEnd: () => { setEditingTextCard(current=>current===node.id?null:current);cache.current.visible=false;setCreationVisible(false) },
      getTextDraft: key => cache.current.textDrafts.get(key),
      setTextDraft: (key, value) => value === null ? cache.current.textDrafts.delete(key) : cache.current.textDrafts.set(key, value),
      onSaveText: saveCardText, onResizeStart: beginResize, onResizeEnd: finishCardResize,
      nativeSessionStatus: nativeStatusesRef.current?.get(node.data.pendingGeneration?.sessionId),
      skillTodo: interactionsRef.current.find(entry => (entry.task.outputCardId && entry.task.outputCardId === node.data.outputCard?.id) || node.data.outputCard?.versions?.some(version => version.taskId === entry.task.id)),
      onOpenSkillTodo: () => openSkillReview(interactionsRef.current.find(entry => (entry.task.outputCardId && entry.task.outputCardId === node.data.outputCard?.id) || node.data.outputCard?.versions?.some(version => version.taskId === entry.task.id))),
      onOpenPending: () => publishedGeneration || node.data.pendingGeneration?.published
        ? void openOutputCard(node.data, card.latestVersionId, { showDeck: false }) : void openPendingCard(node.data, { showDeck: false }),
      onOpenInspect: () => { closeCreation(); setSidebar(true); setTab('inspect') },
      onRevealFile: entry => void openProjectFileAction('project-file-reveal', entry),
      onOpenExternal: entry => void openProjectFileAction('project-file-open', entry),
      onLoadOpenApps: entry => request('card-open-applications', { ...entry, requirementId: requirement.id }),
      onOpenWithApp: (entry, application, draftId) => request(draftId ? 'document-open-application' : 'card-open-application',
        draftId ? { draftId, application } : { ...entry, application, requirementId: requirement.id }),
      onLoadMaterialVersion: versionId => request('material-version', { requirementId: requirement.id, materialId: node.data.refId, versionId }),
      onMaterialVersionView: versionId => void viewMaterialVersion(node.data, versionId),
      onRestoreFile: () => void restoreMaterialFile(node.data),
      onOpenFile: async () => {
        try {
          const file = await request('open-deliverable', { requirementId: requirement.id, sourceRef: `${node.data.kind}:${node.data.refId}` });
          setNotice(`已在 Finder 定位 ${file.fileName}`); await loadBoard();
        } catch (cause) { setError(messageOf(cause)) }
      },
      onVersionChange: versionId => void openOutputCard(node.data, versionId),
      onOpenOutcome: sourceRef => openOutcomes(node.data,sourceRef),
      onOpenWeb: () => {closeCreation();setSidebar(false);setDeckPreview({slideProject:node.data.slideProject,artifactId:node.data.slideProject.artifactId,hash:node.data.slideProject.artifactHash,title:node.data.title,cardId:node.data.outputCard?.id,versionId:node.data.outputCard?.versionId,requirementId:requirement.id,viewIntent:++creationIntent.current,viewEpoch:epochRef.current})},
      loadSlideCover: data => request('slides-cover', data), loadDeckPreview, getDeckPageHref, onOpenDeck: () => void openOutputCard(node.data, node.data.outputCard?.versionId),
      ...(['artifact', 'outline', 'word'].includes(node.data.kind) ? { downloadHref: endpoint(node.data.kind === 'artifact' ? { downloadArtifact: node.data.refId } : { download: node.data.refId }).href } : {}),
      ...(node.data.importedFile?.mime?.startsWith('video/') && node.data.sourceStatus === 'ready'
        ? { videoPreview: endpoint({ materialFile: node.data.refId, preview: '1' }).href } : {}),
      ...(node.data.importedFile?.mime?.startsWith('image/') && node.data.sourceStatus === 'ready'
        ? { imagePreview: endpoint({ materialFile: node.data.refId, preview: '1' }).href } : {}),
      ...(node.data.generatedFile?.mime?.startsWith('video/') && node.data.status === 'ready'
        ? { videoPreview: endpoint({ downloadArtifact: node.data.refId, preview: '1' }).href } : {}),
      ...(node.data.generatedFile?.mime?.startsWith('image/') && node.data.status === 'ready'
        ? { imagePreview: endpoint({ downloadArtifact: node.data.refId, preview: '1' }).href } : {}) } }
    })
  }

  useEffect(() => { if (nodesRef.current.length) replaceNodes(decorate(nodesRef.current)) }, [nativeSessionStatuses, watchedStatuses, tasks])

  function renderLayout(snapshot, ids, autoEditId) {
    if (!boardRef.current) return
    const selection = ids || nodesRef.current.filter(node => node.selected).map(node => node.id)
    elementsRef.current = snapshot.elements || []
    groupsRef.current = snapshot.groups || []
    const business = boardRef.current.nodes.filter(node => node.kind !== 'whiteboard')
    const whiteboard = elementsRef.current.map(element => ({
      ...element, kind: 'whiteboard', elementKind: element.kind, refId: element.id.slice(11),
      title: element.text.trim().slice(0, 36) || ({ text: '自由文本', note: '便签', shape: '图形' }[element.kind]),
      content: element.text, excerpt: element.text.slice(0, 180),
      position: snapshot.positions[element.id] || { x: 80, y: 80 },
    }))
    const projected = [...business, ...whiteboard].map(node => ({ ...node, position: snapshot.positions[node.id] || node.position, ...(snapshot.sizes?.[node.id] || {}) }))
    replaceNodes(decorate(flowFromBoard({ nodes: projected, groups: groupsRef.current }, selection), autoEditId))
    replaceEdges(flowEdges([...(boardRef.current.edges || []).filter(edge => edge.provenance), ...snapshot.edges]))
    setSelectionKey(selection.filter(id => !id.startsWith('group:')).sort().join('|'))
  }

  function applyEdit(before, snapshot, ids, autoEditId) {
    renderLayout(snapshot, ids, autoEditId)
    remember(before)
    void saveLayout()
  }

  function changeElement(id, patch) {
    if (operationLock.current) return
    const before = gestureBefore.current || layoutSnapshot()
    gestureBefore.current = null
    resizingRef.current = false
    const snapshot = layoutSnapshot()
    snapshot.elements = snapshot.elements.map(element => element.id === id ? { ...element, ...patch } : element)
    applyEdit(before, snapshot)
  }

  function undo(redo = false) {
    if (operationLock.current || conflictRef.current) return
    const snapshot = historyRef.current[redo ? 'redo' : 'undo'](layoutSnapshot())
    if (!snapshot) return
    renderLayout(snapshot)
    setHistoryGeneration(value => value + 1)
    void saveLayout()
  }

  function viewCenter() {
    const rect = graphRef.current?.getBoundingClientRect()
    return rect ? flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 240, y: 180 }
  }

  function addElement(kind, point = viewCenter()) {
    if (!boardRef.current || operationLock.current || conflictRef.current) return
    const before = layoutSnapshot()
    const element = { id: `whiteboard:${crypto.randomUUID()}`, kind: ['text', 'note'].includes(kind) ? kind : 'shape',
      text: '', width: kind === 'text' ? 280 : 240, height: kind === 'text' ? 100 : 180,
      colour: kind === 'note' ? 'cream' : 'white', ...(['rectangle', 'ellipse'].includes(kind) ? { shape: kind } : {}) }
    const next = layoutSnapshot()
    next.elements.push(element)
    next.positions[element.id] = { x: point.x - element.width / 2, y: point.y - element.height / 2 }
    applyEdit(before, next, [element.id], element.id)
    setTool('select')
    setContextMenu(null)
  }

  function duplicateElements() {
    const selected = nodesRef.current.filter(node => isObject(node) && node.selected)
    if (!selected.length || selected.some(node => node.type !== 'whiteboard')) {
      setNotice('复制用于白板元素；大纲请通过“保存为新版本”保留修订。')
      return
    }
    const before = layoutSnapshot(), next = layoutSnapshot(), ids = []
    for (const node of selected) {
      const source = next.elements.find(element => element.id === node.id)
      const id = `whiteboard:${crypto.randomUUID()}`
      next.elements.push({ ...source, id })
      const position = absolutePosition(node, nodesRef.current)
      next.positions[id] = { x: position.x + 36, y: position.y + 36 }
      ids.push(id)
    }
    applyEdit(before, next, ids)
  }

  async function removeElements() {
    const selected = nodesRef.current.filter(node => isObject(node) && node.selected)
    if(!selected.length||busy)return
    const epoch=epochRef.current,selection=selected.map(n=>n.id).sort().join('|')
    if(editingTextCard){setError('请先保存或取消正在编辑的文字，再删除节点。');return}
    try{
      await saveLayout()
      if(conflictRef.current)throw new Error('画布发生冲突，请先刷新后再删除')
      const selections=selected.map(n=>({nodeId:n.id,...(n.data.outputCard?.versionId?{versionId:n.data.outputCard.versionId}:{})}))
      const plan=await request('canvas-recycle-plan',{requirementId:requirement.id,selections})
      if(!mounted.current||!activeRef.current||epoch!==epochRef.current||nodesRef.current.filter(n=>isObject(n)&&n.selected).map(n=>n.id).sort().join('|')!==selection)return
      closeCreation();setContextMenu(null);setDeletePlan(plan)
    }catch(cause){if(mounted.current)setError(messageOf(cause))}
  }
  const lastFileRecycle=useRef(null)
  useEffect(()=>{
    if(!active||!fileRecycleSignal||lastFileRecycle.current===fileRecycleSignal.token||!fileRecycleSignal.requirements.includes(requirement.id))return
    lastFileRecycle.current=fileRecycleSignal.token
    closeCreation()
    void recycledChanged().catch(cause=>setError(messageOf(cause)))
  },[fileRecycleSignal,active])
  async function recycledChanged(){
    setDeletePlan(null);setOutcomeView(null);setDocumentView(null);setDeckPreview(null);setSidebar(false);onCloseProjectFile?.();
    await loadBoard({preserveViewport:true});onFilesChanged?.()
  }

  function alignSelection(direction) {
    const selected = nodesRef.current.filter(node => isObject(node) && node.selected)
    if (selected.length < 2) return
    const before = layoutSnapshot(), next = layoutSnapshot()
    const objects = selected.map(node => ({ id: node.id, ...next.positions[node.id], ...nodeSize(node) }))
    if (direction === 'left') for (const item of objects) next.positions[item.id].x = Math.min(...objects.map(node => node.x))
    else if (direction === 'top') for (const item of objects) next.positions[item.id].y = Math.min(...objects.map(node => node.y))
    else if (objects.length >= 3) {
      objects.sort((a, b) => a.x - b.x)
      const span = objects.at(-1).x + objects.at(-1).width - objects[0].x
      const gap = (span - objects.reduce((sum, node) => sum + node.width, 0)) / (objects.length - 1)
      let x = objects[0].x
      for (const item of objects) { next.positions[item.id].x = x; x += item.width + gap }
    }
    applyEdit(before, next)
  }

  function openPanel(nextTab) {
    if (nextTab === 'ai') { openSelectedCreation(); return }
    closeCreation()
    setDeckPreview(null); setOutcomeView(null);setDocumentView(null); setFocusOpen(false); setAssetsOpen(false)
    setTab(nextTab); setSidebar(true); setContextMenu(null)
  }

  function fitSelection() {
    const selected = nodesRef.current.filter(node => isObject(node) && node.selected)
    if (selected.length) void flow.fitView({ nodes: selected, padding: 0.45, maxZoom: 1, duration: 200 })
  }

  function zoom100() {
    const chosen = nodesRef.current.filter(node => isObject(node) && node.selected)
    if (!chosen.length) { void flow.zoomTo(1, { duration: 120 }); return }
    const boxes = chosen.map(node => ({ ...absolutePosition(node, nodesRef.current), ...nodeSize(node) }))
    const x = (Math.min(...boxes.map(box => box.x)) + Math.max(...boxes.map(box => box.x + box.width))) / 2
    const y = (Math.min(...boxes.map(box => box.y)) + Math.max(...boxes.map(box => box.y + box.height))) / 2
    void flow.setCenter(x, y, { zoom: 1, duration: 120 })
  }

  function saveLayout(force = false, duringOperation = false) {
    if (!boardRef.current || conflictRef.current) return chainRef.current
    if (resizingRef.current) return chainRef.current
    if (operationLock.current && !duringOperation) return chainRef.current
    const snapshot = layoutSnapshot()
    const signature = JSON.stringify(snapshot)
    if (!force && signature === queuedSignature.current) return chainRef.current
    queuedSignature.current = signature
    const epoch = epochRef.current
    const requirementId = requirement.id
    pendingCount.current += 1
    setSaveStatus('saving')
    const job = chainRef.current.catch(() => {}).then(async () => {
      if (epoch !== epochRef.current || conflictRef.current) return
      const result = await requestRef.current('save-canvas', {
        requirementId, expectedRevision: boardRef.current.revision, ...snapshot,
      })
      if (!mounted.current || epoch !== epochRef.current) return
      if (generationStateSignature(result.tasks) !== generationStateSignature(boardRef.current?.tasks)) mediaBoardRefresh.current = true
      boardRef.current = versionedBoard(result)
      setBoard(boardRef.current)
      setTasks(result.tasks || [])
    }).catch(cause => {
      if (!mounted.current || epoch !== epochRef.current) return
      const message = messageOf(cause)
      conflictRef.current = /conflict|revision|冲突|旧布局|版本.*过期|已被其他操作修改/i.test(message)
      setSaveStatus(conflictRef.current ? 'conflict' : 'failed')
      setError(message)
      queuedSignature.current = ''
      throw cause
    }).finally(() => {
      if (!mounted.current || epoch !== epochRef.current) return
      pendingCount.current -= 1
      if (!pendingCount.current && !conflictRef.current) {
        setSaveStatus(previous => previous === 'saving' ? 'saved' : previous)
      }
    })
    // Retain the rejecting job for dependent operations, while background events handle errors above.
    chainRef.current = job
    void job.catch(() => {})
    return job
  }
  function finishPositionChange() {
    if (resizingRef.current) return
    const next = resizeGroups(nodesRef.current)
    if (next !== nodesRef.current) replaceNodes(next)
    remember(gestureBefore.current)
    gestureBefore.current = null
    resizingRef.current = false
    void saveLayout()
  }
  finishPositionRef.current = finishPositionChange

  async function loadBoard({ initial = false, selectIds, preserveViewport = false, selectionIntent, requireStableLayout = false, autoEditId } = {}) {
    const epoch = epochRef.current
    const previousLayout = requireStableLayout ? JSON.stringify(layoutSnapshot()) : null
    setLoading(true)
    setLoadError('')
    try {
      const response = await fetch(endpoint({ canvas: requirement.id }), { credentials: 'same-origin' })
      let result = await response.json().catch(() => null)
      if (!response.ok || result?.ok === false || !result?.nodes) {
        throw new Error(result?.error?.message || result?.error || `画布加载失败（${response.status}）`)
      }
      if (!mounted.current || epoch !== epochRef.current) return
      if (requireStableLayout && (previousLayout !== JSON.stringify(layoutSnapshot()) || operationLock.current || gestureBefore.current || resizingRef.current || pendingCount.current || conflictRef.current)) return
      for (const node of result.nodes) {
        const view = node.outputCard && cache.current.versionViews.get(node.outputCard.id)
        if (!view) continue
        const response = await fetch(endpoint({ outputCard: node.outputCard.id, requirementId: requirement.id, cardVersion: view.versionId }), { credentials: 'same-origin' })
        const descriptor = await response.json()
        if (!response.ok || !descriptor?.node) throw new Error(descriptor?.error || '所选历史版本核对失败')
        if (!mounted.current || epoch !== epochRef.current) return
        if (cache.current.versionViews.get(node.outputCard.id) === view) cache.current.versionViews.set(node.outputCard.id, { versionId: view.versionId, node: descriptor.node, provenanceEdges: descriptor.provenanceEdges })
      }
      if (requireStableLayout && (previousLayout !== JSON.stringify(layoutSnapshot()) || operationLock.current || gestureBefore.current || resizingRef.current || pendingCount.current || conflictRef.current)) return
      result = versionedBoard(result)
      const currentSelectIds = selectionIntent === undefined || selectionIntent === creationIntent.current ? selectIds : undefined
      const ids = currentSelectIds || (initial ? result.nodes.filter(node => node.kind === 'requirement').map(node => node.id) : nodesRef.current.filter(node => node.selected).map(node => node.id))
      boardRef.current = result
      groupsRef.current = result.groups || []
      elementsRef.current = result.elements || []
      historyRef.current.reset()
      setHistoryGeneration(value => value + 1)
      viewportRef.current = preserveViewport ? { ...viewportRef.current } : result.viewport || { x: 0, y: 0, zoom: 1 }
      setZoom(viewportRef.current.zoom)
      const nextViewport = { epoch, viewport: { ...viewportRef.current }, focusIds: preserveViewport ? undefined : currentSelectIds }
      viewportRequest.current = nextViewport
      setLoadedViewport(nextViewport)
      replaceNodes(decorate(flowFromBoard(result, ids), currentSelectIds ? autoEditId : undefined))
      replaceEdges(flowEdges(result.edges))
      setBoard(result)
      tasksRef.current = result.tasks || []
      setTasks(result.tasks || [])
      const current = creationRef.current
      if (current?.pendingTaskId) {
        const pending = result.nodes.find(node => node.pendingGeneration?.taskId === current.pendingTaskId)?.pendingGeneration
        if (pending) updateCreation(current.key, { pendingGeneration: pending, sessionId: pending.sessionId || current.sessionId,
          ...(pending.mediaJob ? { mediaJob: pending.mediaJob } : {}) })
      }
      setSelectionKey(ids.join('|'))
      conflictRef.current = false
      chainRef.current = Promise.resolve()
      pendingCount.current = 0
      queuedSignature.current = JSON.stringify(layoutSnapshot())
      setSaveStatus('saved')
      setError('')
      if (creationRef.current?.sessionId) restoredSession.current = true
      if (result.sessionId && !restoredSession.current && restoreRef.current) {
        restoredSession.current = true
        Promise.resolve().then(() => restoreRef.current(result.sessionId, { automatic: true })).catch(cause => {
          if (mounted.current && epoch === epochRef.current) setError(messageOf(cause))
        })
      }
      void followOutputResults(result)
      return result
    } catch (cause) {
      if (mounted.current && epoch === epochRef.current) setLoadError(messageOf(cause))
    } finally {
      if (mounted.current && epoch === epochRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    epochRef.current += 1
    boardRef.current = null
    nodesRef.current = []
    edgesRef.current = []
    groupsRef.current = []
    elementsRef.current = []
    historyRef.current.reset()
    gestureBefore.current = null
    setSidebar(false)
    setTool('select')
    setContextMenu(null)
    setFocusOpen(false)
    setTasks([])
    mediaTracking.current.clear()
    mediaRestores.current.clear()
    mediaBoardRefresh.current = false
    setReaderRange(null)
    setExcerptError('')
    chainRef.current = Promise.resolve()
    queuedSignature.current = ''
    pendingCount.current = 0
    conflictRef.current = false
    operationLock.current = false
    restoredSession.current = false
    setBoard(null)
    setError('')
    setNotice('')
    setBusy('')
    setOutline('')
    if (!draftCache) draftsRef.current.clear()
    setEdgeSelection([])
    setLoadedViewport(null)
    appliedViewport.current = null
    viewportRequest.current = null
    restoringViewport.current = null
    materialAttempt.current = null
    outlineAttempt.current = null
    excerptAttempt.current = null
    void loadBoard({ initial: true })
    return () => {
      cancelCardOpen()
      mounted.current = false
      epochRef.current += 1
      for (const key of mediaRestores.current.keys()) {
        if (cache.current.drafts.get(key)?.mediaRestoring) updateCreation(key, { mediaRestoring: false })
      }
      mediaRestores.current.clear()
    }
  }, [requirement.id])

  useEffect(() => {
    if (!active || !loadedViewport || loading || !flow.viewportInitialized || loadedViewport.epoch !== epochRef.current || appliedViewport.current === loadedViewport) return
    // A loaded board restores once. Ordinary layout-save replies never change this marker.
    appliedViewport.current = loadedViewport
    resumeViewport.current = null
    restoringViewport.current = loadedViewport
    const nextView = loadedViewport.focusIds?.length
      ? flow.fitView({ nodes: loadedViewport.focusIds.map(id => ({ id })), padding: 0.5, maxZoom: 1, duration: 120 })
      : flow.setViewport(loadedViewport.viewport, { duration: 0 })
    Promise.resolve(nextView).catch(cause => {
      if (mounted.current && loadedViewport.epoch === epochRef.current) setError(messageOf(cause))
    }).finally(() => {
      if (!mounted.current || loadedViewport.epoch !== epochRef.current || restoringViewport.current !== loadedViewport) return
      restoringViewport.current = null
      if (loadedViewport.focusIds?.length) void saveLayout()
    })
  }, [active, loadedViewport, loading, flow.viewportInitialized])

  useEffect(() => {
    if (!active) { cancelCardOpen();nodeDragging.current=false;setDraggingCard(false); resumeViewport.current = { ...viewportRef.current }; return }
    if (!resumeViewport.current || loading || !flow.viewportInitialized || restoringViewport.current) return
    const target = resumeViewport.current
    resumeViewport.current = null
    const marker = {}
    const epoch = epochRef.current
    restoringViewport.current = marker
    Promise.resolve(flow.setViewport(target, { duration: 0 })).catch(cause => {
      if (mounted.current) setError(messageOf(cause))
    }).finally(() => {
      if (!mounted.current || epoch !== epochRef.current || restoringViewport.current !== marker) return
      restoringViewport.current = null
    })
  }, [active, loading, flow.viewportInitialized])

  useEffect(() => {
    setOutline(selectedCard?.kind === 'outline' ? draftsRef.current.get(selectedSourceId) ?? selectedCard.content ?? '' : '')
    outlineAttempt.current = null
    setExcerptError('')
    setReaderRange(previous => previous?.cardId === selectedCard?.id ? previous : null)
  }, [selectionKey, selectedSourceId, selectedCard?.sourceHash])


  useEffect(() => {
    const previous = previousRefreshSignal.current
    previousRefreshSignal.current = { initialized: true, value: refreshSignal }
    if (!previous.initialized || Object.is(previous.value, refreshSignal)) return
    void refreshTasks().catch(cause => { if (mounted.current) setError(messageOf(cause)) })
    const layoutPending = pendingCount.current > 0 || nodesRef.current.some(node => node.dragging)
      || (boardRef.current && JSON.stringify(layoutSnapshot()) !== queuedSignature.current)
    if (loading || busy || operationLock.current || draftsRef.current.size || layoutPending || conflictRef.current || saveStatus === 'failed') {
      setNotice('这轮创作已结束。刷新画布可查看新文件，当前草稿和布局会保留。')
      return
    }
    void refresh()
  }, [refreshSignal])

  useEffect(() => {
    if (draftCache) return
    const warnBeforeReload = event => {
      if (!draftsRef.current.size) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeReload)
    return () => window.removeEventListener('beforeunload', warnBeforeReload)
  }, [draftCache])

  function editOutline(markdown) {
    if (!selectedCard || selectedCard.kind !== 'outline') return
    if (normalizeLineEndings(markdown) === normalizeLineEndings(selectedCard.content)) draftsRef.current.delete(selectedSourceId)
    else draftsRef.current.set(selectedSourceId, markdown)
    setOutline(markdown)
  }

  const loadTask = useCallback(async id => {
    const response = await fetch(endpoint({ task: id }), { credentials: 'same-origin' })
    const result = await response.json().catch(() => null)
    if (!response.ok || !result?.id) throw new Error(result?.error || '任务详情读取失败')
    return result
  }, [])

  async function refreshTasks() {
    const epoch = epochRef.current
    const response = await fetch(endpoint({ tasks: requirement.id }), { credentials: 'same-origin' })
    const result = await response.json().catch(() => null)
    if (!response.ok || !Array.isArray(result)) throw new Error(result?.error || '任务列表读取失败')
    if (mounted.current && epoch === epochRef.current) { tasksRef.current = result; setTasks(result) }
    return result
  }

  async function openTaskSession(sessionId) {
    cancelCardOpen()
    const epoch = epochRef.current
    const intent = ++creationIntent.current
    try {
      const summary = tasks.find(task => task.sessionId === sessionId)
      const task = summary ? await loadTask(summary.id) : null
      if (!mounted.current || epoch !== epochRef.current || intent !== creationIntent.current) return
      const pendingCard = (boardRef.current?.nodes || []).find(card => card.pendingGeneration?.taskId === task?.id)
      if (pendingCard) {
        const context = await openPendingCard(pendingCard)
        if (context && creationRef.current?.key === context.key) await restoreRef.current?.(sessionId)
        return
      }
      const restored = await restoreRef.current?.(sessionId)
      if (!restored || !mounted.current || epoch !== epochRef.current || intent !== creationIntent.current) return
      const snapshots = task?.input?.sources || []
      const sourceSnapshot = snapshots.find(source => source.cardId === task?.input?.selection?.sourceCardId) || snapshots[0]
      const liveCards = boardRef.current?.nodes || []
      const source = liveCards.find(card => card.id === sourceSnapshot?.cardId)
      const sourceMatches = usableCreationSource(source) && source.sourceHash === sourceSnapshot?.hash
      const anchor = sourceMatches ? source : liveCards.find(card => card.kind === 'requirement')
      if (anchor) {
        openCreation(anchor, task?.input?.outputType || 'outline', sourceMatches ? task?.input?.selection : undefined)
        if (creationRef.current) {
          const frame = creationRef.current
          const validSources = snapshots.map(snapshot => liveCards.find(card => card.id === snapshot.cardId && usableCreationSource(card) && card.sourceHash === snapshot.hash)).filter(Boolean)
          const missing = snapshots.length - validSources.length
          const preserveDraft = Boolean(frame.instruction.trim() || frame.referencesEdited)
          updateCreation(frame.key, current => ({ ...current,
            ...(!preserveDraft && sourceMatches ? updateCreationReferences({ ...current, references: [current.anchor] }, validSources) : {}),
            sessionId, taskId: task?.id, error: task && (!sourceMatches || missing) ? `原任务有 ${missing || 1} 份来源当前不可用或已变化；已恢复对话，新创作请重新核对引用。` : '' }))
          if (preserveDraft) setNotice('已恢复原任务对话；新任务草稿的引用保持不变，原任务输入可在任务详情中查看。')
        }
      }
    } catch (cause) { if (mounted.current && epoch === epochRef.current && intent === creationIntent.current) setError(messageOf(cause)) }
  }

  function openArtifact({ versionId, kind, artifactId }) {
    const id = artifactId ? `artifact:${artifactId}` : `${kind}:${versionId}`
    const owner = nodesRef.current.find(node => node.id === id || node.data.sourceId === id || node.data.outcomeFiles?.some(file=>file.sourceRef===id) || node.data.outputCard?.versions.some(version => version.primaryRef === id))
    if (owner?.data.outputCard) {
      const version = owner.data.outputCard.versions.find(version => version.primaryRef === id)
      openOutcomes(owner.data, id, version?.id || owner.data.outputCard.versionId)
      return
    }
    if (!owner && artifactId) { closeCreation();setSidebar(false);setOutcomeView({requirementId:requirement.id,sourceRef:id,title:'成果文件'});return }
    if (!owner) { setError('该成果文件当前未显示，请重新读取任务。'); return }
    selectCard(id)
    setFocusOpen(kind === 'outline')
    closeCreation()
    setSidebar(kind !== 'outline')
    setTab('inspect')
  }

  async function openExcerptSource(info) {
    const node = nodesRef.current.find(node => node.id === info.sourceCardId || node.data.sourceId === info.sourceCardId || node.data.outputCard?.versions.some(version => version.primaryRef === info.sourceCardId))
    if (!node) { setError('来源已缺失；已保存的摘录仍在项目文件夹中。'); return }
    const version = node.data.outputCard?.versions.find(version => version.primaryRef === info.sourceCardId)
    if (version) await openOutputCard(node.data, version.id, { showDeck: false })
    setReaderRange({ cardId: node.id, start: info.start, end: info.end })
    selectCard(node.id)
    setFocusOpen(false)
    openPanel('inspect')
  }

  function selectPassage(range) {
    if (!selectedCard || selectedCard.kind !== 'outline' || outlineDirty) return
    if (range.quote.length > 12_000) { setError('选段超过 12000 字符，请缩小范围，或从画布引用整份版本。'); return }
    const selection = { sourceCardId: selectedSourceId, sourceHash: selectedCard.sourceHash, ...range }
    openCreation(selectedCard, 'outline', selection)
    if (creationRef.current?.anchor.id === selectedSourceId) updateCreation(creationRef.current.key, { instruction: '请只调整所选片段，保留其他章节；先分析并等我确认，再保存完整大纲新版本。' })
  }

  const onNodesChange = useCallback(changes => {
    if (changes.some(change => change.type === 'position') && !gestureBefore.current) gestureBefore.current = layoutSnapshot()
    const next = applyNodeChanges(changes.filter(change => change.type !== 'remove'), nodesRef.current)
    nodesRef.current = next
    setNodes(next)
    if (!resizingRef.current && changes.some(change => change.type === 'position' && !change.dragging)) {
      queueMicrotask(() => { finishPositionRef.current?.() })
    }
  }, [])

  function onEdgesChange(changes) {
    const before = layoutSnapshot()
    const allowed = changes.filter(change => change.type !== 'remove' || !edgesRef.current.find(edge => edge.id === change.id)?.provenance)
    const next = applyEdgeChanges(allowed, edgesRef.current)
    replaceEdges(next)
    if (allowed.some(change => change.type === 'remove')) { remember(before); void saveLayout() }
  }

  const selectionChanged = useCallback(({ nodes: selected, edges: selectedEdges }) => {
    setSelectionKey(selected.filter(isObject).map(node => node.id).sort().join('|'))
    setEdgeSelection(selectedEdges.filter(edge => !edge.provenance).map(edge => edge.id))
  }, [])

  function connect(connection) {
    if (!connection.source || !connection.target || connection.source === connection.target) return
    if (edgesRef.current.some(edge => edge.source === connection.source && edge.target === connection.target)) return
    const before = layoutSnapshot()
    replaceEdges([...edgesRef.current, ...flowEdges([{ id: `edge:${crypto.randomUUID()}`, source: connection.source, target: connection.target }])])
    remember(before)
    void saveLayout()
  }

  function regroup(title) {
    const before = layoutSnapshot()
    const ids = nodesRef.current.filter(node => isObject(node) && node.selected).map(node => node.id)
    if (ids.length < 2) return
    const moved = new Set(ids)
    groupsRef.current = groupsRef.current.map(group => ({ ...group, nodeIds: group.nodeIds.filter(id => !moved.has(id)) })).filter(group => group.nodeIds.length >= 2)
    groupsRef.current.push({ id: `group:${crypto.randomUUID()}`, title, nodeIds: ids })
    const absoluteCards = nodesRef.current.filter(isObject).map(node => ({ ...node.data, ...nodeSize(node), position: absolutePosition(node, nodesRef.current) }))
    replaceNodes(decorate(flowFromBoard({ nodes: absoluteCards, groups: groupsRef.current }, ids)))
    remember(before)
    setGroupDialog(false)
    void saveLayout()
  }

  function ungroup() {
    const before = layoutSnapshot()
    const groupIds = new Set(nodesRef.current.filter(node => node.type === 'courseGroup' && node.selected).map(node => node.id))
    for (const node of nodesRef.current) if (node.selected && node.parentId) groupIds.add(node.parentId)
    const absoluteCards = nodesRef.current.filter(isObject).map(node => ({ ...node.data, ...nodeSize(node), position: absolutePosition(node, nodesRef.current) }))
    groupsRef.current = groupsRef.current.filter(group => !groupIds.has(group.id))
    replaceNodes(decorate(flowFromBoard({ nodes: absoluteCards, groups: groupsRef.current }, selectedIds)))
    remember(before)
    void saveLayout()
  }

  async function refresh() {
    if (conflictRef.current && !window.confirm('画布有另一份更新。重新加载会放弃本次未保存的画布改动，继续？')) return
    try {
      if (!conflictRef.current) await saveLayout()
      await onChanged?.()
      await loadBoard()
    } catch (cause) { setError(messageOf(cause)) }
  }

  async function perform(action, operation) {
    if (busy || operationLock.current) return { ok: false, error: new Error('当前操作尚未完成，请稍后再试。') }
    setBusy(action)
    setError('')
    setNotice('')
    const epoch = epochRef.current
    operationLock.current = true
    try {
      if (conflictRef.current) throw new Error('画布存在版本冲突。请先重新加载，再进行内容操作。')
      await saveLayout(false, true)
      const value = await operation(epoch)
      return { ok: true, value }
    } catch (cause) {
      if (mounted.current && epoch === epochRef.current) setError(messageOf(cause))
      return { ok: false, error: cause }
    } finally {
      if (mounted.current && epoch === epochRef.current) {
        operationLock.current = false
        setBusy('')
      }
    }
  }

  async function addMaterial(values, position) {
    if (!position) {
      const anchor = nodesRef.current.find(node => isObject(node) && node.selected)
      const point = anchor ? absolutePosition(anchor, nodesRef.current) : viewCenter()
      position = anchor ? { x: point.x + nodeSize(anchor).width + 60, y: point.y } : { x: point.x - CARD_WIDTH / 2, y: point.y - CARD_HEIGHT / 2 }
    }
    const data = { requirementId: requirement.id, title: values.title.trim(), content: values.content, sourcePath: values.sourcePath.trim(), ...(position ? { position } : {}) }
    if (!data.title || (!data.content.trim() && !data.sourcePath)) { setMaterialError('请填写名称，并提供文字内容或工作目录内文件路径。'); return }
    setMaterialError('')
    await perform('material', async epoch => {
      try {
        const result = await request('add-material', { ...data, operationId: stableOperation(materialAttempt, data) })
        if (!mounted.current || epoch !== epochRef.current) return
        materialAttempt.current = null
        setMaterialDialog(null)
        await onChanged?.()
        await loadBoard({ selectIds: [`material:${result.material.id}`] })
        onFilesChanged?.()
        setTab('inspect')
        setSidebar(true)
        setNotice('素材已保存到当前工作目录。')
      } catch (cause) { setMaterialError(messageOf(cause)); throw cause }
    })
  }

  function saveOutline() {
    if (!outline.trim()) return
    const sourceCardId = selectedSourceId
    const data = { requirementId: requirement.id, markdown: outline, sourceCardIds: selectedNodes.map(node => node.data.sourceId || node.id),
      ...(selectedCard?.kind === 'outline' ? { baseVersionId: selectedCard.refId } : {}) }
    void perform('outline', async epoch => {
      const version = await request('save-outline', { ...data, operationId: stableOperation(outlineAttempt, data) })
      if (!mounted.current || epoch !== epochRef.current) return
      outlineAttempt.current = null
      if (draftsRef.current.get(sourceCardId) === data.markdown) draftsRef.current.delete(sourceCardId)
      await onChanged?.()
      await loadBoard({ selectIds: [`outline:${version.id}`] })
      setNotice(`大纲 v${version.number} 已保存为新版本。`)
    })
  }

  function exportWord() {
    const versionId = ['outline', 'word'].includes(selectedCard?.kind) ? selectedCard.refId : null
    if (!versionId || outlineDirty) return
    void perform('word', async epoch => {
      const version = await request('export-word', { versionId })
      if (!mounted.current || epoch !== epochRef.current) return
      await onChanged?.()
      await loadBoard({ selectIds: [`${deskVisible ? 'outline' : 'word'}:${version.id}`] })
      if (!deskVisible) openPanel('inspect')
      setNotice(`Word 已导出，对应大纲 v${version.number}。`)
    })
  }

  function sendToAI() {
    const context = creationRef.current
    if (!context?.instruction.trim() || (!context.generation && !context.references.length) || context.references.length > 24) return
    if (context.pendingTaskId && !pendingRetryAllowed(context.pendingGeneration)) return
    const submittedIntent = ++creationIntent.current
    if (!cache.current.attempts.has(context.key)) cache.current.attempts.set(context.key, { current: null })
    const attempt = cache.current.attempts.get(context.key)
    void perform('ai', async epoch => {
      const outputType = ['outline', 'exercise', 'script'].includes(context.outputType) ? 'text' : context.outputType
      const target=nodesRef.current.find(node=>node.id===context.composerNodeId);
      const data = { ...creationTaskInput({ ...context, outputType,...(target?{outputPosition:absolutePosition(target,nodesRef.current)}:{}) }), ...(modelSelectionRef.current ? { modelSelection: { ...modelSelectionRef.current } } : {}) }
      const created = context.pendingTaskId
        ? await request('prepare-task', { taskId: context.pendingTaskId })
        : await request('create-task', { ...data, operationId: stableOperation(attempt, data) })
      if (!mounted.current || epoch !== epochRef.current) return
      trackOutput(created.task, context, submittedIntent)
      updateCreation(context.key, { taskId: created.task.id, pendingTaskId: created.task.id,
        ...(created.task.input?.pptEngine ? { pptEngine: created.task.input.pptEngine } : {}),
        pendingGeneration: { taskId: created.task.id, outputType, status: created.task.dispatchStatus || created.task.status, phase: 'draft', sessionId: created.task.sessionId },
        modelSelection: created.task.input?.modelSelection || null, sessionId: created.task.sessionId || null, error: '' })
      cache.current.reservations.set(created.task.id, context.outputPosition)
      try {
        if (!await loadBoard({ preserveViewport: true })) throw new Error('任务已保存，画布暂未加载；请重新加载后打开任务。')
        if (!mounted.current || epoch !== epochRef.current) return
        if (!pendingRetryAllowed(created.task)) {
          openPanel('tasks')
          throw new Error('这项任务已提交或发送结果待核对，请先查看任务与任务对话。')
        }
        if (!onStart) {
          await request('set-task-dispatch', { taskId: created.task.id, status: 'failed', error: '任务对话暂时无法连接。请重新打开工作台后查看任务状态。' })
          throw new Error('任务对话暂时无法连接。请重新打开工作台后查看任务状态。')
        }
        const started = await onStart({ ...created.prepared, ...(created.task.sessionId ? { sessionId: created.task.sessionId } : {}) })
        if (mounted.current && epoch === epochRef.current) {
          attempt.current = null
          const anchor = nodesRef.current.find(node => node.id === (context.anchor.nodeId || context.anchor.id))
          const occupied = [...nodesRef.current.filter(isObject).map(node => ({ position: absolutePosition(node, nodesRef.current), ...nodeSize(node) })), ...[...cache.current.reservations.values()].map(position => ({ position }))]
          const nextPosition = anchor ? adjacentCreationPosition({ position: absolutePosition(anchor, nodesRef.current), ...nodeSize(anchor) }, occupied) : context.outputPosition
          updateCreation(context.key, { error: '', taskId: created.task.id, sessionId: started?.sessionId || created.task.sessionId, outputPosition: context.intent === 'revise' || context.composerNodeId ? context.outputPosition : nextPosition })
          setNotice('任务已提交，卡片会显示生成进度。')
        }
      } finally {
        await refreshTasks().catch(cause => { if (mounted.current) setNotice(`任务列表暂未更新：${messageOf(cause)}`) })
        mediaBoardRefresh.current = true
      }
    }).then(outcome => { if (!outcome.ok) updateCreation(context.key, { error: messageOf(outcome.error), ...(outcome.error.sessionId ? { sessionId: outcome.error.sessionId } : {}) }) })
  }

  function nextMediaPosition(context) {
    if (context.intent === 'revise') return context.outputPosition
    const anchor = nodesRef.current.find(node => node.id === (context.anchor.nodeId || context.anchor.id))
    const occupied = [...nodesRef.current.filter(isObject).map(node => ({ position: absolutePosition(node, nodesRef.current), ...nodeSize(node) })),
      ...[...cache.current.reservations.values()].map(position => ({ position }))]
    const origin = anchor ? { position: absolutePosition(anchor, nodesRef.current), ...nodeSize(anchor) }
      : { position: { x: context.outputPosition.x - CARD_WIDTH - 80, y: context.outputPosition.y } }
    return adjacentCreationPosition(origin, occupied)
  }

  function newMediaTask() {
    const context = creationRef.current
    if (!['image', 'video'].includes(context?.outputType) || !mediaNeedsDecision(context.mediaJob)) return
    const blank=context.references.length===0
    const anchor = blank ? {id:`canvas:${requirement.id}`,kind:'canvas',title:'新建内容'} : usableCreationSource(context.anchor) ? context.anchor : context.references.find(usableCreationSource)
    if (!anchor) { setError('原任务没有可用的来源卡，请从可用卡片或空白画布重新发起创作；原任务记录仍保留。'); return }
    if(context.generation?.mode==='new'&&context.generation.cardId){void beginComposition(anchor,context.outputType,{blank,seed:context});return}
    const intent = context.generation?.mode === 'revise' ? 'revise' : 'new'
    cache.current.attempts.delete(context.key)
    mediaRestores.current.delete(context.key)
    updateCreation(context.key, { taskId: null, pendingTaskId: null, pendingGeneration: null, intent, anchor, ...(intent === 'new' ? { targetCard: undefined } : {}), mediaJob: null, mediaRestoring: false, mediaRecoveryError: false,
      dismissedMediaTaskIds: [...new Set([...(context.dismissedMediaTaskIds || []), context.mediaJob.taskId])],
      outputPosition: nextMediaPosition({ ...context, intent }), error: '', mediaPollError: '' })
    setNotice('新草稿已准备好。原任务记录保留，点击生成才会提交新任务。')
  }

  function generateMedia() {
    const context = creationRef.current
    if (!['image', 'video'].includes(context?.outputType) || context.pendingTaskId || !context.instruction.trim() || context.mediaRestoring || context.mediaRecoveryError || mediaJobPending(context.mediaJob) || mediaNeedsDecision(context.mediaJob)) return
    if (!cache.current.attempts.has(context.key)) cache.current.attempts.set(context.key, { current: null })
    const attempt = cache.current.attempts.get(context.key)
    const options = mediaOptionsFor(context.outputType, mediaCapabilities, context.mediaOptions)
    const target=nodesRef.current.find(node=>node.id===context.composerNodeId)
    const { selectedSkills: _skills, ...input } = creationTaskInput({...context,...(target?{outputPosition:absolutePosition(target,nodesRef.current)}:{})})
    const data = { ...input, media: options }
    const submittedIntent = ++creationIntent.current
    void perform('media', async epoch => {
      const result = await request('generate-media', { ...data, operationId: stableOperation(attempt, data) })
      if (!mounted.current || epoch !== epochRef.current) return
      trackOutput(result.task, { ...context, mediaOptions: options }, submittedIntent)
      rememberMediaTask(result)
      cache.current.reservations.set(result.task.id, { ...context.outputPosition })
      updateCreation(context.key, current => ({ ...current, taskId: result.task.id, pendingTaskId: result.task.id, mediaJob: result.job, mediaOptions: options,
        outputPosition: nextMediaPosition(current), error: '', mediaPollError: '' }))
      attempt.current = null
      if (mounted.current) { await loadBoard({ preserveViewport: true }); setNotice('生成任务已保存，画布卡片将持续显示生成状态。'); await refreshTasks() }
    }).then(outcome => { if (!outcome.ok) updateCreation(context.key, { error: messageOf(outcome.error) }) })
  }

  async function resumeMediaTask(taskId, contextKey) {
    const epoch = epochRef.current
    const result = await request('resume-media', { taskId })
    if (!mounted.current || epoch !== epochRef.current) return result
    rememberMediaTask(result)
    const frames = [...cache.current.drafts].filter(([key, frame]) => (!contextKey || key === contextKey)
      && frame.projectId === projectId && frame.requirementId === requirement.id && frame.mediaJob?.taskId === taskId)
    for (const [key] of frames) updateCreation(key, { mediaJob: result.job, error: '', mediaPollError: '' })
    mediaBoardRefresh.current = true
    await refreshTasks()
    return result
  }

  function referenceOperation(key) {
    if (!cache.current.referenceOperations.has(key)) cache.current.referenceOperations.set(key, crypto.randomUUID())
    return cache.current.referenceOperations.get(key)
  }

  function referenceResultCard(result) {
    const card = result?.board?.nodes?.find(item => item.id === `material:${result.material?.id}`)
    if (!usableCreationSource(card)) throw new Error('素材已返回，但没有可用的引用卡片，请刷新白板后核对。')
    return card
  }

  function nextReferencePosition(context, board) {
    const anchor = board?.nodes?.find(card => card.id === (context.anchor.nodeId || context.anchor.id))
    return anchor ? adjacentCreationPosition(anchor, board.nodes) : context.outputPosition
  }

  const searchCreationFiles = useCallback(async (query, signal) => {
    const response = await fetch(apiEndpoint({ projectReferenceSearch: query }, projectId), { credentials: 'same-origin', signal })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || '项目文件读取失败')
    return result
  }, [projectId])

  async function referenceCreationFile(path) {
    const context = creationRef.current
    if (!context || context.pendingTaskId) throw new Error('当前创作不能更换引用。')
    if (context.references.length >= 24) throw new Error('一次创作最多引用 24 份资料，请先移除部分引用。')
    const outcome = await perform('reference', async () => {
      const occupied = nodesRef.current.filter(isObject).map(node => ({
        id: node.id, position: absolutePosition(node, nodesRef.current), ...nodeSize(node),
      }))
      const anchor = occupied.find(node => node.id === (context.composerNodeId || context.anchor.nodeId || context.anchor.id))
        || { position: context.outputPosition }
      const position = adjacentCreationPosition(anchor, occupied)
      const result = await request('project-file-reference', { requirementId: context.requirementId, path,
        useCurrentFile: true, position, operationId: crypto.randomUUID() })
      const card = referenceResultCard(result)
      updateCreation(context.key, current => ({ ...updateCreationReferences(current, [...current.references, card]),
        referencesEdited: true, error: '' }))
      await cache.current.onMaterialsChanged?.()
      onFilesChanged?.()
    })
    if (!outcome.ok) throw outcome.error
  }

  async function changeCreationReferences(cards) {
    const context = creationRef.current
    if (!context) return
    if (context.pendingTaskId) throw new Error('任务已提交，本次引用不能更换。请打开任务对话补充要求。')
    const unique = [...new Map(cards.map(card => [card.id, card])).values()]
    if (new Set([...(context.intent === 'revise' || context.blank ? [] : [context.anchor.id]), ...unique.map(card => creationSource(card).id)]).size > 24) throw new Error('一次创作最多引用 24 份资料，请先移除部分引用。')
    if (!unique.some(card => card.kind === 'whiteboard')) {
      updateCreation(context.key, current => ({ ...updateCreationReferences(current, unique), referencesEdited: true, error: '' }))
      return
    }
    const outcome = await perform('reference', async () => {
      const references = []
      let changed = false
      try {
        for (const card of unique) {
          if (card.kind !== 'whiteboard') { references.push(card); continue }
          const content = String(card.content ?? '')
          if (!content.trim()) throw new Error('空白元素没有可引用的文字。')
          const digest = await referenceHash(new TextEncoder().encode(content))
          const frame = cache.current.drafts.get(context.key) || context
          const result = await request('snapshot-whiteboard', { requirementId: context.requirementId,
            elementId: card.id, expectedContent: content, operationId: referenceOperation(`${context.key}:whiteboard:${card.id}:${digest}`), position: frame.outputPosition })
          const snapshot = referenceResultCard(result)
          references.push(snapshot)
          changed = true
          updateCreation(context.key, current => ({ ...updateCreationReferences(current, [...current.references, snapshot]),
            outputPosition: nextReferencePosition(current, result.board), referencesEdited: true, error: '' }))
        }
        updateCreation(context.key, current => ({ ...updateCreationReferences(current, references), referencesEdited: true, error: '' }))
      } finally { if (changed) { await cache.current.onMaterialsChanged?.(); onFilesChanged?.() } }
    })
    if (!outcome.ok) { updateCreation(context.key, { error: messageOf(outcome.error) }); throw outcome.error }
  }

  async function importCreationFiles(files, { mediaType } = {}) {
    const context = creationRef.current
    if (!context || !files?.length) return
    if (context.pendingTaskId) throw new Error('任务已提交，本次引用不能更换。请打开任务对话补充要求。')
    if (files.length > 24 - context.references.length) throw new Error(`本次还可添加 ${24 - context.references.length} 份引用，请减少文件数量。`)
    const outcome = await perform('import-reference', async () => {
      const failures = []
      let added = 0
      try {
        for (const file of files) {
          try {
            if (mediaType && !(mediaType === 'image' ? /\.(png|jpe?g|webp|gif)$/i : /\.(mp4|webm)$/i).test(file.name)) throw new Error(`此入口只接受${mediaType === 'image' ? '图片' : 'MP4／WebM 视频'}文件。`)
            if (!REFERENCE_FILE_TYPES.test(file.name)) throw new Error('暂不支持该格式，请选择文本、PDF、DOCX、PPTX 或常见图片。')
            if (!file.size || file.size > REFERENCE_FILE_LIMIT) throw new Error('必须为非空文件，且不能超过 20 MB。')
            const digest = await referenceHash(await file.arrayBuffer())
            const operationId = referenceOperation(`${context.key}:file:${mediaType || 'reference'}:${file.name}:${digest}`)
            const frame = cache.current.drafts.get(context.key) || context
            const url = endpoint({ importMaterial: context.requirementId, operationId, filename: file.name,
              ...(mediaType && !context.blank ? { associate: JSON.stringify({ cardId: context.anchor.id, hash: context.anchor.sourceHash }) } : {}),
              x: frame.outputPosition.x, y: frame.outputPosition.y })
            const response = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: file })
            const result = await response.json().catch(() => null)
            if (!response.ok || result?.ok === false || !result?.material) throw new Error(result?.error?.message || result?.error || `素材导入失败（${response.status}）`)
            const card = referenceResultCard(result)
            updateCreation(context.key, current => ({ ...updateCreationReferences(current, [...current.references, card]),
              outputPosition: nextReferencePosition(current, result.board), referencesEdited: true, error: '' }))
            added += 1
          } catch (cause) { failures.push(`「${file.name}」：${messageOf(cause)}`) }
        }
      } finally { if (added) await cache.current.onMaterialsChanged?.() }
      return { added, failures }
    })
    if (!outcome.ok) { updateCreation(context.key, { error: messageOf(outcome.error) }); throw outcome.error }
    if (outcome.value.failures.length) {
      const error = new Error(`${outcome.value.added ? `已保留 ${outcome.value.added} 份成功素材。` : ''}${outcome.value.failures.join('；')}`)
      updateCreation(context.key, { error: error.message })
      throw error
    }
    if (mounted.current) setNotice(`已将 ${outcome.value.added} 份电脑素材加入「${context.anchor.title}」的引用，并复制到当前项目。`)
  }

  function creationAction(action) {
    const context = creationRef.current
    const selectionIntent = creationIntent.current
    if (!context) return
    if (action === 'whole-source') {
      openCreation(context.anchor, context.outputType)
      if (creationRef.current && !creationRef.current.instruction.trim()) updateCreation(creationRef.current.key, { instruction: context.instruction })
      return
    }
    if (action === 'edit') { selectCard(context.anchor.nodeId || context.anchor.id); closeCreation(); setFocusOpen(true); setSidebar(false); return }
    if (action === 'word') {
      const versionId = context.anchor.refId
      if (!['outline', 'word'].includes(context.anchor.kind) || !versionId) return
      void perform('word', async epoch => {
        const version = await request('export-word', { versionId })
        if (!mounted.current || epoch !== epochRef.current) return
        await onChanged?.()
        await loadBoard({ selectIds: [`word:${version.id}`], preserveViewport: true, selectionIntent })
        updateCreation(context.key, { error: '' })
        setNotice(`Word 已导出，对应锁定的大纲 v${version.number}。`)
      }).then(outcome => { if (!outcome.ok) updateCreation(context.key, { error: messageOf(outcome.error) }) })
      return
    }
    if (action === 'material') {
      if (!context.materialTitle?.trim() || !context.materialContent?.trim()) return
      const key = `${context.key}:material`
      if (!cache.current.attempts.has(key)) cache.current.attempts.set(key, { current: null })
      const attempt = cache.current.attempts.get(key)
      const data = { requirementId: context.requirementId, title: context.materialTitle.trim(), content: context.materialContent,
        sourceRefs: context.references.map(card => ({ cardId: card.id, hash: card.sourceHash })), position: context.outputPosition }
      void perform('material', async epoch => {
        const result = await request('add-material', { ...data, operationId: stableOperation(attempt, data) })
        if (!mounted.current || epoch !== epochRef.current) return
        attempt.current = null
        await loadBoard({ selectIds: [`material:${result.material.id}`], preserveViewport: true, selectionIntent })
        onFilesChanged?.()
        const anchor = nodesRef.current.find(node => node.id === (context.anchor.nodeId || context.anchor.id))
        const nextPosition = anchor ? adjacentCreationPosition({ position: absolutePosition(anchor, nodesRef.current), ...nodeSize(anchor) }, nodesRef.current.filter(isObject).map(node => ({ position: absolutePosition(node, nodesRef.current), ...nodeSize(node) }))) : context.outputPosition
        updateCreation(context.key, current => ({ ...current, materialContent: current.materialContent === context.materialContent ? '' : current.materialContent, outputPosition: nextPosition, error: '' }))
        setNotice(`「${context.anchor.title}」关联素材已保存，来源和正文分别保留。`)
      }).then(outcome => { if (!outcome.ok) updateCreation(context.key, { error: messageOf(outcome.error) }) })
    }
  }

  async function addExcerpt(values, preserveViewport = false) {
    const selectionIntent = creationIntent.current
    setExcerptError('')
    const outcome = await perform('excerpt', async epoch => {
      const anchor = nodesRef.current.find(node => node.id === values.sourceCardId || node.data.sourceId === values.sourceCardId)
      const point = anchor ? absolutePosition(anchor, nodesRef.current) : viewCenter()
      const data = { ...values, requirementId: requirement.id,
        position: { x: point.x + CARD_WIDTH + 60, y: point.y + CARD_HEIGHT + 30 } }
      try {
        const result = await request('add-excerpt', { ...data, operationId: stableOperation(excerptAttempt, data) })
        if (!mounted.current || epoch !== epochRef.current) return
        excerptAttempt.current = null
        await loadBoard({ selectIds: [`material:${result.material.id}`], preserveViewport: preserveViewport || selectionIntent !== creationIntent.current, selectionIntent })
        onFilesChanged?.()
        if (selectionIntent === creationIntent.current) openPanel('inspect')
        setNotice(`摘录「${values.title}」与讲师注释已保存，原始资料保持独立。`)
      } catch (cause) { setExcerptError(messageOf(cause)); throw cause }
    })
    if (!outcome.ok) throw outcome.error
  }

  const handledFileAdd=useRef(null)
  useEffect(()=>{
    if (!projectFileSelection) return
    if (!projectFileSelection.fromConversation) closeCreation()
    setSidebar(false)
    setDeckPreview(null)
    setOutcomeView(null)
    setDocumentView(null)
    setFocusOpen(false)
    setAssetsOpen(false)
  },[projectFileSelection?.token])
  useEffect(()=>{
    if(!active||!board||!fileAddRequest||fileAddRequest.projectId!==projectId||fileAddRequest.requirementId!==requirement.id||handledFileAdd.current===fileAddRequest.token)return
    handledFileAdd.current=fileAddRequest.token
    void addProjectReference(fileAddRequest,viewCenter())
  },[active,Boolean(board),fileAddRequest?.token])
  async function addProjectReference(entry,position){
    if(entry.projectId!==projectId) {setError('请在同一个项目内拖入文件。');return}
    if(busy||operationLock.current){setError('当前操作尚未结束，请稍后再添加文件。');return}
    const epoch=epochRef.current
    setBusy('file-reference');setError('')
    try{
      let hash=entry.hash
      if(!hash){const response=await fetch(endpoint({projectFilePreview:entry.path}),{credentials:'same-origin'}),data=await response.json();if(!response.ok)throw new Error(data.error||'文件读取失败');hash=data.hash}
      const result=await request('project-file-reference',{requirementId:requirement.id,path:entry.path,hash,position,operationId:crypto.randomUUID()})
      if(!mounted.current||epoch!==epochRef.current)return
      await loadBoard({selectIds:[`material:${result.material.id}`],preserveViewport:true})
      onFilesChanged?.()
      onCloseProjectFile?.()
    }catch(cause){if(mounted.current&&epoch===epochRef.current)setError(messageOf(cause))}finally{if(mounted.current&&epoch===epochRef.current)setBusy('')}
  }
  function clickPane(event) {
    setContextMenu(null)
    setCreationMenu(null)
    if (tool === 'select' || tool === 'hand' || event.detail > 1 || busy || loading) return
    const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const epoch = epochRef.current
    cancelPaneInsert()
    // Wait for the double-click before committing a one-shot drawing tool.
    paneInsertTimer.current = setTimeout(() => {
      paneInsertTimer.current = null
      if (mounted.current && activeRef.current && epoch === epochRef.current) addElement(tool, point)
    }, 500)
  }

  function blankMenu(event){
    if(!event.target.matches?.('.react-flow__pane')||busy||loading||operationLock.current)return
    cancelPaneInsert()
    if (tool !== 'select' && tool !== 'hand') setTool('select')
    event.preventDefault();cancelCardOpen();closeCreation();setContextMenu(null)
    const rect=graphRef.current.getBoundingClientRect(),size=canvasSizeRef.current
    setCreationMenu({blank:true,point:flow.screenToFlowPosition({x:event.clientX,y:event.clientY}),position:{x:Math.max(8,Math.min(size.width-272,event.clientX-rect.left)),y:Math.max(8,Math.min(size.height-340,event.clientY-rect.top))}})
  }
  function chooseNewType(type){
    const menu=creationMenu
    if(!menu)return
    if(!menu.blank){openCreation(menu.anchor,type,undefined,{explicitNew:true});return}
    const anchor={id:`canvas:${requirement.id}`,kind:'canvas',title:'新建内容',position:menu.point}
    openCreation(anchor,type,undefined,{explicitNew:true,blank:true,outputPosition:menu.point})
  }
  async function dropFiles(event) {
    const projectPayload=event.dataTransfer.getData(PROJECT_FILE_DRAG)
    if(projectPayload){event.preventDefault();setDraggingFile(false);try{const entry=JSON.parse(projectPayload);await addProjectReference(entry,flow.screenToFlowPosition({x:event.clientX,y:event.clientY}))}catch(cause){setError(messageOf(cause))}return}

    if (!event.dataTransfer.files.length) return
    event.preventDefault()
    setDraggingFile(false)
    if (busy) { setError('当前操作正在进行，请完成后再拖入素材。'); return }
    const files = [...event.dataTransfer.files]
    if (files.length !== 1) { setError('请每次拖入一份文本素材。'); return }
    const file = files[0]
    if (!/\.(md|txt)$/i.test(file.name)) { setError('当前拖入支持 .md、.txt；其他格式请通过“添加素材”关联工作目录内文件。'); return }
    if (file.size > 1024 * 1024) { setError('文本文件超过 1 MB。请通过“添加素材”关联工作目录内文件。'); return }
    try {
      const content = await file.text()
      if (!content.trim()) throw new Error('文本文件为空，未添加素材。')
      const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
      await addMaterial({ title: file.name.replace(/\.(md|txt)$/i, ''), content, sourcePath: '' }, position)
    } catch (cause) { setError(messageOf(cause)) }
  }

  function selectAllCards() {
    replaceNodes(nodesRef.current.map(node => ({ ...node, selected: isObject(node) })))
    setSelectionKey(nodesRef.current.filter(isObject).map(node => node.id).sort().join('|'))
  }

  function selectCard(id) {
    replaceNodes(nodesRef.current.map(node => ({ ...node, selected: node.id === id })))
    setSelectionKey(id || '')
  }

  function deleteSelectedEdges() {
    const before = layoutSnapshot()
    const selected = new Set(edgeSelection)
    replaceEdges(edgesRef.current.filter(edge => edge.provenance || !selected.has(edge.id)))
    setEdgeSelection([])
    remember(before)
    void saveLayout()
  }

  function promoteWhiteboard() {
    const chosen = nodesRef.current.filter(node => isObject(node) && node.selected)
    if (chosen.length !== 1 || chosen[0].type !== 'whiteboard' || !chosen[0].data.text.trim()) return
    const node = chosen[0], position = absolutePosition(node, nodesRef.current)
    void addMaterial({ title: node.data.text.trim().split('\n')[0].slice(0, 80), content: node.data.text, sourcePath: '' }, { x: position.x + nodeSize(node).width + 60, y: position.y })
  }

  function showContext(event, node) {
    cancelCardOpen()
    event.preventDefault()
    if (node && !node.selected) selectCard(node.id)
    if (!node) selectCard(null)
    const rect = graphRef.current.getBoundingClientRect()
    setContextMenu({ x: Math.min(event.clientX - rect.left, Math.max(12, rect.width - 240)), y: Math.min(event.clientY - rect.top, Math.max(80, rect.height - 320)),
      point: flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }), target: node?.id })
  }

  function keyboard(event) {
    if (deskVisible) return
    if (event.target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"],[role="separator"]') || event.nativeEvent?.isComposing) return
    cancelPaneInsert()
    const key = event.key.toLowerCase(), command = event.metaKey || event.ctrlKey
    if (key === 'escape') { setTool('select'); setContextMenu(null); selectCard(null); return }
    if (command && key === 'a') { event.preventDefault(); selectAllCards(); return }
    if (command && key === 'z') { event.preventDefault(); undo(event.shiftKey); return }
    if (command && key === 'y') { event.preventDefault(); undo(true); return }
    if (operationLock.current || conflictRef.current) return
    if (command && key === 'd') { event.preventDefault(); duplicateElements(); return }
    if (command && key === 'g') { event.preventDefault(); if (event.shiftKey) ungroup(); else if (selectedNodes.length >= 2) setGroupDialog(true); return }
    if (key === 'delete' || key === 'backspace') { event.preventDefault(); if (edgeSelection.length) deleteSelectedEdges(); else removeElements(); return }
    if (command) return
    const tools = { v: 'select', h: 'hand', t: 'text', n: 'note', r: 'rectangle', o: 'ellipse' }
    if (tools[key]) { event.preventDefault(); setTool(tools[key]); setContextMenu(null) }
    if (key === '+' || key === '=') { event.preventDefault(); void flow.zoomIn({ duration: 100 }) }
    if (key === '-') { event.preventDefault(); void flow.zoomOut({ duration: 100 }) }
    if (key === '0') { event.preventDefault(); zoom100() }
    if (key === '1') { event.preventDefault(); void flow.fitView({ padding: 0.16, maxZoom: 1, duration: 180 }) }
    if (key === '2') { event.preventDefault(); fitSelection() }
  }

  const bounds = selectedNodes.map(node => ({ position: absolutePosition(node, nodes), size: nodeSize(node) }))
  const rect = graphRef.current?.getBoundingClientRect()
  const overlay = bounds.length && rect ? {
    x: Math.max(170, Math.min(rect.width - 170, (Math.min(...bounds.map(node => node.position.x)) + Math.max(...bounds.map(node => node.position.x + node.size.width))) / 2 * zoom + viewportRef.current.x)),
    y: Math.max(68, Math.min(rect.height - 12, Math.min(...bounds.map(node => node.position.y)) * zoom + viewportRef.current.y < 130
      ? Math.max(...bounds.map(node => node.position.y + node.size.height)) * zoom + viewportRef.current.y + 54
      : Math.min(...bounds.map(node => node.position.y)) * zoom + viewportRef.current.y - 12)),
  } : null
  const contextItems = contextMenu?.target ? [
    { label: '查看内容', onClick: () => openPanel('inspect') }, { label: '交给 AI', onClick: () => openPanel('ai') },
    ...(selectedNodes.length === 1 && onlyWhiteboard ? [{ label: '保存为素材', onClick: promoteWhiteboard, disabled: !selectedCard.text.trim() }] : []),
    { label: '复制白板元素', onClick: duplicateElements, disabled: !onlyWhiteboard, shortcut: '⌘D' },
    { label: '编组', onClick: () => setGroupDialog(true), disabled: selectedNodes.length < 2, shortcut: '⌘G' },
    { label: '解除分组', onClick: ungroup, disabled: !hasSelectedGroup },
    { label: '删除节点', onClick: removeElements, disabled: !selectedNodes.length, shortcut: 'Delete' },
  ] : [
    ...[['note', '便签', 'N'], ['text', '文本', 'T'], ['rectangle', '矩形', 'R'], ['ellipse', '椭圆', 'O']].map(([kind, label, shortcut]) => ({ label: `添加${label}`, onClick: () => addElement(kind, contextMenu.point), shortcut })),
    { label: '撤销', onClick: () => undo(), disabled: !historyRef.current.canUndo, shortcut: '⌘Z' },
    { label: '全选', onClick: selectAllCards, shortcut: '⌘A' },
    { label: '适应全部', onClick: () => void flow.fitView({ padding: 0.16, maxZoom: 1, duration: 180 }) },
  ]

  return <div ref={rootRef} tabIndex={-1} onKeyDown={keyboard} onPointerDownCapture={cancelPaneInsert} onMouseDownCapture={event => {
    if (!event.target.closest('input,textarea,button,select,summary,[contenteditable="true"],[role="textbox"],[role="separator"]')) rootRef.current?.focus({ preventScroll: true })
  }} data-editor-fullscreen={dockOpen&&editorFullscreen||undefined} data-dock-open={dockOpen || undefined} data-dock-mobile={dock.mobile || undefined} data-dock-resizing={dock.dragging || undefined} style={{ '--wtt-dock-width': `${dock.width}px` }} className={`wtt-course-canvas wcc-studio${sidebar ? '' : ' is-sidebar-collapsed'}${deskVisible ? ' is-focus-open' : ''} is-tool-${tool}`}>
    {deletePlan&&<DeleteNodesDialog plan={deletePlan} request={request} onClose={()=>setDeletePlan(null)} onDone={recycledChanged}/>}
    {materialVersionView && <dialog className="wcc-version-view-dialog" open aria-labelledby="wcc-version-view-title">
      <DialogHeader title={`${materialVersionView.title} · V${materialVersionView.number}`} titleId="wcc-version-view-title" onClose={() => setMaterialVersionView(null)} />
      <DialogBody><pre className="wcc-version-view-body">{materialVersionView.content}</pre></DialogBody>
      <DialogFooter><span className="wcc-version-view-meta">{materialVersionView.origin === 'card-edit' ? '卡内编辑版本' : '导入基线'} · {new Date(materialVersionView.createdAt).toLocaleString()}</span><UiButton variant="quiet" type="button" onClick={() => setMaterialVersionView(null)}>关闭</UiButton></DialogFooter>
    </dialog>}
    {recycleOpen&&<ProjectRecycleDialog request={request} endpoint={endpoint} onClose={()=>{setRecycleOpen(false);onCloseRecycle?.()}} onChanged={recycledChanged}/>}
    {(error || notice) && <div className={`wcc-message${error ? ' is-error' : ''}`} role={error ? 'alert' : 'status'}>{error ? <UserError error={error} announce={false} /> : <span>{notice}</span>}<UiButton variant="ghost" size="compact" onClick={() => { setError(''); setNotice('') }} aria-label="关闭提示">×</UiButton></div>}
    <div className="wcc-workspace">
      <div ref={graphRef} className={`wcc-graph${draggingFile ? ' is-file-dragging' : ''}`} inert={(dock.mobile||editorFullscreen)&&dockOpen} aria-hidden={(dock.mobile||editorFullscreen)&&dockOpen||undefined} aria-busy={!!busy} onDragOver={event => {
        if ([...event.dataTransfer.types].some(type=>type==='Files'||type===PROJECT_FILE_DRAG)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDraggingFile(true) }
      }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDraggingFile(false) }} onDrop={dropFiles} onDoubleClick={blankMenu}>
        {loading && <div className="wcc-loading" role="status">正在读取画布…</div>}
        {loadError && <div className="wcc-load-error" role="alert"><strong>画布未能加载</strong><UserError error={loadError} announce={false} /><UiButton variant="quiet" onClick={() => void loadBoard({ initial: !board })}>重新加载</UiButton></div>}
        {board && !loading && !loadError && <ReactFlow id={`wtt-flow-${panelId.replace(/:/g, '')}`}
          key={requirement.id}
          nodes={nodes} edges={edges.map(edge => ({ ...edge, style: { ...edge.style, opacity: allRelations || !selectedNodes.length || selectedNodes.some(node => node.id === edge.source || node.id === edge.target) ? 1 : .12 } }))} nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          onSelectionChange={selectionChanged} onConnect={connect}
          connectionLineType={ConnectionLineType.Bezier}
          onNodeDragStart={beginNodeDrag} onSelectionDragStart={beginNodeDrag}
          onNodeDragStop={finishNodeDrag}
          onSelectionDragStop={finishNodeDrag}
          onMove={(_, viewport) => { if (active) { cancelPaneInsert(); viewportRef.current = viewport; setZoom(viewport.zoom); if (creationMenu) setCreationMenu(null) } }}
          onMoveEnd={(_, viewport) => { if (active) { viewportRef.current = viewport; setZoom(viewport.zoom); if (!restoringViewport.current && !gestureViewportActive.current) void saveLayout() } }}
          defaultViewport={board.viewport || { x: 0, y: 0, zoom: 1 }}
          minZoom={0.1} maxZoom={3} selectionMode={SelectionMode.Partial} nodeDragThreshold={5} nodeClickDistance={5}
          multiSelectionKeyCode={['Meta', 'Control', 'Shift']} selectionKeyCode="Shift"
          selectionOnDrag={tool === 'select' && !busy}
          // The gesture adapter owns wheel/pinch over both the pane and nodes.
          panActivationKeyCode="Space" panOnScroll={false} zoomOnScroll={false} zoomOnPinch={false} zoomActivationKeyCode={null}
          panOnDrag={tool === 'hand' ? true : [1]} zoomOnDoubleClick={false}
          nodesDraggable={!busy && tool === 'select'} nodesConnectable={!busy && tool === 'select'} elementsSelectable={!busy && tool === 'select'} disableKeyboardA11y={!!busy}
          deleteKeyCode={null}
          onPaneClick={clickPane}
          onNodeClick={openClickedCard}
          onNodeDoubleClick={(_event, node) => { cancelCardOpen(); if (node.type === 'content') {
            selectCard(node.id)
            const nodeCaps = cardCapabilities(node.data)
            if (node.data.outputCard && (nodeCaps.editableText.base === null || ['pptx','document'].includes(nodeCaps.format))) void openOutputCard(node.data, node.data.outputCard.versionId)
            else if (node.data.refId && nodeCaps.editableText.base === null) openOutcomes(node.data)
            else openPanel('inspect')
          } }}
          onPaneContextMenu={event => showContext(event)} onNodeContextMenu={showContext}
          onSelectionContextMenu={(event, selection) => showContext(event, selection[0])}
          ariaLabelConfig={{
            'controls.zoomIn.ariaLabel': '放大画布', 'controls.zoomOut.ariaLabel': '缩小画布',
            'controls.fitView.ariaLabel': '适应全部卡片', 'controls.interactive.ariaLabel': '切换画布交互',
            'node.a11yDescription.default': '单击打开AI，双击编辑或查看。拖动移动卡片，按Shift可多选。',
          }}
        >
          <Background gap={24} size={1} color="var(--wtt-ui-grid, #d4d9e3)" />
          {showMap && <MiniMap pannable zoomable position="bottom-right" nodeColor={node => node.type === 'whiteboard' ? 'var(--wtt-ui-warning, #e6ce8d)' : 'var(--wtt-ui-edge, #a6b6d5)'} />}
        </ReactFlow>}
        <CanvasChrome tool={tool} onTool={setTool} zoom={zoom} onZoomIn={() => void flow.zoomIn({ duration: 100 })} onZoomOut={() => void flow.zoomOut({ duration: 100 })}
          onZoom100={zoom100} onFitAll={() => void flow.fitView({ padding: 0.15, maxZoom: 1, duration: 180 })} onFitSelected={fitSelection}
          showMap={showMap} onToggleMap={() => setShowMap(value => !value)} onAddMaterial={() => { setMaterialError(''); setMaterialDialog(EMPTY_MATERIAL) }}
          onUndo={() => undo()} onRedo={() => undo(true)} canUndo={historyRef.current.canUndo} canRedo={historyRef.current.canRedo}
          sidebar={creationVisible ? 'ai' : sidebar ? tab : false} onInspect={() => sidebar && tab === 'inspect' ? setSidebar(false) : openPanel('inspect')}
          onAI={() => { cancelCardOpen(); creationIntent.current += 1; if (creationVisible) closeCreation(); else if (creationRef.current) { cache.current.visible = true; setCreationVisible(true); setSidebar(false) } else openSelectedCreation() }} selectedCount={selectedNodes.length}
          onTasks={() => sidebar && tab === 'tasks' ? setSidebar(false) : openPanel('tasks')} onAssets={() => { setAssetsOpen(true); setSidebar(false); setDeckPreview(null); setOutcomeView(null);setDocumentView(null) }} taskCount={tasks.length} runningCount={tasks.filter(task => task.runtimeState?.phase === 'generating' && !interactions.some(entry => entry.task.id === task.id)).length} pendingCount={interactions.length}
          saveStatus={loading ? '加载中' : draftCount ? 'draft' : saveStatus} onRefresh={refresh} onRetry={saveStatus === 'conflict' ? refresh : () => void saveLayout(true)} busy={!!busy || loading || !board} />
        {interactions.length > 0 && <details className="wcc-skill-inbox"><summary>待你处理 · {interactions.length}</summary><div>{interactions.map(entry => <UiButton variant="custom" type="button" key={entry.key} onClick={() => openSkillReview(entry)}>{entry.interaction.questions?.[0]?.header || entry.interaction.questions?.[0]?.question?.slice(0, 120) || '执行权限待确认'}<small>{entry.task.title}</small></UiButton>)}</div></details>}
        {overlay && !(creationVisible && selectedNodes.length === 1) && !deckPreview && !assetsOpen && !deskVisible && tool === 'select' && !busy && !contextMenu && <SelectionActions {...overlay} selectedCount={selectedNodes.length}
          onInspect={() => openPanel('inspect')} onAI={() => openPanel('ai')} canGroup={selectedNodes.length >= 2} onGroup={() => setGroupDialog(true)}
          canUngroup={hasSelectedGroup} onUngroup={ungroup} onAlign={alignSelection}
          canPromote={onlyWhiteboard && selectedNodes.length === 1 && !!selectedCard?.text?.trim()} onPromote={promoteWhiteboard}
          canDuplicate={onlyWhiteboard} onDuplicate={duplicateElements} canDelete={selectedNodes.length>0} onDelete={removeElements} />}
        {contextMenu && <CanvasContextMenu {...contextMenu} items={contextItems} onClose={() => setContextMenu(null)} />}
        {creationMenu && <NodeCreateMenu caption={creationMenu.blank?'新建卡片':undefined} position={creationMenu.position} items={creationMenuItems(creationMenu.blank?{kind:'canvas'}:creationMenu.anchor).map(item=>creationMenu.blank?{...item,description:undefined}:item)} onAction={chooseNewType} onClose={() => setCreationMenu(null)} />}
        {board && !loading && !loadError && <div className="wcc-canvas-hint">V 选择 · H 手型 · 双指滑动／滚轮平移 · 捏合／＋－缩放 · 空白双击新建 · 卡片双击编辑</div>}
        {draggingFile && <div className="wcc-drop-overlay">松开以添加到画布</div>}
        {projectBar}
    <CanvasSearch width={canvasSize.width} panelOpen={false} hidden={deskVisible || Boolean(deckPreview) || assetsOpen || Boolean(documentView)}
      query={searchQuery} onQuery={setSearchQuery} nodes={nodes} allRelations={allRelations} onRelations={() => setAllRelations(value => !value)}
      onOpen={() => setSidebar(false)} onSelect={node => { selectCard(node.id); void flow.fitView({ nodes: [node], padding: .4, maxZoom: 1, duration: 160 }) }} />
    <CardComposer suspended={draggingCard} visible={creationVisible && !editingTextCard && !deskVisible && !deckPreview && !assetsOpen && !documentView} position={composerPosition} context={creation ? { ...creation,
      pendingGeneration: publishedExecution || nativePendingState(creation.pendingGeneration, effectiveStatuses.get(creation.pendingGeneration?.sessionId || creation.sessionId)) } : creation}
      references={creationReferences} availableReferences={availableReferences}
      creationTypes={creation ? [...creationMenuItems(creation.anchor).map(item => ({ id: item.id, label: item.label, available: !item.disabled, message: item.disabled ? item.reason : item.description })), ...['outline', 'exercise', 'script'].map(id => ({ id, label: '文本', available: true })), ...['word', 'excerpt', 'material'].map(id => ({ id, label: OUTPUT_LABELS[id], available: true }))] : productionTypes}
      skillCatalog={skillCatalog} skillCatalogLoading={skillCatalogLoading} skillCatalogError={skillCatalogError}
      onRefreshSkills={refreshSkillCatalog} onSaveSkillSettings={saveSkillSettings} onUpdateSkillPreference={updateSkillPreference}
      modelCatalog={modelCatalog} modelSelection={creation?.pendingTaskId ? creation.modelSelection : modelSelection}
      onModelChange={onModelChange} onRefreshModels={onRefreshModels} onOpenModelSettings={onOpenModelSettings} modelLoading={modelLoading} modelError={modelError}
      mediaCapabilities={mediaCapabilities} mediaLoading={mediaLoading} mediaError={creation?.mediaPollError || mediaError}
      onRefreshMedia={refreshMediaCapabilities} onSaveMediaSettings={saveMediaSettings}
      onMediaOptionsChange={value => creation && updateCreation(creation.key, { mediaOptions: value, error: '' })}
      onGenerateMedia={generateMedia} onNewMedia={newMediaTask} onResumeMedia={() => creation?.mediaJob && void resumeMediaTask(creation.mediaJob.taskId, creation.key).catch(cause => updateCreation(creation.key, { error: messageOf(cause) }))}
      instruction={creation?.instruction || ''} onInstructionChange={value => creation && updateCreation(creation.key, { instruction: value, error: '' })}
      onReferencesChange={changeCreationReferences} onImportFiles={importCreationFiles}
      searchProjectReferences={searchCreationFiles} onReferenceProjectFile={referenceCreationFile}
      projectRoot={project.path} onOpenReviewDraft={onPreviewProjectFile}
      acceptedFileTypes=".txt,.md,.csv,.json,.jsonl,.pdf,.docx,.pptx,.png,.jpg,.jpeg,.webp,.gif,.mp4,.webm"
      getReferenceFileHref={(card, preview = false) => endpoint({ [card.generatedFile ? 'downloadArtifact' : 'materialFile']: card.refId, ...(preview ? { preview: '1' } : {}) }).href}
      onClose={closeCreation} onSend={sendToAI} onAction={creationAction}
      busy={!!busy || loading || !!creation?.mediaRestoring} error={creation?.error}
      sendLabel={creation?.outputType === 'material' ? '保存关联素材' : creation?.outputType === 'word' ? '导出当前版本 Word' : `开始创作 ${OUTPUT_LABELS[creation?.outputType] || ''}`}
      canSend={!!creation && !creation.mediaRecoveryError && (creation.pendingTaskId ? pendingRetryAllowed(creation.pendingGeneration) && !['image', 'video'].includes(creation.outputType) : creation.outputType === 'material' ? !!creation.materialTitle?.trim() && !!creation.materialContent?.trim() : creation.outputType === 'word' ? ['outline', 'word'].includes(creation.anchor.kind) : !!creation.instruction.trim() && (!!creation.generation || creation.references.length > 0) && creation.references.length <= 24)}
      hideSubmit={creation?.outputType === 'excerpt'} conversation={pptOwnsConversation ? null : conversation} conversationVisible={Boolean(creation?.sessionId && creation.sessionId === conversationSessionId)} onOpenConversation={openCreationConversation} onPrepareContinuation={onPrepareContinuation}
      actionContent={creation?.outputType === 'material' ? <div className="wcc-creation-material-fields">
        <label>素材名称<input aria-label="关联素材名称" disabled={!!busy} maxLength={200} value={creation.materialTitle || ''} onChange={event => updateCreation(creation.key, { materialTitle: event.target.value, error: '' })} /></label>
        <label>素材正文<textarea aria-label="关联素材正文" disabled={!!busy} rows={5} value={creation.materialContent || ''} onChange={event => updateCreation(creation.key, { materialContent: event.target.value, error: '' })} /></label>
      </div> : creation?.outputType === 'excerpt' ? <SourceReader key={creation.key} card={creation.anchor} draft={creation.excerptDraft} onDraftChange={draft => updateCreation(creation.key, { excerptDraft: draft })} initialRange={creation.excerptDraft?.selection} onExcerpt={values => addExcerpt(values, true)} onOpenSource={openExcerptSource} busy={!!busy} error={excerptError} /> : creation?.outputType === 'word' ? <div className="wcc-creation-word-preview"><strong>锁定大纲 v{creation.anchor.number}</strong><p>导出此卡绑定的已保存版本；点击其他卡片可切换目标，各自草稿保留。</p>
        {(board?.nodes || []).some(card => card.kind === 'word' && card.refId === creation.anchor.refId) && <a className="wcc-download" href={endpoint({ download: creation.anchor.refId }).href} download>下载当前版本 Word</a>}
      </div> : undefined} />

      </div>
      {deskVisible && deskVersion && <OutlineDesk version={deskVersion} versions={outlineVersions} value={outline}
        onChange={editOutline} onClose={() => setFocusOpen(false)} onSave={saveOutline} onExport={exportWord}
        onPassage={selectPassage} busy={!!busy} error={error}
        downloadHref={deskVersion.wordPath ? endpoint({ download: deskVersion.id }).href : undefined} />}
      <div hidden={!dockOpen} className="wcc-dock" aria-label="右侧工作栏">
        {!dock.mobile && !editorFullscreen && <div className="wcc-dock-separator" {...dock.separator} />}
        <div className="wcc-dock-mobile-header"><UiButton variant="quiet" type="button" onClick={closeDock}>← 返回画布</UiButton></div>
      {(projectFileSelection || outcomeView) && <OutcomeViewer key={projectFileSelection?.token || JSON.stringify(outcomeView)}
        target={projectFileSelection ? { projectPath: projectFileSelection.path, title: projectFileSelection.name, requirementId: requirement.id,
          ...(projectFileSelection.reviewDraft ? { hash: projectFileSelection.hash, reviewDraft: true } : {}) } : outcomeView}
        endpoint={endpoint} request={request} renderNativePreview={renderNativePreview} active={active}
        onClose={() => {setOutcomeView(null);onCloseProjectFile?.()}}
        onAdd={projectFileSelection && !projectFileSelection.reviewDraft ? onAddProjectFile : undefined} onToggleWidth={dock.toggleExpanded} widthExpanded={dock.expanded}
        onSaved={async result => { cache.current.versionViews.delete(result.cardId);setOutcomeView(null);await onChanged?.();await loadBoard({preserveViewport:true}) }}
        onEditPpt={scope => setDeckPreview({...scope,viewIntent:++creationIntent.current,viewEpoch:epochRef.current})}
        onOpenSlides={manifest => setDeckPreview({slideProject:manifest.slideProject,artifactId:manifest.slideProject.artifactId,hash:manifest.slideProject.artifactHash,title:manifest.title,cardId:manifest.cardId,
          versionId:manifest.versionId,requirementId:requirement.id,viewIntent:++creationIntent.current,viewEpoch:epochRef.current})} /> }
      <aside hidden={!sidebar || Boolean(deckPreview) || Boolean(documentView) || Boolean(projectFileSelection) || Boolean(outcomeView)} className="wcc-sidebar" id={`${panelId}-sidebar`} aria-label="画布侧栏">
        <PanelHeader title={tab==='tasks'?'创作任务':selectedCard?.title||'内容详情'} subtitle={tab==='tasks'?`${tasks.length} 个任务`:undefined} downloadHref={tab==='inspect'&&selectedCard?(selectedCard.importedFile?endpoint({materialFile:selectedCard.refId}).href:selectedCard.kind==='artifact'?endpoint({downloadArtifact:selectedCard.refId}).href:selectedCard.kind==='word'?endpoint({download:selectedCard.refId}).href:undefined):undefined} expanded={dock.expanded} onToggleWidth={dock.toggleExpanded} onClose={()=>setSidebar(false)} closeLabel="关闭画布侧栏"/>
        <div className="wcc-tabs" role="tablist" aria-label="侧栏内容">
          <UiButton variant="custom" role="tab" aria-selected={tab === 'inspect'} aria-controls={`${panelId}-inspect-panel`} id={`${panelId}-inspect-tab`} onClick={() => setTab('inspect')}>内容详情</UiButton>
          <UiButton variant="custom" role="tab" aria-selected={tab === 'ai'} aria-controls={`${panelId}-ai-panel`} id={`${panelId}-ai-tab`} onClick={openSelectedCreation}>AI 制课</UiButton>
          <UiButton variant="custom" role="tab" aria-selected={tab === 'tasks'} aria-controls={`${panelId}-tasks-panel`} id={`${panelId}-tasks-tab`} onClick={() => setTab('tasks')}>创作任务</UiButton>
        </div>
        <div hidden={tab !== 'inspect'} className="wcc-inspector" role="tabpanel" id={`${panelId}-inspect-panel`} aria-labelledby={`${panelId}-inspect-tab`}>
          <div className="wcc-inspector-heading"><span>{selectedNodes.length ? `已选择 ${selectedNodes.length} 张卡片` : selectedGroups.length ? '已选择分组' : '选一张卡片查看内容'}</span>{selectedNodes.length > 0 && <UiButton variant="quiet" className="wcc-text-button" onClick={() => setTab('ai')}>交给 AI →</UiButton>}</div>
          {selectedCard ? <>
            <span className={`wcc-inspector-type is-${selectedCard.kind}`}>{LABELS[selectedCard.kind]}{selectedCard.number != null ? ` · v${String(selectedCard.number).padStart(3, '0')}` : ''}</span>
            <h2>{selectedCard.title}</h2>
            <p className="wcc-muted">{stateLabel(selectedCard)}</p>
            {(selectedCard.sourcePath || selectedCard.path) && <details className="wcc-file-path"><summary>文件位置</summary><code>{selectedCard.sourcePath || selectedCard.path}</code></details>}
            {selectedCard.importedFile && <>
              
              {selectedCard.importedFile.mime?.startsWith('image/') && selectedCard.sourceStatus === 'ready' && <img className="wcc-imported-preview" src={endpoint({ materialFile: selectedCard.refId, preview: '1' }).href} alt={selectedCard.title} />}
              {selectedCard.importedFile.mime?.startsWith('video/') && selectedCard.sourceStatus === 'ready' && <video className="wcc-imported-preview" src={endpoint({ materialFile: selectedCard.refId, preview: '1' }).href} aria-label={`原视频预览：${selectedCard.title}`} controls preload="metadata" playsInline onError={() => setNotice('此浏览器无法播放该视频，可下载原件后用本机播放器打开。')} />}
              {selectedCard.importedFile.media?.warning && <p className="wcc-warning">{selectedCard.importedFile.media.warning}</p>}
              {(selectedCard.importedFile.truncated || selectedCard.importedFile.extractionError) && <p className="wcc-inline-warning">{selectedCard.importedFile.truncated ? '正文超出 1 MB，本次保存了提取节选。' : selectedCard.importedFile.extractionError}</p>}
            </>}
            {selectedCard.sourcePath && selectedCard.extracted === false && <p className="wcc-inline-warning">该文件尚未提取正文。交给 AI 时只会携带实际可用的文字与文件状态。</p>}
            {selectedCard.kind === 'generation' ? <><p className="wcc-inline-warning">{selectedCard.pendingGeneration?.error || selectedCard.pendingGeneration?.message || '成果文件尚未保存，没有可下载或可引用的成功版本。'}</p><UiButton variant="primary" className="wcc-primary" onClick={() => void openPendingCard(selectedCard)}>打开任务</UiButton></> : selectedCard.kind === 'whiteboard' ? <>
              <label><span>白板文字</span><textarea rows={6} maxLength={30000} value={selectedCard.text} onChange={event => changeElement(selectedCard.id, { text: event.target.value })} /></label>
              <WhiteboardStyleControls element={selectedCard} onChange={patch => changeElement(selectedCard.id, patch)} />
              <p className="wcc-muted">双击原位编辑，拖动边角调整大小。交给 AI 前保存为素材快照。</p>
              <div className="wcc-content-actions"><UiButton variant="primary" className="wcc-primary" onClick={promoteWhiteboard} disabled={!!busy || !selectedCard.text.trim()}>保存为素材</UiButton><UiButton variant="quiet" onClick={duplicateElements} disabled={!!busy}>复制</UiButton><UiButton variant="quiet" onClick={removeElements} disabled={!!busy}>删除</UiButton></div>
            </> : selectedCard.kind === 'outline' ? <>
              <UiButton variant="primary" className="wcc-primary" onClick={() => { setFocusOpen(true); setSidebar(false) }}>专注编辑大纲 →</UiButton>
              {outlineDirty && <p className="wcc-inline-warning">当前修改尚未保存。导出前先保存为新版本。</p>}
              <div className="wcc-content-actions"><UiButton variant="primary" className="wcc-primary" onClick={saveOutline} disabled={!!busy || !outline.trim() || !outlineDirty}>{busy === 'outline' ? '正在保存…' : '保存为新版本'}</UiButton><UiButton variant="quiet" onClick={exportWord} disabled={!!busy || outlineDirty || !selectedCard.refId}>{busy === 'word' ? '导出中…' : '导出 Word'}</UiButton></div>
              <SourceReader key={selectedSourceId} card={creationSource(selectedCard)} initialRange={readerRange?.cardId === selectedCard.id ? readerRange : undefined}
                onExcerpt={addExcerpt} onOpenSource={openExcerptSource} busy={!!busy} error={excerptError} />
            </> : selectedCard.kind === 'artifact' ? <>
              <p className="wcc-muted">{OUTPUT_LABELS[selectedCard.artifactKind] || '成果文件'} · 已保存对应的资料和版本。</p>
              {mediaSizeLabel(selectedCard.generatedFile) && <p className="wcc-muted">实际文件：{mediaSizeLabel(selectedCard.generatedFile)}</p>}
              <a className="wcc-download" href={endpoint({ downloadArtifact: selectedCard.refId }).href} download>下载{OUTPUT_LABELS[selectedCard.artifactKind] || '成果文件'}</a>
              {selectedCard.generatedFile?.mime?.startsWith('image/') && selectedCard.status === 'ready' && <img className="wcc-imported-preview" src={endpoint({ downloadArtifact: selectedCard.refId, preview: '1' }).href} alt={selectedCard.title} />}
              {selectedCard.generatedFile?.mime?.startsWith('video/') && selectedCard.status === 'ready' && <video className="wcc-imported-preview" src={endpoint({ downloadArtifact: selectedCard.refId, preview: '1' }).href} aria-label={`生成视频预览：${selectedCard.title}`} controls preload="metadata" playsInline onError={() => setNotice('此浏览器无法播放生成的视频，可下载后用本机播放器打开。')} />}
              {selectedCard.extracted === false ? <p className="wcc-inline-warning">这里展示文件信息。点击预览或下载，查看完整内容。</p> : <SourceReader key={selectedSourceId} card={creationSource(selectedCard)} onExcerpt={addExcerpt} onOpenSource={openExcerptSource} busy={!!busy} error={excerptError} />}
              <UiButton variant="quiet" className="wcc-text-button" onClick={openSelectedCreation}>基于此成果文件继续创作 →</UiButton>
            </> : selectedCard.kind === 'word' ? <>
              <p className="wcc-muted">此成果文件绑定已保存的大纲 v{selectedCard.number}，后续修改会生成独立版本。</p>
              <a className="wcc-download" href={endpoint({ download: selectedCard.refId }).href} download>下载 Word</a>
              <UiButton variant="quiet" className="wcc-text-button" onClick={() => selectCard(`outline:${selectedCard.refId}`)}>查看对应大纲 →</UiButton>
            </> : ['material', 'excerpt'].includes(selectedCard.kind) ? <>
              <SourceReader key={selectedSourceId} card={creationSource(selectedCard)} initialRange={readerRange?.cardId === selectedCard.id ? readerRange : undefined}
                onExcerpt={addExcerpt} onOpenSource={openExcerptSource} busy={!!busy} error={excerptError} />
              {selectedCard.kind === 'material' && <UiButton variant="quiet" onClick={() => { setMaterialError(''); setMaterialDialog({ title: `${selectedCard.title}（修订）`, content: selectedCard.content || '', sourcePath: '', snapshot: true }) }} disabled={!!busy}>编辑并另存新素材</UiButton>}
            </> : <>
              <pre className="wcc-content-preview">{selectedCard.kind === 'requirement' && typeof selectedCard.requirementBackground === 'string' ? selectedCard.requirementBackground || '暂无背景信息。' : selectedCard.content || '暂无可预览正文。'}</pre>
              {selectedCard.kind === 'material' && <UiButton variant="quiet" onClick={() => { setMaterialError(''); setMaterialDialog({ title: `${selectedCard.title}（修订）`, content: selectedCard.content || '', sourcePath: '', snapshot: true }) }} disabled={!!busy}>编辑并另存新素材</UiButton>}
            </>}
          </> : selectedNodes.length > 1 ? <><p className="wcc-muted">可以分组整理，或将所选内容一起交给 AI。</p><ul className="wcc-selected-list">{selectedNodes.map(node => <li key={node.id}><span>{LABELS[node.data.kind]}</span><UiButton variant="quiet" onClick={() => selectCard(node.id)}>{node.data.title}</UiButton></li>)}</ul><UiButton variant="primary" className="wcc-primary" onClick={() => setTab('ai')}>用这 {selectedNodes.length} 张卡片制课</UiButton></> : <div className="wcc-inspector-empty"><span aria-hidden="true">▧</span><p>点击画布上的卡片，<br />在这里查看正文和文件。</p><small>按住 Shift 可选择多张卡片。</small></div>}
          {edgeSelection.length > 0 && <div className="wcc-edge-actions"><p>已选择 {edgeSelection.length} 条手动关联线</p><UiButton variant="quiet" onClick={deleteSelectedEdges}>删除所选关联线</UiButton></div>}
        </div>
        <div hidden={tab !== 'ai'} className="wcc-ai-panel" role="tabpanel" id={`${panelId}-ai-panel`} aria-labelledby={`${panelId}-ai-tab`}>
          <div className="wcc-ai-placeholder"><p>点击卡片可切换创作对象，各卡片草稿分别保留；已提交任务的引用独立保存。</p><UiButton variant="quiet" onClick={openSelectedCreation}>打开卡片创作框</UiButton></div>
        </div>
        <div hidden={tab !== 'tasks'} className="wcc-task-panel" role="tabpanel" id={`${panelId}-tasks-panel`} aria-labelledby={`${panelId}-tasks-tab`}>
          <CourseTasks tasks={tasks} pendingTaskIds={interactions.map(entry => entry.task.id)} loadTask={loadTask} onOpenArtifact={openArtifact} onOpenSession={openTaskSession} onResumeMediaTask={resumeMediaTask} busy={!!busy}
            getDownloadHref={versionId => endpoint({ download: versionId }).href} getFileDownloadHref={id => endpoint({ downloadArtifact: id }).href} />
        </div>
      </aside>
    {documentView && <DocumentViewer key={`${documentView.sourceRef}:${documentView.hash}`} {...documentView} endpoint={endpoint}
      active={active}
      onToggleWidth={dock.toggleExpanded} widthExpanded={dock.expanded}
      leaveCache={cache.current}
      draftCache={cache.current.documentDrafts} onDraftError={setError}
      onSaved={result => documentSaved(result, documentView)} onRewrite={rewriteDocument} onClose={() => { setOutcomeView(null);setDocumentView(null); closeCreation() }} />}
    {deckPreview?.slideProject && <BaoyuSlides key={`${projectId}:${deckPreview.slideProject.id}:${deckPreview.versionId || 'pending'}:${deckPreview.viewIntent}`} scope={deckPreview} api={pptApi} renderEditorConversation={renderEditorConversation} savedPreview={<SavedPptPreview scope={deckPreview} endpoint={endpoint} renderNativePreview={renderNativePreview}/>}
      conversation={pptOwnsConversation ? conversation : null} conversationSessionId={conversationSessionId}
      onRestoreSession={async sessionId => { setPptConversationOwner({ sessionId, cardId: deckPreview.cardId, hash: deckPreview.hash }); return restoreRef.current?.(sessionId) }} onPublished={(result,options) => publishedPptEdit(result, deckPreview,options)} closeRequestRef={editorCloseRequest}
      onToggleWidth={()=>setEditorFullscreen(value=>!value)} widthExpanded={editorFullscreen}
      downloadHref={deckPreview.artifactId ? endpoint({ downloadArtifact: deckPreview.artifactId }).href : undefined} onClose={finishEditorClose} />}
    {deckPreview && !deckPreview.slideProject && (deckPreview.svgCandidateId || deckPreview.svgSourceId) && <SvgSourceView key={`${projectId}:${deckPreview.artifactId}:${deckPreview.hash}`} scope={{...deckPreview,projectId}} api={svgApi} renderEditorConversation={renderEditorConversation} savedPreview={<SavedPptPreview scope={deckPreview} endpoint={endpoint} renderNativePreview={renderNativePreview}/>}
      modelProps={{catalog:modelCatalog,selection:modelSelection,onChange:onModelChange,onRefresh:onRefreshModels,onOpenSettings:onOpenModelSettings,loading:modelLoading,error:modelError}}
      interactions={interactions} currentInteraction={key=>interactionsRef.current.find(entry=>entry.key===key)}
      conversation={pptOwnsConversation?conversation:null} conversationSessionId={conversationSessionId}
      onAiTask={startPptEditAi} onOpenConversation={sessionId=>{setPptConversationOwner({sessionId,cardId:deckPreview.cardId,hash:deckPreview.hash});return restoreRef.current?.(sessionId)}}
      onBackgroundStatus={status=>pptBackgroundStatus(status,deckPreview)} onPublished={(result,options)=>publishedPptEdit(result,deckPreview,options)} closeRequestRef={editorCloseRequest} onToggleWidth={()=>setEditorFullscreen(value=>!value)} widthExpanded={editorFullscreen}
      downloadHref={endpoint({downloadArtifact:deckPreview.artifactId}).href} onClose={finishEditorClose}/>}
    {deckPreview && !deckPreview.slideProject && !deckPreview.svgCandidateId && !deckPreview.svgSourceId && <PptEditor key={`${projectId}:${deckPreview.artifactId}:${deckPreview.hash}:${deckPreview.viewIntent}`} scope={{ ...deckPreview, projectId }} api={pptApi} onToggleWidth={dock.toggleExpanded} widthExpanded={dock.expanded}
      conversation={pptOwnsConversation ? conversation : null} conversationSessionId={conversationSessionId}
      onAiTask={startPptEditAi} onOpenConversation={sessionId => restoreRef.current?.(sessionId)}
      onBackgroundStatus={status=>pptBackgroundStatus(status,deckPreview)}
      onPublished={result => publishedPptEdit(result, deckPreview)}
      downloadHref={endpoint({ downloadArtifact: deckPreview.artifactId }).href} onClose={() => setDeckPreview(null)} />}
        {dock.preferenceError && <p role="status" className="wcc-dock-preference-error">{dock.preferenceError}</p>}
      </div>
    </div>
    {skillReview && active && <SkillConfirmation key={skillReview.entry.key} entry={skillReview.entry} draftCache={skillDrafts.current}
      currentEntry={() => interactionsRef.current.find(entry => entry.key === skillReview.entry.key)} position={{
        x: Math.max(12, Math.min(skillReview.position.x, canvasSize.width - Math.min(500, canvasSize.width - 24) - 12)),
        y: 76, maxHeight: Math.max(160, canvasSize.height - 88),
      }}
      loadOutputs={loadSkillReviewOutputs} verifyOutputs={verifySkillReviewOutputs} onClose={() => setSkillReview(null)}
      onOpenNative={() => { const sessionId = skillReview.entry.task.sessionId; setSkillReview(null); void openTaskSession(sessionId).then(() => { if (creationRef.current?.sessionId === sessionId) updateCreation(creationRef.current.key, { openExecutionRequest: crypto.randomUUID() }) }) }}
      loadDeckPreview={loadDeckPreview} getDeckPageHref={getDeckPageHref} onOpenOutput={output => { setSkillDeckPreview({ output, review: skillReview }); setSkillReview(null) }} />}
    {skillDeckPreview && active && <DeckPreview artifactId={skillDeckPreview.output.node.refId} hash={skillDeckPreview.output.node.sourceHash}
      title={skillDeckPreview.output.node.title} downloadHref={skillDeckPreview.output.downloadHref} loadPreview={loadDeckPreview} getPageHref={getDeckPageHref}
      onClose={() => { setSkillReview(skillDeckPreview.review); setSkillDeckPreview(null) }} />}
    {assetsOpen && <AssetBoard key={`${projectId}:${requirement.id}`} projectId={projectId} requirementId={requirement.id} endpoint={endpoint} request={request} draftCache={cache.current} onClose={() => { setAssetsOpen(false); void refreshSkillCatalog() }}
      onOpenCard={(card, versionId, targetRequirement) => { if (targetRequirement !== requirement.id) { onAssetNavigate?.(targetRequirement, card.id, versionId); return } const node = boardRef.current?.nodes.find(item => item.outputCard?.id === card.id); if (node) { setAssetsOpen(false); void openOutputCard(node, versionId) } }}
      onOpenTask={task => { if (task?.sessionId) { setAssetsOpen(false); void openTaskSession(task.sessionId) } }} />}

    {materialDialog && <MaterialDialog initial={materialDialog} busy={busy === 'material'} error={materialError} onClose={() => setMaterialDialog(null)} onSubmit={values => void addMaterial(values)} />}
    {groupDialog && <GroupDialog busy={!!busy} onClose={() => setGroupDialog(false)} onSubmit={regroup} />}
  </div>
}

export function CourseCanvas(props) {
  return <ReactFlowProvider><CanvasContent {...props} /></ReactFlowProvider>
}
