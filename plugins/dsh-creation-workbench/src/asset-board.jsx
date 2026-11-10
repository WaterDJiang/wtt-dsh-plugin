import { PanelHeader, PanelToolbar, UiButton } from './ui/controls.jsx'
import { VersionSelect } from './version-select.jsx'
import { UserError } from './user-feedback.jsx'
import React, { useEffect, useRef, useState } from 'react'
import './asset-board.css'

const money = value => value == null ? '未约定' : (value / 100).toFixed(2)
const today = () => new Date().toLocaleDateString('en-CA')
const due = business => Boolean(business.followUpDate && business.followUpDate <= today() || business.dueDate && business.dueDate <= today() && business.outstandingMinor > 0)
const count = value => value == null ? '—' : Number(value).toLocaleString('zh-CN')
const businessForm = business => ({ ...business, receivable: business.receivableMinor == null ? '' : money(business.receivableMinor) })
const titleOf = task => {
  const names = task.files?.find(file => file.kind !== 'support' && file.kind !== 'storyboard')?.title
  return names || task.instruction?.replace(/(^|\s)\/[a-z0-9-]+(?=\s|$)/g, ' ').replace(/CW[- ]?\d+\s*[A-Z0-9]*[：:]?/g, '').trim().slice(0, 60) || task.title
}

export function AssetBoard({ projectId, requirementId, endpoint, request, onClose, onOpenCard, onOpenTask, draftCache }) {
  const saved = draftCache?.assetBoard || {}
  const [tab, setTab] = useState(saved.tab || 'deliveries'), [selected, setSelected] = useState(saved.selected || requirementId)
  const [overview, setOverview] = useState(null), [course, setCourse] = useState(null), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false), [draft, setDraft] = useState(saved.draft || null), [receipt, setReceipt] = useState(saved.receipt || { amount: '', currency: 'CNY', paidOn: '', note: '', confirmed: false })
  const [policy, setPolicy] = useState(null), [taskId, setTaskId] = useState(''), [production, setProduction] = useState(null)
  const [reviewNotes, setReviewNotes] = useState(saved.reviewNotes || {}), [versions, setVersions] = useState(saved.versions || {}), [checkpoint, setCheckpoint] = useState(saved.checkpoint || { title: '', decisions: '', pending: '' })
  const [diagnostics, setDiagnostics] = useState(null), [businessFilter, setBusinessFilter] = useState('all')
  const panelRef = useRef(null)
  useEffect(() => { const previous = document.activeElement; panelRef.current?.focus(); return () => { if (previous?.isConnected) previous.focus() } }, [])
  const operationStorageKey = `wtt-assets-operations:${projectId}`
  const operations = useRef(draftCache?.assetOperations || new Map()), operationError = useRef(''), generation = useRef(0), readRef = useRef(null)
  useEffect(() => {
    try { const saved = localStorage.getItem(operationStorageKey); if (saved) for (const [key, id] of JSON.parse(saved)) operations.current.set(key, id); if (draftCache) draftCache.assetOperations = operations.current }
    catch { operationError.current = '待提交操作标识无法读取，已阻止重复提交。请先核对原业务记录。'; setError(operationError.current) }
  }, [projectId])
  useEffect(() => { if (draftCache) draftCache.assetBoard = { tab, selected, draft, receipt, reviewNotes, versions, checkpoint } }, [tab, selected, draft, receipt, reviewNotes, versions, checkpoint])
  function switchCourse(id) {
    if (draftCache) { draftCache.assetCourseDrafts ||= {}; draftCache.assetCourseDrafts[selected] = { draft, receipt } }
    const next = draftCache?.assetCourseDrafts?.[id]
    setDraft(next?.draft || null); setReceipt(next?.receipt || { amount: '', currency: 'CNY', paidOn: '', note: '', confirmed: false })
    setSelected(id); setTaskId(''); setProduction(null)
  }
  readRef.current = async query => { const response = await fetch(endpoint(query), { credentials: 'same-origin' }); const value = await response.json(); if (!response.ok) throw new Error(value.error || '读取失败'); return value }
  async function load(id = selected) {
    const intent = ++generation.current
    const [next, details] = await Promise.all([readRef.current({ assets: 1 }), readRef.current({ assetCourse: id })])
    if (intent !== generation.current) return
    setOverview(next); setCourse(details); setPolicy(value => value || next.policy)
  }
  useEffect(() => { setCourse(null); setError(''); void load(selected).catch(error => setError(error.message)); return () => { generation.current++ } }, [selected, projectId])
  useEffect(() => { if (!taskId || tab !== 'production') return; let live = true; const poll = () => readRef.current({ productionTask: taskId }).then(value => { if (live) setProduction(value) }).catch(error => { if (live) setError(error.message) }); void poll(); const timer = setInterval(poll, 4000); return () => { live = false; clearInterval(timer) } }, [taskId, tab, projectId])
  async function act(action, data, message) {
    setBusy(true); setError(''); setNotice('')
    try {
      if (operationError.current) throw new Error(operationError.current)
      const signature = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([action, data]))))].map(value => value.toString(16).padStart(2, '0')).join('')
      if (!operations.current.has(signature)) operations.current.set(signature, crypto.randomUUID())
      localStorage.setItem(operationStorageKey, JSON.stringify([...operations.current]))
      const intent = generation.current
      const result = await request(action, { ...data, operationId: operations.current.get(signature) })
      if (intent !== generation.current) return null
      operations.current.delete(signature); localStorage.setItem(operationStorageKey, JSON.stringify([...operations.current])); setNotice(message || '已保存'); await load(); return result
    } catch (error) { setError(error.message); return null } finally { setBusy(false) }
  }
  const currentBusiness = course?.business
  const form = draft || (currentBusiness && businessForm(currentBusiness))
  const taskRows = course?.tasks || []
  function changeBusiness(key, value) { setDraft({ ...form, [key]: value }) }
  async function downloadManifest() {
    setError(''); try {
      const manifest = await readRef.current({ deliveryManifest: selected })
      const url = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }))
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${manifest.course}-交付清单.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) { setError(error.message) }
  }
  return <section ref={panelRef} tabIndex={-1} className="wtt-assets nodrag nopan nowheel" role="dialog" aria-label="资产看板" onPointerDown={event => event.stopPropagation()} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') onClose() }}>
    <PanelHeader title="资产看板" subtitle="当前项目" onClose={onClose} closeLabel="关闭资产看板"/><PanelToolbar><select aria-label="资产看板课程" value={selected} disabled={busy} onChange={event => switchCourse(event.target.value)}>{(overview?.courses || []).map(item => <option key={item.requirement.id} value={item.requirement.id}>{item.requirement.title}</option>)}</select><UiButton variant="quiet" type="button" onClick={() => void load().catch(error => setError(error.message))}>刷新</UiButton></PanelToolbar>
    <nav role="tablist" aria-label="资产看板栏目">{[['deliveries', '内容与交付'], ['business', '业务跟进'], ['production', 'AI 用量'], ['environment', '设置与技能']].map(([id, label]) => <UiButton variant="custom" key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</UiButton>)}</nav>
    {error && <UserError className="wtt-assets-error" error={error} />}{notice && <p className="wtt-assets-notice" role="status">{notice}</p>}
    <div className="wtt-assets-body">
      {!course ? <p role="status">正在读取项目资产…</p> : tab === 'deliveries' ? <>
        <div className="wtt-assets-summary"><strong>{course.cards.length} 份成果文件</strong><span>{course.cards.filter(card => card.selectedVersionId).length} 份已选交付版本</span><UiButton variant="quiet" type="button" onClick={downloadManifest}>导出交付清单</UiButton></div>
        <p className="wtt-assets-help">先检查内容，再选入交付清单。选入清单不会自动发送文件；客户确认和收款需另外记录。</p>
        {!course.cards.length && <p>还没有成果文件。返回画布，点击背景卡开始创作。</p>}
        <div className="wtt-assets-grid">{course.cards.map(card => {
          const versionId = versions[card.id] || card.selectedVersionId || card.latestVersionId || card.versions.at(-1)?.id
          const version = card.versions.find(item => item.id === versionId), state = version?.review?.state || 'pending'
          const warnings = card.dependencyWarnings.filter(item => item.taskId === version?.taskId)
          return <article key={card.id} className="wtt-asset-item">
            <div className="wtt-asset-heading"><strong title={card.title}>{card.title}</strong><VersionSelect ariaLabel={`审阅 ${card.title} 的版本`} versions={card.versions} value={versionId} onChange={value => setVersions({ ...versions, [card.id]: value })} /></div>
            <div className="wtt-asset-tags"><span>{version?.format || card.type.toUpperCase()}</span><span>{state === 'approved' ? '审阅通过' : state === 'changes' ? '需修改' : '待审阅'}</span>{card.selectedVersionId === versionId && <span className="is-selected">交付版</span>}</div>
            {!!warnings.length && <details className="wtt-asset-warning"><summary>引用的部分来源已有新版</summary>{warnings.map((item, index) => <p key={index}>{item.title}：这份内容仍使用旧资料；如需更新，请重新发起创作。</p>)}</details>}
            <input aria-label={`审阅意见 ${card.title}`} placeholder="审阅意见（可选）" value={reviewNotes[versionId] ?? version?.review?.note ?? ''} onChange={event => setReviewNotes({ ...reviewNotes, [versionId]: event.target.value })} />
            <footer><UiButton variant="quiet" type="button" onClick={() => onOpenCard?.(card, versionId, selected)}>预览</UiButton><UiButton variant="quiet" type="button" disabled={busy} onClick={() => void act('review-output', { requirementId: selected, cardId: card.id, versionId, state: 'approved', note: reviewNotes[versionId] ?? version?.review?.note ?? '' }, '此版本已记录审阅通过')}>通过</UiButton><UiButton variant="quiet" type="button" disabled={busy} onClick={() => void act('review-output', { requirementId: selected, cardId: card.id, versionId, state: 'changes', note: reviewNotes[versionId] ?? '' }, '已记录修改意见')}>需修改</UiButton><UiButton variant="primary" type="button" className={card.selectedVersionId === versionId ? '' : 'is-primary'} disabled={busy || state !== 'approved' && card.selectedVersionId !== versionId} onClick={() => void act('select-delivery', { requirementId: selected, cardId: card.id, versionId, selected: card.selectedVersionId !== versionId }, card.selectedVersionId === versionId ? '已移出交付清单' : '已加入交付清单，尚未发送')}>{card.selectedVersionId === versionId ? '移出交付' : '选为交付版'}</UiButton></footer>
          </article>
        })}</div>
      </> : tab === 'business' ? <>
        <div className="wtt-assets-summary"><strong>项目业务</strong><label>筛选 <select aria-label="筛选业务待办" value={businessFilter} onChange={event => setBusinessFilter(event.target.value)}><option value="all">全部课程</option><option value="due">今日及逾期待办</option><option value="waiting">等待反馈</option><option value="unpaid">待收款</option></select></label></div>
        <div className="wtt-business-stages" aria-label="项目阶段分布">{overview?.stages.map(stage => <div key={stage}><strong>{stage}</strong>{overview.courses.filter(item => item.business.stage === stage && (businessFilter === 'all' || businessFilter === 'due' && due(item.business) || businessFilter === 'waiting' && item.business.waitingFor || businessFilter === 'unpaid' && item.business.outstandingMinor > 0)).map(item => <UiButton variant="custom" key={item.requirement.id} type="button" disabled={busy} onClick={() => switchCourse(item.requirement.id)}>{item.requirement.title}{due(item.business) && <small className="wtt-due">到期待办</small>}{item.business.nextAction && <small>{item.business.nextAction}</small>}{item.business.followUpDate && <small>跟进 {item.business.followUpDate}</small>}</UiButton>)}</div>)}</div>
        <form className="wtt-assets-form" onSubmit={async event => { event.preventDefault(); const result = await act('save-business', { ...form, requirementId: selected }, '跟进信息已保存'); if (result) setDraft(null) }}>
          <h3>业务跟进</h3><label>阶段<select aria-label="业务阶段" value={form.stage} onChange={event => changeBusiness('stage', event.target.value)}>{overview?.stages.map(stage => <option key={stage}>{stage}</option>)}</select></label>
          <label>客户<input value={form.customer} onChange={event => changeBusiness('customer', event.target.value)} /></label>
          <label>下一步<input value={form.nextAction} onChange={event => changeBusiness('nextAction', event.target.value)} /></label><label>等待谁的反馈<input value={form.waitingFor} onChange={event => changeBusiness('waitingFor', event.target.value)} /></label>
          <label>下次跟进日期<input type="date" value={form.followUpDate} onChange={event => changeBusiness('followUpDate', event.target.value)} /></label>
          <label>币种<input maxLength={3} value={form.currency} onChange={event => changeBusiness('currency', event.target.value.toUpperCase())} /></label>
          <label>约定收款金额<input inputMode="decimal" placeholder="未约定" value={form.receivable} onChange={event => changeBusiness('receivable', event.target.value)} /></label><label>约定收款日期<input type="date" value={form.dueDate} onChange={event => changeBusiness('dueDate', event.target.value)} /></label>
          <label className="is-wide">备注<textarea value={form.note} onChange={event => changeBusiness('note', event.target.value)} /></label><UiButton variant="quiet" type="submit" disabled={busy}>保存业务记录</UiButton>
        </form>
        <section className="wtt-assets-financial"><h3>人工收款记录</h3><p>{currentBusiness.currency} 应收 {money(currentBusiness.receivableMinor)} · 待收 {money(currentBusiness.outstandingMinor)}</p><p>{Object.entries(currentBusiness.collectedByCurrency).map(([currency, amount]) => `${currency} 已记录 ${money(amount)}`).join(' · ') || '尚无人工收款记录'}</p>
          <form className="wtt-assets-form" onSubmit={async event => { event.preventDefault(); const result = await act('record-receipt', { ...receipt, requirementId: selected }, '收款记录已保存'); if (result) setReceipt({ amount: '', currency: 'CNY', paidOn: '', note: '', confirmed: false }) }}>
            <label>币种<input maxLength={3} value={receipt.currency} onChange={event => setReceipt({ ...receipt, currency: event.target.value.toUpperCase() })} /></label><label>实收金额<input required inputMode="decimal" value={receipt.amount} onChange={event => setReceipt({ ...receipt, amount: event.target.value })} /></label><label>收款日期<input required type="date" value={receipt.paidOn} onChange={event => setReceipt({ ...receipt, paidOn: event.target.value })} /></label><label>依据／说明<input required value={receipt.note} onChange={event => setReceipt({ ...receipt, note: event.target.value })} /></label><label className="is-wide is-check"><input type="checkbox" checked={receipt.confirmed} onChange={event => setReceipt({ ...receipt, confirmed: event.target.checked })} />我确认这笔款项已经收到；这里只记账，不发起转账</label><UiButton variant="quiet" type="submit" disabled={busy || !receipt.confirmed}>保存收款记录</UiButton>
          </form>
          <ul>{currentBusiness.receipts.map(item => <li key={item.id}>{item.paidOn} · {item.currency} {money(item.amountMinor)} · {item.note}{!item.reversalOf && !currentBusiness.receipts.some(row => row.reversalOf === item.id) && <UiButton variant="quiet" type="button" disabled={busy} onClick={() => { const reason = window.prompt('请输入撤销记录的原因（保留原记录，不操作账户）'); if (reason?.trim()) void act('reverse-receipt', { requirementId: selected, receiptId: item.id, note: reason, paidOn: new Date().toLocaleDateString('en-CA'), confirmed: true }, '已撤销这笔收款记录，原记录仍保留') }}>撤销收款记录</UiButton>}</li>)}</ul>
        </section>
      </> : tab === 'production' ? <>
        <form className="wtt-assets-form" onSubmit={event => { event.preventDefault(); void act('save-production-policy', policy, '用量上限已保存，将用于之后新建的任务。') }}><h3>新任务用量上限</h3><label>对话整理方式<select value={policy?.contextMode || 'economy'} onChange={event => setPolicy({ ...policy, contextMode: event.target.value })}><option value="economy">工作台模式（自动整理长对话）</option><option value="host">使用 DSH 默认设置</option></select></label>{[['maxSteps', '最多执行轮数'], ['maxInputTokens', '累计输入上限（Token）'], ['maxOutputTokens', '累计输出上限（Token）']].map(([key, label]) => <label key={key}>{label}<input type="number" min={1} required value={policy?.[key] || ''} onChange={event => setPolicy({ ...policy, [key]: Number(event.target.value) })} /></label>)}<UiButton variant="quiet" type="submit" disabled={busy}>保存用量上限</UiButton></form>
        <p className="wtt-assets-help">Token 是模型计量文字用量的单位，不代表金额。达到上限后会在下一轮前暂停；本轮回复可能超出剩余用量。账户余额请到模型服务查看。</p>
        <label>查看任务用量<select aria-label="查看任务用量" value={taskId} onChange={event => { setTaskId(event.target.value); setProduction(null) }}><option value="">请选择任务</option>{taskRows.filter(task => task.kind === 'ai').map(task => <option key={task.id} value={task.id}>{titleOf(task)}</option>)}</select></label>
        {production && <section className="wtt-production-details"><h3>本次任务的 AI 用量</h3>{!production.usage.available && <p>{production.usage.source}。请打开任务读取用量记录。</p>}<dl>{[['modelRequests', '模型请求（含压缩）'], ['steps', '执行轮数'], ['inputTokens', '累计输入'], ['cacheReadTokens', '复用缓存'], ['uncachedInputTokens', '未缓存输入'], ['outputTokens', '累计输出（含推理与压缩）'], ['mainOutputTokens', '主任务输出（含推理）'], ['contextTokens', '当前对话长度（估算）'], ['contextWindow', '模型上下文窗口'], ['requestMaxTokens', '单次输出上限']].map(([key, label]) => <React.Fragment key={key}><dt>{label}</dt><dd>{count(production.usage[key])}</dd></React.Fragment>)}</dl><details className="wtt-assets-help"><summary>压缩、重试与耗时详情</summary><p>对话压缩：{count(production.usage.auxiliary?.requests)} 次 · 输入 {count(production.usage.auxiliary?.inputTokens)} · 压缩输出 {count(production.usage.auxiliary?.outputTokens)} · 复用缓存 {count(production.usage.auxiliary?.cacheReadTokens)}。辅助用量已计入累计输入与输出，主任务缓存单列。失败／中断采样 {count(production.usage.failures?.settlements)} 次，其中可读用量 {count(production.usage.failures?.knownUsage)} 次：输入 {count(production.usage.failures?.inputTokens)}、输出 {count(production.usage.failures?.outputTokens)}（已由官方累计，未再相加）；重试 {count(production.usage.retries)} 次。<br />最后更新：{production.usage.lastUpdatedAt ? new Date(production.usage.lastUpdatedAt).toLocaleString() : '尚未取得'} · 模型耗时 {production.usage.llmMs == null ? '—' : (production.usage.llmMs / 1000).toFixed(1) + '秒'} · 工具耗时 {production.usage.toolMs == null ? '—' : (production.usage.toolMs / 1000).toFixed(1) + '秒'}</p></details>{production.warning && <p className="wtt-asset-warning">部分用量已超过上限的 80%，请留意剩余额度。</p>}{production.usage.budgetStop && <p role="status" className="wtt-asset-warning">{production.usage.budgetStop}</p>}<UiButton variant="quiet" type="button" onClick={() => onOpenTask?.(taskRows.find(task => task.id === taskId))}>打开任务</UiButton><UiButton variant="quiet" type="button" disabled={busy} onClick={() => void act('save-task-budget', { taskId, ...policy }, '已更新用量上限。请打开任务继续，本次没有重新发送请求。')}>将这些上限应用到本任务</UiButton>
          <h3>阶段交接</h3><form className="wtt-assets-form" onSubmit={event => { event.preventDefault(); void act('save-checkpoint', { taskId, ...checkpoint }, '交接已另存，不替代用户授权') }}><label>交接名称<input required value={checkpoint.title} onChange={event => setCheckpoint({ ...checkpoint, title: event.target.value })} /></label><label>决策说明<textarea value={checkpoint.decisions} onChange={event => setCheckpoint({ ...checkpoint, decisions: event.target.value })} /></label><label>待处理<textarea value={checkpoint.pending} onChange={event => setCheckpoint({ ...checkpoint, pending: event.target.value })} /></label><UiButton variant="quiet" type="submit" disabled={busy}>保存交接文件</UiButton></form><ul>{production.checkpoints.map(item => <li key={item.id}><strong>{item.title}</strong><code>{item.path}</code></li>)}</ul>
        </section>}
      </> : <>
        <h3>工具可用性检查</h3><p>检查课件制作、文档导出和技能所需的工具是否可用。</p><UiButton variant="quiet" type="button" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { setDiagnostics(await readRef.current({ environmentCheck: 1 })) } catch (error) { setError(error.message) } finally { setBusy(false) } }}>检查工具是否可用</UiButton>
        {diagnostics && <><ul>{diagnostics.checks?.map(item => <li key={item.name}><strong>{item.name}</strong> · {item.available ? '可用' : '待配置'}<details><summary>查看配置详情</summary><p>{item.message || item.path}</p></details></li>)}</ul><details><summary>诊断信息</summary><code>{diagnostics.fingerprint}</code></details><h3>本机技能</h3><p>课程技能从本机读取。点击卡旁输入框的“／技能 → 设置常用”，搜索后点星标即可；所有项目共用。</p></>}
      </>}
    </div>
  </section>
}
