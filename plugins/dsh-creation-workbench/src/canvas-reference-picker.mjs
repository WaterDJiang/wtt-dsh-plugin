import { projectAgentName } from './project-agent-name.mjs'

export function uniqueCards(cards) {
  const result = new Map()
  for (const card of cards) if (card?.id && !result.has(card.id)) result.set(card.id, card)
  return [...result.values()]
}

export function sameReference(reference, candidate) {
  if (!reference?.id || !candidate?.id) return false
  if (reference.id === candidate.id) return true
  const referenceElement = reference.whiteboardSource?.elementId || (reference.kind === 'whiteboard' ? reference.id : undefined)
  const candidateElement = candidate.whiteboardSource?.elementId || (candidate.kind === 'whiteboard' ? candidate.id : undefined)
  if (!referenceElement || referenceElement !== candidateElement) return false
  const referenceHash = reference.whiteboardSource?.contentHash
  const candidateHash = candidate.whiteboardSource?.contentHash
  if (referenceHash && candidateHash) return referenceHash === candidateHash
  const normalize = card => String(card.content ?? card.text ?? '').replace(/\r\n?/g, '\n')
  return normalize(reference) === normalize(candidate)
}

export function unavailableReason(card) {
  if (card?.disabled) return card.reason || '该资料暂不可引用'
  const reasons = { missing: '文件已缺失', changed: '文件已在外部修改', modified: '文件已在外部修改', unavailable: '文件暂不可用' }
  return reasons[card?.status] || (card?.extracted === false ? reasons[card.sourceStatus] : '') || (card?.unavailable ? '原引用当前不可用' : '')
}

export function pinnedReference(card, context) {
  return Boolean(context?.pendingTaskId || context?.intent !== 'revise' && !context?.blank && (card?.pinned || sameReference(card, context?.anchor)))
}

export function referencePickReason(card, context) {
  if (context?.projectAssistant && card?.kind === 'whiteboard') return '请先将白板文字保存为素材';
  if (context?.excludedReferenceIds?.has(card?.id)) return '已在'+projectAgentName+'的引用中';
  const reason = unavailableReason(card)
  if (reason) return reason
  if (context?.conversation && ['missing', 'changed', 'modified', 'unavailable'].includes(card?.sourceStatus)) return '原文件已缺失或变化'
  if (!card?.id) return '此卡片没有可引用内容'
  const media = ['image', 'video'].includes(context?.outputType) && context?.generationMethod === 'api'
  if (media && (card.generatedFile?.mime || card.importedFile?.mime || '').startsWith('video/')) return '当前媒体 API 不支持视频引用'
  return ''
}

export function addPickedReferences(references, candidates, context) {
  const next = [...references]
  let error = ''
  for (const card of candidates) {
    if (!card || next.some(reference => sameReference(reference, card)) || referencePickReason(card, context)) continue
    if (next.length >= (context?.maxReferences ?? 24)) { error = context?.projectAssistant ? projectAgentName+'最多引用 24 张卡片，请先移除部分引用。' : context?.maxReferences !== undefined ? `本次最多可再添加 ${context.maxReferences} 份附件，请先移除部分选择。` : '一次创作最多引用 24 份资料，请先取消部分选择。'; break }
    next.push(card)
  }
  return { references: next, error }
}

export function togglePickedReference(references, card, context) {
  if (pinnedReference(card, context)) return { references, error: '' }
  if (references.some(reference => sameReference(reference, card))) return { references: references.filter(reference => !sameReference(reference, card)), error: '' }
  const error = referencePickReason(card, context)
  return error ? { references, error } : addPickedReferences(references, [card], context)
}
