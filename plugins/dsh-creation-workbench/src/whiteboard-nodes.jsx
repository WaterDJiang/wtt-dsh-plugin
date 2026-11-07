import { UiButton } from './ui/controls.jsx'
import React, { memo, useEffect, useRef, useState } from 'react'
import { Handle, NodeResizer, Position } from '@xyflow/react'
import './whiteboard-nodes.css'

const COLOURS = {
  cream: { label: '米黄', paper: '#fff4cb', line: '#eadba7' },
  blue: { label: '浅蓝', paper: '#e6efff', line: '#bdcfee' },
  green: { label: '浅绿', paper: '#e7f3e9', line: '#bfd8c5' },
  rose: { label: '浅粉', paper: '#f9e8e9', line: '#e7c8ce' },
  white: { label: '白色', paper: '#ffffff', line: '#dce1e9' },
}
const KINDS = { text: '文字', note: '便签', shape: '图形' }
const stop = event => event.stopPropagation()

export const WhiteboardNode = memo(function WhiteboardNode({ id, data, selected, isConnectable }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(data.text || '')
  const editor = useRef(null)
  const closed = useRef(null)
  const autoEditStarted = useRef(false)
  const kind = KINDS[data.elementKind] ? data.elementKind : 'note'
  const text = typeof data.text === 'string' ? data.text : ''
  const colour = COLOURS[data.colour] || COLOURS.cream
  const ellipse = kind === 'shape' && data.shape === 'ellipse'
  const label = KINDS[kind]

  useEffect(() => { if (!editing) setDraft(text) }, [text, editing])
  useEffect(() => {
    if (!data.autoEdit || autoEditStarted.current) return
    autoEditStarted.current = true
    data.onEditStart?.()
    closed.current = null
    setDraft(text)
    setEditing(true)
  }, [data.autoEdit])
  useEffect(() => {
    if (!editing) return
    editor.current?.focus()
    editor.current?.setSelectionRange(draft.length, draft.length)
  }, [editing])

  function beginEdit(event) {
    event.preventDefault()
    event.stopPropagation()
    if (editing) return
    data.onEditStart?.()
    closed.current = null
    setDraft(text)
    setEditing(true)
  }

  function finishEdit(commit) {
    if (closed.current) return
    closed.current = commit ? 'commit' : 'cancel'
    setEditing(false)
    if (commit && draft !== text) data.onChange?.(id, { text: draft })
    if (!commit) setDraft(text)
  }

  function editingKey(event) {
    event.stopPropagation()
    if (event.nativeEvent?.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      finishEdit(false)
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      finishEdit(true)
    }
  }

  return <article
    className={`wcc-element wcc-element-${kind}${ellipse ? ' is-ellipse' : ''}${selected ? ' is-selected' : ''}${editing ? ' is-editing' : ''}`}
    data-element-id={id}
    aria-label={`${label}：${text.slice(0, 80) || '空白'}`}
    style={{ '--wcc-element-paper': colour.paper, '--wcc-element-line': colour.line }}
    onDoubleClick={beginEdit}
  >
    <NodeResizer nodeId={id} isVisible={selected && !editing} minWidth={100} minHeight={60} maxWidth={1200} maxHeight={1200}
      color="var(--wtt-ui-accent, #3559c7)" handleClassName="wcc-element-resize-handle" lineClassName="wcc-element-resize-line"
      onResizeStart={() => data.onResizeStart?.(id)}
      onResizeEnd={(_event, { width, height }) => data.onChange?.(id, { width, height })}
    />
    <Handle type="target" position={Position.Left} isConnectable={isConnectable && !editing} aria-label={`连接到${label}`} />
    <div className="wcc-element-grip" aria-label={`拖动${label}`}>
      <span className="wcc-element-grip-lines" aria-hidden="true" />
      <UiButton variant="custom" type="button" className="wcc-element-edit nodrag nopan" aria-label={`编辑${label}文字`} onPointerDown={stop} onClick={beginEdit}>编辑</UiButton>
    </div>
    {editing ? <textarea
      ref={editor}
      className="wcc-element-editor nodrag nopan nowheel"
      aria-label={`编辑${label}文字`}
      value={draft}
      maxLength={30000}
      placeholder="写下想法…"
      onChange={event => setDraft(event.target.value)}
      onBlur={() => finishEdit(true)}
      onKeyDown={editingKey}
      onKeyUp={stop}
      onPointerDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      onWheel={stop}
      spellCheck={false}
    /> : <div className={`wcc-element-content${text ? '' : ' is-empty'}`}>{text || `双击输入${label === '图形' ? '文字' : label}`}</div>}
    <Handle type="source" position={Position.Right} isConnectable={isConnectable && !editing} aria-label={`从${label}连线`} />
  </article>
})

export function WhiteboardStyleControls({ element, onChange }) {
  const kind = element.elementKind || element.kind
  return <div className="wcc-element-style-controls" aria-label="白板元素样式">
    <div className="wcc-element-colours" role="group" aria-label="元素颜色">
      {Object.entries(COLOURS).map(([key, colour]) => <UiButton variant="custom" key={key} type="button"
        className="wcc-element-colour" aria-label={`元素颜色：${colour.label}`} title={colour.label}
        aria-pressed={(element.colour || 'cream') === key}
        style={{ '--wcc-swatch': colour.paper, '--wcc-swatch-line': colour.line }}
        onClick={() => onChange({ colour: key })}
      ><span aria-hidden="true" /></UiButton>)}
    </div>
    {kind === 'shape' && <div className="wcc-element-shape-controls" role="group" aria-label="图形形状">
      <UiButton variant="custom" type="button" aria-label="图形设为矩形" aria-pressed={element.shape !== 'ellipse'} onClick={() => onChange({ shape: 'rectangle' })}>矩形</UiButton>
      <UiButton variant="custom" type="button" aria-label="图形设为椭圆" aria-pressed={element.shape === 'ellipse'} onClick={() => onChange({ shape: 'ellipse' })}>椭圆</UiButton>
    </div>}
  </div>
}
