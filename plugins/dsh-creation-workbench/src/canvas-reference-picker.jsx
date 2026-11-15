import React, { createContext, useContext, useEffect, useRef } from 'react'
import { UiButton } from './ui/controls.jsx'
import { cardDisplayTitle } from './card-capabilities.mjs'
import './canvas-reference-picker.css'

export const CanvasReferencePickerContext = createContext(null)

export function ReferencePickOverlay({ nodeId }) {
  const picker = useContext(CanvasReferencePickerContext)
  const control = useRef(null)
  const option = picker?.options.get(nodeId)
  useEffect(() => {
    if (!picker || !control.current) return
    const siblings = [...control.current.parentElement.children].filter(element => element !== control.current)
    const previous = siblings.map(element => element.inert)
    siblings.forEach(element => { element.inert = true })
    return () => siblings.forEach((element, index) => { element.inert = previous[index] })
  }, [Boolean(picker)])
  if (!picker) return null
  const title = cardDisplayTitle(option?.card) || '此卡片'
  const reason = option?.reason || (!option ? '此卡片没有可引用内容' : '')
  const disabled = picker.busy || option?.pinned || Boolean(reason && !option?.checked)
  return <UiButton ref={control} variant="custom" type="button" role="checkbox" aria-checked={Boolean(option?.checked)} aria-disabled={Boolean(disabled)}
    aria-label={`引用 ${title}${option?.pinned ? '，来源卡片，保留引用' : reason ? `，${reason}` : ''}`} title={option?.pinned ? '来源卡片 · 保留引用' : reason || title}
    className={`wcc-reference-pick-card nodrag nopan${option?.checked ? ' is-checked' : ''}`}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => { event.preventDefault(); event.stopPropagation() }}
    onClick={event => { event.stopPropagation(); if (!disabled) picker.onToggle(nodeId) }}>
    <span className="wcc-reference-pick-check" aria-hidden="true">{option?.pinned ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg> : option?.checked ? '✓' : ''}</span>
    {(reason || option?.pinned) && <span className="wcc-reference-pick-reason">{option?.pinned ? '来源卡片' : reason}</span>}
  </UiButton>
}
