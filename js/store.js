// store.js - in-memory session state for selected files. Nothing is persisted or transmitted.
// Owns the object-URL lifecycle: every URL created for a preview is revoked on remove / clear /
// destroy, so previews never leak memory.

import { DEFAULT_POLICY, KINDS, processFiles, isRetryable } from './intake.js';

let nextId = 1;

export function createStore({
  policy = DEFAULT_POLICY,
  createObjectURL = (b) => URL.createObjectURL(b),
  revokeObjectURL = (u) => URL.revokeObjectURL(u),
  readBytes,
} = {}) {
  let items = []; // accepted
  let rejected = [];
  let busy = false;
  let queue = Promise.resolve();
  const listeners = new Set();

  const emit = () => listeners.forEach((fn) => fn(getState()));
  const getState = () => ({ items, rejected, busy });
  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  function existingState() {
    return {
      count: items.length,
      totalBytes: items.reduce((s, i) => s + i.size, 0),
      fingerprints: new Map(items.map((i) => [i.fingerprint, i.name])),
    };
  }

  function revoke(item) {
    if (item.url) {
      revokeObjectURL(item.url);
      item.url = null;
    }
  }

  /** Serialised so concurrent drops cannot race the limit/duplicate checks. */
  function add(fileList, { restoring = false } = {}) {
    const files = Array.from(fileList ?? []);
    const run = async () => {
      if (!files.length) return { added: 0, rejected: 0 };
      busy = true;
      emit();
      try {
        const res = await processFiles(files, existingState(), policy, readBytes);
        const created = res.accepted.map((a) => ({
          id: `f${nextId++}`,
          ...a,
          label: KINDS[a.kind].label,
          isImage: KINDS[a.kind].image,
          url: KINDS[a.kind].image ? createObjectURL(a.file) : null,
          previewFailed: false,
          restoring, // true while a saved project is being re-opened: the caller restores the result instead of re-running OCR
        }));
        const rej = res.rejected.map((r) => ({ id: `r${nextId++}`, ...r, retryable: isRetryable(r.code) }));
        items = [...items, ...created];
        rejected = [...rejected, ...rej];
        return { added: created.length, rejected: rej.length, rejectedItems: rej };
      } finally {
        busy = false;
        emit();
      }
    };
    queue = queue.then(run, run);
    return queue;
  }

  function remove(id) {
    const item = items.find((i) => i.id === id);
    if (!item) return false;
    revoke(item);
    items = items.filter((i) => i.id !== id);
    emit();
    return true;
  }

  function markPreviewFailed(id) {
    const item = items.find((i) => i.id === id);
    if (!item || item.previewFailed) return;
    revoke(item);
    item.previewFailed = true;
    emit();
  }

  function dismissRejected(id) {
    rejected = rejected.filter((r) => r.id !== id);
    emit();
  }

  async function retry(id) {
    const r = rejected.find((x) => x.id === id);
    if (!r || !r.retryable) return null;
    rejected = rejected.filter((x) => x.id !== id);
    emit();
    return add([r.file]);
  }

  function clear() {
    items.forEach(revoke);
    items = [];
    rejected = [];
    emit();
  }

  function destroy() {
    items.forEach(revoke);
    items = [];
    rejected = [];
    listeners.clear();
  }

  return { getState, subscribe, add, remove, markPreviewFailed, dismissRejected, retry, clear, destroy, policy };
}
