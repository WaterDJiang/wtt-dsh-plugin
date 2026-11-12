const GAP = 48;
const LIMIT = 1_000_000;

function arrangeGrid(blocks, fixed) {
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


const readingOrder = (a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id);

// Cyclic references stay together; the condensation graph still has a usable hierarchy.
function sourceRanks(nodes, edges) {
  const next = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) next.get(edge.source).push(edge.target);
  const index = new Map(), low = new Map(), stack = [], active = new Set(), groups = [];
  function visit(id) {
    index.set(id, index.size); low.set(id, index.get(id)); stack.push(id); active.add(id);
    for (const child of next.get(id)) {
      if (!index.has(child)) { visit(child); low.set(id, Math.min(low.get(id), low.get(child))); }
      else if (active.has(child)) low.set(id, Math.min(low.get(id), index.get(child)));
    }
    if (low.get(id) === index.get(id)) {
      const group = []; let member;
      do { member = stack.pop(); active.delete(member); group.push(member); } while (member !== id);
      groups.push(group);
    }
  }
  for (const node of nodes) if (!index.has(node.id)) visit(node.id);
  const owner = new Map(groups.flatMap((group, n) => group.map(id => [id, n])));
  const children = groups.map(() => new Set()), incoming = groups.map(() => 0), ranks = groups.map(() => 0);
  for (const edge of edges) {
    const from = owner.get(edge.source), to = owner.get(edge.target);
    if (from !== to && !children[from].has(to)) { children[from].add(to); incoming[to]++; }
  }
  const queue = incoming.flatMap((count, n) => count === 0 ? [n] : []);
  for (let i = 0; i < queue.length; i++) for (const child of children[queue[i]]) {
    ranks[child] = Math.max(ranks[child], ranks[queue[i]] + 1);
    if (--incoming[child] === 0) queue.push(child);
  }
  return new Map(nodes.map(node => [node.id, ranks[owner.get(node.id)]]));
}

function relatedFamilies(blocks, edges) {
  const byId = new Map(blocks.map(block => [block.id, block]));
  const neighbors = new Map(blocks.map(block => [block.id, []]));
  for (const edge of edges) { neighbors.get(edge.source).push(edge.target); neighbors.get(edge.target).push(edge.source); }
  const visited = new Set(), families = [];
  for (const block of [...blocks].sort(readingOrder)) {
    if (visited.has(block.id)) continue;
    const ids = [block.id]; visited.add(block.id);
    for (let i = 0; i < ids.length; i++) for (const id of neighbors.get(ids[i])) if (!visited.has(id)) { visited.add(id); ids.push(id); }
    const members = new Set(ids), nodes = ids.map(id => byId.get(id));
    const relations = edges.filter(edge => members.has(edge.source));
    const sources = relations.filter(edge => edge.provenance);
    const ranks = sourceRanks(nodes, sources.length ? sources : relations);
    // Manual links group related notes without reversing or flattening source levels.
    if (sources.length) {
      const ranked = new Set(sources.flatMap(edge => [edge.source, edge.target])), queue = [...ranked];
      for (let i = 0; i < queue.length; i++) for (const id of neighbors.get(queue[i])) if (!ranked.has(id)) {
        ranks.set(id, ranks.get(queue[i])); ranked.add(id); queue.push(id);
      }
    }
    const layers = [];
    for (const node of nodes) (layers[ranks.get(node.id)] ||= []).push(node);
    families.push({ nodes, relations, ranks, layers: layers.filter(Boolean) });
  }
  return families;
}

export function arrangeCardBlocks(blocks, fixed, relations = []) {
  const known = new Set(blocks.map(block => block.id));
  const edges = relations.filter(edge => edge.source !== edge.target && known.has(edge.source) && known.has(edge.target));
  if (!edges.length) return arrangeGrid(blocks, fixed);
  const families = relatedFamilies(blocks, edges), connected = families.filter(family => family.relations.length);
  const isolated = families.filter(family => !family.relations.length).flatMap(family => family.nodes).sort(readingOrder);
  const spans = connected.map(family => family.layers.reduce((width, layer) => width + Math.max(...layer.map(node => node.width)) + 80, -80));
  if (isolated.length) spans.push(Math.max(...isolated.map(node => node.width)) * Math.min(8, Math.ceil(Math.sqrt(isolated.length))) + GAP * 7);
  const span = Math.max(...spans);
  if (span > 2 * LIMIT || blocks.some(node => node.width > 2 * LIMIT || node.height > 2 * LIMIT)) throw new Error('排版超出画布坐标范围，请缩小分组跨度后重试。');
  const left = Math.max(-LIMIT, Math.min(...blocks.map(node => node.x), LIMIT - span));
  const totalHeight = blocks.reduce((height, node) => height + node.height + GAP * 2, 0);
  let top = Math.max(-LIMIT, Math.min(...blocks.map(node => node.y), LIMIT - totalHeight));
  const positions = new Map(), obstacles = [...fixed].sort((a, b) => a.y - b.y);
  const place = (node, x, start) => {
    let y = start;
    for (const box of obstacles) if (x < box.x + box.width + GAP && x + node.width + GAP > box.x
      && y < box.y + box.height + GAP && y + node.height + GAP > box.y) y = box.y + box.height + GAP;
    if (y + node.height > LIMIT || x + node.width > LIMIT) throw new Error('排版超出画布坐标范围，请缩小分组跨度后重试。');
    positions.set(node.id, { x, y });
    return y + node.height + GAP;
  };
  for (const family of connected) {
    let x = left;
    for (const layer of family.layers) {
      const desired = node => {
        const parents = family.relations.filter(edge => edge.target === node.id).map(edge => edge.source);
        const placed = parents.map(id => {
          const parent = family.nodes.find(value => value.id === id), position = positions.get(id);
          return position && position.y + parent.height / 2;
        }).filter(value => value !== undefined);
        return placed.length ? placed.reduce((a, b) => a + b, 0) / placed.length : top + node.height / 2;
      };
      layer.sort((a, b) => desired(a) - desired(b) || readingOrder(a, b));
      let y = top;
      for (const node of layer) {
        y = Math.max(y, desired(node) - node.height / 2);
        y = place(node, x, y);
      }
      x += Math.max(...layer.map(node => node.width)) + 80;
    }
    // Pull upstream blocks toward their branch's center instead of leaving all parents at the top.
    const byId = new Map(family.nodes.map(node => [node.id, node]));
    const sourceEdges = family.relations.some(edge => edge.provenance) ? family.relations.filter(edge => edge.provenance) : family.relations;
    for (let level = family.layers.length - 2; level >= 0; level--) {
      let y = top;
      for (const node of family.layers[level]) {
        const children = sourceEdges.filter(edge => edge.source === node.id && family.ranks.get(edge.target) > family.ranks.get(node.id))
          .map(edge => ({ ...positions.get(edge.target), height: byId.get(edge.target).height }));
        const desired = children.length ? (Math.min(...children.map(child => child.y)) + Math.max(...children.map(child => child.y + child.height)) - node.height) / 2
          : positions.get(node.id).y;
        y = place(node, positions.get(node.id).x, Math.max(y, desired));
      }
    }
    let lift = Math.max(0, Math.min(...family.nodes.map(node => positions.get(node.id).y)) - top);
    for (const node of family.nodes) {
      const position = positions.get(node.id);
      for (const box of obstacles) if (position.x < box.x + box.width + GAP && position.x + node.width + GAP > box.x
        && box.y + box.height + GAP <= position.y) lift = Math.min(lift, position.y - box.y - box.height - GAP);
    }
    if (lift > 0) for (const node of family.nodes) positions.get(node.id).y -= lift;
    top = Math.max(...family.nodes.map(node => positions.get(node.id).y + node.height)) + GAP * 2;
  }
  if (isolated.length) {
    const occupied = [...fixed, ...blocks.filter(node => positions.has(node.id)).map(node => ({ ...node, ...positions.get(node.id) }))];
    for (const [id, position] of arrangeGrid(isolated.map((node, n) => ({ ...node, x: left, y: top + n })), occupied)) positions.set(id, position);
  }
  return positions;
}
