import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRepo } from '../../js/projects/repo.js';
import { migrateProject, migrateFile, validateManifest, cleanProjectName, SchemaError, SCHEMA_VERSION, PORTABLE_FORMAT, LIMITS, STORES } from '../../js/projects/schema.js';
import { StorageFullError } from '../../js/projects/db.js';
import { createFakeDb } from './fake-db.js';

const blob = (s) => new Blob([s]);
const file = (id, over = {}) => ({ id, meta: { name: `${id}.png`, kind: 'png', size: 10, status: 'recognized', rotation: 0, override: null, result: { pages: [] }, doc: null, ...over.meta }, blob: over.blob === undefined ? blob(id) : over.blob, thumb: over.thumb ?? null });
const mk = () => { const db = createFakeDb(); let t = 1000; return { db, repo: createRepo(db, { now: () => (t += 10) }) }; };

test('save -> list -> load round trip keeps order, metadata and original blobs', async () => {
  const { repo } = mk();
  const id = await repo.saveProject({ name: '  Nov   invoices ', autosave: true }, [file('b'), file('a', { thumb: blob('t') })]);
  const [p] = await repo.listProjects();
  assert.equal(p.name, 'Nov invoices');
  assert.equal(p.fileCount, 2);
  assert.equal(p.bytes, 20);
  assert.equal(p.thumbs.length, 1);
  assert.equal(p.autosave, true);
  const { project, files } = await repo.loadProject(id);
  assert.deepEqual(files.map((f) => f.id), ['b', 'a'], 'saved order');
  assert.equal(await files[0].blob.text(), 'b');
  assert.equal(project.schemaVersion, SCHEMA_VERSION);
});

test('saving again replaces the file set (removed files and their blobs disappear), keeps createdAt, skips unchanged blobs', async () => {
  const { repo, db } = mk();
  const id = await repo.saveProject({ name: 'P' }, [file('a'), file('b')]);
  const created = (await repo.listProjects())[0].createdAt;
  assert.equal(await repo.hasBlob(id, 'a'), true);
  await repo.saveProject({ id, name: 'P' }, [file('a', { blob: null })]); // autosave: blob not re-sent
  assert.equal(await repo.hasBlob(id, 'a'), true, 'blob kept');
  assert.equal(await repo.hasBlob(id, 'b'), false, 'removed file is gone');
  assert.equal(db.state[STORES.thumbs].size, 0);
  const [p] = await repo.listProjects();
  assert.equal(p.fileCount, 1);
  assert.equal(p.createdAt, created);
  assert.ok(p.updatedAt > created);
});

test('a failed write (storage full) rolls the whole save back: the previous project is untouched', async () => {
  const { repo, db } = mk();
  const id = await repo.saveProject({ name: 'Old' }, [file('a')]);
  db.setBudget(2); // allows the first couple of puts, then "disk full"
  await assert.rejects(repo.saveProject({ id, name: 'New' }, [file('a'), file('b'), file('c')]), StorageFullError);
  db.setBudget(Infinity);
  const [p] = await repo.listProjects();
  assert.equal(p.name, 'Old');
  assert.equal(p.fileCount, 1);
});

test('rename, delete one, delete all', async () => {
  const { repo, db } = mk();
  const a = await repo.saveProject({ name: 'A' }, [file('x', { thumb: blob('t') })]);
  const b = await repo.saveProject({ name: 'B' }, [file('y')]);
  await repo.rename(a, 'Renamed\n\tname');
  assert.equal((await repo.listProjects()).find((p) => p.id === a).name, 'Renamed name');
  await assert.rejects(repo.rename('nope', 'x'), SchemaError);
  await repo.deleteProject(a);
  assert.deepEqual((await repo.listProjects()).map((p) => p.id), [b]);
  assert.equal(db.state[STORES.thumbs].size, 0);
  assert.equal(db.state[STORES.blobs].size, 1);
  await repo.deleteAll();
  for (const s of Object.values(STORES)) assert.equal(db.state[s].size, 0, `${s} emptied`);
  assert.deepEqual(await repo.usage(), { projects: 0, files: 0, bytes: 0 });
});

test('usage counts projects, files and bytes', async () => {
  const { repo } = mk();
  await repo.saveProject({ name: 'A' }, [file('a', { meta: { size: 100 } }), file('b', { meta: { size: 50 } })]);
  assert.deepEqual(await repo.usage(), { projects: 1, files: 2, bytes: 150 });
});

test('loadProject refuses a project whose original is missing, and a missing project', async () => {
  const { repo, db } = mk();
  const id = await repo.saveProject({ name: 'A' }, [file('a')]);
  db.state[STORES.blobs].clear();
  await assert.rejects(repo.loadProject(id), (e) => e.code === 'missing-blob' && /missing/.test(e.message));
  await assert.rejects(repo.loadProject('zzz'), (e) => e.code === 'missing');
});

// ------------------------------------------------------------------ migrations
test('migration: a v0 record (no schemaVersion, files embedded, "docs") is upgraded in place of reading it wrongly', () => {
  const p = migrateProject({ id: 'p', name: 'Old', createdAt: 1, updatedAt: 2, files: [{ id: 'x' }] });
  assert.equal(p.schemaVersion, 1);
  assert.deepEqual(p.order, []);
  assert.equal(p.autosave, false);
  assert.equal('files' in p, false);
  const f = migrateFile({ key: 'p:x', projectId: 'p', id: 'x', name: 'x.png', docs: { schema: 'invoicelens.document' } });
  assert.equal(f.schemaVersion, 1);
  assert.deepEqual(f.doc, { schema: 'invoicelens.document' });
  assert.equal('docs' in f, false);
});

test('migration: newer data is refused with a clear message, never reinterpreted; corrupt records are rejected', async () => {
  assert.throws(() => migrateProject({ id: 'p', schemaVersion: SCHEMA_VERSION + 1 }), (e) => e.code === 'too-new' && /newer version/.test(e.message));
  assert.throws(() => migrateFile(null), (e) => e.code === 'corrupt');
  const { repo, db } = mk();
  await repo.saveProject({ name: 'Good' }, [file('a')]);
  db.state[STORES.projects].set('future', { id: 'future', name: 'From the future', schemaVersion: 99, updatedAt: 1 });
  const list = await repo.listProjects();
  assert.equal(list.length, 2);
  const bad = list.find((p) => p.id === 'future');
  assert.match(bad.unreadable, /newer version/);
  assert.equal(bad.fileCount, 0);
});

test('cleanProjectName: control characters and whitespace collapsed, length capped, never empty', () => {
  assert.equal(cleanProjectName('a\u0000b\n c'), 'a b c');
  assert.equal(cleanProjectName('x'.repeat(500)).length, LIMITS.maxNameLength);
  assert.equal(cleanProjectName('   '), 'Untitled project');
  assert.equal(cleanProjectName(null, 'Fallback'), 'Fallback');
});

// ------------------------------------------------------------------ portable manifest validation
const good = () => ({ format: PORTABLE_FORMAT, version: 1, project: { name: 'P' }, files: [{ name: 'a.png', path: 'files/1-a.png', kind: 'png', size: 10, status: 'recognized', rotation: 90, override: 'receipt', result: { pages: [] }, doc: { schema: 'invoicelens.document' } }] });

test('manifest: a good one validates; every kind of damage is reported', () => {
  assert.deepEqual(validateManifest(good()), []);
  const cases = [
    [(m) => { m.format = 'other'; }, /not an InvoiceLens project/],
    [(m) => { m.version = 99; }, /newer version/],
    [(m) => { delete m.version; }, /missing manifest version/],
    [(m) => { m.files[0].path = 'files/../../etc/passwd'; }, /unsafe path/],
    [(m) => { m.files[0].path = '/abs.png'; }, /unsafe path/],
    [(m) => { m.files[0].path = 'files/a/b.png'; }, /unsafe path/],
    [(m) => { m.files.push({ ...m.files[0] }); }, /duplicate path/],
    [(m) => { m.files[0].kind = 'exe'; }, /unknown kind/],
    [(m) => { m.files[0].size = 0; }, /bad size/],
    [(m) => { m.files[0].size = LIMITS.maxMemberBytes + 1; }, /bad size/],
    [(m) => { m.files[0].status = 'running'; }, /bad status/],
    [(m) => { m.files[0].rotation = 45; }, /bad rotation/],
    [(m) => { m.files[0].override = 'passport'; }, /bad type override/],
    [(m) => { m.files[0].result = { nope: 1 }; }, /bad recognition result/],
    [(m) => { m.files[0].doc = { schema: 'x' }; }, /bad document/],
    [(m) => { m.files = Array.from({ length: LIMITS.maxFiles + 1 }, (_, i) => ({ ...m.files[0], path: `files/${i}.png` })); }, /too many files/],
    [(m) => { m.project = null; }, /missing project/],
  ];
  for (const [mutate, re] of cases) {
    const m = good(); mutate(m);
    const errs = validateManifest(m);
    assert.ok(errs.some((e) => re.test(e)), `${re}: got ${JSON.stringify(errs)}`);
  }
  for (const nonObject of [null, 'x', [], 5]) assert.ok(validateManifest(nonObject).length);
  assert.deepEqual(validateManifest({ format: PORTABLE_FORMAT, version: 1, project: { name: 'P' } }).slice(-1), ['missing files list']);
});

// ------------------------------------------------------------------ space check
import { checkSpace, requestPersistence } from '../../js/projects/space.js';
const MB = 1024 * 1024;
const nav = (usage, quota) => ({ estimate: async () => ({ usage, quota }), persisted: async () => false, persist: async () => true });

test('checkSpace: ok / warn / block / unknown with readable messages', async () => {
  const ok = await checkSpace(10 * MB, { storage: nav(100 * MB, 2000 * MB) });
  assert.equal(ok.level, 'ok');
  const warn = await checkSpace(100 * MB, { storage: nav(1500 * MB, 2000 * MB) });
  assert.equal(warn.level, 'warn');
  assert.match(warn.message, /\d+% full after saving/);
  const block = await checkSpace(300 * MB, { storage: nav(1900 * MB, 2000 * MB) });
  assert.equal(block.level, 'block');
  assert.match(block.message, /Not enough space/);
  for (const storage of [undefined, {}, { estimate: async () => ({}) }, { estimate: async () => { throw new Error('x'); } }]) {
    const u = await checkSpace(5 * MB, { storage });
    assert.equal(u.level, 'unknown');
    assert.match(u.message, /did not report/);
  }
});

test('requestPersistence: true when granted or already persistent, false when refused or unsupported', async () => {
  assert.equal(await requestPersistence({ storage: nav(0, 1) }), true);
  assert.equal(await requestPersistence({ storage: { persisted: async () => true } }), true);
  assert.equal(await requestPersistence({ storage: { persisted: async () => false, persist: async () => false } }), false);
  assert.equal(await requestPersistence({ storage: undefined }), false);
});
