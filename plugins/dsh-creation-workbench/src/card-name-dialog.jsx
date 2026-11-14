import React, { useEffect, useId, useRef, useState } from 'react'
import { DialogHeader, DialogBody, DialogFooter, UiButton } from './ui/controls.jsx'
import { UserError } from './user-feedback.jsx'

export function CardNameDialog({ title, busy, error, onSave, onClose }) {
  const ref = useRef(null), id = useId()
  const [value, setValue] = useState(title)
  useEffect(() => { ref.current?.showModal() }, [])
  return <dialog ref={ref} className="wtt-dialog" aria-labelledby={id} onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <form onSubmit={event => { event.preventDefault(); if (value.trim()) onSave(value.trim()) }}>
      <DialogHeader title="重命名卡片" titleId={id} busy={busy} onClose={onClose}/>
      <DialogBody><label>名称<input autoFocus required maxLength={200} value={value} disabled={busy} onChange={event => setValue(event.target.value)}/></label>
        {error && <UserError error={error}/>}</DialogBody>
      <DialogFooter><UiButton variant="quiet" disabled={busy} onClick={onClose}>取消</UiButton>
        <UiButton variant="primary" type="submit" disabled={busy || !value.trim()}>{busy ? '保存中…' : '保存'}</UiButton></DialogFooter>
    </form>
  </dialog>
}
