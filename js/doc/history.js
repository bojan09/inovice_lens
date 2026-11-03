// history.js - undo/redo over immutable document snapshots. Because every model updater is pure,
// a snapshot is just a reference, so this is cheap and cannot desynchronize from the document.
// Consecutive edits with the same `key` inside `coalesceMs` (typing in one field) become ONE step.

export function createHistory(initial, { limit = 200, coalesceMs = 1000, now = () => Date.now(), start = initial } = {}) {
  let past = []; // earlier snapshots, oldest first
  let present = start; // != initial only when a saved document is restored (its edits are not an undo step)
  let future = [];
  let lastKey = null;
  let lastAt = 0;
  const base = initial; // the untouched, freshly extracted document

  const api = {
    get present() { return present; },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    /** True when the document differs from the freshly extracted one. */
    get modified() { return present !== base; },
    get base() { return base; },
    /** Apply an edit. `fn(doc) -> doc`; no-ops (same reference) are ignored. */
    commit(fn, key = null) {
      const next = fn(present);
      if (next === present) return false;
      const t = now();
      const merge = key !== null && key === lastKey && t - lastAt < coalesceMs && past.length > 0 && future.length === 0;
      if (!merge) {
        past.push(present);
        if (past.length > limit) past.shift();
      }
      present = next;
      future = [];
      lastKey = key;
      lastAt = t;
      return true;
    },
    undo() {
      if (!past.length) return false;
      future.push(present);
      present = past.pop();
      lastKey = null;
      return true;
    },
    redo() {
      if (!future.length) return false;
      past.push(present);
      present = future.pop();
      lastKey = null;
      return true;
    },
    /** Stop coalescing (e.g. on blur) so the next edit starts a new step. */
    seal() { lastKey = null; },
  };
  return api;
}
