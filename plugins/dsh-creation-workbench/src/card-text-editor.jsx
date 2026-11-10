import React, { useEffect, useRef, useState } from 'react'
import { cardCapabilities } from './card-capabilities.mjs'
import { RichTextEditor } from './rich-text-editor.jsx'
import { PanelHeader, PanelToolbar, UiButton } from './ui/controls.jsx'
import { UserError } from './user-feedback.jsx'

const SAVE_LABELS = { draft: '保存正文', background: '保存背景', version: '保存新版本', snapshot: '保存到文件', 'project-file': '保存到文件' }

export function CardTextEditor({ card, title, initialDraft, onDraft, onSave, onClose, downloadHref, onToggleWidth, expanded, autoFocus }) {
  const { editableText: { base }, writeBack: { mode } } = cardCapabilities(card)
  const [draft, setDraft] = useState(initialDraft ?? base)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const editor = useRef(null)
  const inFlight = useRef(false)
  const dirty = draft !== base
  const canSave = dirty && Boolean(draft.trim()) && !saving
  const markdown = mode === 'draft' || card.kind === 'outline' || /\.(md|markdown)$/i.test(card.importedFile?.name || card.path || '')
  useEffect(() => { if (autoFocus) editor.current?.focus() }, [autoFocus])

  async function save() {
    if (!canSave || inFlight.current) return
    inFlight.current = true
    setSaving(true)
    setError('')
    try { await onSave(draft) }
    catch (cause) { setError(cause.message || String(cause)) }
    finally { inFlight.current = false; setSaving(false) }
  }

  return <section className="wcc-sidebar wcc-text-editor-panel" aria-label="正文编辑" aria-busy={saving} onKeyDown={event => {
    event.stopPropagation()
    if (event.nativeEvent?.isComposing || saving) return
    if (event.key === 'Escape') { event.preventDefault(); onClose() }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void save() }
  }}>
    <PanelHeader title={title} downloadHref={downloadHref} expanded={expanded} onToggleWidth={onToggleWidth}
      onClose={onClose} closeLabel="关闭正文编辑" closeDisabled={saving} />
    <PanelToolbar>
      <UiButton variant="primary" onClick={save} disabled={!canSave}>{saving ? '保存中…' : SAVE_LABELS[mode] || '另存素材'}</UiButton>
      {dirty && <UiButton variant="quiet" disabled={saving} onClick={() => { onDraft(null); onClose() }}>放弃草稿</UiButton>}
    </PanelToolbar>
    {error && <UserError error={error} />}
    <div className="wcc-text-editor-body">
      <RichTextEditor ref={editor} label={`编辑 ${title} 的正文`} value={draft} disabled={saving} markdown={markdown}
        onChange={value => { setDraft(value); onDraft(value === base ? null : value) }} />
    </div>
  </section>
}
