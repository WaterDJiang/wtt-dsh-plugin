const clone = value => JSON.parse(JSON.stringify(value));

// View navigation and immutable business artifacts never belong to layout undo.
export function editableLayout(layout) {
  return clone({ positions: layout.positions, sizes: layout.sizes || {}, edges: layout.edges, groups: layout.groups, elements: layout.elements || [] });
}

export function createLayoutHistory(limit = 50) {
  const past = [], future = [];
  return {
    record(before, after) {
      before = editableLayout(before); after = editableLayout(after);
      if (JSON.stringify(before) === JSON.stringify(after)) return false;
      past.push(before);
      if (past.length > limit) past.shift();
      future.length = 0;
      return true;
    },
    undo(current) {
      if (!past.length) return null;
      future.push(editableLayout(current));
      return clone(past.pop());
    },
    redo(current) {
      if (!future.length) return null;
      past.push(editableLayout(current));
      return clone(future.pop());
    },
    reset() { past.length = 0; future.length = 0; },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
  };
}
