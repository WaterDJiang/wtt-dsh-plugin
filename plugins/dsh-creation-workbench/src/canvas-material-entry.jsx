import React from 'react'
import { UiButton } from './ui/controls.jsx'

export const canvasMaterialExtensions = '.txt,.md,.csv,.json,.jsonl,.pdf,.docx,.pptx,.png,.jpg,.jpeg,.webp,.gif,.mp4,.webm'
const allowed = new Set(canvasMaterialExtensions.split(','))

export function checkMaterialFile(file) {
  if (!allowed.has(file.name.toLowerCase().match(/\.[^.]+$/)?.[0])) throw new Error('请选择文本、PDF、DOCX、PPTX、常见图片或 MP4／WebM 视频。')
  if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('必须为非空文件，且不能超过 20 MB。')
}

export async function uploadCanvasMaterial(file, url) {
  const response = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: file })
  const result = await response.json().catch(() => null)
  if (!response.ok || !result?.material) throw new Error(result?.error?.message || result?.error || `素材导入失败（${response.status}）`)
  return result
}

export function CanvasMaterialEntry({ busy, onPick }) {
  return <div className="wcc-first-material" onDoubleClick={event => event.stopPropagation()}>
    <UiButton variant="primary" disabled={busy} onClick={onPick}>{busy ? '正在添加…' : '添加素材'}</UiButton>
    <span>或拖入文件</span>
  </div>
}
