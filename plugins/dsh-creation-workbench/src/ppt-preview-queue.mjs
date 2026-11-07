/** One expensive render at a time; keep only the latest settled edit. */
export function createPptPreviewQueue(run, { delay = 1200, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let pending = null, timer = null, running = false, paused = false, closed = false
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null }
  const supersede = () => { pending?.resolve(null); pending = null }
  async function flush() {
    timer = null
    if (closed || paused || running || !pending) return
    const next = pending; pending = null; running = true
    try { next.resolve(await run(next.value)) } catch (cause) { next.reject(cause) }
    finally { running = false; if (pending && timer === null && !paused && !closed) void flush() }
  }
  return {
    schedule(value, { immediate = false } = {}) {
      if (closed) return Promise.resolve(null)
      clear(); supersede(); paused = false
      const promise = new Promise((resolve, reject) => { pending = { value, resolve, reject } })
      if (immediate) void flush(); else timer = setTimer(flush, delay)
      return promise
    },
    pause() { paused = true; clear() },
    resume() { if (!closed) { paused = false; if (pending && timer === null) timer = setTimer(flush, delay) } },
    cancel() { clear(); supersede() },
    close() { closed = true; clear(); supersede() },
  }
}
