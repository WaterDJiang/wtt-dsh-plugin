import React from 'react'
import { EFFORT_LABELS } from './model-selection.mjs'
import './task-input-summary.css'
import { LazyDetails } from './ui/controls.jsx'

export function TaskInputSummary({ instruction, references, skills, model, engine, renderFile }) {
  const effort = model?.reasoningEffort
  const missing = references.filter(reference => reference.status === 'missing').length
  const modified = references.filter(reference => reference.status === 'modified').length
  const changed = references.filter(reference => reference.unavailable && !['missing', 'modified'].includes(reference.status) || ['changed', 'unavailable'].includes(reference.status)).length
  const warning = [missing ? `${missing}份文件已缺失` : '', modified ? `${modified}份文件已在外部修改` : '', changed ? `${changed}份来源已变化` : ''].filter(Boolean).join(' · ')
  return <LazyDetails className="wcc-task-input-summary"
    summary={<summary><span>创作详情</span>{warning && <small className="wcc-task-input-warning" role="status">{warning}</small>}{references.length > 0 && <small>{references.length} 份引用</small>}</summary>}>
    <div className="wcc-task-input-body">
      <pre>{instruction || '这次创作没有保存提示词。'}</pre>
      {(skills?.length > 0 || model?.model || engine) && <dl className="wcc-task-input-meta">
        {!!skills?.length && <><dt>使用技能</dt><dd>{skills.join('、')}</dd></>}
        {model?.model && <><dt>使用模型</dt><dd>{model.model}{effort ? ` · 推理等级 ${EFFORT_LABELS[effort] || effort}` : ''}</dd></>}
        {engine && <><dt>制作方式</dt><dd>{engine}</dd></>}
      </dl>}
      {references.map(reference => <LazyDetails key={reference.id} summary={<summary>{reference.displayTitle || reference.title || reference.name || '引用资料'}</summary>}>
        {(reference.referenceNote || reference.unavailable || ['missing', 'modified', 'changed'].includes(reference.status)) && <p role="status">{reference.referenceNote || (reference.status === 'missing' ? '文件已缺失，仍可查看引用时的内容。' : reference.status === 'modified' ? '文件已在外部修改，仍可查看引用时的内容。' : '来源已变化，仍可查看引用时的内容。')}</p>}
        {renderFile?.(reference)}
        {reference.truncated && <p>本次引用为节选{Number.isFinite(reference.fullLength) ? `，原文共 ${reference.fullLength} 字符` : ''}。</p>}
        <pre>{reference.previewText ?? reference.content ?? '此格式未提取正文'}</pre></LazyDetails>)}
    </div>
  </LazyDetails>
}
