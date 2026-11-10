const GAP = 48;
const LIMIT = 1_000_000;

export function arrangeCardBlocks(blocks, fixed) {
  if (!blocks.length) return new Map();
  const ordered = [...blocks].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
  const columns = Math.min(8, Math.ceil(Math.sqrt(ordered.length)));
  const rows = [];
  for (let start = 0; start < ordered.length; start += columns) {
    const cards = ordered.slice(start, start + columns);
    rows.push({ cards, height: Math.max(...cards.map(card => card.height)),
      width: cards.reduce((width, card) => width + card.width + GAP, -GAP) });
  }
  const width = Math.max(...rows.map(row => row.width));
  const height = rows.reduce((total, row) => total + row.height + GAP, -GAP);
  const left = Math.max(-LIMIT, Math.min(...ordered.map(card => card.x), LIMIT - width));
  let y = Math.max(-LIMIT, Math.min(ordered[0].y, LIMIT - height));
  const obstacles = [...fixed].sort((a, b) => a.x - b.x);
  const positions = new Map();
  for (const row of rows) {
    const nearby = obstacles.filter(box => box.y < y + row.height + GAP && box.y + box.height + GAP > y);
    let x = left;
    for (const card of row.cards) {
      for (const box of nearby) {
        if (box.y < y + card.height + GAP && x < box.x + box.width + GAP && x + card.width + GAP > box.x) {
          x = box.x + box.width + GAP;
        }
      }
      if (x + card.width > LIMIT || y + card.height > LIMIT) throw new Error('排版超出画布坐标范围，请缩小分组跨度后重试。');
      positions.set(card.id, { x, y });
      x += card.width + GAP;
    }
    y += row.height + GAP;
  }
  return positions;
}
