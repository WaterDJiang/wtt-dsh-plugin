import { UiButton } from './ui/controls.jsx'
import React, { useEffect, useRef, useState } from 'react'
import { pptObjectStyle } from './ppt-editor-state.mjs'
import { pptInlineStyle } from './ppt-inline-style.mjs'

function InlineText({ document, element, onChange, onFinish }) {
  const input = useRef(null), initial = useRef(element.text), composing = useRef(false), cancelled = useRef(false)
  useEffect(() => {
    input.current?.focus({ preventScroll: true })
    input.current?.setSelectionRange(initial.current.length, initial.current.length)
  }, [])
  return <textarea ref={input} className="wtt-ppt-inline-input" aria-label={`原位编辑：${element.name || '文字框'}`}
    style={pptInlineStyle(document, element, { editing: true })} value={element.text} maxLength={50000} spellCheck={false}
    onChange={event => onChange(event.currentTarget.value)}
    onCompositionStart={() => { composing.current = true }}
    onCompositionEnd={event => { composing.current = false; onChange(event.currentTarget.value) }}
    onKeyDown={event => {
      if (composing.current || event.nativeEvent?.isComposing || event.keyCode === 229) { event.stopPropagation(); return }
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); cancelled.current = true
        onChange(initial.current); event.currentTarget.blur()
      }
    }}
    onBlur={event => {
      const value = cancelled.current ? initial.current : event.currentTarget.value
      composing.current = false; onChange(value)
      onFinish({ cancelled: cancelled.current, changed: value !== initial.current })
    }} />
}

export function PptTextLayer({ document, slide, renderedSlide, selectedId, disabled, showBounds, onSelect, onEdit, onCommit, onEditingChange }) {
  const [editingId, setEditingId] = useState(null)
  useEffect(() => () => onEditingChange?.(false), [])
  function finish(result) {
    setEditingId(null); onEditingChange?.(false)
    if (!result.cancelled) onCommit?.(result)
  }
  return (slide?.elements || []).map(element => {
    if (!element.text && element.editable === false) return null
    const style = pptObjectStyle(document, element)
    if (!style) return null
    const editable = element.editable !== false
    const rendered = renderedSlide?.elements.find(item => item.id === element.id)
    const changed = editable && rendered && rendered.text !== element.text
    if (editingId === element.id && editable && !disabled) return <InlineText key={element.id} document={document} element={element}
      onChange={text => onEdit?.({ slideId: slide.id, elementId: element.id, text })} onFinish={finish} />
    return <React.Fragment key={element.id}>
      {changed && <div className="wtt-ppt-inline-draft" style={pptInlineStyle(document, element)} aria-hidden="true">{element.text}</div>}
      <UiButton variant="custom" type="button" className={`wtt-ppt-object${selectedId === element.id ? ' is-selected' : ''}${editable ? '' : ' is-readonly'}`}
        style={style} aria-label={`${editable ? '直接编辑文字' : '查看只读文字'}：${element.text.replace(/\s+/g, ' ').trim().slice(0, 40) || '空文字框'}`}
        aria-pressed={selectedId === element.id} disabled={disabled}
        title={editable ? '单击直接修改文字' : element.reason || '此文字暂不可编辑'}
        onClick={() => { onSelect?.(element.id); if (editable) { setEditingId(element.id); onEditingChange?.(true) } }} />
    </React.Fragment>
  })
}
