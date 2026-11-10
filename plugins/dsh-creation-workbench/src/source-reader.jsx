import { UiButton } from './ui/controls.jsx'
import { UserError } from './user-feedback.jsx'
import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import './source-reader.css'

const SOURCE_STATES = {
  ready: '来源可用', available: '来源可用', missing: '来源文件缺失',
  unavailable: '来源文件不可用', modified: '来源文件已变化', changed: '来源文件已变化',
  unextracted: '尚未提取正文', not_extracted: '尚未提取正文', linked: '仅关联文件',
}

function normalizeText(value) { return String(value ?? '').replace(/\r\n?/g, '\n') }
function messageOf(value) { return value instanceof Error ? value.message : String(value) }
function sourceState(value) { return SOURCE_STATES[value] || value || '来源状态未提供' }

function splitsSurrogate(text, offset) {
  if (offset <= 0 || offset >= text.length) return false
  return /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset])
}

function validRange(text, start, end) {
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= text.length
    && start < end && !splitsSurrogate(text, start) && !splitsSurrogate(text, end)
}

function describeRange(text, start, end) {
  const first = text.slice(0, start).split('\n').length
  const last = text.slice(0, end - 1).split('\n').length
  return first === last ? `第 ${first} 行` : `第 ${first}–${last} 行`
}

export function SourceReader({ card, initialRange, onExcerpt, onOpenSource, draft, onDraftChange, busy = false, error = '' }) {
  const id = useId()
  const readerRef = useRef(null)
  const identityRef = useRef('')
  const submittingRef = useRef(false)
  const identity = `${card?.id || ''}:${card?.sourceHash || ''}`
  const draftRef = useRef(draft)
  draftRef.current = draft
  const [selection, setSelection] = useState(() => draft?.identity === identity ? draft.selection : null)
  const [title, setTitle] = useState(() => draft?.identity === identity ? draft.title : '')
  const [annotation, setAnnotation] = useState(() => draft?.identity === identity ? draft.annotation : '')
  const [saving, setSaving] = useState(false)
  const [localError, setLocalError] = useState('')
  const [notice, setNotice] = useState('')
  const content = useMemo(() => normalizeText(card?.content), [card?.content])
  identityRef.current = identity
  const excerpt = card?.kind === 'excerpt' ? card.excerptInfo : null
  const readable = ['material', 'excerpt', 'outline', 'artifact'].includes(card?.kind)
  const textAvailable = readable && card?.extracted !== false && !!content.trim()
  const intact = !card?.status || ['ready', 'available'].includes(card.status)
  const canExcerpt = textAvailable && intact && !!card?.sourceHash
  const pending = !!busy || saving
  const start = initialRange?.start, end = initialRange?.end

  useEffect(() => {
    const saved = draftRef.current?.identity === identity ? draftRef.current : null
    setSelection(saved?.selection || null)
    setTitle(saved?.title ?? (card?.title ? `${card.title} · 摘录` : ''))
    setAnnotation(saved?.annotation || '')
    setLocalError('')
    setNotice('')
    setSaving(false)
    submittingRef.current = false
  }, [identity])

  function rememberDraft(patch) {
    onDraftChange?.({ identity, selection, title, annotation, saved: false, ...patch })
  }

  useEffect(() => {
    if (!textAvailable || !validRange(content, start, end)) return
    const reader = readerRef.current
    if (!reader) return
    reader.focus({ preventScroll: true })
    reader.setSelectionRange(start, end)
    const lineHeight = Number.parseFloat(getComputedStyle(reader).lineHeight) || 22
    reader.scrollTop = Math.max(0, (content.slice(0, start).split('\n').length - 2) * lineHeight)
    setSelection({ start, end, quote: content.slice(start, end) })
  }, [identity, content, textAvailable, start, end])

  function readSelection(event) {
    const reader = event.currentTarget
    const nextStart = reader.selectionStart, nextEnd = reader.selectionEnd
    const next = validRange(content, nextStart, nextEnd)
      ? { start: nextStart, end: nextEnd, quote: content.slice(nextStart, nextEnd) } : null
    setSelection(next)
    rememberDraft({ selection: next })
    setLocalError('')
    setNotice('')
  }

  async function saveExcerpt(event) {
    event.preventDefault()
    if (pending || submittingRef.current || !canExcerpt || !onExcerpt) return
    if (!selection?.quote.trim()) { setLocalError('先在原文中选择需要保存的片段。'); return }
    if (!title.trim()) { setLocalError('请填写摘录名称。'); return }
    const savedIdentity = identity
    submittingRef.current = true
    setSaving(true)
    setLocalError('')
    setNotice('')
    try {
      await onExcerpt({ sourceCardId: card.id, sourceHash: card.sourceHash,
        start: selection.start, end: selection.end, quote: selection.quote,
        title: title.trim(), annotation: annotation.trim() })
      if (identityRef.current !== savedIdentity) return
      setAnnotation('')
      rememberDraft({ annotation: '', saved: true })
      setNotice('摘录已保存。')
    } catch (cause) {
      if (identityRef.current === savedIdentity) setLocalError(messageOf(cause))
    } finally {
      if (identityRef.current === savedIdentity) { submittingRef.current = false; setSaving(false) }
    }
  }

  if (!card) return null

  return <section className="wcc-source-reader" aria-label="原文阅读与摘录" aria-busy={pending}>
    {excerpt && <div className="wcc-excerpt-origin">
      <span className="wcc-source-kicker">摘录来源</span>
      <strong>{excerpt.sourceTitle || '来源未命名'}</strong>
      <span>{excerpt.rangeLabel || (Number.isInteger(excerpt.start) && Number.isInteger(excerpt.end) ? `原文范围 ${excerpt.start}–${excerpt.end}` : '来源位置未提供')}</span>
      <p className={['ready', 'available'].includes(excerpt.sourceStatus) ? '' : 'is-warning'}>{sourceState(excerpt.sourceStatus)}</p>
      {onOpenSource && <UiButton variant="quiet" type="button" onClick={() => onOpenSource(excerpt)} disabled={pending || !excerpt.sourceCardId}>查看原文位置 →</UiButton>}
      <small>摘录和注释已独立保存，原文以后修改也不会影响这份摘录。</small>
    </div>}
    <div className="wcc-reader-heading">
      <label htmlFor={`${id}-text`}>{excerpt ? '摘录原文' : card.kind === 'outline' ? '已保存大纲原文' : '素材原文'}</label>
      {textAvailable && <span>{content.split('\n').length} 行 · {content.length} 字符</span>}
    </div>
    {textAvailable ? <>
      <textarea id={`${id}-text`} ref={readerRef} className="wcc-source-text" value={content}
        readOnly rows={13} spellCheck={false} onSelect={readSelection}
        aria-describedby={`${id}-selection`} />
      <p className="wcc-reader-selection" id={`${id}-selection`} aria-live="polite">
        {selection ? `${describeRange(content, selection.start, selection.end)} · 已选 ${selection.quote.length} 字符`
          : '在原文中拖选，或用 Shift + 方向键选择片段。'}
      </p>
    </> : <p className="wcc-inline-warning">{card.extracted === false
      ? '该文件尚未提取正文，当前不能读取或摘录。' : '当前卡片没有可用的已保存正文。'}</p>}
    {excerpt && <section className="wcc-reader-annotation" aria-label="注释">
      <span className="wcc-source-kicker">注释</span>
      <p>{excerpt.annotation || '未填写注释。'}</p>
    </section>}
    {textAvailable && !intact && <p className="wcc-inline-warning">{sourceState(card.status)}。保留的正文可供核对；核对并另存可用来源后再摘录。</p>}
    {textAvailable && intact && !card.sourceHash && <p className="wcc-inline-warning">暂时无法核对来源。请刷新内容后再保存摘录。</p>}
    {canExcerpt && <form className="wcc-excerpt-form" onSubmit={saveExcerpt}>
      <div className="wcc-reader-heading"><strong>另存为摘录卡</strong><span>可回到原文位置</span></div>
      {selection?.quote.trim() && <blockquote className="wcc-excerpt-selection">{selection.quote}</blockquote>}
      <label htmlFor={`${id}-title`}>摘录名称<input id={`${id}-title`} value={title} onChange={event => { setTitle(event.target.value); rememberDraft({ title: event.target.value }) }} disabled={pending} required /></label>
      <label htmlFor={`${id}-annotation`}>注释 <small>单独保存，不混入摘录原文</small><textarea id={`${id}-annotation`} rows={3} value={annotation} onChange={event => { setAnnotation(event.target.value); rememberDraft({ annotation: event.target.value }) }} placeholder="补充用途或说明" disabled={pending} /></label>
      <UiButton variant="primary" className="wcc-primary" type="submit" disabled={pending || !selection?.quote.trim() || !title.trim() || !onExcerpt}>{saving || busy === 'excerpt' ? '正在保存摘录…' : '保存摘录卡'}</UiButton>
    </form>}
    {(error || localError) && <UserError className="wcc-error" error={messageOf(error || localError)} />}
    {notice && <p className="wcc-reader-notice" role="status">{notice}</p>}
  </section>
}
