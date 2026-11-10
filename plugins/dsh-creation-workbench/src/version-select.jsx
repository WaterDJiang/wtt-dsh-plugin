import React from 'react'

// 画布卡片／预览面板／资产看板共用的版本选择按钮：按页面布局自适应，数据契约 {id, number}[]
export function VersionSelect({ versions, value, onChange, ariaLabel, className = '' }) {
  if (!versions?.length || !onChange) return null
  const current = value ?? versions[0].id
  return <select className={`wtt-version-select ${className}`.trim()} aria-label={ariaLabel} value={current}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onChange={event => { event.stopPropagation(); onChange(event.target.value) }}>
    {versions.map(version => <option key={version.id} value={version.id}>V{version.number}</option>)}
  </select>
}
