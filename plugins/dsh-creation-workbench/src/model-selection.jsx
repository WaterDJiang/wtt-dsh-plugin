import { UiButton } from './ui/controls.jsx'
import { UserError } from './user-feedback.jsx'
import React, { useId } from 'react'
import { EFFORT_LABELS, normalizeModelCatalog } from './model-selection.mjs'
import './model-selection.css'

export function ModelSelection({ catalog, selection, onChange, onRefresh, onOpenSettings, loading = false, error, compact = false }) {
  const id = useId()
  let normalized = null
  let catalogError = ''
  if (catalog) {
    try { normalized = normalizeModelCatalog(catalog) }
    catch (cause) { catalogError = cause.message }
  }
  const groups = normalized?.groups || []
  const current = selection || normalized?.default
  const provider = groups.find(group => group.id === current?.provider)
  const model = provider?.models.find(item => item.id === current?.model)
  const efforts = model?.reasoning?.efforts || []
  const unavailable = Boolean(current && !model)
  const failure = error?.message || (typeof error === 'string' ? error : '') || catalogError
  const disabled = loading || !groups.length || typeof onChange !== 'function'
  function chooseModel(group, nextModel) {
    if (!group || !nextModel) return
    const next = { provider: group.id, model: nextModel.id }
    if (nextModel.reasoning?.defaultEffort) next.reasoningEffort = nextModel.reasoning.defaultEffort
    onChange?.(next)
  }
  const fields = <>
    <div className="wcc-model-selection-heading"><span>创作模型</span><div>
      {onRefresh && <UiButton variant="quiet" type="button" onClick={onRefresh} disabled={loading} aria-label="刷新模型目录">{loading ? '读取中…' : '刷新'}</UiButton>}
      {onOpenSettings && <UiButton variant="quiet" type="button" onClick={onOpenSettings}>模型设置</UiButton>}
    </div></div>
    <div className="wcc-model-selection-fields">
      <label htmlFor={`${id}-provider`}>提供商<select id={`${id}-provider`} aria-label="模型提供商" value={current?.provider || ''} disabled={disabled} onChange={event => { const next = groups.find(group => group.id === event.target.value); chooseModel(next, next?.models[0]) }}>
        {!current && <option value="">{loading ? '正在读取…' : '选择提供商'}</option>}
        {current && !provider && <option value={current.provider} disabled>{current.provider}（当前不可用）</option>}
        {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
      </select></label>
      <label htmlFor={`${id}-model`}>模型<select id={`${id}-model`} aria-label="创作模型" value={current?.model || ''} disabled={disabled || !provider} onChange={event => chooseModel(provider, provider?.models.find(item => item.id === event.target.value))}>
        {!current && <option value="">选择模型</option>}
        {current && !model && <option value={current.model} disabled>{current.model}（当前不可用）</option>}
        {provider?.models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      {(efforts.length > 0 || current?.reasoningEffort) && <label htmlFor={`${id}-effort`}>推理等级<select id={`${id}-effort`} aria-label="模型推理等级" disabled={disabled || !model} value={current?.reasoningEffort || ''} onChange={event => {
        const next = { provider: current.provider, model: current.model }
        if (event.target.value) next.reasoningEffort = event.target.value
        onChange?.(next)
      }}>
        <option value="">模型默认</option>
        {current?.reasoningEffort && !efforts.some(item => item.id === current.reasoningEffort) && <option value={current.reasoningEffort} disabled>{current.reasoningEffort}（当前不可用）</option>}
        {efforts.map(item => <option key={item.id} value={item.id}>{EFFORT_LABELS[item.id] || item.name}</option>)}
      </select></label>}
    </div>
    <p className="wcc-model-selection-hint">用于之后发起的创作；已有任务继续使用创建时的模型。</p>
  </>
  const modelLabel = loading ? '读取模型…' : model?.name || current?.model || '选择模型'
  const effortLabel = current?.reasoningEffort ? EFFORT_LABELS[current.reasoningEffort] || current.reasoningEffort : '默认'
  const modelState = failure ? '加载失败' : !loading && !groups.length ? '未配置' : unavailable ? '不可用' : normalized?.failures.length ? '部分不可用' : ''
  const diagnostics = <>
    {failure && <UserError className="wcc-model-selection-error" error={failure} />}
    {!loading && !failure && !groups.length && <p className="wcc-model-selection-error" role="status">尚无可用模型，请打开模型设置添加提供商。</p>}
    {unavailable && (groups.length > 0 || !compact) && <p className="wcc-model-selection-error" role="status">这个模型目前不可用。请检查连接设置，或为新任务选择其他模型。</p>}
    {normalized?.failures.map((item, index) => <p className="wcc-model-selection-error" key={`${item.id}-${index}`} role="status">{item.name}：{item.message}</p>)}
  </>
  return <section className={`wcc-model-selection${compact ? ' is-compact' : ''}`} aria-label="创作模型" aria-busy={loading}>
    {compact ? <details className="wcc-model-selection-disclosure" onKeyDown={event => {
      if (event.key === 'Escape' && event.currentTarget.open) {
        event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false
        event.currentTarget.querySelector('summary')?.focus()
      }
    }}><summary aria-label={[`创作模型：${modelLabel}`, effortLabel, modelState].filter(Boolean).join(' · ')} title={[provider?.name || current?.provider, modelLabel, `推理：${effortLabel}`, !onChange && '原任务模型已锁定'].filter(Boolean).join(' · ')}>
      <span className="wcc-model-selection-current">{modelLabel}</span><span className="wcc-model-selection-effort">· {effortLabel}</span>{modelState && <span className="wcc-model-selection-state">{modelState}</span>}{!onChange && current && <span className="wcc-model-selection-state">已锁定</span>}<span className="wcc-model-selection-chevron" aria-hidden="true">⌄</span>
    </summary><div className="wcc-model-selection-expanded">{fields}{diagnostics}</div></details> : <>{fields}{diagnostics}</>}
  </section>
}

export default ModelSelection
