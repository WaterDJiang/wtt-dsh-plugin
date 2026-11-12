import { extractSkillNames } from './skill-commands.mjs';
export const CARD_WIDTH = 320;
export const CARD_HEIGHT = 256;
const BLOCKED = /^(missing|modified|changed|unavailable)$/;
const FIELDS = ['id', 'nodeId', 'kind', 'artifactKind', 'title', 'number', 'refId', 'content', 'excerpt', 'path', 'sourcePath', 'sourceHash', 'status', 'sourceStatus', 'extracted', 'excerptInfo', 'importedFile', 'generatedFile', 'whiteboardSource', 'referenceNote', 'unavailable'];

// Layout uses a stable node id; references always name an immutable physical version.
export function creationSource(card) {
  return card?.sourceId ? { ...card, id: card.sourceId, nodeId: card.nodeId || card.id } : card;
}

export function usableCreationSource(card) {
  return Boolean(card && card.kind !== 'whiteboard' && /^[a-f0-9]{64}$/i.test(card.sourceHash || '') && !BLOCKED.test(card.status || ''));
}

export function freezeCreationSource(card) {
  card = creationSource(card);
  if (!usableCreationSource(card)) throw new Error('此卡片尚无可用的已保存来源，请先保存素材或核对文件状态。');
  const value = Object.fromEntries(FIELDS.filter(key => card[key] !== undefined).map(key => [key, card[key]]));
  return JSON.parse(JSON.stringify(value));
}

export function createCardContext({ projectId, projectName, projectPath, requirement, anchor, outputType = 'outline', outputPosition, selection, generation, blank = false }) {
  if (!projectId || !requirement?.id) throw new Error('项目或画布尚未就绪。');
  if (blank && anchor?.kind !== 'canvas') throw new Error('空白创作只能从画布入口发起');
  const frozen = blank ? { id: `canvas:${requirement.id}`, kind: 'canvas', title: '新建内容' } : freezeCreationSource(anchor);
  const references = blank ? [] : [frozen];
  return {
    key: `${projectId}:${requirement.id}:${frozen.id}:${outputType}${selection ? `:range:${selection.start}-${selection.end}` : ''}`,
    projectId, projectName, projectPath, requirementId: requirement.id, requirementTitle: requirement.title,
    requirement: Object.fromEntries(['id', 'title', 'customer', 'audience', 'background', 'objectives'].map(key => [key, requirement[key] || ''])),
    anchor: frozen, blank, intent: 'new', outputType, ...(outputType === 'pptx' ? { pptEngine: 'baoyu' } : {}), references, instruction: '',
    originalInput: { instruction: '', references: JSON.parse(JSON.stringify(references)), taskId: null, sessionId: null },
    ...(generation ? { generation: { ...generation } } : {}),
    outputPosition: { ...outputPosition }, ...(selection ? { selection: JSON.parse(JSON.stringify(selection)) } : {}),
  };
}

export function createCompositionContext({projectId,projectName,projectPath,requirement,descriptor}) {
  const {card,node,composition}=descriptor;
  const references=JSON.parse(JSON.stringify(composition.references));
  const anchor=references[0]||{id:`canvas:${requirement.id}`,kind:'canvas',title:'新建内容'};
  return {key:`${projectId}:${requirement.id}:compose:${card.id}`,projectId,projectName,projectPath,
    requirementId:requirement.id,requirementTitle:requirement.title,requirement,anchor,
    targetCard:JSON.parse(JSON.stringify(node)),composerNodeId:node.id,intent:'new',blank:references.length===0,
    outputType:card.type,...(card.type==='pptx'?{pptEngine:'baoyu'}:{}),references,instruction:composition.instruction,
    draftRevision:composition.revision,draftSaved:JSON.stringify([composition.instruction,references.map(r=>[r.id,r.sourceHash])]),
    generation:{mode:'new',cardId:card.id},outputPosition:{...node.position},
    originalInput:{instruction:composition.instruction,references:JSON.parse(JSON.stringify(references)),taskId:null,sessionId:null}};
}

export function createRevisionContext({ projectId, projectName, projectPath, requirement, descriptor }) {
  const { card, version, node, editor } = descriptor || {};
  if (!projectId || !requirement?.id || !card?.id || !version?.id || !node) throw new Error('此产物版本记录不完整，请刷新画布。');
  const references = JSON.parse(JSON.stringify(editor?.references || []));
  const originalInput = { instruction: editor?.instruction || '', references: JSON.parse(JSON.stringify(references)),
    taskId: editor?.taskId || version.taskId || null, sessionId: editor?.sessionId || null,
    generationMethod: editor?.generationMethod || 'skill',
    ...(editor?.media ? { mediaOptions: { ...editor.media } } : {}),
    ...(editor?.mediaJob ? { mediaJob: { ...editor.mediaJob } } : {}),
  };
  return {
    key: `${projectId}:${requirement.id}:revise:${card.id}:${version.id}`,
    projectId, projectName, projectPath, requirementId: requirement.id, requirementTitle: requirement.title,
    requirement: Object.fromEntries(['id', 'title', 'customer', 'audience', 'background', 'objectives'].map(key => [key, requirement[key] || ''])),
    anchor: creationSource(node), targetCard: JSON.parse(JSON.stringify(node)), intent: 'revise',
    outputType: card.type, ...(card.type === 'pptx' ? { pptEngine: editor?.pptEngine || 'native' } : {}), references, instruction: editor?.instruction || '',
    ...(editor?.modelSelection ? { modelSelection: { ...editor.modelSelection } } : {}),
    originalInput,
    generation: { mode: 'revise', cardId: card.id, baseVersionId: version.id },
    outputPosition: { ...node.position },
    taskId: editor?.taskId || version.taskId || null, sessionId: editor?.sessionId || null,
    generationMethod: 'skill',
    ...(editor?.media ? { mediaOptions: { ...editor.media } } : {}),
    ...(editor?.mediaJob ? { mediaJob: { ...editor.mediaJob } } : {}),
    recorded: editor?.recorded !== false, referenceNotes: JSON.parse(JSON.stringify(editor?.referenceNotes || [])),
    selectedSkills: [...(editor?.selectedSkills || [])],
    baseVersion: { id: version.id, number: version.number },
  };
}

export function updateCreationReferences(context, cards) {
  const pinned = context.intent !== 'revise' && !context.blank;
  const seen = new Set(pinned ? [context.anchor.id] : []);
  const references = pinned ? [context.anchor] : [];
  for (let card of cards) {
    card = creationSource(card);
    if (seen.has(card.id)) continue;
    if (references.length >= 24) throw new Error('一次创作最多引用 24 张卡片。');
    seen.add(card.id);
    // Keep a previously pinned snapshot; only a newly added reference is captured now.
    references.push(context.references.find(item => item.id === card.id) || freezeCreationSource(card));
  }
  return { ...context, references };
}

export function creationTaskInput(context) {
  return { requirementId: context.requirementId, selectedCardIds: context.references.map(card => card.id),
    sourceRefs: context.references.map(card => ({ cardId: card.id, hash: card.sourceHash })),
    instruction: context.instruction.trim(), outputType: context.outputType, ...(context.pptEngine ? { pptEngine: context.pptEngine } : {}), outputPosition: { ...context.outputPosition },
    selectedSkills: extractSkillNames(context.instruction),
    ...(['image', 'video'].includes(context.outputType) ? { generationMethod: context.generationMethod || 'skill' } : {}),
    ...(context.selection ? { selection: { ...context.selection } } : {}),
    ...(context.generation ? { generation: { ...context.generation } } : {}) };
}

// Shared by first creation and multi-output registration. Never return an occupied fallback.
export function creationSourceAnchor(sources, cards) {
  for (const source of sources || []) {
    const id = typeof source === 'string' ? source : source.nodeId || source.cardId || source.id;
    const card = cards.find(value => value.id === id || value.sourceId === id || value.outputCard?.versions?.some(version => version.primaryRef === id));
    if (card) return card;
  }
}

export function creationPositionFree(position, cards, width = CARD_WIDTH, height = CARD_HEIGHT) {
  return Number.isFinite(position?.x) && Number.isFinite(position?.y) && Math.abs(position.x) <= 999_000 && Math.abs(position.y) <= 999_000
    && !cards.some(card => position.x < card.position.x + (card.width || CARD_WIDTH) + 24
      && position.x + width + 24 > card.position.x && position.y < card.position.y + (card.height || CARD_HEIGHT) + 24
      && position.y + height + 24 > card.position.y);
}

export function adjacentCreationPosition(anchor, cards, width = CARD_WIDTH, height = CARD_HEIGHT) {
  const min = -999_000, maxX = 999_000 - width, maxY = 999_000 - height;
  const clamp = (value, max) => Math.max(min, Math.min(max, value));
  const origin = { x: clamp(anchor.position.x + (anchor.width || CARD_WIDTH) + 80, maxX), y: clamp(anchor.position.y, maxY) };
  const columns = new Set([origin.x, clamp(anchor.position.x - width - 80, maxX), min, maxX]);
  for (const card of cards) {
    columns.add(clamp(card.position.x + (card.width || CARD_WIDTH) + 24, maxX));
    columns.add(clamp(card.position.x - width - 24, maxX));
  }
  let best = null, score = Infinity;
  for (const x of [...columns].sort((a, b) => Math.abs(a - origin.x) - Math.abs(b - origin.x) || b - a)) {
    const distance = (x - origin.x) ** 2;
    if (distance > score) break;
    const intervals = cards.filter(card => x < card.position.x + (card.width || CARD_WIDTH) + 24 && x + width + 24 > card.position.x)
      .map(card => [card.position.y - height - 24, card.position.y + (card.height || CARD_HEIGHT) + 24]).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const interval of intervals) {
      const last = merged.at(-1);
      if (last && interval[0] < last[1]) last[1] = Math.max(last[1], interval[1]);
      else merged.push([...interval]);
    }
    const blocked = merged.find(([top, bottom]) => origin.y > top && origin.y < bottom);
    const rows = blocked ? [blocked[1], blocked[0]] : [origin.y];
    for (const y of rows) {
      if (y < min || y > maxY) continue;
      const nextScore = distance + (y - origin.y) ** 2;
      if (nextScore < score && creationPositionFree({ x, y }, cards, width, height)) { best = { x, y }; score = nextScore; }
    }
  }
  if (!best) throw new Error('来源附近没有可用的卡片位置，请整理画布后重试。');
  return best;
}

// Keep the existing caller contract; source proximity now takes precedence over the viewport.
export function visibleCreationPosition(anchor, cards, viewport, size, width = CARD_WIDTH, height = CARD_HEIGHT) {
  return adjacentCreationPosition(anchor, cards, width, height);
}
