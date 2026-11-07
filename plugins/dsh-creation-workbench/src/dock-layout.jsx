import { useEffect, useRef, useState } from 'react'
import { DOCK_WIDTH_KEY, dockGeometry, dockKeyboardWidth } from './dock-width.mjs'
import './dock-layout.css'

export function useDockLayout(rootRef, active, editing = false) {
  const [total, setTotal] = useState(900)
  const [preferred, setPreferred] = useState(() => {
    try { const saved = Number(localStorage.getItem(DOCK_WIDTH_KEY)); return saved >= 320 && saved <= 900 ? saved : 480 } catch { return 480 }
  })
  const [dragging, setDragging] = useState(false)
  const [preferenceError, setPreferenceError] = useState('')
  const drag = useRef(null), frame = useRef(null), previous = useRef(480)
  const geometry = dockGeometry(total, preferred, editing)
  const latest = useRef(geometry); latest.current = geometry
  const persist = value => {
    setPreferred(value)
    try { localStorage.setItem(DOCK_WIDTH_KEY, String(value)); setPreferenceError('') }
    catch { setPreferenceError('宽度已调整，但浏览器未能保存设置。下次打开时可能恢复原宽度。') }
  }
  useEffect(() => {
    if (!active) return
    try { const saved = Number(localStorage.getItem(DOCK_WIDTH_KEY)); if (saved >= 320 && saved <= 900) setPreferred(saved) } catch { /* Keep the in-memory preference when browser storage is unavailable. */ }
  }, [active])
  useEffect(() => {
    if (!rootRef.current) return
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width
      if (width > 0) setTotal(width)
    })
    observer.observe(rootRef.current)
    return () => { observer.disconnect(); cancelAnimationFrame(frame.current) }
  }, [])
  const finish = (event, cancel = false) => {
    const state = drag.current
    if (!state || event.pointerId !== state.id) return
    cancelAnimationFrame(frame.current)
    drag.current = null; setDragging(false)
    if (cancel) setPreferred(state.preferred)
    else persist(dockGeometry(total, state.width + state.x - event.clientX, editing).width)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const separator = {
    role: 'separator', tabIndex: 0, 'aria-label': '调整右侧栏宽度', 'aria-orientation': 'vertical',
    'aria-valuemin': geometry.minimum, 'aria-valuemax': Math.round(geometry.maximum), 'aria-valuenow': Math.round(geometry.width),
    onPointerDown(event) {
      if (geometry.mobile || event.button !== 0) return
      event.preventDefault(); event.stopPropagation(); event.currentTarget.focus()
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { id: event.pointerId, x: event.clientX, width: geometry.width, preferred }
      setDragging(true)
    },
    onPointerMove(event) {
      const state = drag.current
      if (!state || event.pointerId !== state.id) return
      const x = event.clientX
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(() => setPreferred(dockGeometry(total, state.width + state.x - x, editing).width))
    },
    onPointerUp: event => finish(event), onPointerCancel: event => finish(event, true),
    onLostPointerCapture() { if (drag.current) { setPreferred(drag.current.preferred); drag.current = null; setDragging(false) } },
    onKeyDown(event) {
      event.stopPropagation()
      const next = dockKeyboardWidth(event.key, latest.current.width, latest.current, event.shiftKey)
      if (next !== null) { event.preventDefault(); persist(next) }
    },
  }
  return { ...geometry, dragging, separator, preferenceError, expanded: geometry.width === geometry.maximum,
    toggleExpanded() { if (geometry.width === geometry.maximum) persist(previous.current); else { previous.current = preferred; persist(geometry.maximum) } } }
}
