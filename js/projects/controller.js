// controller.js - application-level project actions. Owns the lazily opened database, the repo and the autosave, and
// turns every failure into a readable message (the UI never shows a raw exception, and never claims "saved" falsely).
import { openDb, deleteDb, StorageFullError, StorageUnavailableError } from './db.js';
import { createRepo } from './repo.js';
import { createAutosave } from './autosave.js';
import { capture, restore } from './snapshot.js';
import { packProject, unpackProject, portableName } from './portable.js';
import { checkSpace, requestPersistence } from './space.js';
import { makeThumb } from './thumbs.js';
import { fingerprint } from '../intake.js';
import { cleanProjectName, SchemaError } from './schema.js';
import { STATUS } from '../recognition/states.js';

export function createProjectsController({ store, session, workspace, engines, openDatabase = openDb, now = () => new Date(), debounceMs = 1500 }) {
  let repoP = null;
  let unavailable = null;
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn());

  function repo() {
    repoP ??= openDatabase().then((db) => createRepo(db), (e) => { unavailable = e instanceof StorageUnavailableError ? e.message : `Saved projects are unavailable: ${e.message}`; repoP = null; emit(); throw e; });
    return repoP;
  }

  const thumbOf = (item) => makeThumb(item, engines);
  let autosave = null;
  async function auto() {
    if (autosave) return autosave;
    const r = await repo();
    autosave = createAutosave({ repo: r, store, session, workspace, makeThumb: thumbOf, now, debounceMs });
    autosave.subscribe(emit);
    return autosave;
  }

  const hasFiles = () => store.getState().items.length > 0;
  const readyFiles = () => store.getState().items.filter((i) => [STATUS.RECOGNIZED, STATUS.REVIEW, STATUS.FAILED, STATUS.CANCELLED].includes(session.get(i.id)?.status));

  return {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get unavailable() { return unavailable; },
    get status() { return autosave?.status ?? { project: null, state: 'off', at: null, error: null }; },
    hasFiles,

    /** Probe storage once so the Projects page can say "not available" up front (private mode, blocked storage). */
    async probe() { try { await repo(); return true; } catch { return false; } },

    async list() { return (await repo()).listProjects(); },
    async usage() { return (await repo()).usage(); },
    space: (needed) => checkSpace(needed),
    workspaceBytes: () => store.getState().items.reduce((s, i) => s + i.size, 0),

    /** Create a project from the current workspace and start autosaving into it. Requires the user's explicit consent in the UI. */
    async saveWorkspace(name) {
      const r = await repo();
      const a = await auto();
      const space = await checkSpace(this.workspaceBytes());
      if (space.level === 'block') throw new StorageFullError(space.message);
      const id = (await import('./repo.js')).newId();
      a.attach({ id, name: cleanProjectName(name) });
      const ok = await a.saveNow();
      if (!ok) { const err = a.status.error; a.detach(); try { await r.deleteProject(id); } catch { /* nothing was written */ } throw new Error(err || 'Saving failed'); }
      const persistent = await requestPersistence();
      emit();
      return { id, persistent, space };
    },

    /** Replace the workspace with a saved project and continue autosaving into it. */
    async open(id) {
      const r = await repo();
      const loaded = await r.loadProject(id); // throws SchemaError with a readable message if damaged/newer
      const a = await auto();
      a.detach();
      store.clear();
      const out = await restore(loaded, { store, session, workspace });
      a.attach({ id: loaded.project.id, name: loaded.project.name }, loaded.files.map((f) => f.fingerprint ?? f.id));
      emit();
      return { name: loaded.project.name, ...out };
    },

    async rename(id, name) {
      const r = await repo();
      await r.rename(id, name);
      if (autosave?.project?.id === id) autosave.rename(cleanProjectName(name));
      emit();
    },

    async remove(id) {
      const r = await repo();
      if (autosave?.project?.id === id) autosave.detach();
      await r.deleteProject(id);
      emit();
    },

    async removeAll() {
      const r = await repo();
      autosave?.detach();
      await r.deleteAll();
      emit();
    },

    stopAutosave() { autosave?.detach(); emit(); },
    saveNow: async () => (await auto()).saveNow(),

    /** A portable ZIP of a SAVED project. */
    async exportSaved(id) {
      const r = await repo();
      const loaded = await r.loadProject(id);
      const { blob } = await packProject({ project: loaded.project, files: loaded.files.map((f) => ({ ...f, id: f.id })) }, { now: now() });
      return { blob, filename: portableName(loaded.project.name, now()) };
    },

    /** A portable ZIP of the CURRENT workspace (no browser storage involved). */
    async exportWorkspace(name) {
      const snap = capture({ store, session, workspace });
      const { blob } = await packProject({ project: { name }, files: snap.map((f) => ({ ...f.meta, id: f.id, blob: f.file })) }, { now: now() });
      return { blob, filename: portableName(name, now()) };
    },

    /** Validate and store a project file in this browser (does not open it). */
    async importFile(file) {
      const u = await unpackProject(file);
      const need = u.files.reduce((s, f) => s + f.blob.size, 0);
      const space = await checkSpace(need);
      if (space.level === 'block') throw new StorageFullError(space.message);
      const r = await repo();
      const files = [];
      for (const f of u.files) {
        let thumb = null;
        if (/^image\//.test(f.mime || '') || ['png', 'jpeg', 'webp'].includes(f.kind)) { try { thumb = await makeThumb({ file: new File([f.blob], f.name, { type: f.mime }), isImage: true }, engines); } catch { thumb = null; } }
        const { blob, path: _p, ...meta } = f;
        const fp = await fingerprint(new Uint8Array(await blob.arrayBuffer()), new File([blob], f.name)); // same hash the workspace uses, so opening later does not rewrite originals
        files.push({ id: fp, meta: { ...meta, fingerprint: fp }, blob, thumb });
      }
      const id = await r.saveProject({ name: u.project.name, autosave: false }, files);
      emit();
      return { id, name: u.project.name, files: files.length, space };
    },

    async deleteEverything() {
      autosave?.detach();
      try { (await repo()).deleteAll(); } catch { /* nothing opened */ }
      await deleteDb();
      repoP = null;
      emit();
    },

    dispose() { autosave?.dispose(); listeners.clear(); },
    SchemaError,
    readyFiles,
  };
}
