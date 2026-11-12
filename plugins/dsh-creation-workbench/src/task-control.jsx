import React, { useEffect, useRef, useState } from 'react'
import { DialogFooter, DialogHeader, UiButton } from './ui/controls.jsx'
import { UserError } from './user-feedback.jsx'
import './canvas-recycle.css'

export function TaskControlDialog({ taskId, requirementId, request, onClose, onChanged, onRemove }) {
  const dialog = useRef(null), mounted = useRef(false), epoch = useRef(0)
  const [model, setModel] = useState(null), [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function inspect() {
    const read = ++epoch.current
    setLoading(true); setError('')
    try {
      const next = await request('inspect-task-control', { taskId, requirementId })
      if (mounted.current && epoch.current === read) setModel(next)
    } catch (cause) { if (mounted.current && epoch.current === read) setError(cause.message) }
    finally { if (mounted.current && epoch.current === read) setLoading(false) }
  }
  useEffect(() => {
    mounted.current = true; dialog.current?.showModal(); void inspect()
    return () => { mounted.current = false; epoch.current++ }
  }, [taskId, requirementId])
  async function act() {
    if (busy || loading || !model) return
    setBusy(true); setError('')
    try {
      if (model.canStop) {
        const next = await request('stop-task-control', { taskId, requirementId, token: model.token })
        if (mounted.current) setModel(next)
      } else if (model.job?.canResume) {
        await request('resume-media', { taskId }); await inspect()
      } else { onClose(); onRemove?.(); return }
      await onChanged()
    } catch (cause) { if (mounted.current) setError(cause.message) }
    finally { if (mounted.current) setBusy(false) }
  }
  const removable = model && !model.stopping && ['unknown', 'paused', 'cancelled', 'idle', 'failed', 'succeeded'].includes(model.state)
  const action = model?.canStop ? model.stopLabel : model?.job?.canResume ? '继续跟进' : removable && onRemove ? '移除卡片' : null
  return <dialog ref={dialog} className="wtt-recycle-dialog" aria-labelledby="wtt-task-control-title"
    aria-busy={busy || loading} onKeyDown={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <DialogHeader title="任务控制" titleId="wtt-task-control-title" onClose={onClose} busy={busy} />
    <div className="wtt-recycle-body">
      {loading && <p role="status">正在核对任务…</p>}
      {model && <>
        <strong>{model.title}</strong>
        <p role="status">{model.message}</p>
        {model.relatedCount > 1 && <details open><summary>同一对话关联 {model.relatedCount} 项任务</summary>
          <ul>{model.relatedTasks.map(task => <li key={task.id}>{task.title}</li>)}</ul>
          {model.relatedCount > model.relatedTasks.length && <p>另有 {model.relatedCount - model.relatedTasks.length} 项</p>}
        </details>}
      </>}
      {error && <UserError error={error} />}
    </div>
    <DialogFooter>
      <UiButton size="compact" disabled={busy || loading} onClick={() => void inspect()}>重新核对</UiButton>
      <UiButton size="compact" disabled={busy} onClick={onClose}>关闭</UiButton>
      {action && <UiButton size="compact" variant={model.canStop ? 'danger' : 'primary'} disabled={busy || loading}
        onClick={() => void act()}>{busy ? '正在处理…' : action}</UiButton>}
    </DialogFooter>
  </dialog>
}
