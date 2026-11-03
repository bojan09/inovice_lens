// Phase 2 end-to-end: real pdf.js + real Tesseract in Chromium, real fixtures, strict CSP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, fixture, VIEWPORTS, runAxe, hasHorizontalOverflow } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

async function open(opts) {
  const ctx = await app.newPage(opts);
  await ctx.page.goto(app.base);
  await ctx.page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…');
  return ctx;
}
const card = (page, name) => page.locator(`.file-card:has(.file-name[title="${name}"])`);
const TERMINAL = ['recognized', 'review', 'failed', 'cancelled'];

async function waitStatus(page, name, statuses, timeout = 90000) {
  const want = [].concat(statuses);
  await page.waitForFunction(({ name, want }) => {
    const c = [...document.querySelectorAll('.file-card')].find((n) => n.querySelector('.file-name')?.getAttribute('title') === name);
    return c && want.includes(c.dataset.status);
  }, { name, want }, { timeout });
}
const statusOf = (page, name) => card(page, name).getAttribute('data-status');
const recognizedText = async (page, name) => {
  const c = card(page, name);
  if (!(await c.locator('details.rec-text').evaluate((d) => d.open))) await c.locator('details.rec-text > summary').click();
  return c.locator('.rec-text-body').innerText();
};
const tokenRecall = (text, tokens) => tokens.filter((t) => text.toLowerCase().includes(t.toLowerCase())).length / tokens.length;

const INVOICE_TOKENS = ['ACME Supplies', 'INVOICE', 'INV-00482', '03 Nov 2026', '17 Nov 2026', 'Bright Tech Ltd', 'Product A', 'Product B', '160.00', '85.00', '245.00', 'Total EUR'];

// ------------------------------------------------------------------ text-native PDF
test('text-native PDF: text extracted without starting OCR, type suggested, pages listed', async () => {
  const { page, requests, problems, context } = await open();
  await page.setInputFiles('#file-input', fixture('invoice-text.pdf'));
  await waitStatus(page, 'invoice-text.pdf', 'recognized');
  const c = card(page, 'invoice-text.pdf');
  assert.match(await c.locator('.rec-summary').innerText(), /2 pages · embedded text, no OCR needed/);
  assert.equal(await c.locator('select').inputValue(), 'invoice');
  assert.match(await c.locator('.type-hint').innerText(), /likely/);
  const text = await recognizedText(page, 'invoice-text.pdf');
  assert.match(text, /Page 1 · Embedded text/);
  assert.match(text, /Page 2 · Embedded text/);
  assert.equal(tokenRecall(text, ['INV-00482', '03 Nov 2026', '245.00', 'Bright Tech Ltd', 'Payment terms: 14 days']), 1);
  // Needless OCR avoided: the Tesseract engine and model were never requested.
  assert.deepEqual(requests.filter((r) => r.url.includes('/vendor/tesseract/')), []);
  assert.ok(requests.some((r) => r.url.includes('/vendor/pdfjs/pdf.min.mjs')));
  assert.deepEqual(problems, []);
  await context.close();
});

// ------------------------------------------------------------------ OCR paths
test('scanned image (PNG) is OCRed: recognized text, confidence, type, traceable page block', async () => {
  const { page, requests, problems, context } = await open();
  await page.setInputFiles('#file-input', fixture('invoice-scan.png'));
  await waitStatus(page, 'invoice-scan.png', ['recognized', 'review']);
  assert.equal(await statusOf(page, 'invoice-scan.png'), 'recognized');
  const c = card(page, 'invoice-scan.png');
  assert.match(await c.locator('.rec-summary').innerText(), /1 page · read by OCR · \d+(\.\d)?% mean confidence/);
  assert.equal(await c.locator('select').inputValue(), 'invoice');
  const text = await recognizedText(page, 'invoice-scan.png');
  assert.match(text, /Page 1 · OCR, \d+(\.\d)?% confidence/);
  const recall = tokenRecall(text, INVOICE_TOKENS);
  console.log(`  synthetic invoice-scan.png token recall: ${(recall * 100).toFixed(0)}% (${INVOICE_TOKENS.length} tokens)`);
  assert.ok(recall >= 0.9, `token recall ${recall}`);
  assert.ok(requests.some((r) => r.url.includes('/vendor/tesseract/eng.traineddata.gz')), 'local model used');
  assert.deepEqual(requests.filter((r) => !r.url.startsWith(new URL(app.base).origin) && !/^(blob|data):/.test(r.url)), []);
  assert.deepEqual(problems, []);
  await context.close();
});

test('scanned JPG receipt and PNG table get the right suggestions', async () => {
  const { page, context } = await open();
  await page.setInputFiles('#file-input', [fixture('receipt-scan.jpg'), fixture('table-scan.png')]);
  await waitStatus(page, 'receipt-scan.jpg', ['recognized', 'review']);
  await waitStatus(page, 'table-scan.png', ['recognized', 'review']);
  assert.equal(await card(page, 'receipt-scan.jpg').locator('select').inputValue(), 'receipt');
  assert.equal(await card(page, 'table-scan.png').locator('select').inputValue(), 'table');
  assert.ok(tokenRecall(await recognizedText(page, 'receipt-scan.jpg'), ['CORNER STORE', 'Receipt', 'Milk', 'Bread', 'Coffee', '8.70', 'VISA']) >= 0.85);
  assert.ok(tokenRecall(await recognizedText(page, 'table-scan.png'), ['Widget', 'Gadget', 'Gizmo', 'Sprocket', 'Totals', '112']) >= 0.85);
  await context.close();
});

test('scanned multi-page PDF: pages rendered and OCRed, real progress advances, per-page blocks', async () => {
  const { page, context } = await open();
  const seen = [];
  await page.exposeFunction('__sample', (v) => seen.push(v));
  await page.evaluate(() => {
    new MutationObserver(() => {
      const m = document.querySelector('.file-card .meter[role=progressbar]:not([hidden])');
      const bar = document.querySelector('.file-card[data-status="extracting"] .meter');
      if (bar) window.__sample(Number(bar.getAttribute('aria-valuenow')));
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['aria-valuenow'] });
  });
  await page.setInputFiles('#file-input', fixture('scanned-2page.pdf'));
  await waitStatus(page, 'scanned-2page.pdf', ['recognized', 'review']);
  const c = card(page, 'scanned-2page.pdf');
  assert.match(await c.locator('.rec-summary').innerText(), /2 pages · read by OCR/);
  const text = await recognizedText(page, 'scanned-2page.pdf');
  assert.match(text, /Page 1 · OCR/);
  assert.match(text, /Page 2 · OCR/);
  assert.match(text, /INV-00482/);
  assert.match(text, /CORNER STORE/);
  assert.ok(seen.length >= 2, `progress samples ${seen}`);
  for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i] >= seen[i - 1], `non-monotonic ${seen}`);
  assert.ok(seen.some((v) => v > 0 && v < 100), `intermediate progress observed: ${seen}`);
  // an invoice page and a receipt page in one file must not get a confident single label
  assert.match(await c.locator('.type-hint').innerText(), /uncertain.*different document types/);
  await context.close();
});

test('skewed scan still reads (preprocessing is applied only when measured to be needed)', async () => {
  const { page, context } = await open();
  await page.setInputFiles('#file-input', fixture('invoice-skewed.png'));
  await waitStatus(page, 'invoice-skewed.png', ['recognized', 'review']);
  const recall = tokenRecall(await recognizedText(page, 'invoice-skewed.png'), INVOICE_TOKENS);
  console.log(`  synthetic invoice-skewed.png (3 degrees) token recall: ${(recall * 100).toFixed(0)}%`);
  assert.ok(recall >= 0.75, `recall ${recall}`);
  await context.close();
});

test('low-contrast, shadowed, blurred photo: weak first pass is detected and the enhanced pass recovers the text', async () => {
  const { page, context } = await open();
  await page.setInputFiles('#file-input', fixture('invoice-lowcontrast.png'));
  await waitStatus(page, 'invoice-lowcontrast.png', ['recognized', 'review']);
  assert.equal(await statusOf(page, 'invoice-lowcontrast.png'), 'recognized');
  const text = await recognizedText(page, 'invoice-lowcontrast.png');
  assert.match(text, /enhanced image/, 'the enhanced attempt was the one kept');
  const recall = tokenRecall(text, INVOICE_TOKENS);
  console.log(`  synthetic invoice-lowcontrast.png token recall: ${(recall * 100).toFixed(0)}% (raw pass alone found 14 of ~63 words at 92% mean confidence)`);
  assert.ok(recall >= 0.8, `recall ${recall}`);
  await context.close();
});

// ------------------------------------------------------------------ honesty: bad inputs
test('unreadable inputs are flagged, not invented: blank page, noise', async () => {
  const { page, context } = await open();
  await page.setInputFiles('#file-input', [fixture('blank.png'), fixture('noise.png')]);
  await waitStatus(page, 'blank.png', 'review');
  await waitStatus(page, 'noise.png', 'review');
  assert.match(await card(page, 'blank.png').locator('.rec-review').innerText(), /Page 1: no text found/);
  assert.match(await card(page, 'blank.png').locator('.type-hint').innerText(), /Not enough text/);
  assert.match(await card(page, 'noise.png').locator('.rec-review').innerText(), /low recognition confidence \(\d+(\.\d)?%\)/);
  assert.notEqual(await card(page, 'noise.png').locator('.type-hint').getAttribute('data-confidence'), 'likely');
  await context.close();
});

test('encrypted and broken PDFs fail with specific messages; no crash, others unaffected', async () => {
  const { page, problems, context } = await open();
  await page.setInputFiles('#file-input', [fixture('encrypted.pdf'), fixture('broken.pdf'), fixture('invoice-text.pdf')]);
  await waitStatus(page, 'encrypted.pdf', 'failed');
  await waitStatus(page, 'broken.pdf', 'failed');
  await waitStatus(page, 'invoice-text.pdf', 'recognized');
  assert.match(await card(page, 'encrypted.pdf').locator('.rec-error').innerText(), /password-protected/);
  assert.match(await card(page, 'broken.pdf').locator('.rec-error').innerText(), /damaged or not a valid PDF/);
  assert.equal(await card(page, 'encrypted.pdf').getByRole('button', { name: /Retry/ }).count(), 1);
  assert.equal(await card(page, 'encrypted.pdf').getByRole('button', { name: /Rotate/ }).isVisible(), false);
  // pdf.js logs this recovery notice itself when it meets the deliberately broken fixture
  assert.deepEqual(problems.filter((p) => !/Indexing all PDF objects/.test(p)), []);
  await context.close();
});

// ------------------------------------------------------------------ rotate / retry
test('rotated scan is flagged for review, then rotating fixes it (genuine re-run)', async () => {
  const { page, context } = await open();
  await page.setInputFiles('#file-input', fixture('invoice-rotated90.png'));
  await waitStatus(page, 'invoice-rotated90.png', 'review');
  assert.match(await card(page, 'invoice-rotated90.png').locator('.rec-review').innerText(), /low recognition confidence/);
  // content is turned 90 degrees clockwise; the Rotate button turns 90 clockwise each time -> 3 presses
  for (let i = 0; i < 3; i += 1) {
    await card(page, 'invoice-rotated90.png').getByRole('button', { name: /^Rotate/ }).click();
    await waitStatus(page, 'invoice-rotated90.png', TERMINAL);
  }
  assert.equal(await statusOf(page, 'invoice-rotated90.png'), 'recognized');
  const recall = tokenRecall(await recognizedText(page, 'invoice-rotated90.png'), INVOICE_TOKENS);
  assert.ok(recall >= 0.85, `recall after rotate ${recall}`);
  await context.close();
});

// ------------------------------------------------------------------ queue, concurrency, cancel
test('bounded concurrency: never more than one file active; all complete in order', async () => {
  const { page, context } = await open();
  await page.setInputFiles('#file-input', ['invoice-scan.png', 'receipt-scan.jpg', 'table-scan.png', 'invoice-text.pdf'].map(fixture));
  let maxActive = 0;
  const deadline = Date.now() + 100000;
  while (Date.now() < deadline) {
    const st = await page.$$eval('.file-card', (cs) => cs.map((c) => c.dataset.status));
    maxActive = Math.max(maxActive, st.filter((s) => s === 'preparing' || s === 'extracting').length);
    if (st.length === 4 && st.every((s) => ['recognized', 'review'].includes(s))) break;
    await page.waitForTimeout(40);
  }
  assert.equal(maxActive, 1);
  assert.deepEqual(await page.$$eval('.file-card', (cs) => cs.map((c) => c.dataset.status)), ['recognized', 'recognized', 'recognized', 'recognized']);
  await context.close();
});

test('cancel: a running OCR job stops for real (worker terminated), next file proceeds, no late result', async () => {
  const { page, context } = await open();
  await page.addInitScript(() => {
    window.__terminated = 0;
    const t = Worker.prototype.terminate;
    Worker.prototype.terminate = function () { window.__terminated += 1; return t.call(this); };
  });
  await page.goto(app.base);
  await page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…');
  await page.setInputFiles('#file-input', [fixture('scanned-2page.pdf'), fixture('receipt-scan.jpg')]);
  await waitStatus(page, 'scanned-2page.pdf', 'extracting');
  assert.equal(await statusOf(page, 'receipt-scan.jpg'), 'queued');
  const t0 = Date.now();
  await card(page, 'scanned-2page.pdf').getByRole('button', { name: /^Cancel recognition/ }).click();
  await waitStatus(page, 'scanned-2page.pdf', 'cancelled', 3000);
  assert.ok(Date.now() - t0 < 3000);
  await waitStatus(page, 'receipt-scan.jpg', ['recognized', 'review']);
  assert.equal(await statusOf(page, 'receipt-scan.jpg'), 'recognized');
  await page.waitForTimeout(6000); // longer than the cancelled job would have needed to finish
  assert.equal(await statusOf(page, 'scanned-2page.pdf'), 'cancelled', 'no late result resurrects a cancelled job');
  assert.equal(await card(page, 'scanned-2page.pdf').locator('.rec-summary').isVisible(), false);
  assert.ok(await page.evaluate(() => window.__terminated) >= 1, 'OCR worker was terminated to stop the job');
  // Retry works afterwards
  await card(page, 'scanned-2page.pdf').getByRole('button', { name: /^Retry/ }).click();
  await waitStatus(page, 'scanned-2page.pdf', ['recognized', 'review']);
  assert.match(await card(page, 'scanned-2page.pdf').locator('.rec-summary').innerText(), /2 pages/);
  await context.close();
});

test('cancel: queued file never starts; Cancel all stops everything; removing a running file cancels it', async () => {
  const { page, context } = await open();
  await page.setInputFiles('#file-input', [fixture('scanned-2page.pdf'), fixture('invoice-scan.png'), fixture('table-scan.png')]);
  await waitStatus(page, 'scanned-2page.pdf', 'extracting');
  await card(page, 'invoice-scan.png').getByRole('button', { name: /^Cancel recognition/ }).click();
  assert.equal(await statusOf(page, 'invoice-scan.png'), 'cancelled');
  await page.click('#cancel-all');
  await waitStatus(page, 'scanned-2page.pdf', 'cancelled', 3000);
  await waitStatus(page, 'table-scan.png', 'cancelled', 3000);
  assert.equal(await page.locator('#cancel-all').isVisible(), false);
  // remove while running
  await card(page, 'scanned-2page.pdf').getByRole('button', { name: /^Retry/ }).click();
  await waitStatus(page, 'scanned-2page.pdf', 'extracting');
  await card(page, 'scanned-2page.pdf').getByRole('button', { name: /^Remove/ }).click();
  assert.equal(await card(page, 'scanned-2page.pdf').count(), 0);
  await context.close();
});

// ------------------------------------------------------------------ user override, persistence in session
test('document type override is kept, labelled as user-chosen, and can be reset', async () => {
  const { page, context } = await open();
  await page.setInputFiles('#file-input', fixture('invoice-text.pdf'));
  await waitStatus(page, 'invoice-text.pdf', 'recognized');
  const c = card(page, 'invoice-text.pdf');
  await c.locator('select').selectOption('receipt');
  assert.match(await c.locator('.type-hint').innerText(), /Changed by you\. Suggested: Invoice\./);
  // adding another file re-renders the list; the choice must survive
  await page.setInputFiles('#file-input', fixture('table-scan.png'));
  await waitStatus(page, 'table-scan.png', ['recognized', 'review']);
  assert.equal(await c.locator('select').inputValue(), 'receipt');
  // survives navigating away and back
  await page.click('.sidebar [data-nav="batch"]');
  await page.click('.sidebar [data-nav="convert"]');
  assert.equal(await c.locator('select').inputValue(), 'receipt');
  await c.getByRole('button', { name: 'Use suggestion' }).click();
  assert.equal(await c.locator('select').inputValue(), 'invoice');
  await context.close();
});

test('UI stays responsive while OCR runs (main thread not blocked by recognition)', async () => {
  const { page, context } = await open();
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ entryTypes: ['longtask'] });
  });
  await page.setInputFiles('#file-input', fixture('scanned-2page.pdf'));
  await waitStatus(page, 'scanned-2page.pdf', 'extracting');
  const t0 = Date.now();
  await page.click('#theme-btn');
  await page.click('[data-theme-pref="dark"]');
  const clickMs = Date.now() - t0;
  await waitStatus(page, 'scanned-2page.pdf', ['recognized', 'review']);
  const max = await page.evaluate(() => Math.max(0, ...window.__long));
  console.log(`  longest main-thread task during OCR: ${Math.round(max)} ms; theme change during OCR took ${clickMs} ms`);
  assert.ok(clickMs < 3000, `interaction during OCR took ${clickMs}ms`);
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  await context.close();
});

// ------------------------------------------------------------------ privacy
test('privacy: full recognition run uses only same-origin GETs; no document bytes leave the page', async () => {
  const { page, requests, problems, context } = await open();
  await page.setInputFiles('#file-input', ['invoice-text.pdf', 'scanned-2page.pdf', 'invoice-scan.png'].map(fixture));
  await waitStatus(page, 'invoice-text.pdf', 'recognized');
  await waitStatus(page, 'scanned-2page.pdf', ['recognized', 'review']);
  await waitStatus(page, 'invoice-scan.png', ['recognized', 'review']);
  const origin = new URL(app.base).origin;
  assert.deepEqual(requests.filter((r) => !r.url.startsWith(origin) && !/^(blob|data):/.test(r.url)), []);
  assert.deepEqual(requests.filter((r) => r.method !== 'GET'), []);
  assert.deepEqual(problems, [], 'no console errors or CSP violations');
  await context.close();
});

// ------------------------------------------------------------------ a11y + layout in recognized states
for (const [vpName, vp] of Object.entries({ desktop: VIEWPORTS.desktop, mobile: VIEWPORTS.mobile, small: VIEWPORTS.small })) {
  for (const scheme of ['light', 'dark']) {
    test(`recognized/review/failed cards: axe clean and no overflow at ${vpName} ${scheme}`, async () => {
      const { page, context } = await open({ viewport: vp, colorScheme: scheme });
      await page.setInputFiles('#file-input', ['invoice-text.pdf', 'invoice-scan.png', 'blank.png', 'encrypted.pdf'].map(fixture));
      for (const n of ['invoice-text.pdf', 'invoice-scan.png', 'blank.png', 'encrypted.pdf']) await waitStatus(page, n, TERMINAL);
      await recognizedText(page, 'invoice-scan.png'); // open a details block
      await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
      assert.equal(await hasHorizontalOverflow(page), false, 'overflow');
      // the text column must stay readable (regression: actions once squeezed it to a few characters)
      for (const n of ['invoice-scan.png', 'encrypted.pdf']) {
        const w = (await card(page, n).locator('.file-info').boundingBox()).width;
        assert.ok(w >= (vp.width <= 400 ? 180 : 300), `${n} text column only ${Math.round(w)}px wide at ${vp.width}px`);
      }
      assert.deepEqual(await runAxe(page), [], 'axe');
      await context.close();
    });
  }
}

test('mobile: Cancel / Rotate / Retry / select / summary controls are >= 44px', async () => {
  const { page, context } = await open({ viewport: VIEWPORTS.mobile });
  await page.setInputFiles('#file-input', [fixture('scanned-2page.pdf'), fixture('invoice-scan.png')]);
  await waitStatus(page, 'scanned-2page.pdf', 'extracting');
  const cancel = await card(page, 'scanned-2page.pdf').getByRole('button', { name: /^Cancel recognition/ }).boundingBox();
  assert.ok(cancel.height >= 44, `cancel ${cancel.width}x${cancel.height}`);
  await waitStatus(page, 'invoice-scan.png', ['recognized', 'review']);
  const c = card(page, 'invoice-scan.png');
  for (const [label, loc] of [['rotate', c.getByRole('button', { name: /^Rotate/ })], ['select', c.locator('select')], ['summary', c.locator('details > summary')], ['remove', c.getByRole('button', { name: /^Remove/ })]]) {
    const b = await loc.boundingBox();
    assert.ok(b.width >= 44 && b.height >= 44, `${label} ${b.width}x${b.height}`);
  }
  await context.close();
});
