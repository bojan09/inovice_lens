// autosave.js - saves the workspace to ONE project, only after the user created/opened that project (consent). Writes are
// debounced, serialised and atomic (repo.saveProject); originals already stored are not rewritten. The status is honest:
// "saved" is only reported after the write committed, a failure is reported with its cause and nothing is claimed.
import { capture } from './snapshot.js';
import { StorageFullError } from './db.js';

export function createAutosave({ repo, store, session, workspace, makeThumb, debounceMs = 1500, now = () => new Date() }) {
  let project = null; // {id, name}
  let timer = null;
  let running = Promise.resolve();
  let dirty = false;
  let status = { state: 'off', at: null, error: null }; // off | idle | saving | saved | error
  const listeners = new Set();
  const stored = new Set(); // file ids whose original/thumb are already in the DB for this project
  const emit = () => listeners.forEach((fn) => fn({ project, ...status }));
  const set = (s) => { status = { ...status, ...s }; emit(); };

  async function saveNow() {
    if (!project) return false;
    clearTimeout(timer);
    dirty = false;
    set({ state: 'saving', error: null });
    const job = running.then(async () => {
      const items = capture({ store, session, workspace });
      const files = [];
      for (const f of items) {
        const have = stored.has(f.id);
        let thumb = null;
        if (!have && makeThumb) { try { thumb = await makeThumb(store.getState().items.find((i) => i.id === f.itemId)); } catch { thumb = null; } }
        files.push({ id: f.id, meta: f.meta, blob: have ? null : f.file, thumb });
      }
      await repo.saveProject({ id: project.id, name: project.name, autosave: true }, files);
      files.forEach((f) => stored.add(f.id));
      for (const id of [...stored]) if (!items.some((i) => i.id === id)) stored.delete(id);
      set({ state: dirty ? 'idle' : 'saved', at: now(), error: null });
      return true;
    });
    running = job.catch(() => {});
    try { return await job; } catch (e) {
      set({ state: 'error', error: e instanceof StorageFullError ? 'The browser has no space left. Free space or delete a project; nothing new was saved.' : `Could not save: ${e.message}` });
      return false;
    }
  }

  const schedule = () => {
    if (!project) return;
    dirty = true;
    clearTimeout(timer);
    if (status.state !== 'saving') set({ state: 'idle' });
    timer = setTimeout(saveNow, debounceMs);
  };

  const unsubs = [store.subscribe(schedule), session.subscribe(schedule), workspace.subscribe(schedule)];

  return {
    /** Start autosaving into `p` ({id, name}); `already` = file ids whose originals are already stored for it. */
    attach(p, already = []) { project = p; stored.clear(); already.forEach((i) => stored.add(i)); set({ state: 'idle', error: null }); },
    detach() { clearTimeout(timer); project = null; stored.clear(); set({ state: 'off', at: null, error: null }); },
    saveNow,
    rename(name) { if (project) { project = { ...project, name }; emit(); } },
    get project() { return project; },
    get status() { return { project, ...status }; },
    subscribe(fn) { listeners.add(fn); fn({ project, ...status }); return () => listeners.delete(fn); },
    dispose() { clearTimeout(timer); unsubs.forEach((u) => u()); listeners.clear(); },
  };
}
