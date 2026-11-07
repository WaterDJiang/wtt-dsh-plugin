const SKILL_TOKEN = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;

/** Match the Host's whitespace-bounded /name gesture; paths and URLs are not commands. */
export function extractSkillNames(text) {
  if (typeof text !== 'string') return [];
  return [...new Set([...text.matchAll(SKILL_TOKEN)].map(match => match[2]))];
}

/** Explicit production Skills override the canvas's default engine hint. */
export function pptEngineForSelection({ pptEngine, selectedSkills = [] }) {
  const names = selectedSkills.map(name => name.replace(/-builtin$/, ''));
  if (names.includes('claude-slides')) {
    if (names.includes('wtt-course-pptx-builder')) throw new Error('PPT Builder 与宝玉制作是两种制作方式，请只选择一种。');
    return 'baoyu';
  }
  if (names.length) return 'native';
  return pptEngine || 'native';
}

/** Return the current slash query and complete token replacement range, or null. */
export function skillQueryAtCursor(text, cursor) {
  if (typeof text !== 'string' || !Number.isInteger(cursor) || cursor < 0 || cursor > text.length) return null;
  const match = text.slice(0, cursor).match(/(?:^|\s)\/([a-z0-9-]*)$/i);
  if (!match) return null;
  const start = cursor - match[1].length - 1;
  let end = cursor;
  while (end < text.length && !/\s/.test(text[end])) end += 1;
  if (!/^\/[a-z0-9-]*$/i.test(text.slice(start, end))) return null;
  return { query: match[1], start, end };
}
