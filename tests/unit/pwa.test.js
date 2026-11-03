import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createPwa } from '../../js/pwa.js';
import { PWA } from '../../js/pwa-manifest.js';
import { parseSettingsSection, SETTINGS_SECTIONS } from '../../js/router.js';
import { plan } from '../../scripts/build-pwa.js';

const root = new URL('../../', import.meta.url);

test('generated sw.js / js/pwa-manifest.js are up to date (run `npm run build:pwa` after changing any app file)', () => {
  const r = spawnSync('node', ['scripts/build-pwa.js', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

test('service worker precaches exactly the files that exist, none of the documents/tests/docs, and never skipWaiting by itself', () => {
  const sw = readFileSync(new URL('sw.js', root), 'utf8');
  const shell = JSON.parse(/const SHELL = (\[[\s\S]*?\n\]);/.exec(sw)[1]);
  assert.ok(shell.includes('index.html') && shell.includes('manifest.webmanifest') && shell.includes('js/main.js') && shell.includes('css/tokens.css'));
  for (const f of shell) assert.ok(existsSync(new URL(f, root)), `${f} exists`);
  assert.deepEqual(shell, plan().shell, 'list matches the real files');
  assert.ok(!shell.some((f) => /^(tests|docs|corpus|node_modules|scripts|vendor)\//.test(f)), 'only the app shell is precached; vendor is cached on demand');
  assert.ok(!shell.includes('sw.js'));
  assert.match(sw, /APP_VERSION = '[0-9a-f]{12}'/);
  assert.match(sw, /VENDOR_CACHE = 'invoicelens-vendor-[0-9a-f]{12}'/);
  // the only skipWaiting call is behind the explicit SKIP_WAITING message from the page
  const calls = sw.split('\n').filter((l) => /self\.skipWaiting\(\)/.test(l) && !l.trim().startsWith('//')).length;
  assert.equal(calls, 1);
  assert.match(sw, /event\.data\.type === 'SKIP_WAITING'\) self\.skipWaiting\(\)/);
  // untouched traffic: non-GET, other origins and unlisted paths are not answered by the worker
  assert.match(sw, /if \(req\.method !== 'GET'\) return;/);
  assert.match(sw, /url\.origin !== BASE\.origin/);
  const code = sw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/blob:|indexedDB|FileReader|\.formData|postMessage\(/.test(code), 'the worker code never touches user files');
});

test('shell + vendor budget: sizes are measured and bounded', () => {
  const shell = plan().shell;
  const shellBytes = shell.reduce((n, f) => n + statSync(new URL(f, root)).size, 0);
  const vendorBytes = PWA.groups.flatMap((g) => g.files).reduce((n, f) => n + f.bytes, 0);
  assert.ok(shellBytes < 1_000_000, `app shell ${shellBytes} B`);
  assert.ok(vendorBytes < 14_000_000, `vendored libraries ${vendorBytes} B`);
  console.log(`# shell ${shell.length} files ${shellBytes} B, vendor ${PWA.groups.flatMap((g) => g.files).length} files ${vendorBytes} B`);
});

test('manifest: valid JSON, icons exist with the declared sizes, maskable icon present', () => {
  const m = JSON.parse(readFileSync(new URL('manifest.webmanifest', root), 'utf8'));
  assert.equal(m.display, 'standalone'); assert.ok(m.name && m.short_name && m.start_url && m.scope && m.theme_color && m.background_color);
  const sizes = {};
  for (const i of m.icons) {
    const buf = readFileSync(new URL(i.src, root));
    assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${i.src} is a PNG`);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    assert.equal(`${w}x${h}`, i.sizes, `${i.src} really is ${i.sizes}`);
    sizes[i.purpose] = (sizes[i.purpose] ?? []).concat(i.sizes);
  }
  assert.ok(sizes.any.includes('192x192') && sizes.any.includes('512x512') && sizes.maskable.includes('512x512'));
});

test('router: settings sections', () => {
  assert.equal(parseSettingsSection('#/settings/ocr'), 'ocr');
  assert.equal(parseSettingsSection('#settings/storage/'), 'storage');
  for (const bad of ['#/settings', '#/settings/', '#/settings/nope', '#/settings/ocr/x', '#/convert', '', undefined, '#/settings/__proto__']) assert.equal(parseSettingsSection(bad), 'general');
  assert.deepEqual(SETTINGS_SECTIONS, ['general', 'ocr', 'export', 'storage', 'appearance', 'processing']);
});

// ------------------------------------------------------------------ page-side logic with fakes
function fakeEnv({ cached = [], online = true, ok = true } = {}) {
  const store = new Map(); // cacheName -> Map(url -> Response)
  const name = PWA.vendorCache;
  if (cached.length) store.set(name, new Map(cached.map((p) => [new URL(p, 'http://app.test/').href, new Response('x')])));
  const caches_ = {
    keys: async () => [...store.keys()],
    open: async (n) => { if (!store.has(n)) store.set(n, new Map()); const m = store.get(n); return { keys: async () => [...m.keys()].map((u) => ({ url: u })), put: async (u, r) => { m.set(u, r); } }; },
    delete: async (n) => store.delete(n),
  };
  const fetched = [];
  const win = { isSecureContext: true, location: { href: 'http://app.test/index.html' }, addEventListener() {} };
  const nav = { serviceWorker: { controller: {}, register: async () => ({ addEventListener() {}, update: async () => {} }), addEventListener() {} }, onLine: online };
  globalThis.fetch = async (u) => { fetched.push(u); return ok ? new Response('data') : new Response('no', { status: 404 }); };
  return { pwa: createPwa({ nav, win, caches_ }), store, fetched };
}

test('pwa.status reports what is REALLY cached per group and a matching message', async () => {
  const all = PWA.groups.flatMap((g) => g.files.map((f) => f.path));
  let e = fakeEnv();
  let s = await e.pwa.status();
  assert.ok(s.groups.every((g) => !g.cached && !g.complete));
  assert.match(s.message, /app itself opens offline/);
  e = fakeEnv({ cached: PWA.groups[0].files.map((f) => f.path) });
  s = await e.pwa.status();
  assert.deepEqual(s.groups.map((g) => g.complete), [true, false, false]);
  e = fakeEnv({ cached: all });
  s = await e.pwa.status();
  assert.ok(s.groups.every((g) => g.complete));
  assert.match(s.message, /Ready for offline use/);
});

test('pwa.download fetches only what is missing, reports progress, fails loudly on a bad response; clear() removes it', async () => {
  const have = PWA.groups[0].files.map((f) => f.path);
  const e = fakeEnv({ cached: have });
  const prog = [];
  await e.pwa.download((d, t) => prog.push([d, t]));
  const total = PWA.groups.flatMap((g) => g.files).length - have.length;
  assert.equal(e.fetched.length, total, 'already cached files are not fetched again');
  assert.deepEqual(prog.at(-1), [total, total]);
  assert.ok((await e.pwa.status()).groups.every((g) => g.complete));
  await e.pwa.clear();
  assert.ok((await e.pwa.status()).groups.every((g) => g.cached === 0));
  const bad = fakeEnv({ ok: false });
  await assert.rejects(bad.pwa.download(), /could not be downloaded \(404\)/);
});

test('pwa without service workers / secure context says so instead of pretending', async () => {
  const pwa = createPwa({ nav: {}, win: { isSecureContext: false, location: { href: 'http://x/' }, addEventListener() {} }, caches_: undefined });
  assert.equal(pwa.supported, false);
  assert.equal(await pwa.register(), null);
  assert.match((await pwa.status()).message, /not available here/);
  await assert.rejects(pwa.download(), /not available/);
});
