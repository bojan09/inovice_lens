// snapshot.js - move a workspace to/from storage records. capture() is synchronous and cheap (no blobs are read);
// restore() re-opens originals through the NORMAL file store (so intake validation runs again) and injects saved
// recognition results/documents instead of re-running OCR. Files that were still queued or running when saved are
// queued again (recovery after an interrupted session).
import { STATUS, isActive } from '../recognition/states.js';
import { toPlain } from '../doc/model.js';

/** What to persist for every file currently in the workspace. */
export function capture({ store, session, workspace }) {
  return store.getState().items.map((it) => {
    const rec = session.get(it.id);
    const done = rec && (rec.status === STATUS.RECOGNIZED || rec.status === STATUS.REVIEW);
    const status = !rec ? 'queued' : isActive(rec.status) ? 'queued' : rec.status;
    const entry = workspace.get(it.id);
    return {
      id: it.fingerprint ?? it.id, // storage id = content hash: stable across reloads, so reopening a project does not rewrite its originals
      itemId: it.id,
      file: it.file,
      meta: {
        name: it.name, kind: it.kind, mime: it.file.type || '', size: it.size, width: it.width ?? null, height: it.height ?? null, fingerprint: it.fingerprint ?? null,
        status, rotation: rec?.rotation ?? 0, override: rec?.override ?? null,
        result: done ? rec.result : null,
        doc: done && entry ? toPlain(entry.doc) : null,
        error: rec?.status === STATUS.FAILED ? rec.error?.message ?? 'Recognition failed' : null,
      },
    };
  });
}

/**
 * @param {{project:object, files:object[]}} loaded  from repo.loadProject / unpackProject (files carry blob)
 * @returns {Promise<{opened:number, skipped:{name:string, reason:string}[], requeued:number, docsRestored:number, docsDropped:number}>}
 */
export async function restore(loaded, { store, session, workspace }) {
  const before = new Set(store.getState().items.map((i) => i.id));
  const inputs = loaded.files.map((f) => new File([f.blob], f.name, { type: f.mime || f.blob.type || '' }));
  const res = await store.add(inputs, { restoring: true });
  const created = store.getState().items.filter((i) => !before.has(i.id));
  const rejectedNames = (res.rejectedItems ?? []).map((r) => r.name);
  const out = { opened: 0, skipped: [], requeued: 0, docsRestored: 0, docsDropped: 0 };
  let next = 0;
  for (const f of loaded.files) {
    const ri = rejectedNames.indexOf(f.name);
    if (ri >= 0) {
      rejectedNames.splice(ri, 1);
      out.skipped.push({ name: f.name, reason: (res.rejectedItems.find((r) => r.name === f.name)?.message) ?? 'not accepted' });
      continue;
    }
    const item = created[next++];
    if (!item) { out.skipped.push({ name: f.name, reason: 'not accepted' }); continue; }
    out.opened += 1;
    if ((f.status === 'recognized' || f.status === 'review') && f.result) {
      session.restore(item, { status: f.status, result: f.result, rotation: f.rotation ?? 0, override: f.override ?? null });
      if (f.doc) { if (workspace.restoreDoc(item.id, f.doc)) out.docsRestored += 1; else out.docsDropped += 1; }
    } else if (f.status === 'failed' || f.status === 'cancelled') {
      session.restore(item, { status: f.status, rotation: f.rotation ?? 0, override: f.override ?? null });
    } else {
      session.enqueue(item); // was queued/running when saved (or has no usable result): process it again
      out.requeued += 1;
    }
  }
  return out;
}
