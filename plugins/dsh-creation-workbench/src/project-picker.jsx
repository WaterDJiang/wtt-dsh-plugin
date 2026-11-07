import { DialogFooter, DialogHeader, UiButton } from './ui/controls.jsx'
import { UserError } from './user-feedback.jsx'
import React, { useEffect, useId, useRef, useState } from 'react'
import './project-picker.css'

function messageOf(error) {
  return error?.rpcError?.message || (error instanceof Error ? error.message : String(error))
}

function FolderIcon({ className = '' }) {
  return <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7.5V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M3 9h18" /></svg>
}

function projectName(project) {
  return project.name || project.path?.split(/[\\/]/).filter(Boolean).pop() || project.path
}

export function ProjectPicker({ currentProject, projects = [], browseDirectory, onOpenProject, onClose, busy = false, purpose = 'project' }) {
  const isSkill = purpose === 'skill'
  const titleId = useId()
  const hintId = useId()
  const pathId = useId()
  const dialog = useRef(null)
  const mounted = useRef(false)
  const controller = useRef(null)
  const scan = useRef(0)
  const inputRevision = useRef(0)
  const opening = useRef(false)
  const browseRef = useRef(browseDirectory)
  const openRef = useRef(onOpenProject)
  const initialPath = useRef(currentProject?.path)
  const [path, setPath] = useState(currentProject?.path || '')
  const [listing, setListing] = useState(null)
  const [loading, setLoading] = useState(true)
  const [browseError, setBrowseError] = useState('')
  const [openError, setOpenError] = useState('')
  const [openingPath, setOpeningPath] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  browseRef.current = browseDirectory
  openRef.current = onOpenProject

  const working = busy || Boolean(openingPath)
  const entries = (listing?.entries || []).filter(entry => showHidden || !entry.hidden)
  const parent = listing?.crumbs?.length > 1 ? listing.crumbs[listing.crumbs.length - 2] : null
  const chosenPath = path.trim()

  useEffect(() => {
    mounted.current = true
    dialog.current?.showModal()
    void navigate(initialPath.current)
    return () => {
      mounted.current = false
      scan.current += 1
      controller.current?.abort()
      dialog.current?.close()
    }
  }, [])

  async function navigate(target) {
    const ticket = ++scan.current
    controller.current?.abort()
    const request = new AbortController()
    controller.current = request
    if (typeof target === 'string') setPath(target)
    const revision = ++inputRevision.current
    setLoading(true)
    setBrowseError('')
    setOpenError('')
    try {
      if (typeof browseRef.current !== 'function') throw new Error('目录浏览暂不可用，请粘贴项目文件夹的完整路径。')
      const next = await browseRef.current(target, request.signal)
      if (!mounted.current || ticket !== scan.current || request.signal.aborted) return
      if (!next || typeof next.path !== 'string' || !Array.isArray(next.entries)) throw new Error('未能读取目录，请重新选择或粘贴完整路径。')
      setListing(next)
      if (revision === inputRevision.current) setPath(next.path)
    } catch (error) {
      if (mounted.current && ticket === scan.current && !request.signal.aborted) setBrowseError(messageOf(error))
    } finally {
      if (mounted.current && ticket === scan.current) setLoading(false)
    }
  }

  async function openProject(target) {
    if (working || opening.current || !target?.trim()) return
    opening.current = true
    controller.current?.abort()
    scan.current += 1
    inputRevision.current += 1
    setPath(target.trim())
    setLoading(false)
    setBrowseError('')
    setOpeningPath(target)
    setOpenError('')
    try {
      await openRef.current(target.trim())
    } catch (error) {
      if (mounted.current) setOpenError(messageOf(error))
    } finally {
      opening.current = false
      if (mounted.current) setOpeningPath('')
    }
  }

  function changePath(value) {
    inputRevision.current += 1
    setPath(value)
    setOpenError('')
  }

  return <dialog ref={dialog} className={`wtt-project-picker${isSkill ? ' is-skill-picker' : ''}`} aria-labelledby={titleId} aria-describedby={hintId}
    onCancel={event => { event.preventDefault(); if (!working) onClose() }}
    onClick={event => {
      if (event.target !== event.currentTarget || working) return
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
    }}>
    <DialogHeader title={isSkill?'选择技能文件夹':'选择项目文件夹'} titleId={titleId} descriptionId={hintId} description={isSkill?'选择存放技能的文件夹，只建立关联，不复制文件。':'这个文件夹用于保存课程资料、任务和生成的文件。'} onClose={onClose} closeLabel={isSkill?'关闭文件夹选择':'关闭项目选择'} busy={working}/>
    <div className="wtt-pp-body">
      <aside hidden={isSkill} className="wtt-pp-recent" aria-label="最近项目">
        <h3>最近项目</h3>
        {projects.length ? <ul>{projects.map(project => <li key={project.id || project.path}>
          <UiButton variant="custom" type="button" className={`wtt-pp-project${project.id === currentProject?.id ? ' is-current' : ''}`} title={project.path}
            aria-label={`打开项目 ${projectName(project)}`} disabled={working} onClick={() => void openProject(project.path)}>
            <span className="wtt-pp-project-name"><FolderIcon /><strong>{projectName(project)}</strong></span>
            <span className="wtt-pp-project-path">{project.path}</span>
            {project.id === currentProject?.id && <span className="wtt-pp-current-label">当前项目</span>}
          </UiButton>
        </li>)}</ul> : <p className="wtt-pp-recent-empty">打开过的项目会留在这里，方便随时切换。</p>}
      </aside>
      <section className="wtt-pp-browser" aria-label="浏览本机文件夹">
        <form className="wtt-pp-path-form" onSubmit={event => { event.preventDefault(); if (!working && chosenPath) void navigate(chosenPath) }}>
          <label htmlFor={pathId}>文件夹路径</label>
          <div><input id={pathId} autoFocus value={path} disabled={working} onChange={event => changePath(event.target.value)} spellCheck={false} autoComplete="off" placeholder="粘贴本机文件夹的完整路径" /><UiButton variant="quiet" type="submit" disabled={working || !chosenPath}>前往</UiButton></div>
        </form>
        <nav className="wtt-pp-navigation" aria-label="目录导航">
          <UiButton variant="quiet" type="button" disabled={!parent || working || loading} onClick={() => void navigate(parent.path)} aria-label="上一级目录" title="上一级目录">↑</UiButton>
          <UiButton variant="quiet" type="button" disabled={!listing?.home || working || loading} onClick={() => void navigate(listing.home)}>我的文件夹</UiButton>
          <div className="wtt-pp-crumbs">{(listing?.crumbs || []).map((crumb, index) => <React.Fragment key={crumb.path}>
            {index > 0 && <span aria-hidden="true">/</span>}
            <UiButton variant="quiet" type="button" title={crumb.path} disabled={working || loading} aria-current={index === listing.crumbs.length - 1 ? 'location' : undefined} onClick={() => void navigate(crumb.path)}>{crumb.name}</UiButton>
          </React.Fragment>)}</div>
        </nav>
        {browseError && <UserError className="wtt-pp-error" error={browseError} />}
        <div className="wtt-pp-directory-list" aria-busy={loading}>
          {loading ? <p className="wtt-pp-directory-state" role="status">正在读取目录…</p> : listing ? entries.length ? <ul aria-label="子文件夹">{entries.map(entry => <li key={entry.path}>
            <UiButton variant="quiet" type="button" disabled={working} title={entry.path} aria-label={`进入文件夹 ${entry.name}`} onClick={() => void navigate(entry.path)}><FolderIcon /><span>{entry.name}</span><span className="wtt-pp-enter" aria-hidden="true">›</span></UiButton>
          </li>)}</ul> : <div className="wtt-pp-directory-state"><FolderIcon /><p>{showHidden ? '此目录没有子文件夹。' : '此目录没有可见的子文件夹。'}</p><span>{isSkill ? '可直接选择当前目录。' : '可直接打开当前目录作为项目。'}</span></div> : <p className="wtt-pp-directory-state">{isSkill ? '输入技能文件夹路径。' : '选择最近项目，或输入文件夹路径。'}</p>}
        </div>
        <div className="wtt-pp-browser-footer"><label><input type="checkbox" checked={showHidden} disabled={working} onChange={event => setShowHidden(event.target.checked)} />显示隐藏文件夹</label><span>{loading ? '' : `${entries.length} 个文件夹`}</span></div>
        {listing?.truncated && <p className="wtt-pp-truncated">此目录内容较多，列表只显示部分文件夹；可输入完整路径前往。</p>}
      </section>
    </div>
    {openError && <UserError className="wtt-pp-error wtt-pp-open-error" error={openError} />}
    <DialogFooter className="wtt-pp-actions">
      <div className="wtt-pp-selection"><span>{isSkill ? '将添加的技能文件夹' : '将使用的项目文件夹'}</span><code>{openingPath || chosenPath || '请选择文件夹'}</code></div>
      <div><UiButton variant="quiet" type="button" disabled={working} onClick={onClose}>取消</UiButton><UiButton variant="primary" type="button" className="wtt-pp-open" disabled={working || !chosenPath} onClick={() => void openProject(chosenPath)}>{working ? '处理中…' : isSkill ? '使用此文件夹' : '打开此文件夹'}</UiButton></div>
    </DialogFooter>
  </dialog>
}
