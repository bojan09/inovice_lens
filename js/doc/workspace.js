// workspace.js - one editable document per recognized file, kept for the whole browser session so
// edits survive navigating between Convert and the editor. Pure logic: the file store and the
// recognition session are injected, so it is unit-tested with fakes (no DOM).
//
// Lifecycle rules
//  * A document is created the first time a recognized file is opened. Its source result is frozen.
//  * If recognition is re-run (Rotate/Retry) and the document is UNEDITED, it is rebuilt silently.
//    If it has edits, the new result is held back as `pendingResult` and the editor asks the user:
//    use the new recognition (edits discarded) or keep the current one. Edits are never lost silently.
//  * Changing the document type (editor or Convert page) re-extracts the structured parts as an
//    undoable step; page text and page order are kept.

import { extractDocument } from './extract.js';
import { createDocument, retype, deepFreeze } from './model.js';
import { createHistory } from './history.js';
import { STATUS } from '../recognition/states.js';

const READY = new Set([STATUS.RECOGNIZED, STATUS.REVIEW]);

export function createWorkspace({ store, session, now } = {}) {
  const entries = new Map();
  const listeners = new Set();
  const emit = (id) => listeners.forEach((fn) => fn(id));

  function typeFor(rec) {
    return rec.override ?? rec.result.classification.suggested;
  }

  function build(item, rec) {
    const result = deepFreeze(rec.result);
    const docType = typeFor(rec);
    const extraction = extractDocument({ result, docType });
    const doc = createDocument({ fileId: item.id, name: item.name, result, docType, typeOrigin: rec.override ? 'user' : 'suggested', extraction });
    return { result, history: createHistory(doc, { now }), lastOverride: rec.override, rotation: rec.rotation };
  }

  function makeEntry(item, rec) {
    const e = { id: item.id, item, pendingResult: null, pageSource: null, ...build(item, rec) };
    let cached = { doc: null, mod: false };
    Object.defineProperties(e, {
      doc: { get: () => e.history.present },
      /** Differs from the freshly extracted document (typing a value back is still "unchanged"). */
      modified: {
        get() {
          const p = e.history.present;
          if (cached.doc !== p) cached = { doc: p, mod: p !== e.history.base && JSON.stringify(p) !== JSON.stringify(e.history.base) };
          return cached.mod;
        },
      },
    });
    e.commit = (fn, key) => { const ok = e.history.commit(fn, key); if (ok) emit(e.id); return ok; };
    e.undo = () => { const ok = e.history.undo(); if (ok) emit(e.id); return ok; };
    e.redo = () => { const ok = e.history.redo(); if (ok) emit(e.id); return ok; };
    e.seal = () => e.history.seal();
    /** Take the held-back recognition result and discard edits. */
    e.acceptPending = () => {
      const rec = session.get(e.id);
      if (!e.pendingResult || !rec?.result) return false;
      const next = build(e.item, rec);
      e.pageSource?.dispose();
      e.pageSource = null;
      Object.assign(e, next, { pendingResult: null });
      emit(e.id);
      return true;
    };
    e.keepCurrent = () => { e.pendingResult = null; emit(e.id); };
    return e;
  }

  /** The editor for `id`, or null while the file has no usable recognition result. */
  function ensure(id) {
    const item = store.getState().items.find((i) => i.id === id);
    const rec = session.get(id);
    if (!item || !rec || !rec.result || !READY.has(rec.status)) return entries.get(id) ?? null;
    let e = entries.get(id);
    if (!e) { e = makeEntry(item, rec); entries.set(id, e); }
    return e;
  }

  function drop(id) {
    const e = entries.get(id);
    if (!e) return;
    e.pageSource?.dispose();
    entries.delete(id);
    emit(id);
  }

  function sync(snapshot) {
    for (const e of [...entries.values()]) {
      const rec = snapshot.get(e.id);
      if (!rec) { drop(e.id); continue; }
      if (rec.result && rec.result !== e.result && rec.result !== e.pendingResult && READY.has(rec.status)) {
        if (!e.modified) {
          const next = build(e.item, rec);
          e.pageSource?.dispose();
          e.pageSource = null;
          Object.assign(e, next, { pendingResult: null });
          emit(e.id);
        } else {
          e.pendingResult = rec.result;
          emit(e.id);
        }
        continue;
      }
      if (rec.override !== e.lastOverride && rec.result === e.result) {
        e.lastOverride = rec.override;
        const type = typeFor({ ...rec, result: e.result });
        if (type !== e.doc.docType) {
          e.commit((d) => retype(d, type, extractDocument({ result: e.result, docType: type }), rec.override ? 'user' : 'suggested'));
        }
      }
    }
  }

  session.subscribe(sync);
  store.subscribe(({ items }) => {
    const ids = new Set(items.map((i) => i.id));
    for (const id of [...entries.keys()]) if (!ids.has(id)) drop(id);
  });

  return {
    ensure,
    get: (id) => entries.get(id) ?? null,
    has: (id) => entries.has(id),
    hasUnsavedEdits: () => [...entries.values()].some((e) => e.modified),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    dispose() { [...entries.keys()].forEach(drop); listeners.clear(); },
  };
}
