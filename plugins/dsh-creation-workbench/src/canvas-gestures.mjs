export const MIN_CANVAS_ZOOM = 0.1;
export const MAX_CANVAS_ZOOM = 3;

export function scaleViewport(viewport, anchor, scale) {
  if (Number.isNaN(scale) || scale <= 0) return { ...viewport };
  const zoom = Math.min(MAX_CANVAS_ZOOM, Math.max(MIN_CANVAS_ZOOM, viewport.zoom * scale));
  const ratio = zoom / viewport.zoom;
  return { x: anchor.x - (anchor.x - viewport.x) * ratio, y: anchor.y - (anchor.y - viewport.y) * ratio, zoom };
}

export function wheelViewport(viewport, event, anchor, pageHeight = 800) {
  const unit = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? pageHeight : 1;
  const x = Number.isFinite(event.deltaX) ? event.deltaX * unit : 0;
  const y = Number.isFinite(event.deltaY) ? event.deltaY * unit : 0;
  // Trackpad pinch is delivered as Ctrl+wheel; ordinary scrolling never changes zoom.
  if (event.ctrlKey) return scaleViewport(viewport, anchor, Math.exp(-y * 0.01));
  return { x: viewport.x - x, y: viewport.y - y, zoom: viewport.zoom };
}

export function touchGeometry(points) {
  const [a, b] = [...points];
  if (!a || !b) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
}

export function touchViewport(viewport, start, current) {
  const scaled = scaleViewport(viewport, start, current.distance / start.distance);
  return { x: scaled.x + current.x - start.x, y: scaled.y + current.y - start.y, zoom: scaled.zoom };
}

const EDITOR = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),video,audio';

function scrollable(target, boundary) {
  for (let element = target; element && element !== boundary; element = element.parentElement) {
    const style = getComputedStyle(element);
    if ((/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1)
      || (/(auto|scroll)/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1)) return element;
  }
  return null;
}

// React Flow owns node drag/selection and single-touch pan. This adapter owns wheel
// and multi-touch navigation, including over draggable nodes whose `nopan` blocks it.
export function attachCanvasGestures(root, options) {
  const points = new Map();
  const removers = [];
  let disposed = false, multi = false, baseline = null, reader = null, webkit = null;
  let pending = null, frame = null, timer = null, changed = false, started = false, sequence = 0;
  let suppressClickUntil = 0, writing = Promise.resolve();
  const viewport = () => pending || options.getViewport();
  const within = target => target?.closest?.('.react-flow') && root.contains(target) ? target : null;
  const consume = event => { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); };
  const listen = (element, name, handler, config = { capture: true, passive: false }) => {
    element.addEventListener(name, handler, config);
    removers.push(() => element.removeEventListener(name, handler, config));
  };
  const start = () => { sequence++; if (!started) { started = true; options.onStart?.(); } };
  const flush = () => {
    if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
    if (pending) {
      const next = pending; pending = null;
      writing = Promise.resolve(options.setViewport(next)).catch(error => { if (!disposed) options.onError?.(error); });
    }
    return writing;
  };
  const schedule = next => {
    const before = viewport();
    if (Math.abs(before.x - next.x) < 0.00001 && Math.abs(before.y - next.y) < 0.00001 && Math.abs(before.zoom - next.zoom) < 0.000001) return;
    start(); changed = true; pending = next;
    if (frame === null) frame = requestAnimationFrame(() => { frame = null; void flush(); });
  };
  const finish = () => {
    clearTimeout(timer); timer = null;
    const ticket = ++sequence;
    void flush().then(() => {
      if (disposed || ticket !== sequence || multi || webkit) return;
      const save = changed; changed = false; started = false;
      options.onEnd?.(save, options.getViewport());
    });
  };
  const local = event => {
    const rect = root.querySelector('.react-flow')?.getBoundingClientRect() || root.getBoundingClientRect();
    return { x: Number.isFinite(event.clientX) ? event.clientX - rect.left : rect.width / 2,
      y: Number.isFinite(event.clientY) ? event.clientY - rect.top : rect.height / 2 };
  };

  listen(root, 'wheel', event => {
    const target = within(event.target);
    if (!target || !options.enabled()) return;
    if (target.closest(EDITOR) || !event.ctrlKey && scrollable(target, root)) {
      // Keep native content scrolling; do not let it bubble into the viewport handler.
      event.stopPropagation(); return;
    }
    consume(event);
    if (webkit || multi) return;
    schedule(wheelViewport(viewport(), event, local(event), root.clientHeight));
    clearTimeout(timer); timer = setTimeout(finish, 160);
  });

  listen(root, 'pointerdown', event => {
    if (event.pointerType !== 'touch') { if (!multi) suppressClickUntil = 0; return; }
    const target = within(event.target);
    if (!target || !options.enabled()) return;
    if (!points.size && !multi) {
      suppressClickUntil = 0;
      const element = scrollable(target, root);
      if (element) reader = { id: event.pointerId, element, x: event.clientX, y: event.clientY, moved: false };
    }
    if (target.closest(EDITOR)) return;
    points.set(event.pointerId, local(event));
    if (points.size < 2) return;
    consume(event); start(); multi = true; reader = null;
    baseline = { viewport: { ...viewport() }, geometry: touchGeometry(points.values()) };
    options.onMultiTouch?.();
  });

  listen(root, 'pointermove', event => {
    if (event.pointerType !== 'touch' || !options.enabled()) return;
    if (points.has(event.pointerId)) points.set(event.pointerId, local(event));
    if (multi) {
      consume(event);
      const geometry = touchGeometry(points.values());
      if (geometry && baseline) schedule(touchViewport(baseline.viewport, baseline.geometry, geometry));
      return;
    }
    if (reader?.id === event.pointerId) {
      const dx = event.clientX - reader.x, dy = event.clientY - reader.y;
      if (!reader.moved && Math.hypot(dx, dy) < 5) return;
      reader.moved = true;
      reader.element.scrollLeft -= dx; reader.element.scrollTop -= dy;
      reader.x = event.clientX; reader.y = event.clientY;
      consume(event); options.onMultiTouch?.();
    }
  });

  const up = event => {
    if (event.pointerType !== 'touch') return;
    if (reader?.id === event.pointerId) {
      if (reader.moved) suppressClickUntil = performance.now() + 350;
      reader = null;
    }
    points.delete(event.pointerId);
    if (!multi) return;
    suppressClickUntil = performance.now() + 350;
    if (points.size >= 2) baseline = { viewport: { ...viewport() }, geometry: touchGeometry(points.values()) };
    if (!points.size) { multi = false; baseline = null; finish(); }
    // Let existing d3 touch/drag end handlers release their original contact.
  };
  listen(window, 'pointerup', up);
  listen(window, 'pointercancel', up);
  listen(root, 'touchstart', event => {
    if (multi) consume(event);
    else if (reader) event.stopPropagation();
  });
  listen(root, 'touchmove', event => {
    if (multi || reader?.moved) consume(event);
  });
  const preventGhostClick = event => {
    if (multi || performance.now() < suppressClickUntil) consume(event);
  };
  listen(root, 'click', preventGhostClick);
  listen(root, 'dblclick', preventGhostClick);

  // Safari trackpads expose GestureEvent instead of Chromium's Ctrl+wheel.
  listen(root, 'gesturestart', event => {
    if (!within(event.target) || event.target.closest(EDITOR) || !options.enabled()) return;
    consume(event);
    if (multi) return;
    start(); webkit = { viewport: { ...viewport() }, anchor: local(event), scale: event.scale || 1 };
  });
  listen(root, 'gesturechange', event => {
    if (!webkit && !multi) return;
    consume(event);
    if (webkit) schedule(scaleViewport(webkit.viewport, webkit.anchor, event.scale / webkit.scale));
  });
  listen(root, 'gestureend', event => {
    if (!webkit) return;
    consume(event); webkit = null; finish();
  });

  const reset = () => { points.clear(); multi = false; baseline = null; reader = null; webkit = null; finish(); };
  listen(window, 'blur', reset);
  listen(document, 'visibilitychange', () => { if (document.hidden) reset(); });
  return () => {
    disposed = true; sequence++; clearTimeout(timer);
    if (frame !== null) cancelAnimationFrame(frame);
    for (const remove of removers) remove();
    points.clear(); options.onEnd?.(false, options.getViewport());
  };
}
