import React, { useEffect, useId, useRef, useState } from 'react'
import { UiButton } from './ui/controls.jsx'
import { insertReferenceMention, referenceQueryAtCursor } from './reference-mention.mjs'

export function ReferencePromptInput({ textareaRef, onValueChange, onCursor, onSelect, onKeyDown, onSubmit,
  referenceOptions, searchReferences, acceptProjectFile, onMention, disabled, value, ...props }) {
  const id = useId()
  const ownInput = useRef(null), list = useRef(null), choosing = useRef(false)
  const input = textareaRef || ownInput
  const [range, setRange] = useState(null)
  const [active, setActive] = useState(0)
  const [files, setFiles] = useState(null)
  const [error, setError] = useState('')
  const query = range?.query
  const term = query?.normalize('NFC').toLowerCase()
  const matching = (referenceOptions || []).filter(option => option.searchText.includes(term || ''))
  const paths = new Set(matching.map(option => option.path).filter(Boolean))
  const projectResults = files?.query === query ? files : null
  const candidates = [...matching.slice(0, 24), ...(projectResults?.entries || [])
    .filter(entry => !paths.has(entry.path) && (!acceptProjectFile || acceptProjectFile(entry)))
    .map(entry => ({ key: entry.path, label: entry.name, detail: entry.path, mentionLabel: entry.path, projectFile: entry.path }))]
  const selected = Math.min(active, candidates.length - 1)
  const open = Boolean(range && !disabled)

  useEffect(() => {
    if (query === undefined || !searchReferences || disabled) return
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const result = await searchReferences(query, controller.signal)
        if (!controller.signal.aborted) setFiles({ query, ...result })
      } catch (cause) {
        if (!controller.signal.aborted) setFiles({ query, error: cause.message || String(cause) })
      }
    }, 160)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, searchReferences, disabled])

  useEffect(() => { setActive(0) }, [query])
  useEffect(() => {
    const panel = list.current
    const option = panel?.children[selected]
    if (!option) return
    if (option.offsetTop < panel.scrollTop) panel.scrollTop = option.offsetTop
    else if (option.offsetTop + option.offsetHeight > panel.scrollTop + panel.clientHeight) panel.scrollTop = option.offsetTop + option.offsetHeight - panel.clientHeight
  }, [selected])

  function inspect(element) {
    onCursor?.(element)
    if (!onMention || choosing.current) return
    setRange(element.selectionStart === element.selectionEnd ? referenceQueryAtCursor(element.value, element.selectionStart) : null)
  }

  async function choose(candidate) {
    if (!open || !candidate || choosing.current) return
    const source = input.current?.value
    if (source === undefined) return
    const next = insertReferenceMention(source, range, candidate.mentionLabel || candidate.label)
    if (next.text.length > 8000) { setError('创作要求最多 8000 字，请缩短后再插入引用。'); return }
    choosing.current = true
    setRange(null)
    setError('')
    try {
      if (!await onMention(candidate) || input.current?.value !== source) return
      onValueChange?.(next.text)
      requestAnimationFrame(() => {
        const field = input.current
        if (field?.value !== next.text) return
        if (document.activeElement === document.body) field.focus({ preventScroll: true })
        field.setSelectionRange(next.cursor, next.cursor)
      })
    } finally { choosing.current = false }
  }

  return <div className="wcc-reference-prompt" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setRange(null)
  }}>
    <textarea {...props} ref={input} value={value} disabled={disabled} maxLength={8000}
      aria-controls={open ? `${id}-references` : props['aria-controls']}
      aria-activedescendant={open && selected >= 0 ? `${id}-reference-${selected}` : props['aria-activedescendant']}
      aria-autocomplete="list"
      onChange={event => {
        onValueChange?.(event.target.value)
        setError('')
        if (!event.nativeEvent?.isComposing) inspect(event.target)
      }}
      onCompositionEnd={event => inspect(event.currentTarget)}
      onClick={event => inspect(event.currentTarget)}
      onSelect={event => { onSelect?.(event.currentTarget); if (range) inspect(event.currentTarget) }}
      onKeyDown={event => {
        if (event.nativeEvent?.isComposing) return
        if (open) {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRange(null); return }
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault()
            if (candidates.length) setActive((selected + (event.key === 'ArrowUp' ? -1 : 1) + candidates.length) % candidates.length)
            return
          }
          if (event.key === 'Enter' && !event.shiftKey || event.key === 'Tab' && !event.shiftKey && selected >= 0) {
            if (selected >= 0 || event.metaKey || event.ctrlKey) event.preventDefault()
            if (!event.metaKey && !event.ctrlKey) void choose(candidates[selected])
            return
          }
        }
        onKeyDown?.(event)
        if (!event.defaultPrevented && (event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); onSubmit?.() }
      }} />
    {open && <div className="wcc-creation-skill-picker wcc-reference-mention">
      <div className="wcc-creation-skill-picker-heading">引用资料</div>
      <div ref={list} className="wcc-creation-skill-options" id={`${id}-references`} role="listbox" aria-label="可引用的文件与卡片">
        {candidates.map((option, index) => <UiButton variant="custom" type="button" role="option" key={option.key}
          id={`${id}-reference-${index}`} aria-selected={index === selected} title={option.detail}
          tabIndex={-1} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)}
          onClick={() => void choose(option)}><strong>{option.label}</strong><span>{option.detail}</span></UiButton>)}
      </div>
      {searchReferences && !projectResults ? <small role="status">搜索项目文件…</small>
        : projectResults?.error ? <small role="status">项目文件搜索失败，可从文件栏添加。{projectResults.error}</small>
          : !candidates.length ? <small role="status">没有匹配资料，换个关键词或点「添加」。</small>
            : projectResults?.truncated && <small>结果有限，输入更具体的名称，或从文件栏添加。</small>}
    </div>}
    {error && <p className="wcc-creation-disabled-reason" role="status">{error}</p>}
  </div>
}
