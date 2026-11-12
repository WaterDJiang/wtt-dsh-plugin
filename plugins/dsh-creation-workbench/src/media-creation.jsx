import { UiButton } from './ui/controls.jsx'
import { UserError } from './user-feedback.jsx'
import { ReferencePromptInput } from './reference-prompt-input.jsx'
import React from 'react'
import './media-creation.css'

export function mediaJobPending(job) { return ['queued', 'submitting', 'processing', 'downloading', 'registering'].includes(job?.status) }
export function mediaOptionsFor(type, capabilities, options) {
  const defaults = capabilities?.modelDefaults?.[type]
  return { ...(typeof defaults === 'string' ? { model: defaults } : defaults), ...options }
}
export function mediaSizeLabel(file) {
  const media = file?.media || file?.validation?.media
  if (!media) return ''
  return [media.width && media.height ? `${media.width} × ${media.height}` : '', Number.isFinite(media.durationSeconds) ? `${media.durationSeconds.toFixed(2)} 秒` : ''].filter(Boolean).join(' · ')
}

function Choice({ label, value, choices, onChange, disabled }) {
  const entries = [...new Set([...(choices || []), ...(value === undefined ? [] : [value])])]
  return <label>{label}<select aria-label={label} value={value ?? ''} disabled={disabled} onChange={event => onChange(event.target.value)}>{entries.map(entry => <option key={entry} value={entry}>{entry}</option>)}</select></label>
}

export function ApiMediaPrompt({ type, instruction, onChange, options, onOptionsChange, providers, providerId, onProviderChange, capabilities, loading, error, onRefresh, onOpenSettings, onSubmit, disabled, mentionProps }) {
  providers = providers.filter(provider => !provider.type || provider.type === type)
  const models = capabilities?.models?.filter(model => model.type === type) || []
  const selected = models.find(model => model.id === options.model)
  const set = (key, value) => onOptionsChange?.({ ...options, [key]: value })
  return <div className="wcc-media-creation">
    <ReferencePromptInput aria-label="创作提示词" value={instruction} rows={2} disabled={disabled} onValueChange={onChange} onSubmit={onSubmit} placeholder="描述内容，@ 引用资料" {...mentionProps} />
    {providers.length > 0 && <div className="wcc-media-options">
      <label>API 服务<select aria-label="API 服务" value={providerId || ''} disabled={disabled} onChange={event => onProviderChange?.(event.target.value)}><option value="" disabled>选择服务</option>{providers.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
      <label>生成模型<select aria-label="生成模型" value={options.model || ''} disabled={disabled || !models.length} onChange={event => { const model = models.find(item => item.id === event.target.value); onOptionsChange?.({ model: model.id, ...Object.fromEntries([['ratio',model.ratios],['resolution',model.resolutions],['size',model.sizes],['quality',model.qualities],['duration',model.durations]].filter(([, list]) => list?.length).map(([key,list]) => [key,list[0]])) }) }}><option value="" disabled>选择模型</option>{models.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}</select></label>
      {selected?.sizes?.length > 0 && <Choice label="画面尺寸" value={options.size} choices={selected.sizes} disabled={disabled} onChange={value => set('size', value)} />}
      {selected?.qualities?.length > 0 && <Choice label="生成质量" value={options.quality} choices={selected.qualities} disabled={disabled} onChange={value => set('quality', value)} />}
      {selected?.ratios?.length > 0 && <Choice label="画面比例" value={options.ratio} choices={selected.ratios} disabled={disabled} onChange={value => set('ratio', value)} />}
      {selected?.resolutions?.length > 0 && <Choice label="分辨率" value={options.resolution} choices={selected.resolutions} disabled={disabled} onChange={value => set('resolution', value)} />}
      {type === 'video' && selected?.durations?.length > 0 && <Choice label="视频时长（秒）" value={options.duration} choices={selected.durations} disabled={disabled} onChange={value => set('duration', Number(value))} />}
    </div>}
    {error && <UserError className="wcc-creation-error" error={error} />}
    <UiButton variant="ghost" size="compact" disabled={disabled || !onOpenSettings} onClick={onOpenSettings}>API 设置</UiButton>
    <UiButton variant="ghost" size="compact" disabled={loading || disabled} onClick={() => void onRefresh?.()}>{loading ? '检测中…' : '刷新 API 服务'}</UiButton>
  </div>
}
