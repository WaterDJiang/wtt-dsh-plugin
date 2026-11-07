import React, { useEffect, useRef, useState } from 'react'
import { UiButton } from './ui/controls.jsx'
import './slide-draft-cover.css'

export function SlideDraftCover({ project, loadCover, onOpen, title, running = false }) {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState(null)
  const [scale, setScale] = useState(0)
  const pageElement = useRef(null)
  const loader = useRef(loadCover)
  loader.current = loadCover
  const identity = `${project.id}:${project.coverRevision || ''}:${attempt}`
  const current = result?.identity === identity ? result : null
  useEffect(() => {
    const element = pageElement.current?.querySelector('.wcc-slide-draft-page')
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setScale(Math.min(entry.contentRect.width / 1920, entry.contentRect.height / 1080)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let disposed = false
    if (!project.coverRevision || project.coverError || !loader.current) return
    Promise.resolve().then(() => loader.current({ projectId: project.id, requirementId: project.requirementId, revision: project.coverRevision })).then(cover => {
      if (cover.projectId !== project.id || cover.revision !== project.coverRevision || !cover.document || !cover.pageCount) throw new Error('草稿封面与当前工程不一致，请重新读取')
      if (!disposed) setResult({ identity, cover })
    }).catch(error => { if (!disposed) setResult({ identity, error: error.message || String(error) }) })
    return () => { disposed = true }
  }, [identity, project.coverError])
  const error = project.coverError || current?.error || (!loadCover ? '工程预览暂不可用' : !project.coverRevision ? '尚无可读取的工程封面' : null)
  return <div ref={pageElement} className="wcc-slide-draft-cover">
    <UiButton variant="custom" className="wcc-slide-draft-page" aria-label={`双击查看工程草稿：${title}`} disabled={!onOpen}
      onClick={event => { if (event.detail === 0) { event.stopPropagation(); onOpen?.() } }} onDoubleClick={event => { event.stopPropagation(); onOpen?.() }}>
      {current?.cover ? <iframe title={`${title}工程草稿封面`} sandbox="" referrerPolicy="no-referrer" srcDoc={current.cover.document} tabIndex={-1} style={{ transform: `translate(-50%, -50%) scale(${scale})`, visibility: scale ? 'visible' : 'hidden' }} />
        : <span role="status">{error || '正在读取工程封面…'}</span>}
    </UiButton>
    <div className="wcc-slide-draft-caption"><span>{running ? '已有工程草稿' : '工程草稿'}{current?.cover ? ` · ${current.cover.pageCount} 页` : ''}</span>
      <UiButton variant="quiet" onClick={event => { event.stopPropagation(); onOpen?.() }} disabled={!onOpen}>查看草稿 ↗</UiButton></div>
    {error && <div className="wcc-slide-draft-error"><span>{error}</span><UiButton variant="quiet" onClick={event => { event.stopPropagation(); setAttempt(value => value + 1) }}>重新读取</UiButton></div>}
  </div>
}
