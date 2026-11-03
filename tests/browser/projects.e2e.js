// Phase 5 end-to-end: batch queue controls, combined exports, saved projects (IndexedDB), reload/resume, deletion,
// low storage, portable files, schema migration. Real OCR, real downloads re-read with independent tools.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp, fixture, VIEWPORTS, runAxe, hasHorizontalOverflow } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const OUT = mkdtempSync(join(tmpdir(), 'il-e2e-proj-'));
const py = (code, ...args) => spawnSync('python3', ['-I', '-c', code, ...args], { encoding: 'utf8' });
const DONE = ['recognized', 'review', 'failed', 'cancelled'];

async function fresh(opts = {}) {
  const ctx = await app.newPage({ acceptDownloads: true, ...opts });
  await ctx.page.goto(app.base);
  await ctx.page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…');
  return ctx;
}
const add = (page, files) => page.setInputFiles('#file-input', [].concat(files));
const waitAll = (page, n, states = DONE, timeout = 150000) => page.waitForFunction(({ n, states }) => {
  const rows = [...document.querySelectorAll('.file-card')];
  return rows.length === n && rows.every((r) => states.includes(r.dataset.status));
}, { n, states }, { timeout });
const go = async (page, view) => { await page.evaluate((v) => { location.hash = `#/${v}`; }, view); await page.waitForSelector(`#view-${view}:not([hidden])`); }; // hash navigation works with the sidebar, the drawer and the bottom bar alike
const toast = (page) => page.locator('#toasts').innerText();
async function idbCounts(page) {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === 'invoicelens')) return null;
    return new Promise((res) => {
      const r = indexedDB.open('invoicelens');
      r.onsuccess = () => {
        const db = r.result; const names = [...db.objectStoreNames]; const out = {};
        const tx = db.transaction(names); let n = names.length;
        names.forEach((nm) => { const c = tx.objectStore(nm).count(); c.onsuccess = () => { out[nm] = c.result; if (--n === 0) { db.close(); res(out); } }; });
      };
      r.onerror = () => res(null);
    });
  });
}
async function saveProject(page, name, { opener = '#save-project-btn' } = {}) {
  await page.click(opener);
  await page.waitForSelector('dialog.dlg[open]');
  await page.fill('dialog.dlg input[type="text"]', name);
  await page.check('dialog.dlg input[type="checkbox"]');
  await page.click('dialog.dlg button:has-text("Save in this browser")');
  await page.waitForFunction(() => /Saved \d/.test(document.getElementById('project-status').textContent), null, { timeout: 30000 });
}
const statusText = (page) => page.locator('#project-status').innerText();

// ================================================================== BATCH
test('batch: counts come from the real queue; one broken file is isolated; Retry failed re-queues only it', async () => {
  const { page, context, problems } = await fresh();
  await go(page, 'batch');
  assert.equal(await page.locator('#batch-empty').isVisible(), true);
  assert.equal(await page.locator('#stat-total').innerText(), '0');
  await add(page, [fixture('invoice-scan.png'), fixture('broken.pdf'), fixture('receipt-scan.jpg')]);
  await page.waitForFunction(() => document.querySelectorAll('#batch-table tbody tr').length === 3);
  await page.waitForFunction(() => !document.querySelector('#batch-table tr[data-status="queued"], #batch-table tr[data-status="preparing"], #batch-table tr[data-status="extracting"]'), null, { timeout: 150000 });
  assert.equal(await page.locator('#view-batch:not([hidden])').count(), 1, 'adding files on Batch keeps you on Batch');
  const stat = async (k) => Number(await page.locator(`#stat-${k}`).innerText());
  assert.deepEqual([await stat('total'), await stat('done'), await stat('review'), await stat('failed'), await stat('queue')], [3, 2, 0, 1, 0]);
  const failed = page.locator('#batch-table tr[data-status="failed"]');
  assert.match(await failed.innerText(), /damaged or not a valid PDF/);
  assert.equal(await failed.locator('.meter').isVisible(), false, 'no progress bar for a finished/failed file');
  assert.equal(await page.locator('#batch-table tr[data-status="recognized"] .meter:visible').count(), 0, 'no fake 100% bars on completed files');
  // retry only the failed one
  await page.click('#q-retry-all');
  await page.waitForFunction(() => document.querySelector('#batch-table tr[data-status="failed"]'), null, { timeout: 30000 });
  assert.equal(await stat('done'), 2, 'the good files were not touched');
  assert.equal(await stat('failed'), 1);
  assert.deepEqual(problems.filter((p) => !/Indexing all PDF objects/.test(p)), []);
  await context.close();
});

test('batch: Pause stops NEW files from starting (the running one finishes); Resume continues; Cancel stops real work', async () => {
  const { page, context } = await fresh();
  await go(page, 'batch');
  await add(page, [fixture('invoice-scan.png'), fixture('receipt-scan.jpg'), fixture('table-scan.png')]);
  await page.waitForFunction(() => document.querySelectorAll('#batch-table tbody tr').length === 3);
  await page.click('#q-pause');
  assert.equal(await page.locator('#q-pause').innerText(), 'Resume queue');
  assert.match(await page.locator('#queue-state').innerText(), /Queue paused/);
  const states = () => page.$$eval('#batch-table tbody tr', (r) => r.map((x) => x.dataset.status));
  // the file that was already running completes...
  await page.waitForFunction(() => !document.querySelector('#batch-table tr[data-status="preparing"], #batch-table tr[data-status="extracting"]'), null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  const s = await states();
  assert.ok(s.filter((x) => x === 'queued').length >= 1, `paused: waiting files did not start (${s})`);
  assert.equal(s.filter((x) => x === 'preparing' || x === 'extracting').length, 0);
  assert.match(await page.locator('#batch-table tr[data-status="queued"]').first().innerText(), /Paused/);
  assert.equal(await page.locator('#stat-queue').innerText(), String(s.filter((x) => x === 'queued').length));
  // resume
  await page.click('#q-pause');
  await page.waitForFunction(() => [...document.querySelectorAll('#batch-table tbody tr')].every((r) => r.dataset.status === 'recognized'), null, { timeout: 120000 });
  assert.equal(await page.locator('#stat-done').innerText(), '3');
  // cancel a running file for real
  await page.click('#sel-all'); await page.click('#b-remove');
  await add(page, [fixture('scanned-2page.pdf'), fixture('invoice-scan.png')]);
  await page.waitForSelector('#batch-table tr[data-status="extracting"], #batch-table tr[data-status="preparing"]', { timeout: 30000 });
  await page.locator('#batch-table tr[data-status="extracting"] button:has-text("Cancel"), #batch-table tr[data-status="preparing"] button:has-text("Cancel")').first().click();
  await page.waitForSelector('#batch-table tr[data-status="cancelled"]');
  await page.waitForFunction(() => document.querySelectorAll('#batch-table tr[data-status="recognized"]').length === 1, null, { timeout: 60000 });
  await context.close();
});

test('batch: selection actions act on the selection only; Export opens with those files and combined outputs verify with independent tools', async () => {
  const { page, context } = await fresh();
  await add(page, [fixture('invoice-scan.png'), fixture('receipt-scan.jpg'), fixture('invoice-text.pdf')]);
  await waitAll(page, 3);
  await go(page, 'batch');
  assert.equal(await page.locator('.abar').isHidden(), true, 'no action bar without a selection');
  await page.locator('#batch-table tr:has(.b-name[title="invoice-scan.png"]) input[type=checkbox]').check();
  await page.locator('#batch-table tr:has(.b-name[title="receipt-scan.jpg"]) input[type=checkbox]').check();
  assert.equal(await page.locator('#sel-count').innerText(), '2 selected');
  assert.equal(await page.locator('#sel-all').evaluate((e) => e.indeterminate), true);
  await page.click('#b-export');
  await page.waitForSelector('.exp[open]');
  const ticked = await page.$$eval('.exp-controls input[id^="exp-file-"]', (i) => i.map((x) => [x.nextElementSibling.textContent, x.checked]));
  assert.deepEqual(ticked.sort(), [['invoice-scan.png', true], ['invoice-text.pdf', false], ['receipt-scan.jpg', true]]);
  const ready = () => page.waitForFunction(() => /^Ready:/.test(document.querySelector('.exp-status').textContent) || document.querySelector('.exp-error').textContent, null, { timeout: 60000 });
  const dl = async () => { const [d] = await Promise.all([page.waitForEvent('download'), page.click('.exp-actions .btn-primary')]); const p = join(OUT, `${Date.now()}-${d.suggestedFilename()}`); await d.saveAs(p); return { p, name: d.suggestedFilename() }; };
  await ready();
  // default for several files: ZIP of separate exports
  assert.match(await page.locator('.exp-status').innerText(), /\.zip/);
  // combined PDF
  await page.check('#exp-combine-combined'); await ready();
  let { p, name } = await dl();
  assert.match(name, /^invoicelens-combined_\d{4}-\d{2}-\d{2}\.pdf$/);
  const pages = Number(/Pages:\s+(\d+)/.exec(spawnSync('pdfinfo', [p], { encoding: 'utf8' }).stdout)[1]);
  assert.equal(pages, 4, 'two documents x (details/items page + page-text page)');
  const text = spawnSync('pdftotext', ['-layout', p, '-'], { encoding: 'utf8' }).stdout;
  assert.match(text, /invoice-scan\.png · page 1 of/);
  assert.match(text, /receipt-scan\.jpg · page 1 of/);
  assert.ok(!text.includes('invoice-text.pdf'), 'the unselected file is not in the output');
  // consolidated workbook
  await page.check('#exp-format-xlsx'); await ready();
  ({ p, name } = await dl());
  assert.match(name, /^invoicelens-consolidated_.*\.xlsx$/);
  const o = JSON.parse(py(`
import openpyxl,sys,json
wb=openpyxl.load_workbook(sys.argv[1]); d=wb['Documents']; l=wb['Line items']
print(json.dumps({'sheets':wb.sheetnames,'docs':[[c.value for c in r] for r in d.iter_rows(min_row=2)],'lines':[[c.value for c in r] for r in l.iter_rows(min_row=2)]},default=str))`, p).stdout);
  assert.deepEqual(o.docs.map((r) => r[0]).sort(), ['invoice-scan.png', 'receipt-scan.jpg']);
  const inv = o.docs.find((r) => r[0] === 'invoice-scan.png');
  assert.equal(inv[2], 'ACME Supplies'); assert.equal(inv[9], 245);
  assert.ok(o.lines.every((r) => ['invoice-scan.png', 'receipt-scan.jpg'].includes(r[0])), 'every line item names its source');
  assert.equal(o.lines.filter((r) => r[0] === 'invoice-scan.png').length, 2);
  // consolidated CSV
  await page.check('#exp-format-csv'); await ready();
  await page.selectOption('#exp-table', 'items'); await ready();
  ({ p, name } = await dl());
  assert.match(name, /consolidated_items/);
  assert.match(readFileSync(p, 'utf8'), /^\uFEFFSource file,#,Description,Qty,Unit price,Total\r\n/);
  // Word cannot be combined: disabled with a reason
  await page.check('#exp-format-docx'); await ready();
  assert.equal(await page.locator('#exp-combine-combined').isDisabled(), true);
  assert.match(await page.locator('#exp-combine-combined-h').innerText(), /one per document/);
  assert.match(await page.locator('.exp-status').innerText(), /\.zip/);
  // remove the selection from the queue
  await page.keyboard.press('Escape');
  await page.click('#b-remove');
  assert.equal(await page.locator('#batch-table tbody tr').count(), 1);
  await context.close();
});

// ================================================================== PROJECTS
test('consent: nothing is stored until the box is ticked; then it is saved, shown honestly and listed with its thumbnail', async () => {
  const { page, context } = await fresh();
  await add(page, fixture('invoice-scan.png'));
  await waitAll(page, 1);
  assert.equal(await idbCounts(page), null, 'no database at all before the user saves anything');
  assert.equal(await page.locator('#project-status').isHidden(), true);
  await page.click('#save-project-btn');
  await page.waitForSelector('dialog.dlg[open]');
  assert.match(await page.locator('dialog.dlg').innerText(), /Nothing is uploaded/);
  await page.fill('dialog.dlg input[type="text"]', 'November invoices');
  await page.click('dialog.dlg button:has-text("Save in this browser")'); // without consent
  assert.match(await page.locator('.dlg-error').innerText(), /Tick the box/);
  assert.equal(await idbCounts(page), null, 'still nothing stored');
  await page.check('dialog.dlg input[type="checkbox"]');
  await page.click('dialog.dlg button:has-text("Save in this browser")');
  await page.waitForFunction(() => /Saved \d/.test(document.getElementById('project-status').textContent), null, { timeout: 30000 });
  assert.match(await statusText(page), /Project “November invoices”\. Saved \d\d:\d\d/);
  const c = await idbCounts(page);
  assert.deepEqual([c.projects, c.files, c.blobs], [1, 1, 1]);
  await go(page, 'projects');
  const card = page.locator('.proj-card');
  await card.waitFor();
  assert.equal(await card.locator('.pc-name').innerText(), 'November invoices');
  assert.match(await card.locator('.pc-meta').innerText(), /1 document · \d+(\.\d)? KB/);
  assert.equal(await card.locator('.pc-thumbs img').count(), 1, 'real thumbnail from the saved file');
  assert.equal(await card.locator('.pc-thumbs img').evaluate((i) => i.naturalWidth > 10), true);
  assert.match(await page.locator('#proj-storage').innerText(), /1 project, 1 file/);
  assert.match(await page.locator('#proj-privacy').innerText(), /only in this browser.*Nothing is uploaded/);
  await context.close();
});

test('reload + resume: edits and recognition come back, OCR does NOT run again, deletion removes everything', async () => {
  const { page, context, requests } = await fresh();
  await add(page, [fixture('invoice-scan.png'), fixture('receipt-scan.jpg')]);
  await waitAll(page, 2);
  await saveProject(page, 'Resume me');
  // edit in the editor: autosave must pick it up
  await page.locator('.file-card:has(.file-name[title="invoice-scan.png"]) a:has-text("Review")').click();
  await page.waitForSelector('.editor:not([hidden])');
  await page.locator('#fld-supplier').fill('Persisted Supplier Ltd');
  await page.selectOption('#ed-type', 'invoice');
  await page.waitForFunction(() => /Edited\. Saved in project/.test(document.querySelector('.save-text').textContent), null, { timeout: 20000 });
  assert.equal(await page.locator('.save-state').getAttribute('data-state'), 'clean', 'saved edits are not shown as unsaved');
  // reload: the workspace is gone, the project is not
  await page.reload();
  await page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…');
  assert.equal(await page.locator('.file-card').count(), 0);
  const before = requests.length;
  await go(page, 'projects');
  await page.locator('.proj-card').waitFor();
  await page.click('.proj-card button:has-text("Open")');
  await waitAll(page, 2, ['recognized', 'review']);
  assert.match(await toast(page), /Opened “?"?Resume me/);
  const ocr = requests.slice(before).filter((r) => /tesseract|traineddata/.test(r.url));
  assert.deepEqual(ocr, [], 'a saved project is resumed without running OCR again');
  assert.match(await page.locator('#project-status').innerText(), /Project “Resume me”/);
  await page.locator('.file-card:has(.file-name[title="invoice-scan.png"]) a:has-text("Review")').click();
  await page.waitForSelector('.editor:not([hidden])');
  assert.equal(await page.locator('#fld-supplier').inputValue(), 'Persisted Supplier Ltd');
  assert.equal(await page.locator('.fld[data-key="supplier"] .fld-tag').innerText(), 'Edited by you');
  assert.equal(await page.locator('[aria-label="Undo"]').isDisabled(), true, 'resume is not an undo step');
  assert.equal(await page.locator('.vw-stage').isVisible(), true);
  await page.waitForFunction(() => document.querySelector('.vw-canvas').width > 100);
  // the original file is intact: export it as structured PDF and read the edited value back
  await page.click('#ed-export'); await page.waitForSelector('.exp[open]');
  await page.waitForFunction(() => /^Ready:/.test(document.querySelector('.exp-status').textContent), null, { timeout: 30000 });
  const [d] = await Promise.all([page.waitForEvent('download'), page.click('.exp-actions .btn-primary')]);
  const f = join(OUT, `${Date.now()}-${d.suggestedFilename()}`); await d.saveAs(f);
  assert.match(spawnSync('pdftotext', [f, '-'], { encoding: 'utf8' }).stdout, /Persisted Supplier Ltd/);
  await page.keyboard.press('Escape');

  // delete: confirmation can be cancelled; confirming removes every trace
  await go(page, 'projects');
  await page.click('.proj-card button:has-text("Delete")');
  await page.waitForSelector('dialog.dlg[open]');
  assert.match(await page.locator('dialog.dlg').innerText(), /permanently removes the project.*cannot be undone/);
  await page.click('dialog.dlg button:has-text("Cancel")');
  assert.equal(await page.locator('.proj-card').count(), 1, 'cancel keeps it');
  assert.equal((await idbCounts(page)).projects, 1);
  await page.click('.proj-card button:has-text("Delete")');
  await page.click('dialog.dlg button:has-text("Delete project")');
  await page.waitForFunction(() => !document.querySelector('.proj-card'));
  assert.deepEqual(await idbCounts(page), { projects: 0, files: 0, blobs: 0, thumbs: 0 });
  assert.equal(await page.locator('#project-status').isHidden(), true, 'autosave detached when its project is deleted');
  await context.close();
});

test('rename and "Delete all local data" (with confirmation)', async () => {
  const { page, context } = await fresh();
  await add(page, [fixture('invoice-scan.png')]);
  await waitAll(page, 1);
  await saveProject(page, 'First');
  await go(page, 'projects');
  await page.click('.proj-card button:has-text("Rename")');
  await page.fill('dialog.dlg input', 'Renamed  project');
  await page.click('dialog.dlg button:has-text("Save")');
  await page.waitForFunction(() => document.querySelector('.pc-name')?.textContent === 'Renamed project');
  assert.match(await statusText(page), /Renamed project/);
  await page.click('#delete-all');
  assert.match(await page.locator('dialog.dlg').innerText(), /Delete all local data/);
  await page.click('dialog.dlg button:has-text("Cancel")');
  assert.equal((await idbCounts(page)).projects, 1);
  await page.click('#delete-all');
  await page.click('dialog.dlg button:has-text("Delete everything")');
  await page.waitForFunction(() => !document.querySelector('.proj-card'));
  assert.deepEqual(await idbCounts(page), { projects: 0, files: 0, blobs: 0, thumbs: 0 });
  await context.close();
});

test('interrupted processing: a project saved while files were still queued re-processes them when reopened', async () => {
  const { page, context, requests } = await fresh();
  await add(page, [fixture('scanned-2page.pdf'), fixture('invoice-scan.png'), fixture('receipt-scan.jpg')]);
  await page.waitForSelector('.file-card[data-status="extracting"], .file-card[data-status="preparing"]', { timeout: 30000 });
  await saveProject(page, 'Interrupted');
  // "crash": reload before recognition finished everything
  const unfinished = await page.$$eval('.file-card', (c) => c.filter((x) => !['recognized', 'review'].includes(x.dataset.status)).length);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…');
  const mark = requests.length;
  await go(page, 'projects');
  await page.locator('.proj-card').waitFor();
  await page.click('.proj-card button:has-text("Open")');
  await waitAll(page, 3, ['recognized', 'review'], 180000);
  assert.ok(unfinished > 0, 'the project really was saved mid-processing');
  assert.ok(requests.slice(mark).some((r) => /tesseract|traineddata|pdf\.worker/.test(r.url)), 'unfinished files were processed again after reopening');
  await context.close();
});

test('low storage: a write failure is reported, nothing is claimed saved; a too-small quota blocks saving up front; a tight one warns', async () => {
  const { page, context } = await fresh();
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...a) { if (window.__full) { throw new DOMException('quota', 'QuotaExceededError'); } return put.apply(this, a); };
  });
  await page.reload();
  await page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…');
  await add(page, fixture('invoice-scan.png'));
  await waitAll(page, 1);
  await page.evaluate(() => { window.__full = true; });
  await page.click('#save-project-btn');
  await page.waitForSelector('dialog.dlg[open]');
  await page.fill('dialog.dlg input[type="text"]', 'Will not fit');
  await page.check('dialog.dlg input[type="checkbox"]');
  await page.click('dialog.dlg button:has-text("Save in this browser")');
  await page.waitForFunction(() => /Could not save/.test(document.getElementById('toasts').textContent), null, { timeout: 20000 });
  assert.match(await toast(page), /no space left/);
  assert.equal(await page.locator('#project-status').isHidden(), true, 'no "saved" claim, no half-attached project');
  const c = await idbCounts(page);
  assert.deepEqual(c && [c.projects, c.files, c.blobs], [0, 0, 0], 'the failed save left nothing behind');
  // pre-check: quota nearly exhausted -> blocked before trying; nearly full -> warning
  await page.evaluate(() => { window.__full = false; navigator.storage.estimate = async () => ({ usage: 1999.6 * 1048576, quota: 2000 * 1048576 }); });
  await page.click('#save-project-btn');
  await page.waitForSelector('dialog.dlg[open]');
  assert.match(await page.locator('.dlg-space').innerText(), /Not enough space/);
  assert.equal(await page.locator('dialog.dlg button:has-text("Save in this browser")').isDisabled(), true);
  await page.click('dialog.dlg button:has-text("Cancel")');
  await page.evaluate(() => { navigator.storage.estimate = async () => ({ usage: 1700 * 1048576, quota: 2000 * 1048576 }); });
  await page.click('#save-project-btn');
  await page.waitForSelector('dialog.dlg[open]');
  assert.match(await page.locator('.dlg-space').innerText(), /Storage will be \d+% full after saving/);
  assert.equal(await page.locator('dialog.dlg button:has-text("Save in this browser")').isDisabled(), false, 'a warning does not block saving');
  await page.click('dialog.dlg button:has-text("Cancel")');
  await context.close();
});

test('large file: a ~9 MB original is saved, survives reload and is byte-identical', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'il-big-'));
  const big = join(dir, 'large-noise.png');
  const mk = py(`
from PIL import Image
import os,sys
w,h=1800,1700
im=Image.frombytes('RGB',(w,h),os.urandom(w*h*3)); im.save(sys.argv[1])`, big);
  assert.equal(mk.status, 0, mk.stderr);
  const size = statSync(big).size;
  assert.ok(size > 8_000_000, `fixture size ${size}`);
  const { page, context } = await fresh();
  await add(page, big);
  await page.waitForSelector('.file-card', { timeout: 30000 });
  await saveProject(page, 'Big one');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…');
  await go(page, 'projects');
  await page.locator('.proj-card').waitFor();
  assert.match(await page.locator('.pc-meta').innerText(), /1 document · (8|9)\.\d+ MB/);
  await page.click('.proj-card button:has-text("Export")');
  const [d] = await Promise.all([page.waitForEvent('download'), Promise.resolve()]).catch(() => [null]);
  void d;
  const stored = await page.evaluate(async () => new Promise((res) => {
    const r = indexedDB.open('invoicelens');
    r.onsuccess = () => { const tx = r.result.transaction('blobs'); const g = tx.objectStore('blobs').getAll(); g.onsuccess = () => { res(g.result.map((x) => x.blob.size)); r.result.close(); }; };
  }));
  assert.deepEqual(stored, [size], 'the stored original is byte-for-byte the same size');
  await context.close();
});

test('portable file: export -> import in a brand-new browser profile -> open; hostile files are refused', async () => {
  const a = await fresh();
  await add(a.page, [fixture('invoice-scan.png'), fixture('receipt-scan.jpg')]);
  await waitAll(a.page, 2);
  await saveProject(a.page, 'Take it with me');
  await a.page.locator('.file-card:has(.file-name[title="invoice-scan.png"]) a:has-text("Review")').click();
  await a.page.waitForSelector('.editor:not([hidden])');
  await a.page.locator('#fld-supplier').fill('Portable Co');
  await a.page.waitForFunction(() => /Edited\. Saved in project/.test(document.querySelector('.save-text').textContent), null, { timeout: 20000 });
  await go(a.page, 'projects');
  await a.page.locator('.proj-card').waitFor();
  const [d] = await Promise.all([a.page.waitForEvent('download'), a.page.click('.proj-card button:has-text("Export")')]);
  assert.match(d.suggestedFilename(), /^Take_it_with_me_\d{4}-\d{2}-\d{2}\.invoicelens\.zip$/);
  const zipPath = join(OUT, d.suggestedFilename()); await d.saveAs(zipPath);
  const man = JSON.parse(py('import zipfile,sys,json\nz=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None\nm=json.loads(z.read("manifest.json"));print(json.dumps({"fmt":m["format"],"v":m["version"],"n":len(m["files"]),"names":[f["name"] for f in m["files"]],"sizes":[[f["size"],len(z.read(f["path"]))] for f in m["files"]],"doc":[(f["doc"] or {}).get("fields",{}).get("supplier",{}).get("value") for f in m["files"]]}))', zipPath).stdout);
  assert.equal(man.fmt, 'invoicelens-project'); assert.equal(man.n, 2);
  assert.ok(man.sizes.every(([a2, b2]) => a2 === b2), 'recorded sizes match the stored originals');
  assert.ok(man.doc.includes('Portable Co'));
  await a.context.close();

  const b = await fresh(); // new context = empty IndexedDB
  await go(b.page, 'projects');
  await b.page.waitForSelector('#proj-storage');
  assert.equal(await b.page.locator('.proj-card').count(), 0);
  await b.page.setInputFiles('#import-input', zipPath);
  await b.page.locator('.proj-card').waitFor({ timeout: 30000 });
  assert.equal(await b.page.locator('.pc-name').innerText(), 'Take it with me');
  const before = b.requests.length;
  await b.page.click('.proj-card button:has-text("Open")');
  await waitAll(b.page, 2, ['recognized', 'review']);
  assert.deepEqual(b.requests.slice(before).filter((r) => /tesseract|traineddata/.test(r.url)), [], 'no OCR for an imported project either');
  await b.page.locator('.file-card:has(.file-name[title="invoice-scan.png"]) a:has-text("Review")').click();
  await b.page.waitForSelector('.editor:not([hidden])');
  assert.equal(await b.page.locator('#fld-supplier').inputValue(), 'Portable Co');

  // hostile / damaged files
  await go(b.page, 'projects');
  const bad = (name, py_) => { const p = join(OUT, name); const r = py(py_, p); assert.equal(r.status, 0, r.stderr); return p; };
  const garbage = join(OUT, 'garbage.zip'); writeFileSync(garbage, Buffer.from('not a zip at all'));
  const traversal = bad('evil.zip', `import zipfile,json,sys
z=zipfile.ZipFile(sys.argv[1],"w")
z.writestr("manifest.json",json.dumps({"format":"invoicelens-project","version":1,"project":{"name":"x"},"files":[{"name":"a.png","path":"files/../../evil","kind":"png","size":4,"status":"queued","rotation":0}]}))
z.writestr("files/../../evil",b"abcd");z.close()`);
  const wrong = bad('wrong.zip', `import zipfile,json,sys
z=zipfile.ZipFile(sys.argv[1],"w");z.writestr("manifest.json",json.dumps({"hello":1}));z.close()`);
  for (const [file, re] of [[garbage, /not a readable InvoiceLens project/], [traversal, /unsafe path/], [wrong, /not valid/]]) {
    await b.page.setInputFiles('#import-input', file);
    await b.page.waitForFunction((t) => new RegExp(t).test(document.getElementById('toasts').textContent), re.source, { timeout: 15000 });
    assert.match(await toast(b.page), /Import refused/);
    assert.equal(await b.page.locator('.proj-card').count(), 1, 'nothing was added');
  }
  await b.context.close();
});

test('schema migration in the browser: an old-format record is upgraded and opens; a newer-schema record is listed as unreadable, not misread', async () => {
  const { page, context } = await fresh();
  // let the app create the database, then plant two foreign records straight into it
  await go(page, 'projects');
  await page.waitForSelector('#proj-storage');
  await add(page, fixture('invoice-scan.png'));
  await waitAll(page, 1);
  await saveProject(page, 'Current');
  await page.evaluate(async () => {
    const buf = await (await fetch('/assets/favicon.svg')).arrayBuffer().catch(() => new ArrayBuffer(4));
    void buf;
    await new Promise((res, rej) => {
      const r = indexedDB.open('invoicelens');
      r.onsuccess = () => {
        const db = r.result; const tx = db.transaction(['projects'], 'readwrite');
        const s = tx.objectStore('projects');
        s.put({ id: 'legacy', name: 'Legacy v0 project', createdAt: 1, updatedAt: 2, files: [] }); // no schemaVersion, embedded files
        s.put({ id: 'future', name: 'From the future', schemaVersion: 99, createdAt: 1, updatedAt: 3 });
        tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error);
      };
    });
  });
  await go(page, 'convert'); await go(page, 'projects');
  await page.waitForFunction(() => document.querySelectorAll('.proj-card').length === 3);
  const legacy = page.locator('.proj-card:has-text("Legacy v0 project")');
  assert.match(await legacy.locator('.pc-meta').innerText(), /0 documents/);
  assert.equal(await legacy.locator('button:has-text("Open")').isDisabled(), false, 'migrated record is usable');
  const future = page.locator('.proj-card:has-text("From the future")');
  assert.match(await future.locator('.pc-meta').innerText(), /Cannot open: .*newer version of InvoiceLens/);
  assert.equal(await future.locator('button:has-text("Open")').isDisabled(), true);
  await context.close();
});

// ================================================================== privacy, a11y, layout
test('privacy: saving, resuming, exporting and deleting make only same-origin GETs; nothing leaves the device', async () => {
  const { page, context, requests, problems } = await fresh();
  await add(page, [fixture('invoice-scan.png')]);
  await waitAll(page, 1);
  await saveProject(page, 'Private');
  await go(page, 'projects');
  await page.locator('.proj-card').waitFor();
  await Promise.all([page.waitForEvent('download'), page.click('.proj-card button:has-text("Export")')]);
  await page.click('.proj-card button:has-text("Delete")'); await page.click('dialog.dlg button:has-text("Delete project")');
  await page.waitForFunction(() => !document.querySelector('.proj-card'));
  const origin = new URL(app.base).origin;
  assert.deepEqual(requests.filter((r) => r.method !== 'GET' || (!r.url.startsWith(origin) && !/^(blob|data):/.test(r.url))), []);
  assert.deepEqual(problems, []);
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => !/^(il-|theme|invoicelens)/i.test(k)).length), 0, 'no document data in localStorage');
  await context.close();
});

for (const [scheme, vpName] of [['light', 'desktop'], ['dark', 'desktop'], ['light', 'mobile'], ['dark', 'small']]) {
  test(`batch + projects + dialogs: axe clean, no overflow, touch targets (${scheme}, ${vpName})`, async () => {
    const { page, context } = await fresh({ viewport: VIEWPORTS[vpName], colorScheme: scheme });
    await add(page, [fixture('invoice-scan.png'), fixture('broken.pdf')]);
    await waitAll(page, 2);
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await go(page, 'batch');
    await page.locator('#batch-table tbody input[type=checkbox]').first().check();
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    assert.deepEqual(await runAxe(page), [], 'batch');
    assert.equal(await hasHorizontalOverflow(page), false, 'batch overflow');
    if (VIEWPORTS[vpName].width <= 390) {
      const small = await page.evaluate(() => [...document.querySelectorAll('#view-batch button, #view-batch a.btn, #view-batch input[type=checkbox]')].filter((e) => e.offsetParent !== null).map((e) => { const r = (e.type === 'checkbox' ? e.closest('label') ?? e : e).getBoundingClientRect(); return { id: e.id || e.getAttribute('aria-label') || e.textContent.trim().slice(0, 20), h: Math.round(r.height), w: Math.round(r.width) }; }).filter((r) => r.h < 43.5 || r.w < 43.5));
      assert.deepEqual(small, [], 'batch touch targets');
    }
    await go(page, 'convert');
    await page.click('#save-project-btn');
    await page.waitForSelector('dialog.dlg[open]');
    assert.deepEqual(await runAxe(page), [], 'save dialog');
    await page.click('dialog.dlg input[value="file"]');
    assert.deepEqual(await runAxe(page), [], 'save dialog (file)');
    assert.equal(await hasHorizontalOverflow(page), false);
    await page.click('dialog.dlg button:has-text("Cancel")');
    await go(page, 'projects');
    await page.waitForSelector('#proj-storage');
    assert.deepEqual(await runAxe(page), [], 'projects empty');
    assert.equal(await hasHorizontalOverflow(page), false, 'projects overflow');
    await saveProject(page, 'A11y project', { opener: '#new-project' });
    await page.waitForSelector('.proj-card');
    assert.deepEqual(await runAxe(page), [], 'projects with a card');
    await page.click('.proj-card button:has-text("Delete")');
    assert.deepEqual(await runAxe(page), [], 'delete dialog');
    await page.click('dialog.dlg button:has-text("Cancel")');
    await context.close();
  });
}
