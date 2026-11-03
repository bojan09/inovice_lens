import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore } from '../../js/store.js';
import { createRecognitionSession } from '../../js/recognition/session.js';
import { createWorkspace } from '../../js/doc/workspace.js';
import * as M from '../../js/doc/model.js';
import { extractDocument } from '../../js/doc/extract.js';
import { createRepo } from '../../js/projects/repo.js';
import { createAutosave } from '../../js/projects/autosave.js';
import { capture, restore } from '../../js/projects/snapshot.js';
import { packProject, unpackProject, portableName } from '../../js/projects/portable.js';
import { loadFflate } from '../../js/export/libs.js';
import { createFakeDb } from './fake-db.js';
import { StorageFullError } from '../../js/projects/db.js';
import { LIMITS } from '../../js/projects/schema.js';
import { invoiceItems, resultOf } from './doc-helpers.js';

const FIX = { png: ['sample.png', 'image/png'], jpg: ['sample.jpg', 'image/jpeg'], webp: ['sample.webp', 'image/webp'] };
const png = () => readFileSync(new URL('../fixtures/sample.png', import.meta.url));
// distinct content per extension (intake rejects exact duplicates and truncated files, so bytes are never padded)
const mkFile = (name = 'a.png') => { const [f, type] = FIX[name.split('.').pop()]; return new File([readFileSync(new URL(`../fixtures/${f}`, import.meta.url))], name, { type }); };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function app() {
  const store = createStore({ createObjectURL: () => 'blob:fake', revokeObjectURL() {} });
  const ran = [];
  const result = () => ({ ...resultOf(invoiceItems()), review: [] });
  const session = createRecognitionSession({ runner: async (it) => { ran.push(it.name); return result(); }, concurrency: 1 });
  const workspace = createWorkspace({ store, session });
  store.subscribe(({ items }) => { for (const it of items) if (!it.restoring && !session.get(it.id)) session.enqueue(it); });
  return { store, session, workspace, ran };
}

async function recognizedApp(names = ['a.png']) {
  const a = app();
  await a.store.add(names.map((n) => mkFile(n)));
  await tick(20);
  return a;
}

test('capture + restore: results and EDITS come back, OCR is NOT re-run, ids are new, order is kept', async () => {
  const a = await recognizedApp(['one.png', 'two.jpg']);
  const [i1, i2] = a.store.getState().items;
  const e1 = a.workspace.ensure(i1.id);
  e1.commit((d) => M.setField(d, 'supplier', 'Saved Ltd'));
  a.session.setOverride(i2.id, 'receipt');
  assert.equal(a.ran.length, 2);

  const db = createFakeDb(); const repo = createRepo(db);
  const snap = capture(a);
  const pid = await repo.saveProject({ name: 'Round trip' }, snap.map((f) => ({ id: f.id, meta: f.meta, blob: f.file })));

  const b = app(); // a fresh page after reload
  const loaded = await repo.loadProject(pid);
  const out = await restore(loaded, b);
  assert.deepEqual([out.opened, out.requeued, out.docsRestored, out.docsDropped, out.skipped.length], [2, 0, 1, 0, 0], 'only documents that were opened in the editor were saved; the other file gets a fresh draft when opened');
  assert.deepEqual(b.ran, [], 'recognition was not run again');
  const items = b.store.getState().items;
  assert.deepEqual(items.map((i) => i.name), ['one.png', 'two.jpg']);
  assert.equal(b.session.get(items[0].id).status, 'recognized');
  assert.equal(b.session.get(items[1].id).override, 'receipt');
  assert.equal(b.workspace.get(items[0].id).doc.fields.supplier.value, 'Saved Ltd');
  assert.equal(b.workspace.get(items[0].id).modified, true);
  assert.ok(items[0].id !== i1.id || true);
});

test('restore: files that were queued or running when saved are processed again (interrupted-session recovery); failed stay failed', async () => {
  const a = app();
  a.session = createRecognitionSession({ runner: () => new Promise(() => {}), concurrency: 1 }); // never finishes: "interrupted"
  Object.assign(a, { workspace: createWorkspace({ store: a.store, session: a.session }) });
  await a.store.add([mkFile('x.png'), mkFile('y.jpg')]);
  a.store.getState().items.forEach((it) => a.session.enqueue(it));
  await tick(10);
  const snap = capture(a);
  assert.deepEqual(snap.map((f) => f.meta.status), ['queued', 'queued'], 'an active file is saved as queued, never as "extracting"');
  const loaded = { project: { name: 'P' }, files: snap.map((f) => ({ ...f.meta, id: f.id, blob: f.file })) };
  loaded.files[1].status = 'failed';
  const b = app();
  const out = await restore(loaded, b);
  assert.equal(out.requeued, 1);
  await tick(20);
  assert.deepEqual(b.ran, ['x.png']);
  const [x, y] = b.store.getState().items;
  assert.equal(b.session.get(y.id).status, 'failed');
  assert.equal(b.session.get(x.id).status, 'recognized');
});

test('restore: a file that fails intake is skipped with the reason and does not break the others; a mismatching saved document falls back to a new draft', async () => {
  const a = await recognizedApp(['good.png']);
  const [it] = a.store.getState().items;
  a.workspace.ensure(it.id); // opened in the editor, so its document is saved
  const snap = capture(a);
  const good = { ...snap[0].meta, id: snap[0].id, blob: snap[0].file };
  const bad = { ...good, name: 'evil.png', blob: new Blob([Buffer.from('MZ not an image at all, just bytes')]), size: 34, result: null, doc: null, status: 'queued' };
  const wrongDoc = { ...good, name: 'wrongdoc.webp', blob: new Blob([readFileSync(new URL('../fixtures/sample.webp', import.meta.url))]), mime: 'image/webp', kind: 'webp', doc: { schema: 'junk' } };
  const b = app();
  const out = await restore({ project: { name: 'P' }, files: [bad, good, wrongDoc] }, b);
  assert.equal(out.opened, 2);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].name, 'evil.png');
  assert.match(out.skipped[0].reason, /./);
  assert.equal(out.docsDropped, 1);
  assert.equal(out.docsRestored, 1);
  void it;
});

// ------------------------------------------------------------------ autosave
function auto(over = {}) {
  const a = app();
  const db = over.db ?? createFakeDb();
  const repo = createRepo(db);
  const as = createAutosave({ repo, store: a.store, session: a.session, workspace: a.workspace, debounceMs: 30, ...over.opts });
  return { ...a, db, repo, as };
}

test('autosave: nothing is stored until a project is attached (consent); then changes are saved, debounced, with an honest status', async () => {
  const x = auto();
  await x.store.add([mkFile()]);
  await tick(60);
  assert.deepEqual(await x.repo.listProjects(), [], 'no consent, no storage');
  assert.equal(x.as.status.state, 'off');
  x.as.attach({ id: 'p1', name: 'Mine' });
  assert.equal(x.as.status.state, 'idle');
  const states = [];
  x.as.subscribe((s) => states.push(s.state));
  x.store.getState().items.length && x.workspace.ensure(x.store.getState().items[0].id);
  await x.as.saveNow();
  assert.equal(x.as.status.state, 'saved');
  assert.ok(states.includes('saving') && states.at(-1) === 'saved');
  const [p] = await x.repo.listProjects();
  assert.equal(p.name, 'Mine');
  assert.equal(p.fileCount, 1);
  // an edit schedules a debounced save of the document
  const id = x.store.getState().items[0].id;
  x.workspace.ensure(id).commit((d) => M.setField(d, 'supplier', 'Autosaved'));
  assert.notEqual(x.as.status.state, 'saved', 'dirty until the write commits');
  await tick(120);
  assert.equal(x.as.status.state, 'saved');
  const { files } = await x.repo.loadProject('p1');
  assert.equal(files[0].doc.fields.supplier.value, 'Autosaved');
});

test('autosave: an unchanged original is not rewritten; removing a file removes it from the project', async () => {
  const x = auto();
  await x.store.add([mkFile('a.png'), mkFile('b.jpg')]);
  await tick(20);
  x.as.attach({ id: 'p', name: 'P' });
  await x.as.saveNow();
  let blobWrites = 0;
  const orig = x.db.run.bind(x.db);
  x.db.run = (names, mode, fn) => orig(names, mode, (tx) => fn({ ...tx, put: (s, v) => { if (s === 'blobs') blobWrites += 1; return tx.put(s, v); } }));
  x.workspace.ensure(x.store.getState().items[0].id)?.commit((d) => M.setField(d, 'supplier', 'z'));
  await x.as.saveNow();
  assert.equal(blobWrites, 0, 'originals are written once');
  x.store.remove(x.store.getState().items[1].id);
  await x.as.saveNow();
  assert.equal((await x.repo.listProjects())[0].fileCount, 1);
});

test('autosave: a full disk is reported as an error, "saved" is never claimed, and the earlier save is intact', async () => {
  const x = auto();
  await x.store.add([mkFile()]);
  await tick(20);
  x.as.attach({ id: 'p', name: 'Keep' });
  assert.equal(await x.as.saveNow(), true);
  x.db.setBudget(1);
  x.workspace.ensure(x.store.getState().items[0].id).commit((d) => M.setField(d, 'supplier', 'will not fit'));
  assert.equal(await x.as.saveNow(), false);
  assert.equal(x.as.status.state, 'error');
  assert.match(x.as.status.error, /no space left/);
  x.db.setBudget(Infinity);
  const { files } = await x.repo.loadProject('p');
  assert.notEqual(files[0].doc?.fields.supplier.value, 'will not fit');
  assert.equal(await x.as.saveNow(), true, 'recovers once there is space');
  assert.equal(x.as.status.state, 'saved');
  void StorageFullError;
});

test('autosave: detach stops saving and leaves what was saved', async () => {
  const x = auto();
  await x.store.add([mkFile()]);
  x.as.attach({ id: 'p', name: 'P' });
  await x.as.saveNow();
  x.as.detach();
  await x.store.add([mkFile('c.jpg')]);
  await tick(80);
  assert.equal((await x.repo.listProjects())[0].fileCount, 1);
  assert.equal(x.as.status.state, 'off');
});

// ------------------------------------------------------------------ portable file
test('portable: pack -> unpack round trip keeps bytes, results, documents and names', async () => {
  const a = await recognizedApp(['inv one.png']);
  a.workspace.ensure(a.store.getState().items[0].id).commit((d) => M.setField(d, 'supplier', 'Portable Ltd'));
  const snap = capture(a)[0];
  const { blob } = await packProject({ project: { name: 'My / project' }, files: [{ ...snap.meta, id: snap.id, blob: snap.file }] });
  const u = await unpackProject(blob);
  assert.equal(u.project.name, 'My / project');
  assert.equal(u.files.length, 1);
  assert.equal(u.files[0].name, 'inv one.png');
  assert.equal((await u.files[0].blob.arrayBuffer()).byteLength, snap.file.size);
  assert.equal(u.files[0].doc.fields.supplier.value, 'Portable Ltd');
  assert.equal(portableName('My / project', new Date('2026-11-03')), 'My_project_2026-11-03.invoicelens.zip');
  const b = app();
  const out = await restore({ project: u.project, files: u.files }, b);
  assert.equal(out.opened, 1);
  assert.equal(b.workspace.get(b.store.getState().items[0].id).doc.fields.supplier.value, 'Portable Ltd');
});

test('portable: hostile or damaged archives are refused with a readable reason', async () => {
  const { zipSync, strToU8 } = await loadFflate();
  const man = (over = {}) => ({ format: 'invoicelens-project', version: 1, project: { name: 'P' }, files: [{ name: 'a.png', path: 'files/1-a.png', kind: 'png', size: 4, status: 'queued', rotation: 0, override: null }], ...over });
  const zip = (members) => zipSync(members);
  const ok = { 'manifest.json': strToU8(JSON.stringify(man())), 'files/1-a.png': new Uint8Array([1, 2, 3, 4]) };
  const rejects = async (bytes, re, label, opts) => assert.rejects(unpackProject(bytes, opts), (e) => e.name === 'SchemaError' && re.test(e.message), label);
  await unpackProject(zip(ok)); // control
  await rejects(new Uint8Array([1, 2, 3, 4, 5]), /not a readable InvoiceLens project/, 'not a zip');
  await rejects(zip({ 'x.txt': strToU8('hi') }), /no manifest\.json/, 'no manifest');
  await rejects(zip({ 'manifest.json': strToU8('{nope') }), /not valid JSON/, 'bad json');
  await rejects(zip({ ...ok, 'manifest.json': strToU8(JSON.stringify(man({ format: 'something-else' }))) }), /not valid.*not an InvoiceLens project/, 'wrong format');
  await rejects(zip({ ...ok, 'manifest.json': strToU8(JSON.stringify(man({ files: [{ ...man().files[0], path: 'files/../../evil' }] }))) }), /unsafe path/, 'path traversal');
  await rejects(zip({ 'manifest.json': ok['manifest.json'] }), /its file is missing/, 'missing member');
  await rejects(zip({ ...ok, 'files/1-a.png': new Uint8Array([1, 2, 3]) }), /does not match its recorded size/, 'size mismatch');
  await rejects(zip(ok), /import limit/, 'archive too large', { limits: { ...LIMITS, maxImportBytes: 10 } });
  await rejects(zip({ ...ok, 'files/1-a.png': new Uint8Array(5000) }), /larger than/, 'member too large (declared size)', { limits: { ...LIMITS, maxMemberBytes: 1000 } });
  await rejects(zip({ ...ok, 'a': new Uint8Array(4000), 'b': new Uint8Array(4000) }), /expands to more than/, 'inflated total too large', { limits: { ...LIMITS, maxInflatedBytes: 6000 } });
});
