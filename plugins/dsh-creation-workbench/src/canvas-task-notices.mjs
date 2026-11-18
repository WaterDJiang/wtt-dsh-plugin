import { useEffect, useState } from 'react'
import { pendingLabel } from './pending-card-state.mjs'

export function completedCanvasTasks(tasks, statuses, pendingIds) {
  return tasks.filter(task => {
    if (task.status !== 'output' || pendingIds.has(task.id) || !(task.files?.length || task.artifacts?.length)) return false
    if (task.kind === 'media') return task.mediaJob?.status === 'succeeded'
    if (task.kind !== 'ai' || !['accepted', 'output'].includes(task.dispatchStatus)) return false
    return task.runtimeState?.phase === 'idle' && pendingLabel(task.runtimeState) === '本轮已结束'
      && statuses.get(task.sessionId)?.running !== true
  }).map(task => task.id)
}

function seenTasks(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key))
    if (Array.isArray(value)) return new Set(value.filter(id => typeof id === 'string'))
  } catch { /* Keep in-memory acknowledgements when storage is unavailable. */ }
  return null
}

export function useCanvasTaskNotices({ projectId, canvasId, ready, tasks, statuses, pendingIds }) {
  const key = `wtt-canvas-task-seen:${projectId}:${canvasId}`
  const [seen, setSeen] = useState(() => seenTasks(key))
  const completed = completedCanvasTasks(tasks, statuses, pendingIds)
  useEffect(() => {
    if (!ready || seen !== null) return
    // An old result may be present before the host finishes restoring its turn history.
    const existing = tasks.filter(task => task.status === 'output' && task.kind !== 'manual'
      && !pendingIds.has(task.id) && task.runtimeState?.phase !== 'generating'
      && statuses.get(task.sessionId)?.running !== true)
    setSeen(new Set(existing.map(task => task.id)))
  }, [ready, seen, tasks, pendingIds, statuses])
  useEffect(() => {
    if (seen === null) return
    try { localStorage.setItem(key, JSON.stringify([...new Set([...(seenTasks(key) || []), ...seen])])) }
    catch { /* Keep in-memory acknowledgement if storage is unavailable. */ }
  }, [key, seen])

  const unseen = new Set(seen === null ? [] : completed.filter(id => !seen.has(id)))
  function markSeen(id) {
    if (unseen.has(id)) setSeen(current => new Set([...current, id]))
  }
  return { seen, unseen, markSeen }
}
