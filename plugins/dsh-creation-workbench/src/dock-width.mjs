export const DOCK_WIDTH_KEY = 'wtt-course-workbench.dock-width.v1'
export function dockGeometry(total, preferred = 480, editing = false) {
  const width = Number.isFinite(total) && total > 0 ? total : 900
  const mobile = width < (editing ? 640 : 760)
  const maximum = Math.min(900, width - 320)
  const requested = Number.isFinite(preferred) ? preferred : 480
  return { mobile, minimum: 320, maximum: mobile ? width : maximum,
    width: mobile ? width : Math.max(320, Math.min(maximum, requested)) }
}
export function dockKeyboardWidth(key, current, geometry, shift = false) {
  const step = shift ? 50 : 16
  const value = key === 'ArrowLeft' ? current + step : key === 'ArrowRight' ? current - step
    : key === 'Home' ? geometry.minimum : key === 'End' ? geometry.maximum : null
  return value === null ? null : Math.max(geometry.minimum, Math.min(geometry.maximum, value))
}
