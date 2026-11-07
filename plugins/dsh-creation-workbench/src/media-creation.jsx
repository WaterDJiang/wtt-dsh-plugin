import { DialogFooter, DialogHeader, UiButton } from './ui/controls.jsx'
import { UserError } from './user-feedback.jsx'
import React, { useEffect, useId, useRef, useState } from 'react'
import './media-creation.css'

export const DEFAULT_MEDIA_OPTIONS = {
  image: { model: 'jimeng-5.0', ratio: '4:3', resolution: '2k' },
  video: { model: 'jimeng-video-3.0', ratio: '4:3', resolution: '720p', duration: 5 },
}
const JOB_LABELS = { queued: '排队中', submitting: '正在提交', processing: '生成中', downloading: '保存文件中', registering: '核验文件中', succeeded: '已生成并保存', failed: '生成失败', unknown: '提交结果未知', download_failed: '文件下载失败', registration_failed: '文件核验失败' }
export function mediaJobPending(job) { return ['queued', 'submitting', 'processing', 'downloading', 'registering'].includes(job?.status) }
export function mediaOptionsFor(type, capabilities, options) { return { ...DEFAULT_MEDIA_OPTIONS[type], ...capabilities?.modelDefaults?.[type], ...options } }
export function mediaSizeLabel(file) {
  const media = file?.media || file?.validation?.media
  if (!media) return ''
  return [media.width && media.height ? `${media.width} × ${media.height}` : '', Number.isFinite(media.durationSeconds) ? `${media.durationSeconds.toFixed(2)} 秒` : ''].filter(Boolean).join(' · ')
}

function Choice({ label, value, choices, onChange, disabled }) {
  const entries = [...new Set([...(choices || []), ...(value === undefined ? [] : [value])])]
  return <label>{label}<select aria-label={label} value={value ?? ''} disabled={disabled} onChange={event => onChange(event.target.value)}>{entries.map(entry => <option key={entry} value={entry}>{entry}</option>)}</select></label>
}

export function MediaPrompt({ type, instruction, onChange, options, onOptionsChange, capabilities, loading, error, job, onRefresh, onOpenSettings, onResume, onPrepareNew, onSubmit, disabled }) {
  const id = useId()
  const isVideo = type === 'video'
  const models = capabilities?.models?.filter(model => model.type === type) || []
  const selected = models.find(model => model.id === options.model)
  const pending = mediaJobPending(job)
  const set = (key, value) => onOptionsChange?.({ ...options, [key]: value })
  return <div className="wcc-media-creation">
    <div className="wcc-creation-instruction-caption"><label htmlFor={`${id}-prompt`}>创作提示词</label><UiButton variant="quiet" type="button" onClick={onOpenSettings}>即梦设置</UiButton></div>
    <textarea id={`${id}-prompt`} aria-label="创作提示词" value={instruction} rows={4} maxLength={8000} disabled={disabled} onChange={event => onChange?.(event.target.value)} placeholder={isVideo ? '描述画面、动作、镜头与节奏…' : '描述主体、构图、风格与光线…'} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); onSubmit?.() } }} />
    <div className="wcc-media-options">
      <Choice label="生成模型" value={options.model} choices={models.map(model => model.id)} disabled={disabled} onChange={value => set('model', value)} />
      <Choice label="画面比例" value={options.ratio} choices={selected?.ratios || ['1:1', '4:3', '3:4', '16:9', '9:16']} disabled={disabled} onChange={value => set('ratio', value)} />
      <Choice label="分辨率" value={options.resolution} choices={selected?.resolutions || (isVideo ? ['720p', '1080p'] : ['1k', '2k', '4k'])} disabled={disabled} onChange={value => set('resolution', value)} />
      {isVideo && <Choice label="视频时长（秒）" value={options.duration} choices={selected?.durations || [5, 10]} disabled={disabled} onChange={value => set('duration', Number(value))} />}
    </div>
    <p className="wcc-media-hint">每次生成 1 {isVideo ? '段视频' : '张图片'}。参考图从「＋引用」添加；文字参考每份最多 2000 字符，合计 6000 字符。{selected?.requiresReference ? '此模型需要参考图片。' : ''}以上为请求参数，实际尺寸显示在成果卡上。</p>
    <div className="wcc-media-connection"><span className={capabilities?.healthy && capabilities?.credentialConfigured ? 'is-ready' : ''}>{loading ? '正在检测即梦服务…' : capabilities?.healthy ? capabilities.credentialConfigured ? '即梦已连接 · 认证已配置' : '即梦已连接 · 尚未配置认证' : '即梦服务未连接'}</span><UiButton variant="quiet" type="button" disabled={loading} onClick={() => void onRefresh?.()}>重新检测</UiButton></div>
    {error && <UserError className="wcc-creation-error" error={String(error)} />}
    {job && <div className={`wcc-media-job is-${job.status}`} role="status"><strong>{JOB_LABELS[job.status] || job.status}</strong>{pending && <span className="wcc-media-pulse" aria-hidden="true">···</span>}{job.error && <p>{job.error}</p>}{job.status === 'unknown' && <p>服务可能已受理。本次任务不会自动重发，请先在即梦核对生成记录。</p>}{job.canResume && <UiButton variant="quiet" type="button" disabled={disabled} onClick={onResume}>查询原任务／重新取回文件</UiButton>}{['unknown', 'download_failed', 'registration_failed'].includes(job.status) && onPrepareNew && <><UiButton variant="quiet" type="button" disabled={disabled} onClick={onPrepareNew}>已核对，准备新任务</UiButton><small>保留原任务记录；再次点击生成会另计积分。</small></>}{job.artifactId && <small>文件已保存到当前项目，可在画布与创作任务中查看。</small>}</div>}
  </div>
}

export function MediaSettings({ open, capabilities, options, type, onSave, onClose }) {
  const id = useId()
  const dialog = useRef(null)
  const [endpoint, setEndpoint] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [saveDefaults, setSaveDefaults] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (open) { setEndpoint(capabilities?.endpoint || 'http://127.0.0.1:8000'); setSessionId(''); setError(''); setSaveDefaults(true); dialog.current?.showModal() }
    else dialog.current?.close()
  }, [open])
  async function save(event) {
    event.preventDefault()
    if (saving || !onSave) return
    setSaving(true); setError('')
    try {
      await onSave({ endpoint: endpoint.trim(), ...(sessionId.trim() ? { sessionId: sessionId.trim() } : {}), ...(saveDefaults ? { modelDefaults: { ...capabilities?.modelDefaults, [type]: options } } : {}) })
      setSessionId(''); onClose?.()
    } catch (cause) { setError(cause?.message || String(cause)) }
    finally { setSaving(false) }
  }
  return <dialog ref={dialog} className="wcc-media-settings" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); if (!saving) onClose?.() }} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <form onSubmit={event => void save(event)}>
      <DialogHeader title="即梦生成设置" titleId={`${id}-title`} description="连接这台电脑上的即梦服务。" onClose={onClose} closeLabel="关闭即梦设置" busy={saving}/>
      <div className="wcc-media-settings-body">
        <label>服务地址<input aria-label="即梦服务地址" value={endpoint} disabled={saving} onChange={event => setEndpoint(event.target.value)} placeholder="http://127.0.0.1:8000" spellCheck={false} /></label>
        <label>即梦登录凭据（Session ID）<input aria-label="即梦登录凭据（Session ID）" type="password" autoComplete="off" value={sessionId} disabled={saving} onChange={event => setSessionId(event.target.value)} placeholder={capabilities?.credentialConfigured ? '已配置；留空保留' : '留空时沿用本机即梦技能 配置'} /></label>
        <p>{capabilities?.credentialConfigured ? '已找到认证配置，已有值不会回显。' : '即梦账号与 DeepSeek 登录独立，可沿用本机即梦技能 的认证。'}</p>
        <label className="wcc-media-default-check"><input type="checkbox" checked={saveDefaults} disabled={saving} onChange={event => setSaveDefaults(event.target.checked)} />将当前{type === 'video' ? '视频' : '图片'}参数保存为默认</label>
        {saveDefaults && <code>{options.model} · {options.ratio} · {options.resolution}{type === 'video' ? ` · ${options.duration} 秒` : ''}</code>}
        {error && <UserError className="wcc-creation-error" error={error} />}
      </div>
      <DialogFooter><UiButton variant="quiet" type="button" disabled={saving} onClick={onClose}>取消</UiButton><UiButton variant="quiet" type="submit" disabled={saving || !onSave}>{saving ? '保存中…' : '保存设置'}</UiButton></DialogFooter>
    </form>
  </dialog>
}
