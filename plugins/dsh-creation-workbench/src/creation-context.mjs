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

export function adjacentCreationPosition(anchor, cards, width = CARD_WIDTH, height = CARD_HEIGHT) {
  let x = Math.min(999_000, Math.max(-999_000, anchor.position.x + (anchor.width || width) + 80));
  let y = Math.min(999_000, Math.max(-999_000, anchor.position.y));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!cards.some(card => x < card.position.x + (card.width || width) + 20 && x + width + 20 > card.position.x && y < card.position.y + (card.height || height) + 20 && y + height + 20 > card.position.y)) return { x, y };
    y += height + 48;
    if (y > 999_000) { y = Math.max(-999_000, anchor.position.y); x = Math.max(-999_000, x - width - 80); }
  }
  return { x, y };
}

// Prefer a free visible spot for B without moving the user's viewport.
export function visibleCreationPosition(anchor, cards, viewport, size, width = CARD_WIDTH, height = CARD_HEIGHT) {
  const zoom = viewport.zoom;
  const left = (16 - viewport.x) / zoom, right = (size.width - 16 - viewport.x) / zoom - width;
  const top = (96 - viewport.y) / zoom;
  const bottom = Math.max(top, (size.height - 240 - viewport.y) / zoom - height);
  if (right < left) return adjacentCreationPosition(anchor,cards,width,height);
  const clamp = p => ({x:Math.max(left,Math.min(right,p.x)),y:Math.max(top,Math.min(bottom,p.y))});
  const free = p => !cards.some(card=>p.x<card.position.x+(card.width||width)+16&&p.x+width+16>card.position.x&&p.y<card.position.y+(card.height||height)+16&&p.y+height+16>card.position.y);
  const candidates = [adjacentCreationPosition(anchor,cards,width,height),
    {x:anchor.position.x-width-80,y:anchor.position.y},
    {x:anchor.position.x,y:anchor.position.y+(anchor.height||height)+48},
    {x:anchor.position.x,y:anchor.position.y-height-48}];
  for(const p of candidates.map(clamp))if(free(p))return p;
  for(let y=top;y<=bottom;y+=height+32)for(let x=left;x<=right;x+=width+32)if(free({x,y}))return {x,y};
  const fullBottom=(size.height-16-viewport.y)/zoom-height;
  for(let y=top;y<=fullBottom;y+=height+32)for(let x=left;x<=right;x+=width+32)if(free({x,y}))return {x,y};
  return adjacentCreationPosition(anchor,cards,width,height);
}
