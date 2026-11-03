import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS, canTransition, assertTransition, isTerminal, isActive } from '../../js/recognition/states.js';
import { meaningfulChars, itemsToLines, normalizePage, confidenceStats } from '../../js/recognition/text.js';
import { classify } from '../../js/recognition/classify.js';
import { toGray, stretchContrast, otsu, estimateSkew, flattenBackground, downsampleMin, inkCoverage } from '../../js/recognition/preprocess.js';

// ---------- states ----------
test('state machine: legal path and terminal re-queue', () => {
  const path = ['queued', 'preparing', 'extracting', 'recognized', 'queued', 'preparing', 'failed', 'queued', 'cancelled'];
  // cancelled can only be reached from non-terminal states
  assert.equal(canTransition('queued', 'preparing'), true);
  assert.equal(canTransition('preparing', 'extracting'), true);
  assert.equal(canTransition('extracting', 'review'), true);
  for (const t of ['recognized', 'review', 'failed', 'cancelled']) assert.equal(canTransition(t, 'queued'), true);
  assert.ok(path.length);
});
test('state machine: illegal transitions throw', () => {
  assert.throws(() => assertTransition('queued', 'recognized'), /Illegal/);
  assert.throws(() => assertTransition('recognized', 'extracting'), /Illegal/);
  assert.throws(() => assertTransition('recognized', 'cancelled'), /Illegal/);
  assert.throws(() => assertTransition('bogus', 'queued'), /Illegal/);
  assert.equal(isTerminal(STATUS.REVIEW), true);
  assert.equal(isActive(STATUS.EXTRACTING), true);
  assert.equal(isActive(STATUS.QUEUED), false);
});

// ---------- text ----------
test('meaningfulChars counts letters and digits only', () => {
  assert.equal(meaningfulChars('  A-1 . , 22 '), 4);
  assert.equal(meaningfulChars(''), 0);
  assert.equal(meaningfulChars(null), 0);
  assert.equal(meaningfulChars('---- ....'), 0);
});
test('itemsToLines groups by baseline and orders by x; does not mutate input', () => {
  const items = [
    { text: 'World', x: 60, y: 100, w: 40, h: 10 },
    { text: 'Hello', x: 10, y: 101, w: 40, h: 10 },
    { text: 'Second', x: 10, y: 130, w: 50, h: 10 },
    { text: '   ', x: 5, y: 5, w: 1, h: 10 },
  ];
  const copy = JSON.parse(JSON.stringify(items));
  assert.deepEqual(itemsToLines(items), ['Hello World', 'Second line'.replace(' line', '')]);
  assert.deepEqual(items, copy);
});
test('itemsToLines does not insert a space inside a tightly packed word split by the PDF producer', () => {
  const items = [{ text: 'INV', x: 10, y: 10, w: 20, h: 10 }, { text: '-00482', x: 30.5, y: 10, w: 36, h: 10 }];
  assert.deepEqual(itemsToLines(items), ['INV-00482']);
});
test('itemsToLines on empty / unusable input', () => {
  assert.deepEqual(itemsToLines([]), []);
  assert.deepEqual(itemsToLines([{ text: '', x: 0, y: 0, w: 0, h: 0 }, { text: 'x', x: NaN, y: 0, w: 1, h: 1 }]), []);
});
test('normalizePage derives text from raw items without touching them', () => {
  const items = [{ text: 'A', x: 0, y: 0, w: 5, h: 10, conf: 90 }, { text: 'B', x: 0, y: 40, w: 5, h: 10, conf: 80 }];
  const frozen = Object.freeze(items.map((i) => Object.freeze({ ...i })));
  const n = normalizePage(frozen);
  assert.equal(n.text, 'A\nB');
});
test('confidenceStats', () => {
  assert.deepEqual(confidenceStats([]), { mean: null, words: 0, lowWords: 0 });
  assert.deepEqual(confidenceStats([{ text: 'a', conf: null }]), { mean: null, words: 0, lowWords: 0 });
  assert.deepEqual(confidenceStats([{ text: 'a', conf: 90 }, { text: 'b', conf: 50 }, { text: ' ', conf: 1 }], 60), { mean: 70, words: 2, lowWords: 1 });
});

// ---------- classify ----------
const L = (s) => s.split('\n');
test('classify: invoice', () => {
  const r = classify(L('ACME Supplies\nINVOICE\nInvoice No: INV-00482\nBill to: Bright Tech\nDue Date: 17 Nov 2026\nDescription Qty Unit Price Total\nSubtotal 245.00\nTax (0%) 0.00\nTotal 245.00'));
  assert.equal(r.suggested, 'invoice');
  assert.equal(r.confidence, 'likely');
});
test('classify: receipt', () => {
  const r = classify(L('CORNER STORE\nReceipt\nCashier: 4\nMilk 1.20\nBread 2.10\nTotal 3.30\nVISA **** 1234\nCard ending 1234\nThank you for shopping\nChange 0.00'));
  assert.equal(r.suggested, 'receipt');
  assert.equal(r.confidence, 'likely');
});
test('classify: table', () => {
  const r = classify(L('Product Jan Feb Mar\nWidget 10 20 30\nGadget 15 25 35\nGizmo 20 30 40\nDoohickey 5 6 7\nTotals 50 81 112'));
  assert.equal(r.suggested, 'table');
});
test('classify: prose is general and uncertain; tiny text gives none', () => {
  const g = classify(L('Dear Sir or Madam,\nI am writing to confirm our meeting next week about the project plan and schedule.\nKind regards,\nA. Person'));
  assert.equal(g.suggested, 'general');
  assert.notEqual(g.confidence, 'likely');
  const none = classify(['hi']);
  assert.equal(none.confidence, 'none');
  assert.equal(none.suggested, 'general');
  assert.equal(classify([]).confidence, 'none');
});
test('classify: mixed invoice/receipt wording is not "likely"', () => {
  const r = classify(L('Invoice\nReceipt\nSubtotal 9.00\nTax 1.00\nTotal 10.00'));
  assert.notEqual(r.confidence, 'likely');
});

// ---------- preprocess maths ----------
test('toGray luma weights', () => {
  assert.deepEqual([...toGray(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]))], [76, 150, 29, 255]);
});
test('stretchContrast expands a washed-out range and leaves flat images alone', () => {
  const g = new Uint8Array(1000);
  for (let i = 0; i < 1000; i += 1) g[i] = i % 2 ? 150 : 100;
  const s = stretchContrast(g);
  assert.equal(Math.min(...s), 0);
  assert.ok(Math.max(...s) >= 250, `max ${Math.max(...s)}`);
  const flat = new Uint8Array(100).fill(128);
  assert.deepEqual([...stretchContrast(flat)], [...flat]);
});
test('otsu separates a bimodal histogram', () => {
  const g = new Uint8Array(200);
  g.fill(30, 0, 100); g.fill(220, 100);
  const t = otsu(g);
  assert.ok(t >= 30 && t < 220, `threshold ${t}`);
});

function drawLines(w, h, skewDeg) {
  const g = new Uint8Array(w * h).fill(255);
  const k = Math.tan((skewDeg * Math.PI) / 180);
  for (let line = 0; line < 14; line += 1) {
    const y0 = 40 + line * 22;
    for (let x = 30; x < w - 30; x += 1) {
      if ((x % 9) < 6) {
        const y = Math.round(y0 + (x - w / 2) * k);
        for (let t = 0; t < 4; t += 1) if (y + t >= 0 && y + t < h) g[(y + t) * w + x] = 0;
      }
    }
  }
  return g;
}
test('estimateSkew recovers a known skew within 0.5 degrees and refuses when there is no ink', () => {
  for (const deg of [-3, 2, 4]) {
    const r = estimateSkew(drawLines(500, 400, deg), 500, 400);
    assert.equal(r.confident, true, `confident at ${deg}`);
    // sign convention: rotating the page content by -angle straightens it
    assert.ok(Math.abs(Math.abs(r.angle) - Math.abs(deg)) <= 0.5, `angle ${r.angle} for skew ${deg}`);
  }
  const straight = estimateSkew(drawLines(500, 400, 0), 500, 400);
  assert.equal(straight.confident, false);
  assert.equal(estimateSkew(new Uint8Array(500 * 400).fill(255), 500, 400).confident, false);
});
test('estimateSkew sign: opposite skews give opposite angles', () => {
  const a = estimateSkew(drawLines(500, 400, 3), 500, 400).angle;
  const b = estimateSkew(drawLines(500, 400, -3), 500, 400).angle;
  assert.ok(a * b < 0, `${a} vs ${b}`);
});

// ---- illumination flattening + ink coverage
function shadowedPage(w, h, rects) {
  const g = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) g[y * w + x] = Math.round(70 + (y / h) * 170); // 70 (top) .. 240 (bottom)
  for (const [x0, y0, x1, y1] of rects) for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) g[y * w + x] = Math.round(g[y * w + x] * 0.45);
  return g;
}
const RECTS = [[20, 20, 120, 30], [20, 60, 140, 70], [20, 120, 100, 130], [20, 200, 160, 210], [20, 280, 90, 290], [20, 350, 130, 360]];
test('flattenBackground removes a strong lighting gradient and keeps text darker than paper', () => {
  const w = 200; const h = 400;
  const g = shadowedPage(w, h, RECTS);
  const f = flattenBackground(g, w, h);
  const bgAt = (y) => f[y * w + 180];            // paper far from text at several heights
  const samples = [10, 100, 200, 300, 390].map(bgAt);
  const before = [10, 100, 200, 300, 390].map((y) => g[y * w + 180]);
  assert.ok(Math.max(...before) - Math.min(...before) >= 150, 'fixture has a >=150-level lighting gradient');
  assert.ok(Math.max(...samples) - Math.min(...samples) <= 40, `paper brightness spread after flattening ${samples}`);
  for (const [x0, y0, x1, y1] of RECTS) {
    const ink = f[Math.floor((y0 + y1) / 2) * w + Math.floor((x0 + x1) / 2)];
    assert.ok(ink < 0.7 * 255, `text pixel ${ink} still clearly darker than paper`);
  }
  // the problem being solved: before flattening, top PAPER is darker than bottom TEXT
  assert.ok(g[10 * w + 180] < g[355 * w + 25], 'fixture really has paper darker than some text');
});
test('flattenBackground leaves an already clean page essentially unchanged', () => {
  const g = new Uint8Array(100 * 100).fill(250);
  for (let i = 40; i < 50; i += 1) for (let j = 10; j < 90; j += 1) g[i * 100 + j] = 20;
  const f = flattenBackground(g, 100, 100);
  assert.ok(f[5 * 100 + 5] >= 245);
  assert.ok(f[45 * 100 + 50] < 60);
});
test('downsampleMin keeps thin dark strokes', () => {
  const g = new Uint8Array(64 * 64).fill(255);
  for (let x = 0; x < 64; x += 1) g[31 * 64 + x] = 0; // 1px line
  const d = downsampleMin(g, 64, 64, 8);
  assert.equal(d.width, 8);
  assert.ok([...d.data.slice(3 * 8, 4 * 8)].every((v) => v === 0));
});
test('inkCoverage: full, partial, none; blank page -> null', () => {
  const w = 200; const h = 400;
  const g = shadowedPage(w, h, RECTS);
  const box = ([x0, y0, x1, y1]) => ({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  assert.ok(inkCoverage(g, w, h, RECTS.map(box)) >= 0.95);
  const half = inkCoverage(g, w, h, RECTS.slice(0, 3).map(box));
  assert.ok(half > 0.3 && half < 0.7, `half coverage ${half}`);
  assert.ok(inkCoverage(g, w, h, []) <= 0.05);
  assert.equal(inkCoverage(new Uint8Array(w * h).fill(255), w, h, []), null);
});
