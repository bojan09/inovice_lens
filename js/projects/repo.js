// repo.js - project persistence on top of a db adapter (IndexedDB in the app, an in-memory fake in unit tests).
// Layout: projects (metadata) / files (metadata + recognition result + corrected document) / blobs (original bytes) /
// thumbs (small previews). Metadata is kept apart from blobs so listing projects never loads the originals.
import { STORES, SCHEMA_VERSION, migrateProject, migrateFile, cleanProjectName, SchemaError } from './schema.js';

const fileKey = (projectId, fileId) => `${projectId}:${fileId}`;
export const newId = () => (globalThis.crypto?.randomUUID?.() ?? `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

export function createRepo(db, { now = () => Date.now() } = {}) {
  const S = STORES;

  return {
    /**
     * Atomically write a project and ALL its files. Files no longer present are removed. Blobs are written only when
     * `blob` is provided (autosave passes null for unchanged originals so large files are not rewritten each time).
     * @param {{id?:string,name:string,autosave?:boolean,createdAt?:number}} project
     * @param {{id:string, meta:object, blob?:Blob|null, thumb?:Blob|null}[]} files
     */
    async saveProject(project, files) {
      const id = project.id ?? newId();
      const t = now();
      const keep = new Set(files.map((f) => fileKey(id, f.id)));
      await db.run([S.projects, S.files, S.blobs, S.thumbs], 'readwrite', async (tx) => {
        const old = await tx.getAllByIndex(S.files, 'projectId', id);
        for (const f of old) {
          if (!keep.has(f.key)) { await tx.delete(S.files, f.key); await tx.delete(S.blobs, f.key); await tx.delete(S.thumbs, f.key); }
        }
        for (const f of files) {
          const key = fileKey(id, f.id);
          await tx.put(S.files, { ...f.meta, key, projectId: id, id: f.id, schemaVersion: SCHEMA_VERSION, updatedAt: t });
          if (f.blob) await tx.put(S.blobs, { key, blob: f.blob });
          if (f.thumb) await tx.put(S.thumbs, { key, blob: f.thumb });
        }
        const prev = await tx.get(S.projects, id);
        await tx.put(S.projects, { ...(prev ?? {}), id, name: cleanProjectName(project.name), createdAt: prev?.createdAt ?? project.createdAt ?? t, updatedAt: t, schemaVersion: SCHEMA_VERSION, autosave: project.autosave ?? prev?.autosave ?? false, order: files.map((f) => f.id) });
      });
      return id;
    },

    /** Is the original already stored for this file? (lets autosave skip rewriting big blobs) */
    async hasBlob(projectId, fileId) {
      return db.run([S.blobs], 'readonly', async (tx) => !!(await tx.get(S.blobs, fileKey(projectId, fileId))));
    },

    async listProjects() {
      return db.run([S.projects, S.files, S.blobs, S.thumbs], 'readonly', async (tx) => {
        const projects = await tx.getAll(S.projects);
        const files = await tx.getAll(S.files);
        const out = [];
        for (const raw of projects) {
          let p;
          try { p = migrateProject(raw); } catch (e) { out.push({ id: raw?.id ?? '?', name: raw?.name ?? 'Unreadable project', unreadable: e.message, fileCount: 0, bytes: 0, thumbs: [], updatedAt: raw?.updatedAt ?? 0 }); continue; }
          const mine = files.filter((f) => f.projectId === p.id);
          const thumbs = [];
          let bytes = 0;
          for (const f of mine) {
            bytes += f.size ?? 0;
            if (thumbs.length < 5) { const th = await tx.get(S.thumbs, f.key); if (th?.blob) thumbs.push(th.blob); }
          }
          out.push({ ...p, fileCount: mine.length, bytes, thumbs });
        }
        return out.sort((a, b) => b.updatedAt - a.updatedAt);
      });
    },

    /** Everything needed to resume: project, files in saved order, each with its original blob. Throws SchemaError on unreadable data. */
    async loadProject(id) {
      return db.run([S.projects, S.files, S.blobs], 'readonly', async (tx) => {
        const raw = await tx.get(S.projects, id);
        if (!raw) throw new SchemaError('missing', 'This project no longer exists.');
        const project = migrateProject(raw);
        const rows = (await tx.getAllByIndex(S.files, 'projectId', id)).map(migrateFile);
        const byId = new Map(rows.map((r) => [r.id, r]));
        const ordered = [...project.order.map((i) => byId.get(i)).filter(Boolean), ...rows.filter((r) => !project.order.includes(r.id))];
        const files = [];
        for (const f of ordered) {
          const b = await tx.get(S.blobs, f.key);
          if (!b?.blob) throw new SchemaError('missing-blob', `The saved original of "${f.name}" is missing.`);
          files.push({ ...f, blob: b.blob });
        }
        return { project, files };
      });
    },

    async rename(id, name) {
      return db.run([S.projects], 'readwrite', async (tx) => {
        const p = await tx.get(S.projects, id);
        if (!p) throw new SchemaError('missing', 'This project no longer exists.');
        await tx.put(S.projects, { ...p, name: cleanProjectName(name), updatedAt: now() });
      });
    },

    async deleteProject(id) {
      return db.run([S.projects, S.files, S.blobs, S.thumbs], 'readwrite', async (tx) => {
        for (const f of await tx.getAllByIndex(S.files, 'projectId', id)) { await tx.delete(S.files, f.key); await tx.delete(S.blobs, f.key); await tx.delete(S.thumbs, f.key); }
        await tx.delete(S.projects, id);
      });
    },

    async deleteAll() {
      return db.run(Object.values(S), 'readwrite', async (tx) => { for (const s of Object.values(S)) await tx.clear(s); });
    },

    /** Bytes of originals + counts, for "storage used by projects". */
    async usage() {
      return db.run([S.projects, S.files], 'readonly', async (tx) => {
        const files = await tx.getAll(S.files);
        return { projects: (await tx.getAll(S.projects)).length, files: files.length, bytes: files.reduce((s, f) => s + (f.size ?? 0), 0) };
      });
    },
  };
}
