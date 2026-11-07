import { pptObjectStyle } from './ppt-editor-state.mjs'

export function pptInlineStyle(document, element, { editing = false } = {}) {
  const bounds = pptObjectStyle(document, element)
  if (!bounds) return null
  const text = element.textStyle || {}
  const font = Number.isFinite(text.fontPoints) && text.fontPoints > 0 && text.fontPoints <= 400
    ? text.fontPoints * 12700 / document.width * 100 : null
  const family = typeof text.fontFamily === 'string' && text.fontFamily.length <= 100 && !/[;{}\x00-\x1f]/.test(text.fontFamily)
    ? text.fontFamily : 'sans-serif'
  const color = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : null
  const margins = Array.isArray(text.margins) && text.margins.length === 4
    && text.margins.every(value => Number.isFinite(value) && value >= 0 && value <= document.width)
    ? text.margins.map(value => `${value / document.width * 100}cqw`).join(' ') : '3px 5px'
  return { ...bounds, fontSize: font ? editing ? `clamp(12px, ${font}cqw, 72px)` : `${font}cqw` : '14px',
    fontFamily: family, textAlign: ['left', 'center', 'right', 'justify'].includes(text.align) ? text.align : 'left',
    fontWeight: text.bold ? 700 : 400, fontStyle: text.italic ? 'italic' : 'normal',
    color: color(text.color) || '#222222', backgroundColor: color(text.backgroundColor) || '#ffffff', padding: margins }
}
