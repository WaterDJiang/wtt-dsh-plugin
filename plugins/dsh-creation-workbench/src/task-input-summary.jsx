import React from 'react'
import './task-input-summary.css'

export function TaskInputSummary({ instruction, references, skills, model, engine, renderFile }) {
  return <details className="wcc-task-input-summary">
    <summary><span>本次任务</span><small>{references.length} 份引用{engine ? ` · ${engine}` : ''}</small></summary>
    <div className="wcc-task-input-body">
      <p className="wcc-task-input-label">原始要求</p><pre>{instruction || '此历史任务未记录原始要求'}</pre>
      {!!skills?.length && <p>{skills.join(' · ')}</p>}
      {model?.model && <p>任务模型：{model.model}{model.reasoningEffort ? ` · ${model.reasoningEffort}` : ''}</p>}
      {references.map(reference => <details key={reference.id}><summary>{reference.title || reference.name || '引用资料'}</summary>
        {(reference.referenceNote || reference.unavailable || ['missing', 'modified', 'changed'].includes(reference.status)) && <p role="status">{reference.referenceNote || (reference.status === 'missing' ? '文件已缺失，本次冻结内容保留' : reference.status === 'modified' ? '文件已在外部修改，本次冻结内容保留' : '来源已变化，本次冻结内容保留')}</p>}
        {renderFile?.(reference)}
        {reference.truncated && <p>本次引用为节选{Number.isFinite(reference.fullLength) ? `，原文共 ${reference.fullLength} 字符` : ''}。</p>}
        <pre>{reference.previewText ?? reference.content ?? '此格式未提取正文'}</pre></details>)}
    </div>
  </details>
}
