import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf' };

// Only the actual cover and archived local assets enter this inert document.
// Never execute project scripts, fetch external assets, or export a PPTX for a card.
export function slideCoverIdentity(root) {
  const read = file => { if (realpathSync(file) !== file) throw new Error('工程封面不允许符号链接'); return readFileSync(file); };
  const deckBytes = read(path.join(root, 'deck.json'));
  const deck = JSON.parse(deckBytes);
  const cover = deck.cover || deck.order?.[0];
  if (!deck.order?.includes(cover) || !/^[A-Za-z0-9_-]{1,64}$/.test(cover)) throw new Error('工程封面索引无效');
  const html = read(path.join(root, 'slides', `${cover}.html`)).toString('utf8');
  if (Buffer.byteLength(html) > 2 * 1024 * 1024) throw new Error('工程封面超过 2 MiB，请打开工程查看');
  return { deck, html, cover, revision: sha(Buffer.concat([deckBytes, Buffer.from(html)])) };
}

export function renderSlideCover(root, tree, revision) {
  const source = slideCoverIdentity(root);
  if (revision && revision !== source.revision) throw new Error('工程封面已变化，请重新读取卡片');
  let html = source.html;
  const tags = new Set(['section', 'div', 'h1', 'h2', 'h3', 'p', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'br', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'hr', 'aside']);
  for (const match of html.matchAll(/<\/?([a-zA-Z][\w:-]*)\b/g)) {
    if (!tags.has(match[1].toLowerCase())) throw new Error(`工程封面包含暂不支持的 ${match[1]}，请打开工程查看`);
  }
  if (/\bon[a-z]+\s*=|\bsrcset\s*=|@import/i.test(html)) throw new Error('工程封面含暂不支持的活动属性或资源编码，请打开工程查看');
  let embeddedBytes = 0;
  const embed = input => {
    const name = input.trim().replace(/^['"]|['"]$/g, '');
    // Project assets are rooted at project/, never at the host or workspace.
    const relative = name.startsWith('project/') ? name.slice(8) : name;
    if (!relative || /[?#%\\:]/.test(relative) || relative.startsWith('/') || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('工程封面引用了未归档资源，请打开工程查看');
    const entry = tree.files.find(file => file.path === relative);
    const mime = MIME[path.extname(relative).toLowerCase()];
    if (!entry || !mime) throw new Error('工程封面资源不可预览，请打开工程查看');
    const file = path.join(root, relative);
    if (realpathSync(file) !== file) throw new Error('工程封面资源不允许符号链接');
    const bytes = readFileSync(file);
    if (sha(bytes) !== entry.hash) throw new Error('读取期间封面资源已变化，请重新读取');
    if ((embeddedBytes += bytes.length) > 12 * 1024 * 1024) throw new Error('工程封面资源超过 12 MiB，请打开工程查看');
    return `data:${mime};base64,${bytes.toString('base64')}`;
  };
  html = html.replace(/\bsrc\s*=\s*(["'])(.*?)\1/gi, (_all, quote, src) => `src=${quote}${embed(src)}${quote}`)
    .replace(/url\(\s*([^)]*)\)/gi, (_all, resource) => `url("${embed(resource)}")`)
    .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, '')
    .replace(/\s+hidden(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '');
  const css = '*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}section{position:relative;width:1920px;height:1080px;display:flex;flex-direction:column;overflow:hidden}div{display:flex;flex-direction:column}h1,h2,h3,p,ul,ol{margin:0}h1{font-size:96px;line-height:1.1;font-weight:600}h2{font-size:64px;line-height:1.15;font-weight:600}h3{font-size:44px;line-height:1.2;font-weight:600}p,ul,ol{font-size:32px;line-height:1.4}table{border-collapse:collapse}aside{display:none}';
  const document = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><style>${css}</style></head><body>${html}</body></html>`;
  return { revision: source.revision, treeHash: tree.hash, pageCount: source.deck.order.length, document };
}
