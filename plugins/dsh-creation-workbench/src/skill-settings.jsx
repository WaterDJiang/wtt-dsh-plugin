import { DialogFooter, DialogHeader, UiButton } from './ui/controls.jsx'
import { UserError } from './user-feedback.jsx'
import React, { useEffect, useId, useRef, useState } from 'react'
import { ProjectPicker } from './project-picker.jsx'
import { skillLabel, skillSearchText } from './skill-presentation.mjs'
import './skill-settings.css'

const messageOf = error => error?.rpcError?.message || error?.message || String(error)

export function SkillSettings({ open, catalog, loading = false, error, onRefresh, onSave, onPreference, onClose }) {
  const id = useId(), dialog = useRef(null), searchRef = useRef(null), locked = useRef(false)
  const [search, setSearch] = useState(''), [saving, setSaving] = useState(false), [localError, setLocalError] = useState('')
  const [folderOpen, setFolderOpen] = useState(false), [notice, setNotice] = useState('')
  useEffect(() => {
    if (open && !dialog.current.open) { dialog.current.showModal(); setSearch(''); setLocalError(''); setNotice(''); searchRef.current?.focus() }
    else if (!open && dialog.current.open) { dialog.current.close(); setFolderOpen(false) }
  }, [open])
  const settings = catalog?.settings || { directories: [], favorites: [], aliases: {} }
  const favorites = new Set(settings.favorites)
  const skills = [...new Map((catalog?.skills || []).map(skill => [skill.name, skill])).values()]
  const known = new Set(skills.map(skill => skill.name))
  const entries = [...skills, ...settings.favorites.filter(name => !known.has(name)).map(name => ({ name, label: settings.aliases?.[name], unavailable: true }))]
    .filter(skill => skillSearchText(skill).includes(search.trim().toLowerCase()))
    .sort((a, b) => Number(favorites.has(b.name)) - Number(favorites.has(a.name)) || skillLabel(a).localeCompare(skillLabel(b), 'zh-CN'))
  const busy = saving || loading
  async function change(action, success) {
    if (locked.current) return
    locked.current = true; setSaving(true); setLocalError(''); setNotice('')
    try { await action(); setNotice(success) }
    catch (cause) { setLocalError(messageOf(cause)); throw cause }
    finally { locked.current = false; setSaving(false) }
  }
  const preference = (value, success) => change(() => {
    if (!onPreference) throw new Error('常用设置暂不可用，请重新打开工作台。')
    return onPreference(value)
  }, success).catch(() => {})
  async function browseDirectory(directory, signal) {
    const url = new URL('/api/wtt-creation-workbench', location.origin)
    url.searchParams.set('directory', directory || '')
    const response = await fetch(url, { credentials: 'same-origin', signal }), result = await response.json()
    if (!response.ok) throw new Error(result.error || '文件夹暂时无法读取')
    return result
  }
  async function addDirectory(directory) {
    await change(async () => { await onSave({ ...settings, directories: [...new Set([...settings.directories, directory])] }); setFolderOpen(false) }, '技能文件夹已添加，列表已更新。')
  }
  return <>
    <dialog ref={dialog} className="wcc-skill-settings-dialog wcc-skill-quick-settings" aria-labelledby={`${id}-title`}
      onCancel={event => { event.preventDefault(); if (!saving) onClose?.() }} onPointerDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      <DialogHeader title="设置常用技能" titleId={`${id}-title`} description="点星标即可保存，所有项目共用。常用按钮可自定义名称。" onClose={onClose} closeLabel="关闭技能设置" busy={saving}/>
      <div className="wcc-skill-settings-body">
        <div className="wcc-skill-search-row"><input ref={searchRef} aria-label="搜索本机技能" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索名称、中文快捷名或说明" /><UiButton variant="quiet" type="button" disabled={busy} onClick={() => void change(onRefresh, '技能列表已刷新。').catch(() => {})}>刷新</UiButton></div>
        <p className="wcc-skill-count">{skills.length} 个可用技能 · {favorites.size} 个常用{saving ? ' · 保存中…' : ''}</p>
        <div className="wcc-skill-quick-list" aria-label="本机技能列表">{entries.map(skill => <div className="wcc-skill-quick-item" key={skill.name}>
          <UiButton variant="custom" type="button" className="wcc-skill-star" aria-label={`${favorites.has(skill.name) ? '取消常用' : '设为常用'}：${skillLabel(skill)}`} aria-pressed={favorites.has(skill.name)} disabled={busy || skill.unavailable && !favorites.has(skill.name)} onClick={() => void preference({ name: skill.name, favorite: !favorites.has(skill.name) }, favorites.has(skill.name) ? '已取消常用。' : '已设为常用，回到输入框即可使用。')}>{favorites.has(skill.name) ? '★' : '☆'}</UiButton>
          <div className="wcc-skill-quick-copy"><strong>{skillLabel(skill)}</strong><span>{skill.unavailable ? '本机暂未找到，可取消常用或检查文件夹。' : skill.description || '暂无说明'}</span>
            {favorites.has(skill.name) && <label className="wcc-skill-alias">快捷名称<input key={`${skill.name}:${skill.label || ''}`} aria-label={`快捷名称 ${skill.name}`} defaultValue={skill.label || ''} placeholder={skillLabel({ name: skill.name })} maxLength={40} disabled={busy}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } else if (event.key === 'Escape') { event.currentTarget.value = skill.label || ''; event.currentTarget.blur() } }}
              onBlur={event => { const label = event.currentTarget.value.trim(); if (label !== (skill.label || '')) void preference({ name: skill.name, label }, '快捷名称已保存。') }} /></label>}
            <details><summary>查看名称与来源</summary><code>/{skill.name}</code>{skill.path && <code>{skill.path}</code>}<small>{skill.origin || '本机暂未找到'}</small></details>
          </div>
        </div>)}{!entries.length && <p>{loading ? '正在读取本机技能…' : search ? '没找到相关技能，换个关键词试试。' : '还没有可用技能。添加存放技能的文件夹后再试。'}</p>}</div>
        <details className="wcc-skill-folders"><summary>技能文件夹 · 自动发现与自定义</summary><p>自动读取已存在的常见目录，并保留 DSH 的项目技能来源。</p>
          {(catalog?.automaticDirectories || []).map(directory => <div key={directory}><code>{directory}</code><small>自动发现</small></div>)}
          {settings.directories.map(directory => <div key={directory}><code>{directory}</code><UiButton variant="quiet" type="button" disabled={busy} aria-label={`移除技能目录 ${directory}`} onClick={() => void change(() => onSave({ ...settings, directories: settings.directories.filter(item => item !== directory) }), '已移除关联，原文件保留。').catch(() => {})}>移除关联</UiButton></div>)}
          <UiButton variant="quiet" type="button" disabled={busy} onClick={() => setFolderOpen(true)}>添加技能文件夹</UiButton>
        </details>
        {!!catalog?.warnings?.length && <details className="wcc-skill-settings-warnings"><summary>来源提示 · {catalog.warnings.length} 项</summary><ul>{catalog.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
        {(localError || error) && <UserError className="wcc-skill-settings-error" error={localError || error} />}
      </div>
      <DialogFooter><span role="status">{notice || '更改自动保存'}</span><UiButton variant="quiet" type="button" disabled={saving} onClick={onClose}>完成</UiButton></DialogFooter>
    </dialog>
    {open && folderOpen && <ProjectPicker purpose="skill" currentProject={{ path: settings.directories[0] || catalog?.automaticDirectories?.[0] }} browseDirectory={browseDirectory} onOpenProject={addDirectory} onClose={() => setFolderOpen(false)} busy={saving} />}
  </>
}
