import { completedCanvasTasks } from './canvas-task-notices.mjs'
import { isActiveTaskPhase } from './pending-card-state.mjs'
import { taskInteractions } from './skill-interactions.mjs'

export function desktopTaskNotificationChannel(host, openWorkbench) {
  const Notification = host?.Notification
  if (host?.location?.protocol !== 'dsh-app:' || host.location.hostname !== 'app' || !host.dshDesktop || !Notification) return
  return {
    get permission() { return Notification.permission },
    requestPermission: () => Notification.requestPermission(),
    send({ title, pending, completed }) {
      const body = [pending && `${pending} 项待确认`, completed && `${completed} 项已完成`].filter(Boolean).join('，')
      const notification = new Notification(title, { body })
      notification.onclick = () => {
        host.focus()
        openWorkbench()
        notification.close()
      }
    },
  }
}

function isTracked(task, statuses, pendingIds) {
  if (task.kind === 'media') return ['queued', 'submitting', 'processing', 'downloading', 'registering'].includes(task.mediaJob?.status)
  return task.kind === 'ai' && (pendingIds.has(task.id) || statuses.get(task.sessionId)?.running === true
    || isActiveTaskPhase(task.runtimeState?.phase) || task.dispatchStatus === 'submitting')
}

export function createDesktopTaskNotices({ channel, readTasks, readStatuses, watchSessions, interval = 2500 }) {
  const records = new Map()
  let disposed = false
  const scopeKey = scope => JSON.stringify([scope.projectId, scope.canvasId])

  function publish(record, tasks, statuses, seen) {
    const interactions = taskInteractions(tasks, statuses, record.scope.canvasId).map(entry => ({ ...entry,
      key: entry.interaction.callId ? JSON.stringify([entry.task.id, entry.interaction.callId]) : entry.key,
    }))
    const pendingIds = new Set(interactions.map(entry => entry.task.id))
    const pending = interactions.filter(({ key, task }) => !record.pending.has(key) && !record.restoring.has(task.id))
    const completed = completedCanvasTasks(tasks, statuses, pendingIds)
      .filter(id => !seen.has(id) && !record.completed.has(id))
    for (const { key, task } of interactions) {
      record.pending.add(key)
      record.restoring.delete(task.id)
    }
    for (const task of tasks) {
      if (!['awaiting-input', 'awaiting-approval'].includes(task.runtimeState?.phase)) {
        record.restoring.delete(task.id)
      }
    }
    for (const id of completed) record.completed.add(id)
    record.tracked = tasks.filter(task => isTracked(task, statuses, pendingIds))
    if (record.initialized && channel.permission === 'granted' && (pending.length || completed.length)) {
      try { channel.send({ title: record.scope.title || 'WTT 创作工作台', pending: pending.length, completed: completed.length }) }
      catch (error) { console.warn('DSH 桌面任务通知发送失败', error) }
    }
    record.initialized = true
  }

  function observe(scope, tasks, statuses, seen) {
    if (disposed) return
    const key = scopeKey(scope)
    let record = records.get(key)
    if (!record) {
      const restoring = new Set(tasks.filter(task => ['awaiting-input', 'awaiting-approval'].includes(task.runtimeState?.phase)).map(task => task.id))
      record = { restoring, pending: new Set(), completed: new Set() }
      records.set(key, record)
    }
    record.stop?.()
    record.scope = scope
    record.seen = seen
    publish(record, tasks, statuses, seen)
  }

  function leave(scope) {
    const record = records.get(scopeKey(scope))
    if (disposed || !record?.tracked.length || record.stop) return
    const trackedIds = new Set(record.tracked.map(task => task.id))
    const sessionIds = record.tracked.filter(task => task.kind === 'ai' && task.sessionId).map(task => task.sessionId)
    const controller = new AbortController()
    let timer, watched = new Map(), failed = false
    const stopWatching = sessionIds.length ? watchSessions({ ...scope, sessionIds }, statuses => { watched = statuses }) : undefined
    record.stop = () => {
      controller.abort()
      clearTimeout(timer)
      stopWatching?.()
      record.stop = undefined
    }
    async function poll() {
      try {
        const tasks = await readTasks(scope, controller.signal)
        if (controller.signal.aborted) return
        publish(record, tasks.filter(task => task.requirementId === scope.canvasId && trackedIds.has(task.id)),
          new Map([...readStatuses(), ...watched]), record.seen)
        failed = false
      } catch (error) {
        if (controller.signal.aborted) return
        if (!failed) console.warn('DSH 桌面任务通知读取失败', error)
        failed = true
      }
      if (record.tracked.length) timer = setTimeout(poll, interval)
      else record.stop()
    }
    timer = setTimeout(poll, interval)
  }

  return { channel, observe, leave, dispose() {
    disposed = true
    for (const record of records.values()) record.stop?.()
    records.clear()
  } }
}
