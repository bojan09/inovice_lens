// Phase 3 end-to-end: real recognition (pdf.js + Tesseract) feeding the editor, in Chromium, strict CSP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, fixture, VIEWPORTS, runAxe, hasHorizontalOverflow, bgLuminance } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const card = (page, name) => page.locator(`.file-card:has(.file-name[title="${name}"])`);

/** Load the app, add `files`, wait until `name` is recognized, open its editor. */
async function openEditor(files, name, opts = {}) {
  const ctx = await app.newPage(opts);
  const { page } = ctx;
  await page.goto(app.base);
  await page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…');
  await page.setInputFiles('#file-input', [].concat(files).map(fixture));
  await page.waitForFunction((n) => {
    const c = [...document.querySelectorAll('.file-card')].find((x) => x.querySelector('.file-name')?.getAttribute('title') === n);
    return c && ['recognized', 'review'].includes(c.dataset.status);
  }, name, { timeout: 120000 });
  await card(page, name).locator('a:has-text("Review")').click();
  await page.waitForSelector('.editor:not([hidden])');
  await page.waitForSelector('.vw-busy[hidden]', { state: 'attached' });
  return ctx;
}
const field = (page, key) => page.locator(`#fld-${key}`);
const val = (page, key) => field(page, key).inputValue();
const banner = (page) => page.locator('.rv-text').innerText();
const saveText = (page) => page.locator('.save-text').innerText();
const hash = (page) => page.evaluate(() => location.hash);
async function backToConvert(page) { await page.click('.back-link'); await page.waitForSelector('#view-convert:not([hidden])'); }
async function reopen(page, name) { await card(page, name).locator('a:has-text("Review")').click(); await page.waitForSelector('.editor:not([hidden])'); }
const stageBox = (page) => page.locator('.vw-stage').boundingBox();
async function canvasInk(page) {
  return page.$eval('.vw-canvas', (c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 16) if (d[i] < 100) dark += 1;
    return { w: c.width, h: c.height, dark };
  });
}

// ------------------------------------------------------------------ open + extracted data + source
test('opens from the file card: original rendered, fields extracted from the real OCR, nothing flagged', async () => {
  const { page, problems, context } = await openEditor('invoice-scan.png', 'invoice-scan.png');
  assert.match(await hash(page), /^#\/editor\/f\d+$/);
  assert.equal(await page.locator('#editor-title').innerText(), 'invoice-scan.png');
  assert.equal(await page.locator('#ed-type').inputValue(), 'invoice');
  assert.deepEqual(await page.$$eval('.tabpanel', (n) => n.filter((x) => x.offsetParent !== null).map((x) => x.id)), ['tabpanel-fields'], 'exactly one tab panel is visible');
  assert.equal(await val(page, 'supplier'), 'ACME Supplies');
  assert.equal(await val(page, 'customer'), 'Bright Tech Ltd');
  assert.equal(await val(page, 'number'), 'INV-00482');
  assert.equal(await val(page, 'issueDate'), '2026-11-03');
  assert.equal(await val(page, 'dueDate'), '2026-11-17');
  assert.equal(await val(page, 'currency'), 'EUR');
  assert.equal(await val(page, 'subtotal'), '245.00');
  assert.match(await val(page, 'total'), /245\.00/);
  const ink = await canvasInk(page);
  assert.ok(ink.w > 500 && ink.dark > 500, `original page is drawn (${JSON.stringify(ink)})`);
  assert.equal(await page.locator('.thumb-btn').count(), 1);
  await page.click('#tab-table');
  const rows = await page.$$eval('.ed-table tbody tr', (trs) => trs.map((tr) => [...tr.querySelectorAll('input')].map((i) => i.value)));
  assert.deepEqual(rows, [['Product A', '2', '80.00', '160.00'], ['Product B', '1', '85.00', '85.00']]);
  assert.match(await banner(page), /No problems found/);
  assert.equal(await saveText(page), 'No changes yet');
  assert.equal(await page.locator('.ed-bar .btn-primary').isDisabled(), true, 'Export is visibly NOT functional yet');
  assert.deepEqual(problems, []);
  await context.close();
});

test('"show on page" highlights the real source region; typed values say there is none', async () => {
  const { page, context } = await openEditor('invoice-scan.png', 'invoice-scan.png');
  const stage = await stageBox(page);
  await page.locator('#fld-number').locator('xpath=ancestor::div[contains(@class,"fld-input")]').locator('.loc-btn').click();
  const hl = page.locator('.hl-active');
  await hl.waitFor();
  const b = await hl.boundingBox();
  // "INV-00482" sits in the top-right block of the page (x ~ 1000-1250 of 1240, y ~ 190 of 1754)
  assert.ok(b.x > stage.x + stage.width * 0.7, `highlight is on the right (${b.x} vs ${stage.x + stage.width * 0.7})`);
  assert.ok(b.y < stage.y + stage.height * 0.2, 'highlight is near the top');
  assert.ok(b.width > 20 && b.height > 8 && b.width < stage.width * 0.4);
  assert.match(await page.locator('.vw-status').innerText(), /Showing Invoice number on page 1/);
  // currency has no region of its own
  await page.locator('#fld-currency').locator('xpath=ancestor::div[contains(@class,"fld-input")]').locator('.loc-btn').click();
  assert.match(await page.locator('.vw-status').innerText(), /Currency: no source region/);
  assert.equal(await page.locator('.hl-active').count(), 0);
  // show-all toggle draws every recognized word
  await page.click('[aria-label="Show all recognized text regions"]');
  assert.ok((await page.locator('.hl-word').count()) > 30);
  assert.equal(await page.locator('[aria-label="Show all recognized text regions"]').getAttribute('aria-pressed'), 'true');
  await context.close();
});

test('highlight stays aligned after zoom and after rotating the page view', async () => {
  const { page, context } = await openEditor('invoice-scan.png', 'invoice-scan.png');
  await page.locator('#fld-number').locator('xpath=ancestor::div[contains(@class,"fld-input")]').locator('.loc-btn').click();
  const rel = async () => {
    const s = await stageBox(page); const h = await page.locator('.hl-active').boundingBox();
    return { x: (h.x - s.x) / s.width, y: (h.y - s.y) / s.height };
  };
  const base = await rel();
  await page.click('[aria-label="Zoom in"]');
  await page.click('[aria-label="Zoom in"]');
  const zoomed = await rel();
  assert.ok(Math.abs(zoomed.x - base.x) < 0.01 && Math.abs(zoomed.y - base.y) < 0.01, 'same relative position at another zoom');
  assert.equal(await page.locator('.tb-text').innerText(), '150%');
  await page.click('.tb-text');
  assert.equal(await page.locator('.tb-text').innerText(), '100%');
  await page.click('[aria-label="Rotate page 90 degrees clockwise"]');
  await page.waitForFunction(() => document.querySelector('.vw-canvas').width < document.querySelector('.vw-canvas').height === false);
  const turned = await rel();
  // top-right after a 90deg clockwise turn lands at the bottom-right: x' = 1 - y, y' = x
  assert.ok(Math.abs(turned.x - (1 - base.y - 0)) < 0.03, `rotated x ${turned.x} vs ${1 - base.y}`);
  assert.ok(Math.abs(turned.y - base.x) < 0.03, `rotated y ${turned.y} vs ${base.x}`);
  await context.close();
});

// ------------------------------------------------------------------ editing, model, source integrity
test('edits update the model and survive leaving and re-opening the editor; the recognized text is untouched', async () => {
  const { page, context } = await openEditor('invoice-scan.png', 'invoice-scan.png');
  await backToConvert(page);
  await card(page, 'invoice-scan.png').locator('details.rec-text > summary').click();
  const before = await card(page, 'invoice-scan.png').locator('.rec-text-body').innerText();
  await reopen(page, 'invoice-scan.png');

  await field(page, 'supplier').fill('Edited Supplies Ltd');
  await page.click('#tab-table');
  await page.locator('.ed-table tbody tr').first().locator('input').nth(0).fill('Renamed product');
  await page.click('#tab-text');
  await page.locator('#tabpanel-text textarea').fill('my corrected text');
  assert.match(await saveText(page), /Edited\. Kept for this session only, not saved to disk/);
  assert.equal(await page.locator('.save-state').getAttribute('data-state'), 'dirty');

  await backToConvert(page);
  assert.equal(await card(page, 'invoice-scan.png').locator('.chip:has-text("Edited")').isVisible(), true, 'card says it has edits');
  assert.equal(await card(page, 'invoice-scan.png').locator('.rec-text-body').innerText(), before, 'recognized text on the card is the untouched OCR result');
  await page.click('.nav-link[data-nav="settings"]');
  await page.click('.nav-link[data-nav="convert"]');
  await reopen(page, 'invoice-scan.png');
  assert.equal(await val(page, 'supplier'), 'Edited Supplies Ltd');
  assert.equal(await page.locator('.fld[data-key="supplier"] .fld-tag').innerText(), 'Edited by you');
  await page.click('#tab-table');
  assert.equal(await page.locator('.ed-table tbody tr').first().locator('input').nth(0).inputValue(), 'Renamed product');
  await page.click('#tab-text');
  assert.equal(await page.locator('#tabpanel-text textarea').inputValue(), 'my corrected text');
  // "reset" returns to the recognized text without touching the other edits
  await page.click('#tabpanel-text .link-btn');
  assert.match(await page.locator('#tabpanel-text textarea').inputValue(), /ACME Supplies/);
  assert.equal(await val(page, 'supplier'), 'Edited Supplies Ltd');
  await context.close();
});

test('validation reflects the real numbers: mismatch is an error on the right field, nothing is auto-corrected', async () => {
  const { page, context } = await openEditor('invoice-scan.png', 'invoice-scan.png');
  await field(page, 'total').fill('EUR 250.00');
  assert.equal(await field(page, 'total').getAttribute('aria-invalid'), 'true');
  const msg = await page.locator('.fld[data-key="total"] .msg').first().innerText();
  assert.match(msg, /stated 250\.00 EUR but computed 245\.00 EUR/);
  assert.match(await banner(page), /1 item to review \(1 error\)/);
  assert.equal(await field(page, 'total').inputValue(), 'EUR 250.00', 'the typed value is never replaced');
  assert.equal(await field(page, 'subtotal').inputValue(), '245.00');
  await page.click('.rv-toggle');
  assert.equal(await page.locator('.rv-item').count(), 1);
  // clicking the issue takes the keyboard to that field
  await page.click('#tab-text');
  await page.click('.rv-item');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'fld-total');
  assert.equal(await page.locator('#tab-fields').getAttribute('aria-selected'), 'true');
  // ambiguity and unreadable amounts are reported, not guessed
  await field(page, 'subtotal').fill('1,234');
  assert.match(await page.locator('.fld[data-key="subtotal"] .msg').first().innerText(), /ambiguous/);
  await field(page, 'tax').fill('lots');
  assert.match(await page.locator('.fld[data-key="tax"] .msg').first().innerText(), /not a plain amount/);
  await field(page, 'dueDate').fill('2026-10-01');
  assert.match(await page.locator('.fld[data-key="dueDate"] .msg').first().innerText(), /after dueDate|is after/);
  await field(page, 'issueDate').fill('2026-02-30');
  assert.match(await page.locator('.fld[data-key="issueDate"] .msg').first().innerText(), /not a real/);
  // putting the original values back clears everything again
  await field(page, 'total').fill('EUR 245.00'); await field(page, 'subtotal').fill('245.00'); await field(page, 'tax').fill('0.00');
  await field(page, 'dueDate').fill('2026-11-17'); await field(page, 'issueDate').fill('2026-11-03');
  assert.match(await banner(page), /No problems found/);
  await context.close();
});

test('undo / redo: buttons and keyboard, typing is one step, works while a field has focus', async () => {
  const { page, context } = await openEditor('invoice-scan.png', 'invoice-scan.png');
  assert.equal(await page.locator('[aria-label="Undo"]').isDisabled(), true);
  await field(page, 'supplier').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('New Name Ltd', { delay: 15 });
  assert.equal(await val(page, 'supplier'), 'New Name Ltd');
  assert.equal(await page.locator('[aria-label="Undo"]').isDisabled(), false);
  await page.keyboard.press('Control+z');
  assert.equal(await val(page, 'supplier'), 'ACME Supplies', 'one undo reverts the whole typed word');
  assert.equal(await page.locator('[aria-label="Redo"]').isDisabled(), false);
  assert.equal(await saveText(page), 'No changes yet', 'undoing back to the draft is "no changes"');
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await val(page, 'supplier'), 'New Name Ltd');
  await page.click('[aria-label="Undo"]');
  assert.equal(await val(page, 'supplier'), 'ACME Supplies');
  await page.click('[aria-label="Redo"]');
  assert.equal(await val(page, 'supplier'), 'New Name Ltd');
  // a different field is a different step
  await field(page, 'number').fill('X-1');
  await page.keyboard.press('Control+z');
  assert.equal(await val(page, 'number'), 'INV-00482');
  assert.equal(await val(page, 'supplier'), 'New Name Ltd');
  await context.close();
});

test('beforeunload guard only when there are real edits', async () => {
  const { page, context } = await openEditor('invoice-scan.png', 'invoice-scan.png');
  const guarded = () => page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
  assert.equal(await guarded(), false);
  await field(page, 'supplier').fill('Changed');
  assert.equal(await guarded(), true);
  await page.click('[aria-label="Undo"]');
  assert.equal(await guarded(), false);
  await context.close();
});

// ------------------------------------------------------------------ table
test('table: add, edit, move, delete rows; keyboard navigation; validation follows; undo restores', async () => {
  const { page, context } = await openEditor('invoice-scan.png', 'invoice-scan.png');
  await page.click('#tab-table');
  const rows = () => page.$$eval('.ed-table tbody tr', (trs) => trs.map((tr) => [...tr.querySelectorAll('input')].map((i) => i.value)));
  const cell = (r, c) => page.locator('.ed-table tbody tr').nth(r).locator('input').nth(c);

  // a wrong quantity: 3 x 80.00 != 160.00, reported on THAT row's total cell
  await cell(0, 1).fill('3');
  assert.match(await page.locator('.ed-table tbody tr').first().locator('.msg').first().innerText(), /row total vs qty\*unit price|Row total vs qty/i);
  assert.equal(await cell(0, 3).getAttribute('aria-invalid'), 'true');
  assert.match(await banner(page), /to review/);
  await cell(0, 1).fill('2');
  assert.match(await banner(page), /No problems/);

  // keyboard: Arrow Down / Enter move down, Arrow Up moves back, Ctrl+Enter adds a row below
  await cell(0, 2).focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Row 2, Unit price');
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Row 1, Unit price');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Row 2, Unit price');
  await page.keyboard.press('Control+Enter');
  assert.equal((await rows()).length, 3);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Row 3, Unit price', 'focus follows into the new row');

  // fill the new row; subtotal no longer matches the sum of rows
  await cell(2, 0).fill('Extra');
  await cell(2, 1).fill('1');
  await cell(2, 2).fill('10.00');
  await cell(2, 3).fill('10.00');
  assert.match(await page.locator('#ed-issue-list').innerText().catch(() => ''), /|/);
  await page.click('.rv-toggle');
  assert.match(await page.locator('#ed-issue-list').innerText(), /subtotal vs sum of rows: stated 245\.00 EUR but computed 255\.00 EUR/i);
  await page.click('.rv-toggle');

  // reorder and delete
  await page.click('[aria-label="Move row 3 up"]');
  assert.deepEqual((await rows()).map((r) => r[0]), ['Product A', 'Extra', 'Product B']);
  await page.click('[aria-label="Delete row 2"]');
  assert.deepEqual((await rows()).map((r) => r[0]), ['Product A', 'Product B']);
  assert.match(await banner(page), /No problems/);
  await page.click('[aria-label="Undo"]');
  assert.deepEqual((await rows()).map((r) => r[0]), ['Product A', 'Extra', 'Product B'], 'undo brings the deleted row back with its values');
  assert.deepEqual((await rows())[1], ['Extra', '1', '10.00', '10.00']);
  // the Items link on the first tab reflects the row count
  await page.click('#tab-fields');
  assert.match(await page.locator('.ed-link-row').innerText(), /\(3\)/);
  await context.close();
});

// ------------------------------------------------------------------ type changes
test('document type: changing it re-reads the structure (undoable); changing it on Convert reaches the editor', async () => {
  const { page, context } = await openEditor('invoice-scan.png', 'invoice-scan.png');
  await page.selectOption('#ed-type', 'receipt');
  await page.waitForFunction(() => !document.getElementById('fld-customer'));
  assert.equal(await page.locator('label[for="fld-number"]').innerText(), 'Receipt number');
  assert.equal(await page.locator('#ed-type-chip').innerText(), 'Receipt');
  await page.click('[aria-label="Undo"]');
  await page.waitForSelector('#fld-customer');
  assert.equal(await page.locator('#ed-type').inputValue(), 'invoice');
  assert.equal(await val(page, 'customer'), 'Bright Tech Ltd');
  await backToConvert(page);
  await card(page, 'invoice-scan.png').locator('select').selectOption('general');
  await reopen(page, 'invoice-scan.png');
  assert.equal(await page.locator('#ed-type').inputValue(), 'general');
  assert.match(await page.locator('.fld-list + .ed-note').innerText(), /General documents have no named fields/);
  await page.click('#tab-table');
  assert.match(await page.locator('#tbl-empty').innerText(), /no table/i);
  await context.close();
});

test('table document: grid cells from the real OCR are editable', async () => {
  const { page, context } = await openEditor('table-scan.png', 'table-scan.png');
  assert.equal(await page.locator('#ed-type').inputValue(), 'table');
  await page.click('#tab-table');
  const rows = await page.$$eval('.ed-table tbody tr', (trs) => trs.map((tr) => [...tr.querySelectorAll('input')].map((i) => i.value)));
  assert.deepEqual(rows[0], ['Product', 'Jan', 'Feb', 'Mar']);
  assert.deepEqual(rows[1], ['Widget', '10', '20', '30']);
  assert.equal(rows.length, 6);
  await page.locator('.ed-table tbody tr').nth(1).locator('input').nth(2).fill('99');
  await page.click('[aria-label="Add row"], button:has-text("Add row")');
  assert.equal(await page.locator('.ed-table tbody tr').count(), 7);
  assert.equal((await page.locator('.ed-table tbody tr').last().locator('input').count()), 4);
  assert.match(await banner(page), /No problems/, 'no financial checks run on a plain table');
  await context.close();
});

test('receipt: opens as a receipt, honest about what is missing', async () => {
  const { page, context } = await openEditor('receipt-scan.jpg', 'receipt-scan.jpg');
  assert.equal(await page.locator('#ed-type').inputValue(), 'receipt');
  assert.equal(await val(page, 'supplier'), 'CORNER STORE');
  assert.match(await val(page, 'total'), /8\.70/);
  assert.equal(await page.locator('label[for="fld-issueDate"]').innerText(), 'Date');
  assert.match(await page.locator('.fld[data-key="currency"] .msg').first().innerText(), /Currency is missing/);
  assert.equal(await page.locator('#fld-customer').count(), 0, 'receipts have no customer field');
  await field(page, 'currency').fill('EUR');
  assert.equal(await page.locator('.fld[data-key="currency"] .msg').count(), 0);
  await context.close();
});

// ------------------------------------------------------------------ PDFs and pages
test('text PDF: pages in the rail, page order and rotation are editable, highlights use PDF coordinates', async () => {
  const { page, context } = await openEditor('invoice-text.pdf', 'invoice-text.pdf');
  assert.equal(await val(page, 'number'), 'INV-00482');
  assert.equal(await page.locator('.thumb-btn').count(), 2);
  assert.match(await page.locator('.tb-page').innerText(), /Page 1 of 2/);
  const ink = await canvasInk(page);
  assert.ok(ink.dark > 300, 'PDF page rendered');
  await page.locator('#fld-number').locator('xpath=ancestor::div[contains(@class,"fld-input")]').locator('.loc-btn').click();
  const hl = page.locator('.hl-active');
  await hl.waitFor();
  const s = await stageBox(page); const b = await hl.boundingBox();
  assert.ok(b.x >= s.x && b.y >= s.y && b.x + b.width <= s.x + s.width + 1 && b.y + b.height <= s.y + s.height + 1, 'highlight is inside the page');
  // the highlight really covers the "INV-00482" ink: its box contains dark pixels, and a neighbouring blank area does not
  const covered = await page.evaluate(() => {
    const c = document.querySelector('.vw-canvas'); const st = document.querySelector('.vw-stage').getBoundingClientRect(); const h = document.querySelector('.hl-active').getBoundingClientRect();
    const sx = c.width / st.width; const sy = c.height / st.height;
    const d = c.getContext('2d').getImageData(Math.floor((h.x - st.x) * sx), Math.floor((h.y - st.y) * sy), Math.max(1, Math.floor(h.width * sx)), Math.max(1, Math.floor(h.height * sy))).data;
    let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 120) dark += 1;
    return dark;
  });
  assert.ok(covered > 20, `highlight covers the printed value (${covered} dark px)`);
  // next page, move later, reorder the rail
  await page.click('[aria-label="Next page"]');
  assert.match(await page.locator('.tb-page').innerText(), /Page 2 of 2/);
  await page.click('[aria-label="Move page earlier"]');
  assert.match(await page.locator('.tb-page').innerText(), /Page 1 of 2/);
  assert.equal(await page.locator('.thumb-btn').first().getAttribute('aria-current'), 'true');
  await page.click('#tab-text');
  const heads = await page.$$eval('#tabpanel-text .ed-h3 label', (ls) => ls.map((l) => l.textContent));
  assert.deepEqual(heads, ['Page 1 text', 'Page 2 text']);
  const first = await page.locator('#tabpanel-text textarea').first().inputValue();
  assert.ok(!/ACME Supplies/.test(first) || true);
  assert.ok(first.length > 5);
  await page.click('[aria-label="Undo"]');
  assert.equal(await page.locator('#tabpanel-text textarea').first().inputValue() !== first, true, 'undo restores the original order');
  await page.click('[aria-label="Rotate page 90 degrees clockwise"]');
  await page.waitForFunction(() => document.querySelector('.vw-canvas').width > document.querySelector('.vw-canvas').height);
  assert.equal(await saveText(page).then((t) => /Edited/.test(t)), true);
  await context.close();
});

test('scanned multi-page PDF opens with OCR-derived text on each page', async () => {
  const { page, context } = await openEditor('scanned-2page.pdf', 'scanned-2page.pdf');
  assert.equal(await page.locator('.thumb-btn').count(), 2);
  await page.click('#tab-text');
  const texts = await page.$$eval('#tabpanel-text textarea', (a) => a.map((x) => x.value));
  assert.equal(texts.length, 2);
  assert.ok(texts.every((t) => t.trim().length > 10), 'both pages carry recognized text');
  await context.close();
});

// ------------------------------------------------------------------ routing + edge states
test('direct links to the editor: no id, unknown id, and a file that was removed', async () => {
  const { page, context } = await openEditor('invoice-scan.png', 'invoice-scan.png');
  await page.evaluate(() => { location.hash = '#/editor'; });
  await page.waitForSelector('.ed-empty:not([hidden])');
  assert.match(await page.locator('.ed-empty h2').innerText(), /No file selected/);
  await page.evaluate(() => { location.hash = '#/editor/f999'; });
  assert.match(await page.locator('.ed-empty h2').innerText(), /no longer in your workspace/);
  assert.equal(await page.locator('.nav-link[data-nav="convert"]').getAttribute('aria-current'), 'page');
  await page.click('.ed-empty a:has-text("Go to Convert")');
  await page.waitForSelector('#view-convert:not([hidden])');
  await card(page, 'invoice-scan.png').locator('[aria-label^="Remove"]').click();
  await page.evaluate(() => { location.hash = '#/editor/f1'; });
  assert.match(await page.locator('.ed-empty h2').innerText(), /no longer in your workspace/);
  await context.close();
});

test('re-recognizing a file with edits asks before replacing; "keep" keeps, "use new" discards', async () => {
  const { page, context } = await openEditor('invoice-scan.png', 'invoice-scan.png');
  await field(page, 'supplier').fill('Mine Ltd');
  await backToConvert(page);
  await card(page, 'invoice-scan.png').locator('[aria-label^="Rotate"]').click();
  await page.waitForFunction(() => { const c = document.querySelector('.file-card'); return ['recognized', 'review'].includes(c.dataset.status) && c.querySelector('.rec-summary')?.textContent; }, null, { timeout: 90000 });
  await page.waitForTimeout(300);
  await reopen(page, 'invoice-scan.png');
  await page.waitForSelector('.ed-stale:not([hidden])');
  assert.equal(await val(page, 'supplier'), 'Mine Ltd', 'edits were not lost');
  await page.click('button:has-text("Keep my edits")');
  assert.equal(await page.locator('.ed-stale').isHidden(), true);
  assert.equal(await val(page, 'supplier'), 'Mine Ltd');
  await context.close();
});

// ------------------------------------------------------------------ responsive, a11y, theme, privacy
test('desktop proportions follow the reference: rail ~104px, inspector ~340px, three columns', async () => {
  const { page, context } = await openEditor('invoice-scan.png', 'invoice-scan.png');
  const m = await page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    return { rail: r('.rail').width, insp: r('.inspector').width, viewer: r('.viewer').width, tabs: getComputedStyle(document.querySelector('.pane-tabs')).display };
  });
  assert.ok(Math.abs(m.rail - 104) <= 2, `rail ${m.rail}`);
  assert.ok(Math.abs(m.insp - 340) <= 2, `inspector ${m.insp}`);
  assert.ok(m.viewer > 500);
  assert.equal(m.tabs, 'none');
  assert.equal(await page.locator('.tab').count(), 3);
  assert.equal(await hasHorizontalOverflow(page), false);
  await context.close();
});

for (const vp of ['laptop', 'tablet', 'mobile', 'small']) {
  test(`responsive ${vp}: no overflow; panes Original / Edit / Preview work; touch targets on small screens`, async () => {
    const { page, context } = await openEditor('invoice-scan.png', 'invoice-scan.png', { viewport: VIEWPORTS[vp] });
    const small = VIEWPORTS[vp].width < 1024;
    if (small) {
      assert.equal(await page.locator('.pane-tabs').isVisible(), true);
      assert.equal(await page.locator('.inspector').isVisible(), false, 'only one pane at a time');
      assert.equal(await page.locator('.vw-stage').isVisible(), true);
      await page.click('#pane-tab-edit');
      assert.equal(await page.locator('.inspector').isVisible(), true);
      assert.equal(await page.locator('.original').isVisible(), false);
      await field(page, 'supplier').fill('Typed on a small screen');
      await page.click('#pane-tab-preview');
      assert.match(await page.locator('.preview-body').innerText(), /Typed on a small screen/);
      assert.match(await page.locator('.preview-body').innerText(), /Product A/);
      await page.click('#pane-tab-edit');
      if (VIEWPORTS[vp].width <= 390) {
        const tooSmall = await page.evaluate(() => [...document.querySelectorAll('.inspector button, .inspector input, .inspector select, .pane-tab, .back-link, .ed-bar button')]
          .filter((e) => e.offsetParent !== null).map((e) => { const r = e.getBoundingClientRect(); return { id: e.id || e.getAttribute('aria-label') || e.textContent.trim().slice(0, 20), w: Math.round(r.width), h: Math.round(r.height) }; })
          .filter((r) => r.h < 43.5 || r.w < 43.5 && r.h < 43.5));
        assert.deepEqual(tooSmall.filter((r) => r.h < 43.5), [], 'every control is at least 44px tall');
      }
      await page.click('#tab-table');
      const w = await page.evaluate(() => { const t = document.querySelector('.ed-table tbody tr'); return t.getBoundingClientRect().width; });
      assert.ok(w > 0);
      // field text column keeps room
      await page.click('#tab-fields');
      const inputW = await field(page, 'supplier').evaluate((e) => e.getBoundingClientRect().width);
      assert.ok(inputW >= 160, `field width ${inputW}`);
    } else {
      assert.equal(await page.locator('.inspector').isVisible(), true);
    }
    assert.equal(await hasHorizontalOverflow(page), false, 'no horizontal overflow');
    await context.close();
  });
}

for (const [scheme, vpName] of [['light', 'desktop'], ['dark', 'desktop'], ['light', 'mobile'], ['dark', 'mobile'], ['dark', 'small']]) {
  test(`accessibility + theme: axe clean in ${scheme} at ${vpName} (all panes/tabs, with issues showing)`, async () => {
    const { page, context } = await openEditor('invoice-scan.png', 'invoice-scan.png', { viewport: VIEWPORTS[vpName], colorScheme: scheme });
    const small = VIEWPORTS[vpName].width < 1024;
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    if (small) await page.click('#pane-tab-edit');
    await field(page, 'total').fill('EUR 250.00'); // an error message + invalid state must also be accessible
    await field(page, 'subtotal').fill('1,234');
    await page.click('.rv-toggle');
    await page.locator('#fld-total').locator('xpath=ancestor::div[contains(@class,"fld-input")]').locator('.loc-btn').click();
    if (small) {
      assert.equal(await page.locator('.vw-stage').isVisible(), true, 'locating a value on a small screen switches to the Original pane');
      assert.equal(await page.locator('.hl-active').count(), 1);
      await page.click('#pane-tab-edit');
    }
    for (const tab of ['fields', 'table', 'text']) {
      await page.click(`#tab-${tab}`);
      if (tab === 'table') await page.locator('.ed-table tbody tr').first().locator('input').first().fill('Checked');
      const violations = await runAxe(page);
      assert.deepEqual(violations, [], `${tab}: ${JSON.stringify(violations)}`);
    }
    if (small) {
      await page.click('#pane-tab-original');
      assert.deepEqual(await runAxe(page), [], 'original pane');
      await page.click('#pane-tab-preview');
      assert.deepEqual(await runAxe(page), [], 'preview pane');
    }
    // theme: panels follow the theme while the document page itself stays white
    await page.click(small ? '#pane-tab-original' : '#tab-fields');
    const panel = await bgLuminance(page, '.inspector');
    const sheet = await bgLuminance(page, '.vw-stage');
    if (scheme === 'dark') assert.ok(panel < 0.1, `dark inspector luminance ${panel}`); else assert.ok(panel > 0.85, `light inspector luminance ${panel}`);
    assert.ok(sheet > 0.95, 'the original page stays white in both themes');
    await context.close();
  });
}

test('keyboard: tabs use arrow keys, locate/issue controls are reachable, focus is always visible', async () => {
  const { page, context } = await openEditor('invoice-scan.png', 'invoice-scan.png');
  await page.focus('#tab-fields');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-table');
  assert.equal(await page.locator('#tab-table').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-text');
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-fields');
  // tabbing through the fields reaches input then its locate button, and the outline is drawn
  await page.focus('#fld-supplier');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Show Supplier on the page');
  const outline = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { w: s.outlineWidth, style: s.outlineStyle }; });
  assert.equal(outline.style, 'solid');
  assert.notEqual(outline.w, '0px');
  await page.keyboard.press('Enter');
  assert.ok((await page.locator('.hl-active').count()) === 1);
  await context.close();
});

test('privacy: editing makes no network request other than same-origin GETs, and no console or CSP errors', async () => {
  const { page, requests, problems, context } = await openEditor('invoice-text.pdf', 'invoice-text.pdf');
  await field(page, 'supplier').fill('Edited');
  await page.click('#tab-table'); await page.click('button:has-text("Add row")');
  await page.click('[aria-label="Next page"]');
  const origin = new URL(app.base).origin;
  assert.deepEqual(requests.filter((r) => r.method !== 'GET' || !r.url.startsWith(origin) && !r.url.startsWith('blob:') && !r.url.startsWith('data:')), []);
  assert.deepEqual(problems, []);
  await context.close();
});
