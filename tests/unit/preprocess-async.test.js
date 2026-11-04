import test from 'node:test';
import assert from 'node:assert/strict';

// ------------------------------------------------------------------ time-sliced twins must equal the originals exactly
import { toGray, stretchContrast, downsampleMin, flattenBackground, inkCoverage } from '../../js/recognition/preprocess.js';
import { toGrayAsync, stretchContrastAsync, downsampleMinAsync, flattenBackgroundAsync, inkCoverageAsync } from '../../js/recognition/preprocessAsync.js';
import { createSlicer, noSlicer } from '../../js/recognition/yield.js';

function pseudoImage(w, h, seed = 7) {
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const ink = (x % 37 < 3 || y % 53 < 2) && rnd() < 0.8;
    const shade = 150 + (x / w) * 90; // uneven light
    const v = ink ? 20 + rnd() * 40 : shade + rnd() * 10;
    const p = (y * w + x) * 4;
    rgba[p] = v; rgba[p + 1] = v * 0.98; rgba[p + 2] = v * 0.95; rgba[p + 3] = 255;
  }
  return rgba;
}

test('sliced preprocessing is byte-identical to the synchronous functions (and really yields)', async () => {
  const w = 331; const h = 257;
  const rgba = pseudoImage(w, h);
  let t = 0; let yielded = 0;
  const slicer = createSlicer(1, { now: () => (t += 0.6), yielder: async () => { yielded += 1; } }); // every other tick yields
  const g = toGray(rgba);
  assert.deepEqual(await toGrayAsync(rgba, slicer), g);
  assert.deepEqual(await stretchContrastAsync(g, slicer), stretchContrast(g));
  for (const f of [1, 2, 3]) assert.deepEqual(await downsampleMinAsync(g, w, h, f, slicer), downsampleMin(g, w, h, f));
  for (const block of [8, 24]) assert.deepEqual(await flattenBackgroundAsync(g, w, h, slicer, block), flattenBackground(g, w, h, block));
  const boxes = [{ x: 10, y: 10, w: 120, h: 30 }, { x: 200, y: 100, w: 90, h: 40 }];
  assert.equal(await inkCoverageAsync(g, w, h, boxes, slicer, { maxSide: 200 }), inkCoverage(g, w, h, boxes, { maxSide: 200 }));
  assert.equal(await inkCoverageAsync(new Uint8Array(w * h).fill(255), w, h, boxes, noSlicer), inkCoverage(new Uint8Array(w * h).fill(255), w, h, boxes), 'blank page: both null');
  assert.ok(yielded > 0, 'the slicer actually handed the thread back');
});

test('slicer: yields only after the budget is spent', async () => {
  let t = 0; let n = 0;
  const s = createSlicer(10, { now: () => t, yielder: async () => { n += 1; } });
  await s.tick(); t = 9; await s.tick(); assert.equal(n, 0);
  t = 10; await s.tick(); assert.equal(n, 1);
  await s.tick(); assert.equal(n, 1, 'budget restarts after a yield');
  assert.equal(s.yields, 1);
});
