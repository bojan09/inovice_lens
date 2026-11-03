import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createStore } from '../../js/store.js';
import { DEFAULT_POLICY } from '../../js/intake.js';

const fx = (n) => new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url))));
const file = (bytes, name) => new File([bytes], name);

function makeStore(extra = {}) {
  const urls = { created: [], revoked: [] };
  let n = 0;
  const store = createStore({
    createObjectURL: () => { const u = `blob:test/${++n}`; urls.created.push(u); return u; },
    revokeObjectURL: (u) => urls.revoked.push(u),
    ...extra,
  });
  return { store, urls };
}

test('add creates object URLs for images only; PDFs get none', async () => {
  const { store, urls } = makeStore();
  const res = await store.add([file(fx('sample.png'), 'a.png'), file(fx('sample.pdf'), 'b.pdf')]);
  assert.equal(res.added, 2);
  const { items } = store.getState();
  assert.ok(items[0].url);
  assert.equal(items[1].url, null);
  assert.equal(urls.created.length, 1);
});

test('remove revokes the object URL exactly once', async () => {
  const { store, urls } = makeStore();
  await store.add([file(fx('sample.png'), 'a.png')]);
  const id = store.getState().items[0].id;
  assert.equal(store.remove(id), true);
  assert.equal(store.remove(id), false);
  assert.deepEqual(urls.revoked, urls.created);
  assert.equal(store.getState().items.length, 0);
});

test('clear and destroy revoke every URL', async () => {
  const { store, urls } = makeStore();
  await store.add([file(fx('sample.png'), 'a.png'), file(fx('sample.jpg'), 'b.jpg')]);
  store.clear();
  assert.equal(urls.revoked.length, 2);
  await store.add([file(fx('sample.webp'), 'c.webp')]);
  store.destroy();
  assert.equal(urls.revoked.length, 3);
});

test('rejected files are kept for display and can be dismissed', async () => {
  const { store } = makeStore();
  await store.add([file(new Uint8Array(0), 'e.png')]);
  const { rejected } = store.getState();
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].retryable, false);
  store.dismissRejected(rejected[0].id);
  assert.equal(store.getState().rejected.length, 0);
});

test('duplicate across separate add() calls is rejected', async () => {
  const { store } = makeStore();
  await store.add([file(fx('sample.png'), 'a.png')]);
  const res = await store.add([file(fx('sample.png'), 'a-copy.png')]);
  assert.equal(res.added, 0);
  assert.equal(store.getState().rejected[0].code, 'duplicate');
});

test('removing a file lets the same content be added again', async () => {
  const { store } = makeStore();
  await store.add([file(fx('sample.png'), 'a.png')]);
  store.remove(store.getState().items[0].id);
  const res = await store.add([file(fx('sample.png'), 'a.png')]);
  assert.equal(res.added, 1);
});

test('retry re-processes only retryable rejections and succeeds on second read', async () => {
  let calls = 0;
  const flaky = async (f) => { calls += 1; if (calls === 1) throw new Error('transient'); return f.arrayBuffer(); };
  const { store } = makeStore({ readBytes: flaky });
  await store.add([file(fx('sample.png'), 'a.png')]);
  const r = store.getState().rejected[0];
  assert.equal(r.code, 'read-error');
  assert.equal(r.retryable, true);
  const res = await store.retry(r.id);
  assert.equal(res.added, 1);
  assert.equal(store.getState().rejected.length, 0);
  assert.equal(store.getState().items.length, 1);
});

test('retry on a non-retryable rejection does nothing', async () => {
  const { store } = makeStore();
  await store.add([file(new Uint8Array(0), 'e.png')]);
  const r = store.getState().rejected[0];
  assert.equal(await store.retry(r.id), null);
  assert.equal(store.getState().rejected.length, 1);
});

test('concurrent add() calls are serialised so the file limit holds', async () => {
  const { store } = makeStore({ policy: { ...DEFAULT_POLICY, maxFiles: 1 } });
  const [a, b] = await Promise.all([
    store.add([file(fx('sample.png'), 'a.png')]),
    store.add([file(fx('sample.jpg'), 'b.jpg')]),
  ]);
  assert.equal(a.added + b.added, 1);
  assert.equal(store.getState().items.length, 1);
  assert.equal(store.getState().rejected[0].code, 'limit-files');
});

test('busy flag toggles around add and subscribers are notified', async () => {
  const { store } = makeStore();
  const seen = [];
  store.subscribe((s) => seen.push(s.busy));
  await store.add([file(fx('sample.png'), 'a.png')]);
  assert.deepEqual(seen, [true, false]);
});

test('markPreviewFailed revokes the URL and flags the item', async () => {
  const { store, urls } = makeStore();
  await store.add([file(fx('sample.png'), 'a.png')]);
  const id = store.getState().items[0].id;
  store.markPreviewFailed(id);
  assert.equal(store.getState().items[0].previewFailed, true);
  assert.equal(urls.revoked.length, 1);
  store.remove(id);
  assert.equal(urls.revoked.length, 1);
});
