import { PanelHeader, UiButton } from './ui/controls.jsx'
import { UserError } from './user-feedback.jsx'
import React, { useEffect, useRef, useState } from 'react'
import { answerTaskInteraction, buildQuestionAnswer, interactionLabel, questionFingerprint } from './skill-interactions.mjs'
import { OutputPreview } from './output-preview.jsx'
import './skill-confirmation.css'

export function SkillConfirmation({ entry, currentEntry, position, draftCache, loadOutputs, verifyOutputs, onClose, onOpenNative, onOpenOutput,
  loadDeckPreview, getDeckPageHref }) {
  const [drafts, setDrafts] = useState(() => draftCache.get(entry.key) || {})
  const [outputs, setOutputs] = useState(null)
  const [previewError, setPreviewError] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const mounted = useRef(true)
  const pending = entry.interaction
  const current = currentEntry()
  const stale = current?.key !== entry.key || current?.interaction !== pending || questionFingerprint(current?.interaction) !== questionFingerprint(pending)
  const permission = pending.kind === 'approval'
  useEffect(() => {
    mounted.current = true
    let cancelled = false
    Promise.resolve().then(() => loadOutputs(entry.task)).then(value => { if (!cancelled) setOutputs(value) })
      .catch(cause => { if (!cancelled) setPreviewError(cause.message || String(cause)) })
    return () => { mounted.current = false; cancelled = true }
  }, [])
  function edit(id, changes) {
    setDrafts(previous => { const next = { ...previous, [id]: { ...previous[id], ...changes } }; draftCache.set(entry.key, next); return next })
  }
  async function submit(mode) {
    if (sending || sent) return
    setError('')
    try {
      const answer = buildQuestionAnswer(pending, drafts, mode)
      setSending(true)
      await verifyOutputs(outputs || [])
      await answerTaskInteraction(entry, answer, currentEntry)
      draftCache.delete(entry.key)
      if (mounted.current) setSent(true)
    } catch (cause) { if (mounted.current) setError(cause.message || String(cause)) }
    finally { if (mounted.current) setSending(false) }
  }
  const plan = pending.questions?.length === 1 && pending.questions[0].intent?.kind === 'plan-review'
  const disabled = sending || sent || stale || !permission && (outputs === null || Boolean(previewError)) || Boolean(pending.getSnapshot?.().closed)
  return <section className="wcc-skill-confirmation nodrag nopan nowheel" role="dialog" aria-label="任务待确认"
    style={{ left: position.x, top: position.y, maxHeight: position.maxHeight }}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') onClose() }}>
    <PanelHeader title={entry.task.title} subtitle={`任务待确认 · ${interactionLabel(pending)}`} onClose={onClose} closeLabel="稍后处理 任务待确认"/>
    <div className="wcc-skill-confirmation-body">
      <p className="wcc-skill-scope">回答后继续这次任务。本次确认不会发送文件给客户。</p>
      {sent ? <p role="status">回答已提交。请关闭浮窗查看原任务进展；达到预算时需调整后继续。</p> : stale ? <p role="status">此问题已结束或已更新。请关闭后打开当前待办。</p> : permission ? <p>AI 需要你的授权才能继续。请打开任务对话，查看具体操作后决定是否允许。</p> : (pending.questions || []).map(question => <fieldset key={question.id} disabled={disabled}>
        <legend>{question.question.length > 240 ? question.header || '请审阅后回答' : `${question.header ? `${question.header} · ` : ''}${question.question}`}</legend>
        {question.question.length > 240 && <pre className="wcc-skill-plan">{question.question}</pre>}
        {question.detail && <pre className="wcc-skill-plan">{question.detail}</pre>}
        <div className="wcc-skill-choices">{(question.options || []).map(option => <label key={option.label}>
          <input type={question.multiSelect ? 'checkbox' : 'radio'} name={`${entry.key}:${question.id}`} checked={(drafts[question.id]?.selected || []).includes(option.label)} onChange={event => {
            const selected = question.multiSelect ? event.target.checked ? [...(drafts[question.id]?.selected || []), option.label] : (drafts[question.id]?.selected || []).filter(label => label !== option.label) : [option.label]
            edit(question.id, { selected })
          }} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
        </label>)}</div>
        <label className="wcc-skill-custom">{plan ? '修改意见／补充说明' : '你的回答／补充说明'}<textarea rows={3} maxLength={8000} value={drafts[question.id]?.custom || ''} onChange={event => edit(question.id, { custom: event.target.value })} placeholder={plan ? '有修改要求时填写，再点「提交修改意见」' : '选择选项，或直接填写回答'} /></label>
      </fieldset>)}
      {!permission && <details className="wcc-skill-preview" open><summary>本次已保存文件 · {outputs?.length ?? '读取中'}</summary>
        <p>先核对下面的文件版本。尚未保存成文件的方案，请看上方内容。</p>
        {previewError && <p role="alert">预览读取失败：{previewError}</p>}
        {outputs?.length === 0 && <p>还没有保存文件。请查看上方方案，或打开任务对话了解进度。</p>}
        {outputs?.map(output => <div key={output.versionId} className="wcc-skill-output"><strong>{output.node.title}{output.number ? ` · V${output.number}` : ''}</strong><details><summary>文件信息</summary><p>{output.node.path || output.node.sourcePath}</p><small>校验值：{output.node.sourceHash}</small></details>
          <OutputPreview type={output.type} title={output.node.title} content={output.node.content || output.node.excerpt} extracted={output.node.extracted !== false} status={output.node.status || 'ready'}
            artifactId={output.type === 'pptx' ? output.node.refId : undefined} hash={output.node.sourceHash} loadPreview={loadDeckPreview} getPageHref={getDeckPageHref}
            src={output.src} downloadHref={output.downloadHref} onOpenDeck={() => onOpenOutput(output)} />
        </div>)}
      </details>}
      {error && <UserError className="wcc-skill-error" error={error} />}
    </div>
    <footer><UiButton variant="quiet" type="button" onClick={onClose}>稍后处理</UiButton><UiButton variant="quiet" type="button" onClick={onOpenNative}>打开任务</UiButton>
      {!permission && !sent && (plan ? <><UiButton variant="quiet" type="button" disabled={disabled || !drafts[pending.questions[0].id]?.custom?.trim()} onClick={() => void submit('modify')}>提交修改意见</UiButton><UiButton variant="primary" className="is-primary" type="button" disabled={disabled || Boolean(drafts[pending.questions[0].id]?.custom?.trim())} onClick={() => void submit('approve')}>{sending ? '提交中…' : pending.questions[0].intent.approve}</UiButton></> : <UiButton variant="primary" className="is-primary" type="button" disabled={disabled} onClick={() => void submit('answer')}>{sending ? '提交中…' : '提交回答'}</UiButton>)}
    </footer>
  </section>
}
