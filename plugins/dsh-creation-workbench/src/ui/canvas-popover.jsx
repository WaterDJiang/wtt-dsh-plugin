import React, { useEffect, useLayoutEffect, useRef } from 'react'
import { autoUpdate, computePosition, flip, hide, offset, shift, size } from '@floating-ui/dom'

const surface = { position: 'fixed', inset: '0 auto auto 0', margin: 0, minWidth: 0, transform: 'none', visibility: 'hidden',
  boxSizing: 'border-box', overflow: 'auto', overscrollBehavior: 'contain', color: 'inherit' }

// The top layer escapes the composer's scrolling region and React Flow's
// transformed nodes, while retaining their DOM, focus and theme inheritance.
export function CanvasPopover({ open = true, anchorRef, anchor, widthRef, initialFocusRef, boundary, placement = 'bottom-start', onDismiss, ...props }) {
  const panelRef = useRef(null)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  const native = typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover === 'function'

  useEffect(() => {
    if (!open || !onDismiss) return
    const outside = event => {
      if (!(anchorRef?.current || anchor)?.contains(event.target) && !panelRef.current?.contains(event.target)) dismiss.current?.()
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open, Boolean(onDismiss), anchorRef, anchor])

  useLayoutEffect(() => {
    const target = anchorRef?.current || anchor
    const panel = panelRef.current
    if (!native || !open || !target || !panel) return
    const clippingBoundary = boundary || target.closest('.wcc-graph') || target.closest('.wtt-course-canvas') || 'clippingAncestors'
    const computed = getComputedStyle(panel)
    const { maxWidth, maxHeight } = computed
    const spacing = parseFloat(computed.getPropertyValue('--wtt-space-2')) || 8
    const bounds = { boundary: clippingBoundary, padding: spacing }
    let revision = 0
    let focusPending = Boolean(initialFocusRef)
    panel.style.visibility = 'hidden'
    panel.showPopover()

    function place() {
      const request = ++revision
      if (!target.getClientRects().length) { panel.style.visibility = 'hidden'; return }
      if (widthRef?.current) panel.style.width = `${widthRef.current.getBoundingClientRect().width}px`
      void computePosition(target, panel, {
        strategy: 'fixed', placement,
        middleware: [
          offset(spacing),
          flip({ ...bounds, crossAxis: false, fallbackAxisSideDirection: 'end' }),
          shift(bounds),
          size({ ...bounds, apply({ availableWidth, availableHeight }) {
            if (request !== revision) return
            const width = `${Math.max(0, availableWidth)}px`
            const height = `${Math.max(0, availableHeight)}px`
            panel.style.maxWidth = maxWidth === 'none' ? width : `min(${width}, ${maxWidth})`
            panel.style.maxHeight = maxHeight === 'none' ? height : `min(${height}, ${maxHeight})`
          } }),
          hide(bounds),
        ],
      }).then(({ x, y, middlewareData, placement: side }) => {
        if (request !== revision) return
        panel.style.left = `${x}px`
        panel.style.top = `${y}px`
        const visible = !middlewareData.hide.referenceHidden
        panel.style.visibility = visible ? 'visible' : 'hidden'
        panel.dataset.placement = side
        if (visible && focusPending) {
          focusPending = false
          initialFocusRef.current?.focus({ preventScroll: true })
        }
      })
    }

    const stop = autoUpdate(target, panel, place, { animationFrame: true })
    const resize = clippingBoundary === 'clippingAncestors' ? null : new ResizeObserver(place)
    resize?.observe(clippingBoundary)
    return () => {
      revision += 1
      stop()
      resize?.disconnect()
      if (panel.matches(':popover-open')) panel.hidePopover()
      panel.style.maxWidth = ''
      panel.style.maxHeight = ''
      panel.style.width = ''
    }
  }, [native, open, anchorRef, anchor, widthRef, initialFocusRef, boundary, placement])

  return <div {...props} ref={panelRef} hidden={!open} popover={native ? 'manual' : undefined}
    style={native ? surface : undefined} />
}
