import { PanelHeader, PanelToolbar, UiButton } from './ui/controls.jsx'
import { UserError } from './user-feedback.jsx'
import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { diffLines, normalizeLineEndings, savedPassage } from './text-diff.mjs'
import './outline-desk.css'

const versionName = version => `v${String(version?.number ?? '?').padStart(3, '0')}`
const lineAt = (text, offset) => text.slice(0, offset).split('\n').length

function Difference({ result }) {
  if (!result) return null
  return <div className="wcc-outline-diff" aria-label="完整大纲差异">
    <div className="wcc-outline-diff-summary">
      <span>{result.removed || result.added ? <><b className="is-added">+{result.added} 行</b><b className="is-deleted">−{result.removed} 行</b></> : '两份正文相同'}</span>
      <span>{result.mode === 'blocks' ? '内容较长或差异较多，按完整区块展示，未省略正文。' : '左侧为原行号，右侧为新行号；保留全文与空行。'}</span>
    </div>
    <div className="wcc-outline-diff-body" tabIndex={0}>
      {result.blocks.map((block, index) => result.mode === 'blocks'
        ? <section key={index} className={`wcc-outline-diff-block is-${block.type}`} aria-label={block.type === 'equal' ? '未修改区块' : block.type === 'delete' ? '删除区块' : '新增区块'}>
          <div className="wcc-outline-block-heading">{block.type === 'equal' ? '未修改' : block.type === 'delete' ? '− 删除' : '+ 新增'}<span>{block.type !== 'add' ? `原 ${block.oldStart}–${block.oldStart + block.lines.length - 1} 行` : ''}{block.type === 'equal' ? ' · ' : ''}{block.type !== 'delete' ? `新 ${block.newStart}–${block.newStart + block.lines.length - 1} 行` : ''}</span></div>
          <div className="wcc-outline-block-content"><pre className="wcc-outline-block-gutter" aria-hidden="true">{block.lines.map((_, i) => (block.type === 'add' ? block.newStart : block.oldStart) + i).join('\n')}</pre><pre>{block.lines.join('\n') || '\u200b'}</pre></div>
        </section>
        : block.lines.map((line, offset) => <div key={`${index}-${offset}`} className={`wcc-outline-diff-line is-${block.type}`}>
          <span className="wcc-outline-line-number" aria-hidden="true">{block.type === 'add' ? '' : block.oldStart + offset}</span>
          <span className="wcc-outline-line-number" aria-hidden="true">{block.type === 'delete' ? '' : block.newStart + offset}</span>
          <span className="wcc-outline-line-mark" aria-hidden="true">{block.type === 'add' ? '+' : block.type === 'delete' ? '−' : ''}</span>
          <pre>{line || '\u200b'}</pre>
        </div>))}
    </div>
  </div>
}

export function OutlineDesk({ version, versions = [], value, onChange, onClose, onSave, onExport, onPassage, downloadHref, busy = false, error }) {
  const editor = useRef(null)
  const id = useId()
  const [view, setView] = useState('edit')
  const [comparison, setComparison] = useState('draft')
  const [leftId, setLeftId] = useState('')
  const [rightId, setRightId] = useState('')
  const [selection, setSelection] = useState(null)
  const source = normalizeLineEndings(version?.markdown)
  const draft = normalizeLineEndings(value ?? version?.markdown)
  const dirty = draft !== source
  const savedVersions = useMemo(() => {
    const unique = new Map(versions.filter(item => item && typeof item.markdown === 'string').map(item => [item.id, item]))
    if (version && typeof version.markdown === 'string') unique.set(version.id, version)
    return [...unique.values()].sort((a, b) => a.number - b.number)
  }, [version, versions])
  const previousVersion = savedVersions.filter(item => item.id !== version?.id && item.number < version?.number).at(-1)
  const leftVersion = savedVersions.find(item => item.id === leftId) || previousVersion || savedVersions.find(item => item.id !== version?.id) || version
  const rightVersion = savedVersions.find(item => item.id === rightId) || version
  const passage = selection && version ? savedPassage(source, draft, selection.start, selection.end) : null
  const result = useMemo(() => view === 'compare'
    ? diffLines(comparison === 'draft' ? source : leftVersion?.markdown, comparison === 'draft' ? draft : rightVersion?.markdown)
    : null, [view, comparison, source, draft, leftVersion, rightVersion])
  const selectionMessage = dirty ? '当前有未保存修改，先保存新版本再选择片段。' : passage
    ? `已选择第 ${lineAt(source, passage.start)}–${lineAt(source, passage.end - 1)} 行 · ${passage.quote.length} 字符`
    : '在正文中选择片段，再交给 AI 制课。'
  useEffect(() => { setSelection(null) }, [version?.id, source])

  function readSelection() {
    const element = editor.current
    if (element) setSelection({ start: element.selectionStart, end: element.selectionEnd })
  }
  function keyboard(event) {
    event.stopPropagation()
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      if (dirty && draft.trim() && !busy) onSave?.()
    }
  }
  return <section className="wcc-outline-desk" aria-label="大纲专注编辑" onKeyDown={keyboard} onPointerDown={event => event.stopPropagation()}>
    <PanelHeader title={`大纲编辑 · ${versionName(version)}`} subtitle={dirty?'未保存草稿':'已保存版本'} downloadHref={downloadHref} downloadLabel="下载已保存的 Word" onClose={onClose} closeLabel="关闭专注编辑"/>
      <PanelToolbar>
        <UiButton variant="quiet" onClick={() => { setView('edit'); if (passage && !busy) onPassage?.(passage) }} disabled={!!busy || dirty || !passage || !onPassage} title={dirty ? '先保存新版本，再选择片段交给 AI' : '将已保存版本的所选片段交给 AI'}>选段交给 AI ↗</UiButton>
        <UiButton variant="quiet" onClick={onExport} disabled={!!busy || dirty || !version || !onExport} title={dirty ? '先保存新版本，再导出 Word' : `导出 ${versionName(version)} 对应的 Word`}>导出 Word</UiButton>
        
        <UiButton variant="primary" className="wcc-outline-save" onClick={onSave} disabled={!!busy || !dirty || !draft.trim() || !onSave}>{busy ? '处理中…' : '保存新版本'}</UiButton>
      </PanelToolbar>
    
    <nav className="wcc-outline-desk-nav" aria-label="大纲工作视图">
      <div className="wcc-outline-view-switch"><UiButton variant="quiet" className={view === 'edit' ? 'is-active' : ''} aria-pressed={view === 'edit'} onClick={() => setView('edit')}>编辑大纲</UiButton><UiButton variant="quiet" className={view === 'compare' ? 'is-active' : ''} aria-pressed={view === 'compare'} onClick={() => setView('compare')}>全文比较</UiButton></div>
      <span>{draft.length.toLocaleString()} 字符 · {draft.split('\n').length.toLocaleString()} 行</span>
    </nav>
    {error && <UserError className="wcc-outline-desk-error" error={error instanceof Error ? error.message : String(error)} />}
    {view === 'edit' ? <div className="wcc-outline-editor-area">
      <label htmlFor={`${id}-editor`} className="wcc-outline-editor-label"><span>{versionName(version)} 的编辑草稿</span><span>Markdown · ⌘ / Ctrl + S 保存新版本</span></label>
      <textarea ref={editor} id={`${id}-editor`} className="wcc-outline-desk-textarea" aria-describedby={`${id}-selection`} value={draft} onChange={event => { setSelection(null); onChange?.(event.target.value) }} onSelect={readSelection} onKeyUp={readSelection} onMouseUp={readSelection} readOnly={!!busy} spellCheck={false} placeholder="在这里编辑完整课程大纲" />
    </div> : <div className="wcc-outline-comparison">
      <div className="wcc-outline-compare-controls">
        <label><span>比较内容</span><select value={comparison} onChange={event => setComparison(event.target.value)}><option value="draft">当前版本 → 当前草稿</option><option value="versions">两个已保存版本</option></select></label>
        {comparison === 'versions' ? <><label><span>原版本</span><select value={leftVersion?.id || ''} onChange={event => setLeftId(event.target.value)}>{savedVersions.map(item => <option key={item.id} value={item.id}>{versionName(item)}</option>)}</select></label><span className="wcc-outline-compare-arrow" aria-hidden="true">→</span><label><span>新版本</span><select value={rightVersion?.id || ''} onChange={event => setRightId(event.target.value)}>{savedVersions.map(item => <option key={item.id} value={item.id}>{versionName(item)}</option>)}</select></label></> : <span className="wcc-outline-compare-description">{versionName(version)} → 当前草稿</span>}
      </div>
      <Difference result={result} />
    </div>}
    <footer className={`wcc-outline-desk-footer${dirty ? ' is-dirty' : ''}`} id={`${id}-selection`}><span>{selectionMessage}</span><span>{dirty ? '修改只在当前页面；点击保存生成独立版本。' : '版本原文保留，修改另存为新版本。'}</span></footer>
  </section>
}
