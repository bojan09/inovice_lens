// session.js - recognition queue with bounded concurrency, real cancellation, retry and rotate.
// One entry per selected file (keyed by the file-store item id). The runner is injected.

import { STATUS, assertTransition, isActive, isTerminal } from './states.js';

export function createRecognitionSession({ runner, concurrency = 1 } = {}) {
  const entries = new Map(); // id -> entry
  const queue = [];
  const listeners = new Set();
  let running = 0;
  let paused = false;

  const view = (e) => ({
    id: e.id, status: e.status, progress: e.progress, result: e.result, error: e.error,
    rotation: e.rotation, override: e.override, version: e.version,
  });
  const snapshot = () => new Map([...entries].map(([id, e]) => [id, view(e)]));
  const emit = () => { const s = snapshot(); listeners.forEach((fn) => fn(s)); };
  const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

  function setStatus(e, to) {
    assertTransition(e.status, to);
    e.status = to;
    e.version += 1;
  }

  function enqueue(item) {
    if (entries.has(item.id)) return;
    const e = { id: item.id, item, status: STATUS.QUEUED, progress: { done: 0, total: 0, fraction: 0, note: '' }, result: null, error: null, rotation: 0, override: null, version: 0, controller: null };
    entries.set(item.id, e);
    queue.push(e);
    emit();
    pump();
  }

  function pump() {
    while (!paused && running < concurrency && queue.length) {
      const e = queue.shift();
      if (e.status !== STATUS.QUEUED) continue; // cancelled while waiting
      running += 1;
      start(e).finally(() => { running -= 1; pump(); });
    }
  }

  async function start(e) {
    const controller = new AbortController();
    e.controller = controller;
    const { signal } = controller;
    setStatus(e, STATUS.PREPARING);
    e.error = null;
    e.result = null;
    emit();
    try {
      const result = await runner(e.item, {
        rotation: e.rotation,
        signal,
        onProgress: (p) => {
          if (signal.aborted || e.status === STATUS.CANCELLED) return;
          if (e.status === STATUS.PREPARING && p.phase === 'extracting') setStatus(e, STATUS.EXTRACTING);
          e.progress = { done: p.done, total: p.total, fraction: p.fraction, note: p.note ?? '' };
          emit();
        },
      });
      if (e.controller !== controller) return; // superseded by a re-run: its outcome is stale, drop it
      if (signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
      if (e.status === STATUS.PREPARING) setStatus(e, STATUS.EXTRACTING);
      e.result = result;
      e.progress = { ...e.progress, fraction: 1 };
      setStatus(e, result.review.length ? STATUS.REVIEW : STATUS.RECOGNIZED);
    } catch (err) {
      if (e.controller !== controller) return; // superseded by a re-run: ignore the stale failure/abort
      if (err?.name === 'AbortError' || signal.aborted) {
        if (e.status !== STATUS.CANCELLED) setStatus(e, STATUS.CANCELLED);
      } else {
        e.error = { code: err?.code ?? 'error', message: friendly(err) };
        setStatus(e, STATUS.FAILED);
      }
    } finally {
      if (e.controller === controller) e.controller = null; // a re-run may already own e.controller (concurrency > 1)
      emit();
    }
  }

  const OFFLINE = 'You are offline and the text-recognition files are not stored on this device yet. Connect once and use Settings > Storage & offline > "Download for offline use", then retry.';
  const friendly = (err) => {
    if (err?.message && err.name === 'RecognitionError') return err.message;
    const loadFailure = err?.code === 'ocr-error' || /dynamically imported module|Failed to fetch|NetworkError|Load failed/i.test(err?.message ?? '');
    if (globalThis.navigator?.onLine === false && loadFailure) return OFFLINE; // a failed program-file fetch while offline
    return err?.userMessage ?? err?.message ?? 'Recognition failed.';
  };

  function cancel(id) {
    const e = entries.get(id);
    if (!e || isTerminal(e.status)) return false;
    if (e.status === STATUS.QUEUED) { setStatus(e, STATUS.CANCELLED); emit(); return true; }
    e.controller?.abort(); // active: runner rejects with AbortError; engines terminate real work
    setStatus(e, STATUS.CANCELLED);
    emit();
    return true;
  }

  function requeue(e) {
    setStatus(e, STATUS.QUEUED);
    e.error = null;
    e.progress = { done: 0, total: 0, fraction: 0, note: '' };
    queue.push(e);
    emit();
    pump();
  }

  function retry(id) {
    const e = entries.get(id);
    if (!e || !isTerminal(e.status)) return false;
    requeue(e);
    return true;
  }

  /** Rotate by 90 degrees clockwise and re-run. Only valid when not running. */
  function rotate(id) {
    const e = entries.get(id);
    if (!e || isActive(e.status)) return false;
    e.rotation = (e.rotation + 90) % 360;
    if (e.status === STATUS.QUEUED) { e.version += 1; emit(); return true; }
    requeue(e);
    return true;
  }

  function setOverride(id, category) {
    const e = entries.get(id);
    if (!e) return false;
    e.override = category;
    e.version += 1;
    emit();
    return true;
  }

  function remove(id) {
    const e = entries.get(id);
    if (!e) return;
    if (!isTerminal(e.status)) e.controller?.abort();
    const i = queue.indexOf(e);
    if (i >= 0) queue.splice(i, 1);
    entries.delete(id);
    emit();
  }

  /** Stop STARTING new files. The file already being recognized finishes (a running OCR job cannot be suspended; Cancel stops it). */
  function pause() { if (paused) return; paused = true; emit(); }
  function resume() { if (!paused) return; paused = false; emit(); pump(); }

  /** Re-queue every failed or cancelled file (error isolation: one bad file never blocks the others). */
  function retryFailed() {
    let n = 0;
    for (const e of entries.values()) if (e.status === STATUS.FAILED || e.status === STATUS.CANCELLED) { requeue(e); n += 1; }
    return n;
  }

  /** Put a file straight into a finished state (restoring a saved project) without running anything. */
  function restore(item, { status = STATUS.RECOGNIZED, result = null, rotation = 0, override = null } = {}) {
    if (entries.has(item.id)) return false;
    if (![STATUS.RECOGNIZED, STATUS.REVIEW, STATUS.FAILED, STATUS.CANCELLED].includes(status)) throw new Error(`Cannot restore into ${status}`);
    entries.set(item.id, { id: item.id, item, status, progress: { done: 0, total: 0, fraction: status === STATUS.RECOGNIZED || status === STATUS.REVIEW ? 1 : 0, note: '' }, result, error: status === STATUS.FAILED ? { code: 'restored', message: 'Recognition failed before this project was saved.' } : null, rotation, override, version: 0, controller: null });
    emit();
    return true;
  }

  const counts = () => {
    const c = { total: 0, queued: 0, active: 0, recognized: 0, review: 0, failed: 0, cancelled: 0 };
    for (const e of entries.values()) {
      c.total += 1;
      if (e.status === STATUS.QUEUED) c.queued += 1;
      else if (isActive(e.status)) c.active += 1;
      else c[e.status] += 1;
    }
    return c;
  };

  function cancelAll() { [...entries.keys()].forEach(cancel); }
  function clear() { [...entries.keys()].forEach(remove); }
  const get = (id) => (entries.has(id) ? view(entries.get(id)) : null);

  return { enqueue, cancel, cancelAll, retry, retryFailed, rotate, setOverride, remove, clear, get, snapshot, subscribe, pause, resume, restore, counts, get paused() { return paused; } };
}
