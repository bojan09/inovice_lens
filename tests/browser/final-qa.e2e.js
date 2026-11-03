// Phase 6 final QA: all four export formats over representative samples, keyboard-only journey, hostile file names / text,
// input hardening, visual measurements against the approved design, and a throttled mobile run (numbers are RECORDED, not
// invented: they are written to docs/qa/measured.json by the test run).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, fixture, VIEWPORTS, runAxe, hasHorizontalOverflow } from './helpers.js';
import { parseAmount } from '../../js/money.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
let app;
before(async () => {
  const r = spawnSync('python3', ['-I', 'corpus/make_corpus.py'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  app = await startApp();
});
after(async () => { await app.close(); });
const OUT = mkdtempSync(join(tmpdir(), 'il-e2e-qa-'));
const MEASURED = {};
after(() => { mkdirSync(join(ROOT, 'docs/qa'), { recursive: true }); writeFileSync(join(ROOT, 'docs/qa/measured.json'), JSON.stringify({ measuredAt: new Date().toISOString().slice(0, 10), machine: 'headless Chromium (Playwright) in a cloud container; not a phone', ...MEASURED }, null, 2) + '\n'); });
const py = (code, ...args) => spawnSync('python3', ['-I', '-c', code, ...args], { encoding: 'utf8' });
const corpus = (n) => join(ROOT, 'corpus/docs', n);
const DONE = ['recognized', 'review', 'failed', 'cancelled'];
const waitAll = (page, n, states = DONE, timeout = 150000) => page.waitForFunction(({ n, states }) => {
  const rows = [...document.querySelectorAll('.file-card')];
  return rows.length === n && rows.every((r) => states.includes(r.dataset.status));
}, { n, states }, { timeout });
async function fresh(opts = {}) {
  const ctx = await app.newPage({ acceptDownloads: true, ...opts });
  await ctx.page.goto(app.base);
  await ctx.page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…');
  return ctx;
}
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

// ================================================================== 1. all four export formats, representative samples
const SAMPLES = ['syn-inv-01-a-clean.png', 'syn-inv-02-b-clean.png', 'syn-inv-03-c-photo.jpg', 'syn-inv-04-d-clean.png', 'syn-inv-06-b-photo.jpg', 'syn-rec-25-a-clean.png'];

for (const sample of SAMPLES) {
  test(`export recheck: ${sample} -> PDF, Word, Excel and CSV all re-open and match what the editor shows`, async () => {
    const { page, context } = await fresh();
    await page.setInputFiles('#file-input', corpus(sample));
    await waitAll(page, 1, ['recognized', 'review']);
    await page.locator('.file-card a:has-text("Review")').click();
    await page.waitForSelector('.editor:not([hidden])');
    await page.waitForSelector('.vw-busy[hidden]', { state: 'attached' });
    // what the user sees = the corrected model
    const seen = await page.evaluate(() => ({
      type: document.getElementById('ed-type').value,
      fields: Object.fromEntries([...document.querySelectorAll('.fld[data-key]')].map((r) => [r.dataset.key, r.querySelector('input').value.trim()])),
    }));
    await page.click('#tab-table');
    seen.rows = await page.$$eval('.ed-table tbody tr', (trs) => trs.map((tr) => [...tr.querySelectorAll('input')].map((i) => i.value.trim())));
    assert.ok(seen.fields.total, `a total was read for ${sample}`);
    assert.ok(seen.rows.length >= 1, `line items were read for ${sample}`);

    await page.click('#ed-export'); await page.waitForSelector('.exp[open]');
    const ready = () => page.waitForFunction(() => /^Ready:/.test(document.querySelector('.exp-status').textContent) || document.querySelector('.exp-error').textContent, null, { timeout: 60000 });
    const grab = async (fmt) => {
      await page.check(`#exp-format-${fmt}`); await ready();
      assert.equal(await page.locator('.exp-error').innerText(), '');
      const [d] = await Promise.all([page.waitForEvent('download'), page.click('.exp-actions .btn-primary')]);
      const f = join(OUT, `${Date.now()}-${d.suggestedFilename()}`); await d.saveAs(f); return f;
    };
    const nums = (s) => { const r = parseAmount(s); return r.minor; };

    // PDF (structured): every value is real text in the file
    const pdf = await grab('pdf');
    const txt = norm(spawnSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' }).stdout);
    for (const [k, v] of Object.entries(seen.fields)) if (v) assert.ok(txt.includes(norm(v)), `PDF contains ${k} "${v}"`);
    for (const r of seen.rows) for (const c of r) if (c) assert.ok(txt.includes(norm(c)), `PDF contains cell "${c}"`);

    // Word
    const docx = await grab('docx');
    const dj = JSON.parse(py('import docx,sys,json\nd=docx.Document(sys.argv[1])\nprint(json.dumps([[[c.text for c in r.cells] for r in t.rows] for t in d.tables],ensure_ascii=False))', docx).stdout);
    const details = Object.fromEntries(dj[0].map(([k, v]) => [k, v]));
    for (const [k, v] of Object.entries(seen.fields)) if (v) assert.ok(Object.values(details).includes(v), `Word details contain ${k} "${v}"`);
    assert.deepEqual(dj[1].slice(1).map((r) => r.slice(1)), seen.rows, 'Word line-item table == editor table');

    // Excel: amounts are numbers equal to the parsed text
    const xlsx = await grab('xlsx');
    const xj = JSON.parse(py(`
import openpyxl,sys,json
wb=openpyxl.load_workbook(sys.argv[1]); s=wb['Summary']; i=wb['Line items']
print(json.dumps({'sum':{r[0].value:[r[1].value,r[1].data_type] for r in s.iter_rows(min_row=2)},'items':[[c.value for c in r] for r in i.iter_rows(min_row=2)]},default=str))`, xlsx).stdout);
    const totalCell = xj.sum[seen.type === 'receipt' ? 'Total amount' : 'Total amount'];
    assert.equal(totalCell[1], 'n', 'Total is a numeric cell');
    assert.equal(Math.round(totalCell[0] * 100), nums(seen.fields.total), 'Total cell equals the parsed total');
    assert.equal(xj.items.length, seen.rows.length);
    xj.items.forEach((r, i) => { assert.equal(Math.round(r[4] * 100), nums(seen.rows[i][3]), `row ${i + 1} total is numeric and equal`); assert.equal(r[5], seen.fields.currency || null, 'currency column'); });

    // CSV (Sheets)
    await page.check('#exp-format-csv'); await ready();
    await page.selectOption('#exp-table', 'items'); await ready();
    const [d] = await Promise.all([page.waitForEvent('download'), page.click('.exp-actions .btn-primary')]);
    const f = join(OUT, `${Date.now()}-${d.suggestedFilename()}`); await d.saveAs(f);
    const cj = JSON.parse(py('import csv,sys,json\nprint(json.dumps(list(csv.reader(open(sys.argv[1],encoding="utf-8-sig",newline=""))),ensure_ascii=False))', f).stdout);
    assert.deepEqual(cj[0], ['#', 'Description', 'Qty', 'Unit price', 'Total', 'Currency']);
    // CSV amounts are plain decimals (the editor may show "€33.31" or "33.31 EUR"): same MINOR UNITS, same text elsewhere, currency in its own column
    assert.equal(cj.length - 1, seen.rows.length);
    cj.slice(1).forEach((r, i) => {
      assert.equal(r[1], seen.rows[i][0]); assert.equal(r[2], seen.rows[i][1]);
      assert.equal(parseAmount(r[3]).minor, nums(seen.rows[i][2]), `row ${i + 1} unit price`);
      assert.equal(parseAmount(r[4]).minor, nums(seen.rows[i][3]), `row ${i + 1} total`);
      assert.equal(r[5], seen.fields.currency || '', 'currency column');
    });
    await context.close();
  });
}

// ================================================================== 2. keyboard-only critical journey
test('keyboard only: choose file, review, edit, undo, export and close - every stop shows a focus ring', async () => {
  const { page, context } = await fresh();
  await page.mouse.move(0, 0);
  const ring = () => page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { id: document.activeElement.id || document.activeElement.getAttribute('aria-label') || document.activeElement.textContent.trim().slice(0, 24), style: s.outlineStyle, w: s.outlineWidth, shadow: s.boxShadow }; });
  const visibleFocus = async () => { const r = await ring(); assert.ok((r.style === 'solid' && r.w !== '0px') || r.shadow !== 'none', `visible focus indicator on "${r.id}" (${JSON.stringify(r)})`); return r; };

  // reach "Browse Files" with Tab only, open the chooser with Enter
  let found = false;
  for (let i = 0; i < 25 && !found; i += 1) { await page.keyboard.press('Tab'); found = await page.evaluate(() => document.activeElement.id === 'browse-btn'); }
  assert.ok(found, 'Browse Files is reachable with Tab');
  await visibleFocus();
  // Enter on the focused button must open the file picker. (Headless Chromium does not surface its chooser to Playwright for keyboard-driven
  // opens, so the proof is that the hidden file input received the activation; the file itself is then supplied directly.)
  await page.evaluate(() => { window.__pickerClicks = 0; document.getElementById('file-input').addEventListener('click', () => { window.__pickerClicks += 1; }); });
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.__pickerClicks), 1, 'Enter on "Browse Files" activates the file picker');
  await page.setInputFiles('#file-input', corpus('syn-inv-01-a-clean.png'));
  await waitAll(page, 1, ['recognized', 'review']);
  // Tab to "Review & edit" and activate it
  found = false;
  for (let i = 0; i < 40 && !found; i += 1) { await page.keyboard.press('Tab'); found = await page.evaluate(() => /Review and edit/.test(document.activeElement.getAttribute('aria-label') ?? '')); }
  assert.ok(found, 'Review & edit reachable');
  await visibleFocus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.editor:not([hidden])');
  // into the supplier field, edit, undo with the keyboard
  await page.focus('#fld-supplier');
  await visibleFocus();
  const original = await page.inputValue('#fld-supplier');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Keyboard Only Ltd');
  assert.equal(await page.inputValue('#fld-supplier'), 'Keyboard Only Ltd');
  await page.keyboard.press('Control+z');
  assert.equal(await page.inputValue('#fld-supplier'), original);
  await page.keyboard.press('Control+Shift+z');
  // tabs by arrow keys
  await page.focus('#tab-fields'); await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-table');
  await visibleFocus();
  // open Export with the keyboard
  await page.focus('#ed-export'); await visibleFocus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.exp[open]');
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('.exp')), true, 'focus moved into the dialog');
  await page.focus('#exp-format-docx'); await page.keyboard.press('Space');
  await page.waitForFunction(() => /^Ready:.*\.docx/.test(document.querySelector('.exp-status').textContent), null, { timeout: 60000 });
  await page.focus('.exp-actions .btn-primary'); await visibleFocus();
  const [d] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  assert.match(d.suggestedFilename(), /\.docx$/);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ed-export', 'focus returns to the opener');
  // skip link works
  await page.goto(app.base);
  await page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'skip-link');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => location.hash.length >= 0 && document.activeElement.id), 'main');
  await context.close();
});

// ================================================================== 3. hostile names and text
test('XSS hardening: markup in file names and in recognized text is shown as text everywhere and never executes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'il-xss-'));
  const textImg = join(dir, 'markup-text.png');
  const mk = py(`
from PIL import Image, ImageDraw, ImageFont
import sys
im=Image.new('RGB',(1000,500),'white'); d=ImageDraw.Draw(im)
f=ImageFont.truetype('/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',44)
d.text((40,60),'<img src=x onerror=window.__xss=1>',font=f,fill='black')
d.text((40,160),'Invoice No: <script>alert(1)</script>',font=f,fill='black')
d.text((40,260),'Total EUR 10.00',font=f,fill='black')
im.save(sys.argv[1])`, textImg);
  assert.equal(mk.status, 0, mk.stderr);
  const evil = { name: '"><img src=x onerror=window.__xss=1>.png', mimeType: 'image/png', buffer: readFileSync(corpus('syn-inv-01-a-clean.png')) };
  const { page, context, problems } = await fresh();
  await page.exposeFunction('__alert', () => { throw new Error('alert called'); });
  await page.addInitScript(() => { window.alert = () => { window.__xss = 'alert'; }; });
  await page.setInputFiles('#file-input', [evil, { name: 'markup-text.png', mimeType: 'image/png', buffer: readFileSync(textImg) }]);
  await waitAll(page, 2, ['recognized', 'review']);
  const check = async (where) => assert.equal(await page.evaluate(() => window.__xss), undefined, `no script ran (${where})`);
  await check('convert');
  assert.ok((await page.locator('.file-name').first().innerText()).includes('<img src=x'), 'the name is displayed literally');
  assert.equal(await page.locator('.file-card img[onerror], .file-name img').count(), 0);
  await page.evaluate(() => { location.hash = '#/batch'; }); await page.waitForSelector('#batch-table');
  assert.equal(await page.locator('#batch-table img[src="x"]').count(), 0); await check('batch');
  await page.evaluate(() => { location.hash = '#/convert'; });
  await page.locator('.file-card:has(.file-name[title*="markup-text"]) a:has-text("Review")').click();
  await page.waitForSelector('.editor:not([hidden])');
  await check('editor');
  assert.equal(await page.locator('.editor img[src="x"], .inspector img[src="x"]').count(), 0);
  await page.click('#tab-text');
  assert.ok((await page.locator('#tabpanel-text textarea').first().inputValue()).includes('<'), 'recognized markup is plain text in the editor');
  await page.click('#ed-export'); await page.waitForSelector('.exp[open]');
  await page.waitForFunction(() => /^Ready:/.test(document.querySelector('.exp-status').textContent), null, { timeout: 60000 });
  await check('export dialog');
  const name = await page.locator('.exp-status').innerText();
  assert.doesNotMatch(name, /[<>"]/, 'the export file name is sanitised');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { location.hash = '#/convert'; });
  await page.click('#save-project-btn'); await page.waitForSelector('dialog.dlg[open]');
  await page.fill('dialog.dlg input[type="text"]', '<b onmouseover=window.__xss=1>proj</b>');
  await page.check('dialog.dlg input[type="checkbox"]');
  await page.click('dialog.dlg button:has-text("Save in this browser")');
  await page.waitForFunction(() => /Saved \d/.test(document.getElementById('project-status').textContent), null, { timeout: 30000 });
  await page.evaluate(() => { location.hash = '#/projects'; }); await page.waitForSelector('.proj-card');
  assert.equal(await page.locator('.pc-name b').count(), 0, 'project name is text');
  await page.hover('.pc-name'); await check('projects');
  assert.deepEqual(problems.filter((p) => !/Indexing/.test(p)), [], 'no CSP violations or console errors');
  await context.close();
});

// ================================================================== 4. input hardening
test('input hardening: oversized, truncated, mislabeled and empty files are refused with a reason and the app stays responsive', async () => {
  const { page, context, problems } = await fresh();
  const png = readFileSync(fixture('sample.png'));
  const huge = Buffer.from(png); huge.writeUInt32BE(100000, 16); huge.writeUInt32BE(100000, 20); // IHDR claims 100000 x 100000 px
  await page.setInputFiles('#file-input', [
    { name: 'bomb.png', mimeType: 'image/png', buffer: huge },
    { name: 'truncated.png', mimeType: 'image/png', buffer: png.subarray(0, 30) },
    { name: 'program.png', mimeType: 'image/png', buffer: Buffer.from('MZ\x90\x00 this is an executable pretending to be a picture') },
    { name: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    { name: 'script.js.png', mimeType: 'image/png', buffer: Buffer.from('<script>alert(1)</script>') },
  ]);
  await page.waitForFunction(() => document.querySelectorAll('.reject-card').length >= 5);
  const msgs = await page.$$eval('.reject-card', (c) => c.map((x) => x.innerText.replace(/\s+/g, ' ')));
  assert.equal(await page.locator('.file-card').count() <= 1, true);
  assert.ok(msgs.every((m) => /Not accepted:/.test(m)), `every refusal carries a reason: ${msgs.join(' | ')}`);
  assert.ok(msgs.some((m) => /bomb\.png.*100000 × 100000 px.*over the 100 MP limit/.test(m)), `pixel-bomb refused: ${msgs.join(' | ')}`);
  // the app is still fully usable afterwards
  await page.setInputFiles('#file-input', fixture('invoice-scan.png'));
  await page.waitForFunction(() => [...document.querySelectorAll('.file-card')].some((c) => ['recognized', 'review'].includes(c.dataset.status)), null, { timeout: 90000 });
  assert.deepEqual(problems, []);
  await context.close();
});

// ================================================================== 5. visual measurements vs the approved design (docs/visual-checklist.md)
for (const scheme of ['light', 'dark']) {
  test(`visual parity (${scheme}): measured geometry and tokens match the approved reference where it specifies numbers`, async () => {
    const { page, context } = await fresh({ colorScheme: scheme, viewport: VIEWPORTS.desktop });
    const m = await page.evaluate(() => {
      const r = (s) => document.querySelector(s)?.getBoundingClientRect();
      const css = (s, p) => getComputedStyle(document.querySelector(s))[p];
      return {
        sidebarW: r('.sidebar').width, headerH: r('.topbar').height, navItemH: r('.nav-link').height, searchH: r('.search').height,
        meterH: r('#storage-meter')?.height ?? null, btnH: r('#browse-btn').height, btnRadius: css('#browse-btn', 'borderTopLeftRadius'),
        accent: css('#browse-btn', 'backgroundColor'), bodyBg: css('body', 'backgroundColor'), font: css('body', 'fontFamily').split(',')[0],
        heroSize: css('.hero-title', 'fontSize'), dzBorder: css('#dropzone', 'borderTopStyle'),
      };
    });
    assert.equal(m.sidebarW, 200, 'sidebar 200px'); assert.equal(m.headerH, 56, 'header 56px'); assert.equal(m.navItemH, 40, 'nav item 40px');
    assert.equal(m.btnH, 32, 'button 32px'); assert.equal(m.btnRadius, '6px'); assert.equal(m.heroSize, '32px'); assert.equal(m.dzBorder, 'dashed');
    assert.equal(m.accent, scheme === 'dark' ? 'rgb(31, 107, 255)' : 'rgb(30, 104, 252)');
    assert.equal(m.bodyBg, scheme === 'dark' ? 'rgb(13, 21, 30)' : 'rgb(245, 249, 252)');
    // editor proportions
    await page.setInputFiles('#file-input', fixture('invoice-scan.png'));
    await waitAll(page, 1, ['recognized', 'review']);
    await page.locator('.file-card a:has-text("Review")').click();
    await page.waitForSelector('.editor:not([hidden])');
    const e = await page.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); return { rail: r('.rail').width, panel: r('.inspector').width, input: r('#fld-supplier').height, tab: getComputedStyle(document.querySelector('#tab-fields')).borderBottomWidth, chip: getComputedStyle(document.querySelector('#ed-type-chip')).backgroundColor }; });
    assert.ok(Math.abs(e.rail - 104) <= 1); assert.ok(Math.abs(e.panel - 340) <= 1); assert.equal(e.input, 40); assert.equal(e.tab, '2px');
    MEASURED[`visualParity_${scheme}`] = { sidebarPx: m.sidebarW, headerPx: m.headerH, navItemPx: m.navItemH, buttonPx: m.btnH, editorRailPx: e.rail, editorPanelPx: e.panel, inputPx: e.input, accent: m.accent, background: m.bodyBg };
    await context.close();
  });
}

// ================================================================== 6. throttled mobile run (4x CPU, slow 4G): measured, recorded
test('throttled mobile (4x CPU slowdown, ~1.6 Mbit/s): the core journey completes; timings are recorded', async () => {
  const { page, context } = await fresh({ viewport: VIEWPORTS.mobile, hasTouch: true, isMobile: true });
  const cdp = await context.newCDPSession(page);
  await page.evaluate(() => { window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  const t = {};
  const t0 = Date.now();
  await page.setInputFiles('#file-input', corpus('syn-inv-03-c-photo.jpg'));
  await waitAll(page, 1, ['recognized', 'review'], 240000);
  t.recognizeColdMs = Date.now() - t0; // includes downloading ~7 MB of OCR files over the throttled network on first use
  const t1 = Date.now();
  await page.setInputFiles('#file-input', corpus('syn-rec-25-a-clean.png'));
  await page.waitForFunction(() => document.querySelectorAll('.file-card').length === 2 && [...document.querySelectorAll('.file-card')].every((c) => ['recognized', 'review'].includes(c.dataset.status)), null, { timeout: 240000 });
  t.recognizeWarmMs = Date.now() - t1;
  await page.evaluate(() => { location.hash = '#/editor/f1'; });
  const t2 = Date.now();
  await page.waitForSelector('.editor:not([hidden])'); await page.waitForSelector('.vw-busy[hidden]', { state: 'attached' });
  t.openEditorMs = Date.now() - t2;
  await page.click('#pane-tab-edit');
  const t3 = Date.now();
  await page.fill('#fld-supplier', 'Throttled Co');
  t.typeMs = Date.now() - t3;
  await page.click('#ed-export'); await page.waitForSelector('.exp[open]');
  const t4 = Date.now();
  await page.waitForFunction(() => /^Ready:/.test(document.querySelector('.exp-status').textContent), null, { timeout: 120000 });
  t.firstExportReadyMs = Date.now() - t4;
  const long = await page.evaluate(() => window.__long);
  t.longTasksOver200ms = long.filter((d) => d > 200).length; t.longestTaskMs = Math.max(0, ...long);
  MEASURED.throttledMobile = { cpuSlowdown: 4, network: '1.6 Mbit/s down, 150 ms latency', viewport: '390x844 touch', caveat: 'CDP CPU throttling slows the MAIN thread only. OCR runs in a Web Worker and OCR files may come from the service-worker cache, so recognition times here are NOT a phone estimate; the main-thread figures (open editor, typing, long tasks) are the meaningful ones.', ...t };
  assert.ok(t.recognizeColdMs < 240000 && t.recognizeWarmMs < 120000, JSON.stringify(t));
  assert.ok(t.typeMs < 3000, `typing stays responsive under throttling (${t.typeMs} ms)`);
  await context.close();
});
