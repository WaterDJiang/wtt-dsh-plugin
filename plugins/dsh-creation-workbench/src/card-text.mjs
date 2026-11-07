// File editors keep ownership of binary formats; extracted text is not their source.
export function editableCardText(card) {
  if (!card || card.kind === 'generation') return null;
  if (card.kind === 'requirement') return card.requirementBackground ?? '';
  if (card.kind === 'whiteboard') return card.text ?? '';
  if (card.kind === 'outline') return card.content ?? '';
  if (['material', 'excerpt'].includes(card.kind) && card.extracted !== false
    && !card.importedFile?.mime?.startsWith('image/') && !card.importedFile?.mime?.startsWith('video/')) return card.content ?? '';
  if (card.kind === 'artifact' && /\.(md|txt)$/i.test(card.path || '') && card.extracted !== false) return card.content ?? '';
  return null;
}

export const cardTextDraftKey = card => `${card.id}:${card.outputCard?.versionId || card.sourceHash || ''}`;
