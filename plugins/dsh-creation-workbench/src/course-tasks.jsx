import { UiButton } from './ui/controls.jsx'
import { UserError } from './user-feedback.jsx'
import React, { useEffect, useRef, useState } from 'react'
import './course-tasks.css'
import { mediaSizeLabel } from './media-creation.jsx'

const STATUS = {
  draft: '未发送', submitting: '正在提交', accepted: '已提交',
  output: '已有文件，待审阅', failed: '发送失败', unknown: '请核对提交结果',
  proposed: '修改待确认', applied: '已应用源稿', discarded: '已放弃',
}
const SOURCE_KINDS = { requirement: '需求', material: '素材', excerpt: '摘录', outline: '大纲版本', artifact: '已保存文件', word: 'Word 对应大纲' }
const FILE_KINDS = { image: '生成图片', video: '生成视频', text: '文本', pptx: 'PPT 课件', exercise: '课堂练习', script: '讲师逐字稿', storyboard: 'PPT 分镜', support: '制作资料' }
function taskName(task) {
  return task.files?.find(file => !['support', 'storyboard'].includes(file.kind))?.title || task.instruction?.replace(/(^|\s)\/[a-z0-9-]+(?=\s|$)/g, ' ').replace(/CW[- ]?\d+\s*[A-Z0-9]*[：:]?/g, '').trim().slice(0, 70) || task.title || '未命名任务'
}
const REQUIREMENT_FIELDS = { title: '画布名称', customer: '客户', client: '客户', audience: '受众',
  background: '背景', objectives: '目标', goals: '培训目标', duration: '时长',
  description: '需求描述', status: '需求状态', participants: '参训对象', notes: '备注' }

function messageOf(value) { return value instanceof Error ? value.message : String(value) }
function textOf(value) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
function versionLabel(artifact) { return artifact.number == null ? artifact.versionId : `v${String(artifact.number).padStart(3, '0')}` }
function timeLabel(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

function SourceSnapshot({ source }) {
  const excerpt = source.kind === 'excerpt' ? source.excerptInfo || source : null
  return <details className="wcc-task-source" open={source.kind === 'excerpt'}>
    <summary><span>{SOURCE_KINDS[source.kind] || '来源'}</span>{source.title || source.cardId}</summary>
    {source.noteTruncated && <p className="wcc-inline-warning">{typeof source.noteTruncated === 'string' ? source.noteTruncated : '本次任务的来源正文仅包含节选。'}</p>}
    {excerpt ? <>
      {(excerpt.sourceTitle || excerpt.rangeLabel) && <p className="wcc-task-source-origin">{excerpt.sourceTitle}{excerpt.rangeLabel ? ` · ${excerpt.rangeLabel}` : ''}</p>}
      <span className="wcc-task-field-label">摘录原文</span>
      <pre>{excerpt.quote ?? source.content ?? '原文未提供'}</pre>
      <span className="wcc-task-field-label">注释</span>
      <pre className="wcc-task-annotation">{excerpt.annotation || '未填写注释。'}</pre>
    </> : <pre>{source.content || '该来源未提供可用正文。'}</pre>}
    {(source.path || source.hash || source.sourceHash) && <div className="wcc-task-source-meta">
      {source.path && <span>文件：<code>{source.path}</code></span>}
      {(source.hash || source.sourceHash) && <span>来源校验：<code>{source.hash || source.sourceHash}</code></span>}
    </div>}
  </details>
}

function TaskInput({ input }) {
  if (!input) return <p className="wcc-task-muted">这次任务没有保存输入资料。</p>
  const requirement = input.requirement || {}
  const skill = input.skill
  return <div className="wcc-task-input">
    <details className="wcc-task-requirement">
      <summary>创建任务时的背景</summary>
      <dl>{Object.entries(requirement).filter(([key, value]) => value != null && value !== '' && !['id', 'createdAt', 'updatedAt'].includes(key)).map(([key, value]) => <React.Fragment key={key}>
        <dt>{REQUIREMENT_FIELDS[key] || key}</dt><dd>{textOf(value)}</dd>
      </React.Fragment>)}</dl>
    </details>
    {input.selection && <section className="wcc-task-selection">
      <span className="wcc-task-field-label">本次选段{input.selection.rangeLabel ? ` · ${input.selection.rangeLabel}` : ''}</span>
      <pre>{input.selection.quote}</pre>
      <small>来自 {input.sources?.find(source => source.cardId === input.selection.sourceCardId)?.title || input.selection.sourceCardId}</small>
    </section>}
    {!!input.sources?.length && <section aria-label="本次引用的资料">
      <h4>引用资料 · {input.sources.length}</h4>
      {input.sources.map((source, index) => <SourceSnapshot key={`${source.cardId || source.id || index}:${source.hash || ''}`} source={source} />)}
    </section>}
    <section className="wcc-task-instruction"><h4>创作要求</h4><pre>{input.instruction || '未填写创作要求。'}</pre></section>
    {input.media && <section><h4>生成参数</h4><dl>{[['模型', input.media.model], ['比例', input.media.ratio], ['分辨率', input.media.resolution], ['时长（秒）', input.media.duration]].filter(([, value]) => value != null).map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{String(value)}</dd></React.Fragment>)}</dl></section>}
    {input.effectivePrompt && <details><summary>实际发送的提示词</summary><pre>{input.effectivePrompt}</pre></details>}
    {skill && <details className="wcc-task-skill"><summary>所用技能</summary><pre>{textOf(skill)}</pre></details>}
  </div>
}

export function CourseTasks({ tasks = [], pendingTaskIds = [], loadTask, onOpenArtifact, onOpenSession, onResumeMediaTask, getDownloadHref, getFileDownloadHref, busy = false }) {
  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [resumes, setResumes] = useState({})
  const [filter, setFilter] = useState('all')
  const visibleTasks = tasks.filter(task => filter === 'all' || filter === 'running' && task.runtimeState?.phase === 'generating'
    || filter === 'pending' && pendingTaskIds.includes(task.id) || filter === 'review' && task.status === 'output' || filter === 'failed' && (task.runtimeState?.phase === 'failed' || ['failed', 'unknown'].includes(task.status)))
  const requestRef = useRef(0)
  const loadRef = useRef(loadTask)
  loadRef.current = loadTask
  const selected = visibleTasks.find(task => task.id === selectedId) || visibleTasks[0] || null
  const activeId = selected?.id
  const updatedAt = selected?.updatedAt
  const canLoad = typeof loadTask === 'function'

  useEffect(() => {
    if (selectedId && !tasks.some(task => task.id === selectedId)) setSelectedId(null)
  }, [tasks, selectedId])

  useEffect(() => {
    const request = ++requestRef.current
    let disposed = false
    setDetail(null)
    setError('')
    if (!activeId || !canLoad) { setLoading(false); return () => { disposed = true } }
    setLoading(true)
    Promise.resolve().then(() => loadRef.current(activeId)).then(result => {
      if (disposed || requestRef.current !== request) return
      const next = result?.task || result
      if (!next || next.id !== activeId) throw new Error('任务详情与当前任务不匹配，请重新读取。')
      setDetail(next)
    }).catch(cause => {
      if (!disposed && requestRef.current === request) setError(messageOf(cause))
    }).finally(() => {
      if (!disposed && requestRef.current === request) setLoading(false)
    })
    return () => { disposed = true }
  }, [activeId, updatedAt, canLoad, retry])

  const loadedTask = detail?.id === activeId ? detail : null
  // Word paths are derived from version records and can change without advancing task.updatedAt.
  const detailIsCurrent = loadedTask && (!updatedAt || !loadedTask.updatedAt || loadedTask.updatedAt > updatedAt)
  const task = selected ? detailIsCurrent ? { ...selected, ...loadedTask } : { ...loadedTask, ...selected } : null
  const resumeState = resumes[task?.id] || {}

  async function resumeMedia(id) {
    setResumes(previous => ({ ...previous, [id]: { pending: true } }))
    try {
      await onResumeMediaTask(id)
      setResumes(previous => ({ ...previous, [id]: {} }))
      setRetry(value => value + 1)
    } catch (cause) { setResumes(previous => ({ ...previous, [id]: { error: messageOf(cause) } })) }
  }

  return <section className="wcc-course-tasks" aria-label="创作任务" aria-busy={loading}>
    <header className="wcc-tasks-heading"><div><h2>创作任务</h2><p>在这里查看生成进度、回答 AI 的问题和打开成果文件。</p></div><span>{tasks.length}</span></header>
    <div className="wcc-task-filters" role="group" aria-label="筛选创作任务">{[['all', '全部'], ['running', '运行中'], ['pending', '待确认'], ['review', '待审阅'], ['failed', '异常']].map(([value, label]) => <UiButton variant="custom" key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</UiButton>)}</div>
    {!!tasks.length && !visibleTasks.length && <p role="status">此筛选下没有任务。</p>}
    {!tasks.length ? <div className="wcc-tasks-empty"><span aria-hidden="true">☷</span><p>还没有创作任务</p><small>点击卡片填写要求，即可开始创作；手动保存的新版本也会记录在这里。</small></div> : <>
      <div className="wcc-task-list" aria-label="选择任务">
        {visibleTasks.map(item => <UiButton variant="custom" type="button" key={item.id} className={`wcc-task-list-item${item.id === activeId ? ' is-active' : ''}`} aria-pressed={item.id === activeId} onClick={() => setSelectedId(item.id)}>
          <span className="wcc-task-list-top"><span>{item.kind === 'manual' ? '人工修订' : item.kind === 'media' ? 'AI 媒体生成' : 'AI 创作'}</span><time dateTime={item.createdAt}>{timeLabel(item.createdAt)}</time></span>
          <strong>{taskName(item)}</strong>
          <span className={`wcc-task-status is-${item.status}`}>{STATUS[item.status] || item.status || '状态未提供'}{item.artifacts?.length ? ` · ${item.artifacts.length} 个大纲版本` : ''}{item.files?.length ? ` · ${item.files.length} 个文件` : ''}</span>
        </UiButton>)}
      </div>
      {task && <article className="wcc-task-detail" aria-label="任务详情">
        <div className="wcc-task-detail-heading"><span className={`wcc-task-status is-${task.status}`}>{STATUS[task.status] || task.status || '状态未提供'}</span><UiButton variant="quiet" type="button" className="wcc-text-button" onClick={() => setRetry(value => value + 1)} disabled={loading || !canLoad}>刷新详情</UiButton></div>
        <h3>{taskName(task)}</h3>
        {task.status === 'accepted' && <p className="wcc-task-state-note">请求已提交，尚未登记可审阅的成果文件。</p>}
        {task.status === 'submitting' && <p className="wcc-task-state-note">正在确认是否提交成功。先等待结果，不要重复发送。</p>}
        {task.status === 'unknown' && <p className="wcc-inline-warning">{task.kind === 'media' ? '即梦提交结果未知。本任务不会自动重新生成，请先在即梦核对生成记录。' : '发送结果尚未核实。打开任务对话核对后再决定下一步。'}</p>}
        {task.mediaJob?.canResume && onResumeMediaTask && <UiButton variant="quiet" type="button" className="wcc-task-session" disabled={busy || resumeState.pending} onClick={() => void resumeMedia(task.id)}>{resumeState.pending ? '查询中…' : '查询原任务／重新取回文件'}</UiButton>}
        {resumeState.error && <UserError className="wcc-error" error={resumeState.error} />}
        {task.error && <UserError className="wcc-error" error={textOf(task.error)} />}
        {task.sessionId && <UiButton variant="quiet" className="wcc-task-session" type="button" disabled={!!busy || !onOpenSession} onClick={() => onOpenSession(task.sessionId)}>打开任务对话 →</UiButton>}
        <section className="wcc-task-artifacts" aria-label="任务成果文件"><h4>本次成果文件 · {(task.artifacts?.length || 0) + (task.files?.length || 0)}</h4>
          {task.artifacts?.length ? task.artifacts.map(artifact => <div className="wcc-task-artifact" key={artifact.versionId}>
            <strong>大纲 {versionLabel(artifact)}</strong>
            <div><UiButton variant="quiet" type="button" disabled={!!busy || !artifact.markdownPath || !onOpenArtifact} onClick={() => onOpenArtifact({ versionId: artifact.versionId, kind: 'outline' })}>打开大纲</UiButton>
              {artifact.wordPath ? getDownloadHref
                ? <a className="wcc-task-download" href={getDownloadHref(artifact.versionId)} download>下载 Word</a>
                : <UiButton variant="quiet" type="button" disabled={!!busy || !onOpenArtifact} onClick={() => onOpenArtifact({ versionId: artifact.versionId, kind: 'word' })}>查看 Word</UiButton>
                : <span>Word 未生成</span>}</div>
            <details><summary>版本文件</summary>{artifact.markdownPath && <code>{artifact.markdownPath}</code>}{artifact.wordPath && <code>{artifact.wordPath}</code>}</details>
          </div>) : !task.files?.length && <p className="wcc-task-muted">还没有保存成果文件，请打开任务对话查看进度。</p>}
          {task.files?.map(file => <div className="wcc-task-artifact" key={file.id}>
            <strong>{FILE_KINDS[file.kind] || '成果文件'} · {file.title}</strong>
            <div><UiButton variant="quiet" type="button" disabled={!!busy || !onOpenArtifact} onClick={() => onOpenArtifact({ artifactId: file.id, kind: 'artifact' })}>在画布查看</UiButton>
              {getFileDownloadHref && <a className="wcc-task-download" href={getFileDownloadHref(file.id)} download>下载文件</a>}</div>
            <details><summary>文件与技术检查</summary><code>{file.path}</code>{mediaSizeLabel(file) && <small>实际文件：{mediaSizeLabel(file)}</small>}<small>{file.kind === 'pptx' ? '已通过可编辑性检查；教学内容仍需审阅。' : '已核对实际文件格式与完整性；内容仍需审阅。'}</small></details>
          </div>)}
        </section>
        <section className="wcc-task-input-section" aria-label="任务输入"><h4>任务本次使用的资料</h4>
          {loading ? <p className="wcc-task-muted" role="status">正在读取本次使用的资料…</p> : error ? <UserError className="wcc-error" error={error} /> : <TaskInput input={detail?.id === activeId ? detail.input : selected.input} />}
        </section>
        <details className="wcc-task-identifiers"><summary>任务标识与时间</summary><dl>
          <dt>任务 ID</dt><dd>{task.id}</dd>
          {task.requestId && <><dt>请求 ID</dt><dd>{task.requestId}</dd></>}
          {task.sessionId && <><dt>会话 ID</dt><dd>{task.sessionId}</dd></>}
          {task.createdAt && <><dt>创建</dt><dd>{task.createdAt}</dd></>}
          {task.updatedAt && <><dt>更新</dt><dd>{task.updatedAt}</dd></>}
        </dl></details>
      </article>}
    </>}
  </section>
}
