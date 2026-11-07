import { UiButton } from './ui/controls.jsx'
import React, { useEffect, useRef, useState } from 'react'
import './canvas-chrome.css'

const ICONS = {
  select: <path d="m5 3 13 10-7 1-3 7L5 3Z" />,
  hand: <><path d="M8 12V5a1.5 1.5 0 0 1 3 0v6-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v6-3a1.5 1.5 0 0 1 3 0v5c0 5-3 8-7 8-3 0-4-1-6-4l-3-5a1.6 1.6 0 0 1 2.6-1.8L8 13" /></>,
  text: <><path d="M5 5h14M12 5v15M8 20h8M5 5v3M19 5v3" /></>,
  note: <><path d="M5 3h14a2 2 0 0 1 2 2v10l-6 6H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M15 21v-6h6M7 8h10M7 12h7" /></>,
  rectangle: <rect x="4" y="5" width="16" height="14" rx="1.5" />,
  ellipse: <ellipse cx="12" cy="12" rx="9" ry="7" />,
  material: <><path d="M4 7h6l2 2h8v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7Z" /><path d="M4 7V5a1 1 0 0 1 1-1h5l2 3M12 12v5M9.5 14.5h5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  fit: <><path d="M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6" /><rect x="8" y="8" width="8" height="8" rx="1" /></>,
  focus: <><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5" /><path d="M8 12h8M12 8v8" /></>,
  map: <><path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Z" /><path d="M9 3v16M15 5v16" /></>,
  undo: <><path d="m8 5-5 5 5 5M3 10h11a6 6 0 0 1 0 12" /></>,
  redo: <><path d="m16 5 5 5-5 5M21 10H10a6 6 0 0 0 0 12" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14-5L3 9M3 3v6h6M4 13a8 8 0 0 0 14 5l3-3M15 15h6v6" /></>,
  inspect: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16M6 8h5M6 12h5M6 16h3" /></>,
  ai: <><path d="m12 2 2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4L12 2Z" /><path d="m19 2 .7 2.3L22 5l-2.3.7L19 8l-.7-2.3L16 5l2.3-.7L19 2Z" /></>,
  group: <><path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5" /><rect x="7" y="7" width="10" height="10" rx="1" /></>,
  ungroup: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><path d="M14 3h7v7M3 14v7h7" /></>,
  align: <><path d="M5 3v18" /><rect x="8" y="5" width="13" height="5" rx="1" /><rect x="8" y="14" width="8" height="5" rx="1" /></>,
  left: <><path d="M4 3v18M8 7h12M8 12h8M8 17h12" /></>,
  top: <><path d="M3 4h18M7 8v12M12 8v8M17 8v12" /></>,
  distribute: <><path d="M3 4v16M21 4v16" /><rect x="7" y="8" width="3" height="8" rx=".5" /><rect x="14" y="8" width="3" height="8" rx=".5" /></>,
  chevron: <path d="m8 10 4 4 4-4" />,
  duplicate: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 5V3H3v13h2" /></>,
  trash: <><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" /></>,
  check: <path d="m5 12 4 4 10-10" />,
  loading: <><path d="M20 12a8 8 0 1 1-8-8" /><path d="M12 1v6l4-3-4-3Z" /></>,
  warning: <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5M12 17h.01" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
}

export function CanvasIcon({ name, size = 18, className = '' }) {
  return <svg className={`wcc-studio-icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name] || ICONS.rectangle}</svg>
}

export function CanvasSearch({ width, panelOpen, hidden, query, onQuery, nodes, onSelect, allRelations, onRelations, onOpen }) {
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const input = useRef(null)
  const compact = width <= 700 || panelOpen && width < 920
  const expanded = !compact || open && !panelOpen
  const matches = query.trim() ? nodes.filter(node => node.type === 'content'
    && `${node.data.title} ${node.data.content || ''}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 20) : []
  useEffect(() => { if (open && !hidden) input.current?.focus() }, [open, hidden])
  useEffect(() => { if (panelOpen) setOpen(false) }, [panelOpen])
  useEffect(() => { if (hidden) { setOpen(false); setFocused(false) } }, [hidden])
  return <div className={`wtt-canvas-search${expanded ? ' is-expanded' : ' is-compact'}`} hidden={hidden}
    style={expanded ? { right: panelOpen ? 396 : 12, ...(compact ? { top:128,left:18,right:12,maxWidth:'none' } : {}) } : { left: 18, right: 'auto', top: 76 }}
    role="search" aria-label="查找画布内容" onPointerDown={event => event.stopPropagation()}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); setOpen(false); setFocused(false); input.current?.blur() } }}>
    {expanded ? <>
      <input ref={input} aria-label="搜索画布内容" placeholder="查找卡片…" value={query} onFocus={() => setFocused(true)} onChange={event => { onQuery(event.target.value); setFocused(true) }} />
      {query && <UiButton variant="custom" type="button" aria-label="清空搜索" onClick={() => { onQuery(''); input.current?.focus() }}>×</UiButton>}
      <UiButton variant="custom" type="button" aria-pressed={!allRelations} title={allRelations ? '点击淡化与所选卡片无关的连线' : '点击显示全部连线'} onClick={onRelations}>{allRelations ? '连线：全部' : '连线：相关'}</UiButton>
      {focused && query.trim() && <div role="listbox" aria-label="画布搜索结果">{matches.length ? matches.map(node => <UiButton variant="custom" type="button" role="option" aria-selected={false} key={node.id} onMouseDown={event => event.preventDefault()} onClick={() => { onSelect(node); onQuery(''); setFocused(false) }}>{node.data.title}</UiButton>) : <p role="status">没找到相关卡片，换个关键词试试。</p>}</div>}
    </> : <UiButton variant="custom" type="button" aria-label="搜索画布内容" title="查找卡片与文字" onClick={() => { onOpen?.(); setOpen(true) }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg></UiButton>}
  </div>
}

function ToolButton({ icon, label, shortcut, active, onClick, disabled, children, className = '' }) {
  const title = shortcut ? `${label} · ${shortcut}` : label
  return <UiButton variant="custom" type="button" className={`wcc-studio-button ${active ? 'is-active' : ''} ${className}`} title={title} aria-label={label} aria-pressed={active === undefined ? undefined : active} disabled={disabled || !onClick} onClick={onClick}>
    {icon && <CanvasIcon name={icon} />}
    {children}
    <span className="wcc-studio-tooltip" aria-hidden="true">{label}{shortcut && <kbd>{shortcut}</kbd>}</span>
  </UiButton>
}

const TOOLS = [
  ['select', '选择与移动', 'V'], ['hand', '拖动画布', 'H / Space'],
  ['text', '文本工具', 'T'], ['note', '便签工具', 'N'],
  ['rectangle', '矩形工具', 'R'], ['ellipse', '椭圆工具', 'O'],
]

export function CanvasChrome({
  tool = 'select', onTool, zoom = 1, onZoomIn, onZoomOut, onZoom100, onFitAll, onFitSelected,
  onToggleMap, showMap = false, onAddMaterial, onAddElement, onUndo, onRedo, canUndo, canRedo,
  onInspect, onAI, onTasks, onAssets, taskCount = 0, runningCount = 0, pendingCount = 0, sidebar, selectedCount = 0, onRefresh, saveStatus = 'saved', onRetry,
  hasSelection = selectedCount > 0, busy = false,
}) {
  const status = {
    saved: ['已保存', 'check'], saving: ['保存中', 'loading'],
    failed: ['保存失败', 'warning'], conflict: ['布局已更新，请刷新', 'warning'], draft: ['有未保存草稿', 'note'],
  }[saveStatus] || [String(saveStatus), 'check']
  const chooseTool = value => {
    if (onTool) onTool(value)
    else if (!['select', 'hand'].includes(value)) onAddElement?.(value)
  }
  const controlsDisabled = Boolean(busy)
  return <div className={`wcc-studio-chrome${sidebar ? ' is-panel-open' : ''}`}>
    <div className="wcc-studio-tools wcc-studio-surface" role="toolbar" aria-label="白板工具" aria-orientation="vertical">
      {TOOLS.map(([value, label, shortcut], index) => <React.Fragment key={value}>
        {index === 2 && <span className="wcc-studio-divider is-horizontal" aria-hidden="true" />}
        <ToolButton icon={value} label={label} shortcut={shortcut} active={tool === value} disabled={controlsDisabled} onClick={(onTool || (!['select', 'hand'].includes(value) && onAddElement)) ? () => chooseTool(value) : undefined} />
      </React.Fragment>)}
      <span className="wcc-studio-divider is-horizontal" aria-hidden="true" />
      <ToolButton icon="material" label="添加素材" onClick={onAddMaterial} disabled={controlsDisabled} />
    </div>

    <div className="wcc-studio-status-dock wcc-studio-surface" role="toolbar" aria-label="画布操作">
      <span className={`wcc-studio-save-status is-${saveStatus}`} role="status" aria-live="polite" title={status[0]}>
        <CanvasIcon name={status[1]} size={14} className={saveStatus === 'saving' ? 'is-spinning' : ''} /><span>{status[0]}</span>
      </span>
      {(saveStatus === 'failed' || saveStatus === 'conflict') && onRetry && <UiButton variant="custom" type="button" className="wcc-studio-retry" onClick={onRetry} disabled={controlsDisabled}>{saveStatus === 'conflict' ? '重新加载' : '重试'}</UiButton>}
      <span className="wcc-studio-divider" aria-hidden="true" />
      <ToolButton icon="undo" label="撤销布局" shortcut="⌘/Ctrl Z" onClick={onUndo} disabled={!canUndo || controlsDisabled} />
      <ToolButton icon="redo" label="重做布局" shortcut="⌘/Ctrl Shift Z" onClick={onRedo} disabled={!canRedo || controlsDisabled} />
      <ToolButton icon="refresh" label="刷新画布" onClick={onRefresh} disabled={controlsDisabled} />
      <span className="wcc-studio-divider" aria-hidden="true" />
      <ToolButton icon="inspect" label="内容详情" active={typeof sidebar === 'string' ? sidebar === 'inspect' : undefined} onClick={onInspect} className="wcc-studio-panel-button"><span>内容</span></ToolButton>
      <ToolButton icon="material" label="创作任务" active={sidebar === 'tasks'} onClick={onTasks} className="wcc-studio-panel-button"><span>{runningCount ? `运行 ${runningCount}` : '任务'}{pendingCount ? ` · 待办 ${pendingCount}` : ''}</span></ToolButton>
      <ToolButton icon="inspect" label="资产看板" onClick={onAssets} className="wcc-studio-panel-button"><span>资产</span></ToolButton>
      <ToolButton icon="ai" label="AI 制课" active={typeof sidebar === 'string' ? sidebar === 'ai' : undefined} onClick={onAI} className="wcc-studio-panel-button is-ai"><span>AI 制课</span></ToolButton>
    </div>

    <div className="wcc-studio-zoom-dock wcc-studio-surface" role="toolbar" aria-label="画布缩放与导航">
      <ToolButton icon="minus" label="缩小画布" onClick={onZoomOut} />
      <UiButton variant="custom" type="button" className="wcc-studio-zoom-value" onClick={onZoom100} disabled={!onZoom100} title="恢复至 100%" aria-label={`当前缩放 ${Math.round(zoom * 100)}%，恢复至 100%`}>{Math.round(zoom * 100)}%</UiButton>
      <ToolButton icon="plus" label="放大画布" onClick={onZoomIn} />
      <span className="wcc-studio-divider" aria-hidden="true" />
      <ToolButton icon="fit" label="查看全部卡片" onClick={onFitAll} />
      <ToolButton icon="focus" label="定位所选卡片" onClick={onFitSelected} disabled={!hasSelection} />
      <ToolButton icon="map" label="显示小地图" active={showMap} onClick={onToggleMap} />
    </div>

    <div className="wcc-studio-navigation-hint" aria-hidden="true">双指滑动／滚轮平移<span>·</span>捏合／＋－缩放</div>
  </div>
}

export function SelectionActions({
  x, y, selectedCount = 1, onInspect, onAI, onGroup, onUngroup,
  canGroup = selectedCount > 1, canUngroup = false, onAlign, busy = false,
  onPromote, canPromote = false, onDuplicate, canDuplicate = false,
  onDelete, canDelete = false,
}) {
  const [alignOpen, setAlignOpen] = useState(false)
  const style = x === undefined ? undefined : { left: x, top: y ?? 86 }
  return <div className={`wcc-studio-selection wcc-studio-surface${x === undefined ? '' : ' is-positioned'}`} style={style} role="toolbar" aria-label={`已选 ${selectedCount} 个对象的操作`} onPointerDown={event => event.stopPropagation()}>
    <span className="wcc-studio-selection-count">{selectedCount} 项</span>
    <ToolButton icon="inspect" label="查看内容" onClick={onInspect} />
    <ToolButton icon="ai" label="交给 AI" onClick={onAI} className="is-ai"><span>交给 AI</span></ToolButton>
    {canPromote && <ToolButton icon="material" label="保存为素材" onClick={onPromote} disabled={busy} />}
    <span className="wcc-studio-divider" aria-hidden="true" />
    {canGroup && <ToolButton icon="group" label="编组" shortcut="⌘/Ctrl G" onClick={onGroup} disabled={busy} />}
    {canUngroup && <ToolButton icon="ungroup" label="解除分组" shortcut="⌘/Ctrl Shift G" onClick={onUngroup} disabled={busy} />}
    {selectedCount > 1 && <div className="wcc-studio-align-wrap">
      <ToolButton icon="align" label="对齐与分布" active={alignOpen} onClick={() => setAlignOpen(value => !value)} disabled={busy || !onAlign} />
      {alignOpen && <div className="wcc-studio-align-menu" role="menu" aria-label="对齐与分布">
        {[['left', '左对齐'], ['top', '顶部对齐'], ['horizontal', '水平等距']].map(([value, label]) => <UiButton variant="custom" type="button" key={value} role="menuitem" onClick={() => { onAlign?.(value); setAlignOpen(false) }} disabled={busy || (value === 'horizontal' && selectedCount < 3)}><CanvasIcon name={value === 'horizontal' ? 'distribute' : value} size={16} /><span>{label}</span></UiButton>)}
      </div>}
    </div>}
    {canDuplicate && <ToolButton icon="duplicate" label="复制白板元素" shortcut="⌘/Ctrl D" onClick={onDuplicate} disabled={busy} />}
    {canDelete && <ToolButton icon="trash" label="删除节点" onClick={onDelete} disabled={busy} />}
  </div>
}

export function CanvasContextMenu({ x = 0, y = 0, onClose, items = [] }) {
  const menu = useRef(null)
  useEffect(() => { menu.current?.querySelector('button:not(:disabled)')?.focus() }, [x, y])
  function navigate(event) {
    if (event.key === 'Escape') { event.preventDefault(); onClose?.(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = [...menu.current.querySelectorAll('button:not(:disabled)')]
    if (!buttons.length) return
    const current = buttons.indexOf(document.activeElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }
  return <div className="wcc-studio-menu-layer" onPointerDown={event => { if (event.target === event.currentTarget) onClose?.() }} onContextMenu={event => { event.preventDefault(); if (event.target === event.currentTarget) onClose?.() }}>
    <div className="wcc-studio-context-menu wcc-studio-surface" ref={menu} style={{ left: x, top: y }} role="menu" aria-label="画布右键菜单" onKeyDown={navigate} onPointerDown={event => event.stopPropagation()}>
      {items.map((item, index) => item.separator ? <span key={`separator-${index}`} className="wcc-studio-menu-divider" role="separator" /> : <UiButton variant="custom" type="button" role="menuitem" key={`${item.label}-${index}`} disabled={item.disabled || !item.onClick} onClick={() => { item.onClick(); onClose?.() }}>
        {item.icon && <CanvasIcon name={item.icon} size={16} />}
        <span>{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}
      </UiButton>)}
    </div>
  </div>
}
