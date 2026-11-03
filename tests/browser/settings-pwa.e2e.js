// Phase 6: Settings really change behaviour; the PWA works offline under its documented conditions; updates keep saved projects.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp, fixture, VIEWPORTS, runAxe, hasHorizontalOverflow } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });
const OUT = mkdtempSync(join(tmpdir(), 'il-e2e-p6-'));
const DONE = ['recognized', 'review', 'failed', 'cancelled'];

async function fresh(opts = {}) {
  const ctx = await app.newPage({ acceptDownloads: true, ...opts });
  await ctx.page.goto(app.base);
  await ctx.page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…');
  return ctx;
}
const go = async (page, hash) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  const view = hash.replace(/^#\/?/, '').split('/')[0] || 'convert';
  await page.waitForSelector(`#view-${view}:not([hidden])`);
};
const waitAll = (page, n, states = DONE, timeout = 150000) => page.waitForFunction(({ n, states }) => {
  const rows = [...document.querySelectorAll('.file-card')];
  return rows.length === n && rows.every((r) => states.includes(r.dataset.status));
}, { n, states }, { timeout });
const stored = (page) => page.evaluate(() => localStorage.getItem('invoicelens.settings'));
const setSelect = async (page, label, text) => { await page.getByLabel(label, { exact: true }).selectOption({ label: text }); };
const makePdf = (pages) => {
  const out = join(OUT, `pages-${pages}.pdf`);
  const r = spawnSync('python3', ['-I', '-c', `
import sys
from pypdf import PdfReader, PdfWriter
w=PdfWriter(); src=PdfReader(sys.argv[1])
for i in range(int(sys.argv[2])): w.add_page(src.pages[i % len(src.pages)])
w.write(sys.argv[3])`, fixture('invoice-text.pdf'), String(pages), out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return out;
};

// ================================================================== SETTINGS
test('settings: every section renders from its own URL, aria-current follows, defaults are shown', async () => {
  const { page, context } = await fresh();
  for (const [id, title] of [['general', 'General'], ['ocr', 'Recognition (OCR)'], ['export', 'Export defaults'], ['storage', 'Storage & offline'], ['appearance', 'Appearance'], ['processing', 'Processing']]) {
    await go(page, `#/settings/${id}`);
    assert.equal(await page.locator('#set-sec-title').innerText(), title);
    assert.equal(await page.locator(`.set-nav a[data-section="${id}"]`).getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('.set-nav [aria-current="page"]').count(), 1);
  }
  await go(page, '#/settings');
  assert.equal(await page.locator('#set-sec-title').innerText(), 'General');
  assert.equal(await stored(page), null, 'viewing settings stores nothing');
  assert.equal(await page.locator('select, button, [role="combobox"], [role="menuitem"]').filter({ hasText: /language|македонски|\bEN\b/i }).count(), 0, 'no language control anywhere');
  await context.close();
});

test('settings persist (preferences only), survive reload, and Reset removes them; junk in storage cannot break the app', async () => {
  const { page, context } = await fresh();
  await go(page, '#/settings/ocr');
  await setSelect(page, 'Pages per PDF', 'Up to 10 pages');
  await setSelect(page, 'Enhanced image pass', 'Never');
  const raw = JSON.parse(await stored(page));
  assert.deepEqual(raw.values.ocr, { enhance: 'never', maxPages: 10, maxMegapixels: 12 });
  assert.equal(JSON.stringify(raw).includes('.png'), false, 'no file names stored');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…');
  await go(page, '#/settings/ocr');
  assert.equal(await page.getByLabel('Pages per PDF', { exact: true }).inputValue(), '10');
  await go(page, '#/settings/general');
  await page.click('#reset-settings');
  assert.equal(await stored(page), null, 'defaults are not stored at all');
  await go(page, '#/settings/ocr');
  assert.equal(await page.getByLabel('Pages per PDF', { exact: true }).inputValue(), '50');
  await context.close();
  const bad = await app.newPage({});
  await bad.page.addInitScript(() => { localStorage.setItem('invoicelens.settings', '{"version":1,"values":{"ocr":{"maxPages":"lots","enhance":{"x":1}},"export":{"format":"exe"}},"__proto__":{"x":1}}'); });
  await bad.page.goto(`${app.base}#/settings/export`);
  await bad.page.waitForSelector('.set-panel');
  assert.equal(await bad.page.getByLabel('Default format', { exact: true }).inputValue(), 'pdf', 'invalid stored value falls back to the default');
  assert.deepEqual(bad.problems, []);
  await bad.context.close();
});

test('OCR settings have real effects: page limit refuses long PDFs; "never" skips the enhanced pass', async () => {
  const { page, context } = await fresh();
  const twelve = makePdf(12);
  await go(page, '#/settings/ocr');
  await setSelect(page, 'Pages per PDF', 'Up to 10 pages');
  await go(page, '#/convert');
  await page.setInputFiles('#file-input', twelve);
  await waitAll(page, 1);
  assert.equal(await page.locator('.file-card').getAttribute('data-status'), 'failed');
  assert.match(await page.locator('.rec-error').innerText(), /This PDF has 12 pages; the limit is 10/);
  await go(page, '#/settings/ocr');
  await setSelect(page, 'Pages per PDF', 'Up to 25 pages');
  await go(page, '#/convert');
  await page.click('.file-card button:has-text("Retry")');
  await waitAll(page, 1, ['recognized', 'review']);
  assert.match(await page.locator('.rec-summary').innerText(), /12 pages/);
  await page.click('.file-card .card-actions .icon-btn[aria-label^="Remove"]');

  // enhanced pass: automatic helps the low-contrast photo; "never" does not run it
  await page.setInputFiles('#file-input', fixture('invoice-lowcontrast.png'));
  await waitAll(page, 1);
  const text = async () => { await page.locator('details.rec-text > summary').click(); return page.locator('.rec-text-body').innerText(); };
  assert.match(await text(), /enhanced image/, 'default: the enhanced pass was used');
  await page.click('.file-card .card-actions .icon-btn[aria-label^="Remove"]');
  await go(page, '#/settings/ocr');
  await setSelect(page, 'Enhanced image pass', 'Never');
  await go(page, '#/convert');
  await page.setInputFiles('#file-input', fixture('invoice-lowcontrast.png'));
  await waitAll(page, 1);
  assert.doesNotMatch(await text(), /enhanced image/, 'setting "Never": plain pass only');
  await context.close();
});

test('export defaults open the dialog pre-set; motion and theme settings change the page; unsaved-edits warning can be turned off; autosave delay is honoured', async () => {
  const { page, context } = await fresh();
  await page.setInputFiles('#file-input', fixture('invoice-scan.png'));
  await waitAll(page, 1);
  await go(page, '#/settings/export');
  await setSelect(page, 'Default format', 'Excel (.xlsx)');
  await go(page, '#/convert');
  await page.click('#convert-btn');
  await page.waitForSelector('.exp[open]');
  assert.equal(await page.locator('#exp-format-xlsx').isChecked(), true);
  await page.keyboard.press('Escape');
  await go(page, '#/settings/export');
  await setSelect(page, 'Default format', 'PDF');
  await setSelect(page, 'PDF content', 'Original appearance (page images)');
  await go(page, '#/convert');
  await page.click('#convert-btn');
  await page.waitForSelector('.exp[open]');
  assert.equal(await page.locator('#exp-mode-original').isChecked(), true);
  await page.keyboard.press('Escape');

  // appearance
  await go(page, '#/settings/appearance');
  await page.check('#set-theme-dark');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.match(await page.getAttribute('#theme-btn', 'aria-label'), /Theme: Dark/, 'the top-bar button follows');
  await page.check('#set-theme-system');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme ?? ''), '');
  await setSelect(page, 'Motion', 'Always reduce motion');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.motion), 'reduce');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.btn') ?? document.body).transitionDuration), '0s');
  await setSelect(page, 'Motion', 'Follow my device');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.motion), '');

  // leaving with edits
  await go(page, '#/convert');
  await page.locator('.file-card a:has-text("Review")').click();
  await page.waitForSelector('.editor:not([hidden])');
  await page.locator('#fld-supplier').fill('Edited');
  const guarded = () => page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
  assert.equal(await guarded(), true);
  await go(page, '#/settings/general');
  await page.uncheck('.switch');
  assert.equal(await guarded(), false, 'warning switched off');
  await page.check('.switch');
  assert.equal(await guarded(), true);

  // autosave delay: 5 seconds
  await go(page, '#/settings/processing');
  await setSelect(page, 'Project autosave delay', '5 seconds after the last change');
  await go(page, '#/convert');
  await page.click('#save-project-btn');
  await page.waitForSelector('dialog.dlg[open]');
  await page.fill('dialog.dlg input[type="text"]', 'Delay test');
  await page.check('dialog.dlg input[type="checkbox"]');
  await page.click('dialog.dlg button:has-text("Save in this browser")');
  await page.waitForFunction(() => /Saved \d/.test(document.getElementById('project-status').textContent), null, { timeout: 30000 });
  await page.locator('.file-card a:has-text("Review")').click();
  await page.waitForSelector('.editor:not([hidden])');
  await page.locator('#fld-supplier').fill('Delayed save');
  await page.waitForTimeout(2800);
  assert.doesNotMatch(await page.locator('.save-text').innerText(), /Edited\. Saved in project/, 'still waiting for the 5 s delay');
  await page.waitForFunction(() => /Edited\. Saved in project/.test(document.querySelector('.save-text').textContent), null, { timeout: 15000 });
  await context.close();
});

for (const [scheme, vpName] of [['light', 'desktop'], ['dark', 'desktop'], ['light', 'mobile'], ['dark', 'small']]) {
  test(`settings: axe clean in every section, no overflow, touch targets (${scheme}, ${vpName})`, async () => {
    const { page, context } = await fresh({ viewport: VIEWPORTS[vpName], colorScheme: scheme });
    for (const id of ['general', 'ocr', 'export', 'storage', 'appearance', 'processing']) {
      await go(page, `#/settings/${id}`);
      await page.waitForSelector('#set-sec-title');
      if (id === 'storage') await page.waitForFunction(() => document.getElementById('offline-status')?.textContent !== 'Checking…');
      await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
      const v = await runAxe(page);
      assert.deepEqual(v, [], `${id}: ${JSON.stringify(v)}`);
      assert.equal(await hasHorizontalOverflow(page), false, `${id} overflow`);
      if (VIEWPORTS[vpName].width <= 390) {
        const small = await page.evaluate(() => [...document.querySelectorAll('.set-panel button, .set-panel select, .set-panel .switch, .set-panel .set-radio, .set-nav a')].filter((e) => e.offsetParent !== null).map((e) => { const r = e.getBoundingClientRect(); return { id: e.id || e.textContent.trim().slice(0, 24), h: Math.round(r.height), w: Math.round(r.width) }; }).filter((r) => r.h < 29 || (r.h < 43.5 && !/switch|^$/.test(r.id) && r.w < 43.5)));
        assert.deepEqual(small, [], `${id} touch targets`);
      }
    }
    await context.close();
  });
}

// ================================================================== PWA
const registered = async (page) => {
  await page.waitForFunction(async () => !!navigator.serviceWorker.controller || !!(await navigator.serviceWorker.getRegistration())?.active, null, { timeout: 20000 });
  await page.reload(); // the first load is not controlled; after a reload the worker serves the page
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…');
};

test('service worker: installs, controls the page, precaches exactly its list, keeps documents out of every cache', async () => {
  const { page, context, problems } = await fresh();
  await registered(page);
  const info = await page.evaluate(async () => {
    const names = await caches.keys(); const out = {};
    for (const n of names) out[n] = (await (await caches.open(n)).keys()).map((r) => new URL(r.url).pathname);
    return out;
  });
  const swText = readFileSync(new URL('../../sw.js', import.meta.url), 'utf8');
  const shell = JSON.parse(/const SHELL = (\[[\s\S]*?\n\]);/.exec(swText)[1]);
  const shellName = Object.keys(info).find((n) => n.startsWith('invoicelens-shell-'));
  assert.ok(shellName, JSON.stringify(Object.keys(info)));
  assert.deepEqual(info[shellName].map((p) => p.replace(/^\//, '')).sort(), shell.sort(), 'shell cache == the generated list');
  // process documents (names that must never show up), edit, save, export
  await page.evaluate(() => { location.hash = '#/convert'; });
  await page.setInputFiles('#file-input', { name: 'SECRET-customer-invoice.png', mimeType: 'image/png', buffer: readFileSync(fixture('invoice-scan.png')) });
  await waitAll(page, 1);
  const after = await page.evaluate(async () => {
    const urls = []; for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) urls.push(r.url); return urls;
  });
  assert.ok(after.every((u) => u.startsWith(app.base)), 'only same-origin program files are cached');
  assert.ok(!after.some((u) => /SECRET|blob:|invoice-scan/i.test(u)), 'no document or file name in any cache');
  assert.ok(after.some((u) => /vendor\/tesseract\//.test(u)), 'the OCR files used were cached at runtime');
  assert.deepEqual(problems.filter((p) => !/Indexing/.test(p)), []);
  await context.close();
});

test('offline after the first download: the app reloads, recognizes, edits, exports and saves a project with the network OFF', async () => {
  const { page, context, requests, problems } = await fresh();
  await registered(page);
  await go(page, '#/settings/storage');
  await page.waitForFunction(() => document.getElementById('offline-status')?.textContent !== 'Checking…');
  await page.click('#offline-download');
  await page.waitForFunction(() => /Ready for offline use/.test(document.getElementById('offline-status').textContent), null, { timeout: 90000 });
  assert.equal(await page.locator('#offline-groups strong:has-text("available offline")').count(), 3);
  assert.equal(await page.locator('#offline-download').isDisabled(), true, 'nothing left to download');

  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…', null, { timeout: 20000 });
  assert.equal(await page.evaluate(() => navigator.onLine), false);
  const mark = requests.length;
  await go(page, '#/convert');
  await page.setInputFiles('#file-input', [fixture('invoice-scan.png'), fixture('invoice-text.pdf')]);
  await waitAll(page, 2, ['recognized', 'review']);
  // edit + export every format offline
  await page.locator('.file-card:has(.file-name[title="invoice-scan.png"]) a:has-text("Review")').click();
  await page.waitForSelector('.editor:not([hidden])');
  await page.locator('#fld-supplier').fill('Offline Co');
  await page.click('#ed-export'); await page.waitForSelector('.exp[open]');
  for (const [fmt, ext] of [['pdf', 'pdf'], ['docx', 'docx'], ['xlsx', 'xlsx'], ['csv', 'csv']]) {
    await page.check(`#exp-format-${fmt}`);
    await page.waitForFunction(() => /^Ready:/.test(document.querySelector('.exp-status').textContent) || document.querySelector('.exp-error').textContent, null, { timeout: 60000 });
    assert.equal(await page.locator('.exp-error').innerText(), '', `${fmt} offline`);
    const [d] = await Promise.all([page.waitForEvent('download'), page.click('.exp-actions .btn-primary')]);
    assert.match(d.suggestedFilename(), new RegExp(`\\.${ext}$`));
  }
  await page.keyboard.press('Escape');
  // save + reload + resume, all offline (IndexedDB does not need the network)
  await go(page, '#/convert');
  await page.click('#save-project-btn');
  await page.waitForSelector('dialog.dlg[open]');
  await page.fill('dialog.dlg input[type="text"]', 'Offline project');
  await page.check('dialog.dlg input[type="checkbox"]');
  await page.click('dialog.dlg button:has-text("Save in this browser")');
  await page.waitForFunction(() => /Saved \d/.test(document.getElementById('project-status').textContent), null, { timeout: 30000 });
  await page.reload();
  await page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…');
  await go(page, '#/projects');
  await page.locator('.proj-card').waitFor();
  await page.click('.proj-card button:has-text("Open")');
  await waitAll(page, 2, ['recognized', 'review']);
  const failed = requests.slice(mark).filter((r) => r.method !== 'GET');
  assert.deepEqual(failed, [], 'no non-GET request while offline');
  assert.deepEqual(problems.filter((p) => !/Indexing|net::ERR|Failed to load resource/.test(p)), []);
  await context.close();
});

test('first open while offline is NOT possible (documented); offline without the OCR files gives a clear message, not a hang', async () => {
  const cold = await app.newPage({});
  await cold.context.setOffline(true);
  await assert.rejects(cold.page.goto(app.base, { timeout: 15000 }), /ERR_INTERNET_DISCONNECTED|net::ERR/);
  await cold.context.close();

  const { page, context } = await fresh();
  await registered(page); // the app shell is cached, the OCR files are NOT
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…');
  await page.setInputFiles('#file-input', fixture('invoice-scan.png'));
  await waitAll(page, 1, ['failed'], 60000);
  assert.match(await page.locator('.rec-error').innerText(), /You are offline and the text-recognition files are not stored on this device yet/);
  await go(page, '#/settings/storage');
  await page.waitForFunction(() => document.getElementById('offline-status')?.textContent !== 'Checking…');
  assert.equal(await page.locator('#offline-download').isDisabled(), false, 'download is offered (it will work once online)');
  await context.close();
});

test('update: a new worker waits, the user is told, applying it keeps saved projects and replaces the old cache', async () => {
  const { page, context } = await fresh();
  await registered(page);
  await page.setInputFiles('#file-input', fixture('invoice-scan.png'));
  await waitAll(page, 1);
  await page.click('#save-project-btn');
  await page.waitForSelector('dialog.dlg[open]');
  await page.fill('dialog.dlg input[type="text"]', 'Survives updates');
  await page.check('dialog.dlg input[type="checkbox"]');
  await page.click('dialog.dlg button:has-text("Save in this browser")');
  await page.waitForFunction(() => /Saved \d/.test(document.getElementById('project-status').textContent), null, { timeout: 30000 });
  const before = await page.evaluate(async () => (await caches.keys()).filter((n) => n.startsWith('invoicelens-shell-')));
  assert.equal(before.length, 1);

  // serve a NEW worker version (different version string) from now on
  // (a request interceptor does not see service-worker script fetches, so the real file is changed for the duration of the test)
  const swPath = new URL('../../sw.js', import.meta.url);
  const original = readFileSync(swPath, 'utf8');
  try {
    writeFileSync(swPath, original.replace(/APP_VERSION = '[0-9a-f]{12}'/, "APP_VERSION = 'test-version-2'"));
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
    await page.waitForSelector('#update-bar:not([hidden])', { timeout: 20000 });
  } finally { writeFileSync(swPath, original); }
  assert.match(await page.locator('#update-bar').innerText(), /new version of InvoiceLens is ready/i);
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL.endsWith('sw.js')), true);
  const waiting = await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()).waiting);
  assert.equal(waiting, true, 'the new worker WAITS; it did not swap itself in under the running page');
  assert.match(await (async () => { await page.evaluate(() => { location.hash = '#/settings/storage'; }); await page.waitForSelector('#offline-status'); await page.waitForFunction(() => document.getElementById('offline-status').textContent !== 'Checking…'); return page.locator('#offline-status').innerText(); })(), /new version/i);

  // apply: the project saved before the update is still there and opens
  page.once('dialog', (d) => d.accept());
  await Promise.all([page.waitForNavigation({ timeout: 20000 }).catch(() => {}), page.click('#update-btn')]);
  await page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…', null, { timeout: 20000 });
  await page.waitForFunction(async () => (await caches.keys()).filter((n) => n.startsWith('invoicelens-shell-')).length === 1 && (await caches.keys()).some((n) => n === 'invoicelens-shell-test-version-2'), null, { timeout: 20000 });
  await go(page, '#/projects');
  await page.locator('.proj-card').waitFor();
  assert.equal(await page.locator('.pc-name').innerText(), 'Survives updates');
  await page.click('.proj-card button:has-text("Open")');
  await waitAll(page, 1, ['recognized', 'review']);
  await context.close();
});

test('manifest + icons are served with the right types; the page declares them', async () => {
  const { page, context } = await fresh();
  const r = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]').href;
    const m = await fetch(link); const json = await m.json();
    const icons = await Promise.all(json.icons.map(async (i) => { const res = await fetch(new URL(i.src, link)); return [i.src, res.status, res.headers.get('content-type')]; }));
    return { type: m.headers.get('content-type'), name: json.name, start: json.start_url, icons, themes: [...document.querySelectorAll('meta[name="theme-color"]')].map((x) => x.media), apple: !!document.querySelector('link[rel="apple-touch-icon"]') };
  });
  assert.match(r.type, /application\/manifest\+json/);
  assert.equal(r.name, 'InvoiceLens');
  assert.ok(r.icons.every(([, s, t]) => s === 200 && /image\/png/.test(t)));
  assert.equal(r.themes.length, 2); assert.equal(r.apple, true);
  await context.close();
});
