// Phase 4 end-to-end: real recognition -> editor -> export dialog -> real downloads, re-opened with independent
// tools (poppler, python-docx, openpyxl, LibreOffice, python zipfile) and compared with the user's corrected values.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp, fixture, VIEWPORTS, runAxe, hasHorizontalOverflow } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const OUT = mkdtempSync(join(tmpdir(), 'il-e2e-export-'));
const py = (code, ...args) => spawnSync('python3', ['-I', '-c', code, ...args], { encoding: 'utf8' });
const card = (page, name) => page.locator(`.file-card:has(.file-name[title="${name}"])`);

async function recognized(opts, files) {
  const ctx = await app.newPage({ acceptDownloads: true, ...opts });
  const { page } = ctx;
  await page.goto(app.base);
  await page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…');
  await page.setInputFiles('#file-input', [].concat(files));
  await page.waitForFunction((n) => {
    const cs = [...document.querySelectorAll('.file-card')];
    return cs.length === n && cs.every((c) => ['recognized', 'review'].includes(c.dataset.status));
  }, [].concat(files).length, { timeout: 150000 });
  return ctx;
}
async function openEditor(page, name) {
  await card(page, name).locator('a:has-text("Review")').click();
  await page.waitForSelector('.editor:not([hidden])');
  await page.waitForSelector('.vw-busy[hidden]', { state: 'attached' });
}
const setField = (page, key, v) => page.locator(`#fld-${key}`).fill(v);
async function openExport(page, via = '#ed-export') {
  await page.click(via);
  await page.waitForSelector('.exp[open]');
  await ready(page);
}
async function ready(page, timeout = 60000) {
  await page.waitForFunction(() => /^Ready:/.test(document.querySelector('.exp-status').textContent) || document.querySelector('.exp-error').textContent, null, { timeout });
  const err = await page.locator('.exp-error').innerText();
  assert.equal(err, '', `export error: ${err}`);
}
const pick = async (page, group, value) => { await page.check(`#exp-${group}-${value}`); await ready(page); };
async function download(page) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.exp-actions .btn-primary')]);
  const path = join(OUT, `${Date.now()}-${dl.suggestedFilename()}`);
  await dl.saveAs(path);
  return { path, name: dl.suggestedFilename() };
}
const pdftotext = (f, ...a) => spawnSync('pdftotext', [...a, f, '-'], { encoding: 'utf8' }).stdout;
const pdfinfo = (f, ...a) => spawnSync('pdfinfo', [...a, f], { encoding: 'utf8' }).stdout;
const numbers = (n) => Number(n);

// ------------------------------------------------------------------ entry points + dialog basics
test('Export on Convert is disabled until something is recognized, then names the file count', async () => {
  const ctx = await app.newPage({});
  const { page } = ctx;
  await page.goto(app.base);
  await page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…');
  await page.setInputFiles('#file-input', [fixture('invoice-scan.png'), fixture('receipt-scan.jpg')]);
  assert.equal(await page.locator('#convert-btn').isDisabled(), true, 'nothing recognized yet: no fake export');
  await page.waitForFunction(() => document.querySelectorAll('.file-card[data-status="recognized"], .file-card[data-status="review"]').length === 2, null, { timeout: 120000 });
  assert.equal(await page.locator('#convert-btn').isDisabled(), false);
  assert.equal(await page.locator('#convert-btn').innerText(), 'Export 2 files…');
  await ctx.context.close();
});

test('structured PDF from the editor carries the user\'s EDITS; preview is the real generated PDF; download works', async () => {
  const { page, context, problems, requests } = await recognized({}, fixture('invoice-scan.png'));
  await openEditor(page, 'invoice-scan.png');
  await setField(page, 'supplier', 'Müller & Söhne GmbH');
  await setField(page, 'number', 'EDIT-777');
  await openExport(page);
  assert.equal(await page.locator('#exp-format-pdf').isChecked(), true);
  assert.equal(await page.locator('#exp-mode-structured').isChecked(), true);
  const status = await page.locator('.exp-status').innerText();
  assert.match(status, /Ready: invoice-scan_structured\.pdf \(\d/);
  // the preview is the generated file rendered by pdf.js: drawn, with ink
  await page.waitForFunction(() => document.querySelector('.exp-pv-canvas')?.width > 100);
  const ink = await page.$eval('.exp-pv-canvas', (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let k = 0; for (let i = 0; i < d.length; i += 16) if (d[i] < 100) k += 1; return k; });
  assert.ok(ink > 200, `preview drawn (${ink})`);
  await page.waitForFunction(() => /\d+ pages?, [\d.]+ KB/.test(document.querySelector('.exp-preview').textContent));
  const { path, name } = await download(page);
  assert.equal(name, 'invoice-scan_structured.pdf');
  assert.match(await page.locator('.exp-status').innerText(), /Downloaded invoice-scan_structured\.pdf/);
  const text = pdftotext(path, '-layout');
  for (const must of ['Müller & Söhne GmbH', 'EDIT-777', '2026-11-03', 'Product A', '160.00', '245.00']) assert.ok(text.includes(must), `PDF contains ${must}`);
  assert.ok(!text.includes('ACME Supplies Check'), 'old supplier text is not left in the details');
  assert.match(pdfinfo(path), /Producer:\s+InvoiceLens/);
  const origin = new URL(app.base).origin;
  assert.deepEqual(requests.filter((r) => r.method !== 'GET' || (!r.url.startsWith(origin) && !/^(blob|data):/.test(r.url))), [], 'export makes no external or non-GET request');
  assert.deepEqual(problems, []);
  await context.close();
});

test('original-appearance PDF: images in the editor\'s page order/rotation, page selection, searchable layer on/off', async () => {
  const { page, context } = await recognized({}, fixture('invoice-text.pdf'));
  await openEditor(page, 'invoice-text.pdf');
  // make page 2 the first page, and rotate it
  await page.click('[aria-label="Next page"]');
  await page.click('[aria-label="Move page earlier"]');
  await page.click('[aria-label="Rotate page 90 degrees clockwise"]');
  await page.waitForFunction(() => document.querySelector('.vw-canvas').width > document.querySelector('.vw-canvas').height);
  await openExport(page);
  await pick(page, 'mode', 'original');
  assert.match(await page.locator('.exp-status').innerText(), /_original\.pdf/);
  let { path } = await download(page);
  const info = pdfinfo(path, '-f', '1', '-l', '2');
  assert.match(info, /Pages:\s+2/);
  const sizes = [...info.matchAll(/Page\s+(\d) size:\s+([\d.]+) x ([\d.]+) pts/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  assert.ok(sizes[0][1] > sizes[0][2], `first page (the rotated one) is landscape ${sizes[0]}`);
  assert.ok(sizes[1][1] < sizes[1][2], `second page is portrait ${sizes[1]}`);
  const images = spawnSync('pdfimages', ['-list', path], { encoding: 'utf8' }).stdout.split('\n').filter((l) => /^\s*\d+\s+\d+\s+image/.test(l));
  assert.equal(images.length, 2, 'one image per page');
  const p1 = pdftotext(path, '-f', '1', '-l', '1');
  const p2 = pdftotext(path, '-f', '2', '-l', '2');
  const expect1 = await (async () => pdftotext(fixture('invoice-text.pdf'), '-f', '2', '-l', '2'))();
  const w = (s) => s.replace(/\s+/g, ' ').trim().split(' ').filter((x) => x.length > 3).slice(0, 4);
  for (const word of w(expect1)) assert.ok(p1.includes(word), `text layer of exported page 1 comes from ORIGINAL page 2 ("${word}")`);
  assert.ok(p2.includes('INV-00482'), 'original page 1 is now second');
  // searchable layer off: no text at all
  await page.uncheck('#exp-layer'); await ready(page);
  ({ path } = await download(page));
  assert.equal(pdftotext(path).trim(), '', 'no text layer when it is switched off');
  // only page 2 of the editor's order
  await page.check('#exp-layer'); await ready(page);
  await page.uncheck('#exp-page-0'); await ready(page);
  ({ path } = await download(page));
  assert.match(pdfinfo(path), /Pages:\s+1\b/);
  assert.match(await page.locator('.exp-warn').innerText(), /words as recognized, not your edits/);
  await context.close();
});

test('Word: editable document with the corrected values; python-docx and LibreOffice open it', async () => {
  const { page, context } = await recognized({}, fixture('invoice-scan.png'));
  await openEditor(page, 'invoice-scan.png');
  await setField(page, 'customer', 'Edited Customer “Ltd”');
  await page.click('#tab-table');
  await page.locator('.ed-table tbody tr').first().locator('input').nth(0).fill('Edited product');
  await openExport(page);
  await pick(page, 'format', 'docx');
  assert.match(await page.locator('.exp-preview').innerText(), /Content preview/);
  assert.match(await page.locator('.exp-preview').innerText(), /Edited Customer/);
  const { path, name } = await download(page);
  assert.equal(name, 'invoice-scan.docx');
  const o = JSON.parse(py('import docx,sys,json\nd=docx.Document(sys.argv[1])\nprint(json.dumps([[[c.text for c in r.cells] for r in t.rows] for t in d.tables],ensure_ascii=False))', path).stdout);
  assert.equal(Object.fromEntries(o[0])['Customer'], 'Edited Customer “Ltd”');
  assert.deepEqual(o[1][1], ['1', 'Edited product', '2', '80.00', '160.00']);
  const conv = spawnSync('soffice', ['--headless', '--convert-to', 'txt:Text', '--outdir', OUT, path], { encoding: 'utf8', timeout: 120000 });
  assert.equal(conv.status, 0);
  assert.match(readFileSync(path.replace(/\.docx$/, '.txt'), 'utf8'), /Edited product/);
  await context.close();
});

test('Excel: amounts are numeric cells matching the corrected values (not text)', async () => {
  const { page, context } = await recognized({}, fixture('invoice-scan.png'));
  await openEditor(page, 'invoice-scan.png');
  await setField(page, 'subtotal', '1,234.50'); await setField(page, 'tax', '0.00'); await setField(page, 'total', 'EUR 1,234.50');
  await openExport(page);
  await pick(page, 'format', 'xlsx');
  assert.match(await page.locator('.exp-preview').innerText(), /Sheet: Summary/);
  const { path } = await download(page);
  const o = JSON.parse(py(`
import openpyxl,sys,json
wb=openpyxl.load_workbook(sys.argv[1]); s=wb['Summary']
d={r[0].value:[r[1].value,r[1].data_type] for r in s.iter_rows(min_row=2)}
i=wb['Line items']
print(json.dumps({'sheets':wb.sheetnames,'sum':d,'items':[[c.value for c in r] for r in i.iter_rows(min_row=2)]},default=str))`, path).stdout);
  assert.deepEqual(o.sum['Total amount'], [1234.5, 'n']);
  assert.deepEqual(o.sum['Subtotal'], [1234.5, 'n']);
  assert.equal(o.sum['Currency'][0], 'EUR');
  assert.deepEqual(o.items, [[1, 'Product A', 2, 80, 160], [2, 'Product B', 1, 85, 85]]);
  await context.close();
});

test('Google Sheets: CSV download (BOM, exact decimals) and "Copy for pasting" put tab-separated cells on the clipboard', async () => {
  const { page, context } = await recognized({ permissions: ['clipboard-read', 'clipboard-write'] }, fixture('invoice-scan.png'));
  await openEditor(page, 'invoice-scan.png');
  await openExport(page);
  await pick(page, 'format', 'csv');
  assert.match(await page.locator('.opt-help:has-text("No Google account access")').innerText(), /File > Import/);
  assert.equal(await page.locator('#exp-table').inputValue(), 'items');
  const { path, name } = await download(page);
  assert.equal(name, 'invoice-scan_line_items.csv');
  const bytes = readFileSync(path);
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.toString('utf8').slice(1), '#,Description,Qty,Unit price,Total\r\n1,Product A,2,80.00,160.00\r\n2,Product B,1,85.00,85.00\r\n');
  await page.selectOption('#exp-table', 'summary'); await ready(page);
  await page.click('button:has-text("Copy for pasting")');
  await page.waitForFunction(() => /Copied/.test(document.querySelector('.exp-status').textContent));
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clip, /^Field\tValue\nSupplier\tACME Supplies\n/);
  assert.match(clip, /\nTotal amount\t245\.00/);
  await context.close();
});

test('unsupported combinations are explained and disabled; switching format falls back to a supported mode', async () => {
  const { page, context } = await recognized({}, fixture('invoice-scan.png'));
  await openEditor(page, 'invoice-scan.png');
  await openExport(page);
  await pick(page, 'mode', 'original');
  await pick(page, 'format', 'xlsx');
  assert.equal(await page.locator('#exp-mode-original').isDisabled(), true);
  assert.equal(await page.locator('#exp-mode-structured').isChecked(), true, 'fell back to structured');
  assert.match(await page.locator('#exp-mode-original-h').innerText(), /cannot reproduce a scanned page faithfully\. Use PDF/);
  await pick(page, 'format', 'pdf');
  assert.equal(await page.locator('#exp-mode-original').isDisabled(), false);
  await context.close();
});

test('cancel mid-way stops the work; an encoding failure shows a clear error; both leave the dialog usable', async () => {
  const { page, context } = await recognized({}, fixture('invoice-text.pdf'));
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.toBlob;
    window.__slow = 0; window.__fail = false;
    HTMLCanvasElement.prototype.toBlob = function (cb, ...a) { if (window.__fail) { cb(null); return; } setTimeout(() => orig.call(this, cb, ...a), window.__slow); };
  });
  await page.reload();
  await page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…');
  await page.setInputFiles('#file-input', fixture('invoice-text.pdf'));
  await page.waitForSelector('.file-card[data-status="recognized"]', { timeout: 60000 });
  await openEditor(page, 'invoice-text.pdf');
  await openExport(page);
  await page.evaluate(() => { window.__slow = 1500; });
  await page.check('#exp-mode-original');
  await page.waitForFunction(() => /Rendering page/.test(document.querySelector('.exp-status').textContent), null, { timeout: 10000 });
  assert.equal(await page.locator('.exp-actions .btn-primary').isDisabled(), true, 'no download while generating');
  assert.equal(await page.locator('.exp-meter').isVisible(), true, 'real progress bar while rendering pages');
  await page.click('.exp-actions .btn-secondary:has-text("Cancel")');
  assert.equal(await page.locator('.exp-status').innerText(), 'Cancelled.');
  assert.equal(await page.locator('.exp-actions .btn-primary').isDisabled(), true);
  await page.waitForTimeout(2500);
  assert.equal(await page.locator('.exp-status').innerText(), 'Cancelled.', 'a cancelled run does not finish later');
  // failure path
  await page.evaluate(() => { window.__slow = 0; window.__fail = true; });
  await page.uncheck('#exp-layer');
  await page.waitForFunction(() => document.querySelector('.exp-error').textContent, null, { timeout: 15000 });
  assert.match(await page.locator('.exp-error').innerText(), /Export failed: Could not encode the page image/);
  assert.equal(await page.locator('.exp-actions .btn-primary').isDisabled(), true);
  // recover
  await page.evaluate(() => { window.__fail = false; });
  await page.check('#exp-layer');
  await ready(page);
  assert.equal(await page.locator('.exp-actions .btn-primary').isDisabled(), false);
  await context.close();
});

test('several files: bundled into one ZIP with one export per file; names are safe and unique', async () => {
  // (a non-ASCII file PATH is not delivered by Playwright in this environment, so the name is supplied with the bytes)
  const weird = { name: 'weird name é #1.png', mimeType: 'image/png', buffer: readFileSync(fixture('invoice-scan.png')) };
  const receipt = { name: 'receipt-scan.jpg', mimeType: 'image/jpeg', buffer: readFileSync(fixture('receipt-scan.jpg')) };
  const { page, context } = await recognized({}, [weird, receipt]);
  await page.click('#convert-btn');
  await page.waitForSelector('.exp[open]');
  await ready(page);
  assert.match(await page.locator('.exp-foot-msg .exp-status').innerText(), /invoicelens-export-\d{4}-\d{2}-\d{2}\.zip/);
  assert.match(await page.locator('.exp-controls').innerText(), /Several files are bundled into one ZIP/);
  assert.equal(await page.locator('#exp-name').count(), 1);
  await pick(page, 'format', 'xlsx');
  assert.match(await page.locator('.exp-preview').innerText(), /Showing the first of 2 files/);
  const { path, name } = await download(page);
  assert.match(name, /^invoicelens-export-.*\.zip$/);
  const o = JSON.parse(py(`
import zipfile,sys,json,io,openpyxl
z=zipfile.ZipFile(sys.argv[1]); out={'bad':z.testzip(),'names':z.namelist(),'totals':{}}
for n in z.namelist():
    wb=openpyxl.load_workbook(io.BytesIO(z.read(n)))
    s=wb['Summary']; d={r[0].value:r[1].value for r in s.iter_rows(min_row=2)}
    out['totals'][n]=[d.get('Total amount'), d.get('Supplier')]
print(json.dumps(out,default=str))`, path).stdout);
  assert.equal(o.bad, null);
  assert.deepEqual(o.names.sort(), ['receipt-scan.xlsx', 'weird_name_e_1.xlsx']);
  assert.equal(o.totals['weird_name_e_1.xlsx'][1], 'ACME Supplies');
  assert.equal(numbers(o.totals['receipt-scan.xlsx'][0]), 8.7);
  // unticking one file leaves a single, directly downloadable file
  await page.uncheck(`#exp-file-${await page.locator('.exp-controls input[type=checkbox]').first().getAttribute('id').then((i) => i.replace('exp-file-', ''))}`);
  await ready(page);
  assert.match(await page.locator('.exp-status').innerText(), /Ready: receipt-scan\.xlsx/);
  await context.close();
});

// ------------------------------------------------------------------ accessibility, focus, layout, themes
for (const [scheme, vpName] of [['light', 'desktop'], ['dark', 'desktop'], ['light', 'mobile'], ['dark', 'small']]) {
  test(`export dialog: axe clean, focus kept inside and returned, no overflow (${scheme}, ${vpName})`, async () => {
    const { page, context } = await recognized({ viewport: VIEWPORTS[vpName], colorScheme: scheme }, fixture('invoice-scan.png'));
    await openEditor(page, 'invoice-scan.png');
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await page.click('#ed-export');
    await page.waitForSelector('.exp[open]');
    await ready(page);
    for (const [group, value] of [['format', 'pdf'], ['mode', 'original'], ['format', 'xlsx'], ['format', 'csv'], ['format', 'docx']]) {
      await pick(page, group, value);
      const v = await runAxe(page);
      assert.deepEqual(v, [], `${group}=${value}: ${JSON.stringify(v)}`);
    }
    assert.equal(await hasHorizontalOverflow(page), false);
    const box = await page.locator('.exp').boundingBox();
    assert.ok(box.x >= -1 && box.x + box.width <= VIEWPORTS[vpName].width + 1, 'dialog fits the viewport');
    // focus stays inside the modal while tabbing around
    await page.focus('#exp-format-pdf');
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => !!document.activeElement.closest('.exp') || document.activeElement === document.body), true, `focus reached page content behind the modal after ${i + 1} tabs`);
    }
    if (VIEWPORTS[vpName].width <= 390) {
      const small = await page.evaluate(() => [...document.querySelectorAll('.exp button, .exp select, .exp input[type=text]')].filter((e) => e.offsetParent !== null).map((e) => ({ id: e.id || e.textContent.trim(), h: Math.round(e.getBoundingClientRect().height) })).filter((r) => r.h < 43.5));
      assert.deepEqual(small, [], 'touch targets >= 44px');
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.exp[open]').count(), 0, 'Esc closes');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'ed-export', 'focus returns to the button that opened it');
    await context.close();
  });
}
