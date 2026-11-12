// 画布卡片能力矩阵的唯一判定入口：客户端 UI 与服务端保存分支都从这里取值。
// 输入为画布节点数据（getBoard 输出与客户端 node.data 同构），纯函数、无 IO。
// 业务契约：导入副本冻结（另存素材）、产物/大纲不可覆盖版本链、摘录为引文、外部修改拒绝覆盖。

const TEXT_FILE = /\.(md|markdown|txt)$/i;
const OFFICE_FILE = /\.(docx|pptx|csv|pdf)$/i;

export function cardDisplayTitle(card) {
  return card?.defaultOutcome?.title || card?.title || card?.defaultOutcome?.name || '';
}

export function editableCardText(card) {
  if (!card) return null;
  if (card.kind === 'generation') return card.composition?.editable && card.outputCard?.type === 'text' ? '' : null;
  if (card.kind === 'requirement') return card.requirementBackground ?? '';
  if (card.kind === 'whiteboard') return card.text ?? '';
  if (card.kind === 'outline') return card.content ?? '';
  if (['material', 'excerpt'].includes(card.kind)) {
    if (card.importedFile?.mime?.startsWith('image/') || card.importedFile?.mime?.startsWith('video/')) return null;
    if (card.extracted !== false) return card.content ?? '';
    // 提取失败的纯文本文件（如文件树新建的空 md 拖入后的引用卡）从空正文起编；卡片上的状态提示文案不是正文
    return card.importedFile?.mime?.startsWith('text/') ? '' : null;
  }
  if (card.kind === 'artifact' && /\.(md|txt)$/i.test(card.path || '') && card.extracted !== false) return card.content ?? '';
  return null;
}

export const cardTextDraftKey = card => `${card.id}:${card.outputCard?.versionId || card.sourceHash || ''}`;

// 展示格式与需求／参考用途独立；不改变业务 kind 或版本规则。
export function cardFormat(card) {
  if (['requirement', 'outline', 'excerpt'].includes(card.kind)) return 'text';
  const type = card.outputCard?.type || card.artifactKind;
  const mime = card.generatedFile?.mime || card.importedFile?.mime || card.mime || '';
  const file = card.importedFile?.name || (card.kind === 'material' ? card.sourcePath || card.path : card.path) || '';
  if (type === 'pptx' || /presentation|powerpoint/.test(mime) || /\.(pptx?|odp)$/i.test(file)) return 'pptx';
  if (type === 'image' || mime.startsWith('image/') || card.imagePreview || /\.(png|jpe?g|webp|gif|svg)$/i.test(file)) return 'image';
  if (type === 'video' || mime.startsWith('video/') || card.videoPreview || /\.(mp4|webm|mov)$/i.test(file)) return 'video';
  if (card.kind === 'word' || /\.(pdf|docx?|xlsx?|csv|ods|odt)$/i.test(file) || /pdf|word|spreadsheet|csv/.test(mime)) return 'document';
  if (card.kind === 'material' || /\.(md|txt|jsonl?|html?)$/i.test(file) || ['text', 'outline', 'script', 'storyboard', 'excerpt'].includes(type)) return 'text';
  return null;
}

export function cardPurpose(card) {
  if (card.kind === 'requirement') return '背景';
  if (['material', 'excerpt'].includes(card.kind)) return '参考';
  return null;
}

// 保存去向：客户端自动保存条件与按钮文案、服务端写回分支共用同一判定（判定顺序即优先级）。
export function cardWriteBack(card) {
  if (!card) return { mode: 'none', path: null };
  if (card.kind === 'generation' && editableCardText(card) !== null) return { mode: 'draft', path: null };
  if (card.kind === 'requirement') return { mode: 'background', path: null };
  if (card.kind === 'outline') return { mode: 'version', path: null };
  if (card.kind === 'artifact' && card.outputCard && TEXT_FILE.test(card.path || '') && card.extracted !== false) return { mode: 'version', path: null };
  if (card.kind === 'material' && editableCardText(card) !== null) {
    if (card.projectFile && TEXT_FILE.test(card.projectFile.path || '')) return { mode: 'project-file', path: card.projectFile.path };
    if (card.importedFile) return { mode: 'none', path: null };
    if (!card.sourcePath && TEXT_FILE.test(card.path || '')) return { mode: 'snapshot', path: card.path };
  }
  return { mode: 'none', path: null };
}

// 「打开方式」菜单的目标真实文件；应用列表由服务端按格式枚举，capability 只给路径与类别。
export function cardOpenFile(card) {
  if (!card) return null;
  if (card.projectFile?.path) return { path: card.projectFile.path, source: 'project' };
  if (card.importedFile?.path) return { path: card.importedFile.path, source: 'import' };
  if (card.kind === 'material' && card.path) return { path: card.path, source: 'snapshot' };
  if (['artifact', 'word', 'outline'].includes(card.kind) && card.path) return { path: card.path, source: 'registered' };
  return null;
}

function openWithCategory(card, path) {
  if (!path) return null;
  if (TEXT_FILE.test(path)) return 'text';
  if (OFFICE_FILE.test(path)) return 'office';
  if (card.importedFile?.mime?.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(path)) return 'view';
  if (card.importedFile?.mime?.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(path)) return 'view';
  return null;
}

export function cardCapabilities(card) {
  const format = cardFormat(card);
  const base = format === 'text' ? editableCardText(card) : null;
  const writeBack = cardWriteBack(card);
  const openFile = cardOpenFile(card);
  return {
    format,
    purpose: cardPurpose(card),
    editableText: { editable: base !== null, base },
    writeBack,
    openWith: openFile ? { path: openFile.path, source: openFile.source, sourceRef: openFile.sourceRef || null, category: openWithCategory(card, openFile.path) } : null,
    versioned: Boolean(card.outputCard?.versions?.length > 0 || card.materialVersions?.length || writeBack.mode === 'snapshot'),
    aiChat: Boolean(card) && card.kind !== 'generation',
  };
}
