// canvasOps.js - canvas glue around preprocess.js (browser only).
import { estimateSkew } from './preprocess.js';
import { stretchContrastAsync, flattenBackgroundAsync, inkCoverageAsync } from './preprocessAsync.js';
import { createSlicer } from './yield.js';

const ROWS_PER_READ = 256;

/** Read a canvas as 8-bit luma in bands so no single getImageData / loop blocks the main thread for long. */
async function grayOfCanvas(canvas, slicer) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const g = new Uint8Array(w * h);
  for (let y = 0; y < h; y += ROWS_PER_READ) {
    const rows = Math.min(ROWS_PER_READ, h - y);
    const d = ctx.getImageData(0, y, w, rows).data;
    for (let i = 0, p = 0, o = y * w; i < w * rows; i += 1, p += 4) g[o + i] = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114 + 500) / 1000;
    await slicer.tick();
  }
  return g;
}

export function newCanvas(width, height) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  c.getContext('2d', { willReadFrequently: true }); // the context attribute is fixed by the first call; these canvases are read back for OCR
  return c;
}

/** Free the backing store of a large canvas as soon as we are done with it. */
export function releaseCanvas(c) {
  if (c && typeof c.width === 'number') { c.width = 1; c.height = 1; }
}

/** Rotate by a multiple of 90 degrees clockwise. */
export function rotateCanvas(src, deg) {
  const d = ((deg % 360) + 360) % 360;
  if (d === 0) return src;
  const swap = d === 90 || d === 270;
  const out = newCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((d * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

/**
 * "Enhanced" variant for OCR: grayscale, illumination flattening, contrast stretch, then deskew only when
 * the skew estimate is confident. The pipeline MEASURES whether this beat the raw pass.
 */
export async function enhanceCanvas(src, slicer = createSlicer()) {
  const w = src.width;
  const h = src.height;
  const gray0 = await grayOfCanvas(src, slicer);
  const gray = await stretchContrastAsync(await flattenBackgroundAsync(gray0, w, h, slicer), slicer);
  await slicer.tick();
  const skew = estimateSkew(gray, w, h);
  await slicer.tick();

  const flat = newCanvas(w, h);
  const fctx = flat.getContext('2d');
  for (let y = 0; y < h; y += ROWS_PER_READ) {
    const rows = Math.min(ROWS_PER_READ, h - y);
    const band = fctx.createImageData(w, rows);
    for (let i = 0, p = 0, o = y * w; i < w * rows; i += 1, p += 4) {
      band.data[p] = band.data[p + 1] = band.data[p + 2] = gray[o + i];
      band.data[p + 3] = 255;
    }
    fctx.putImageData(band, 0, y);
    await slicer.tick();
  }
  if (!skew.confident) return flat;

  const straight = newCanvas(w, h);
  const sctx = straight.getContext('2d');
  sctx.fillStyle = '#fff';
  sctx.fillRect(0, 0, w, h);
  sctx.translate(w / 2, h / 2);
  sctx.rotate((-skew.angle * Math.PI) / 180); // content tilted clockwise by `angle` -> rotate back
  sctx.drawImage(flat, -w / 2, -h / 2);
  releaseCanvas(flat);
  return straight;
}

/** Share of the page's dark marks that fall inside the recognised words (null = no ink to compare). */
export async function computeCoverage(canvas, words, slicer = createSlicer()) {
  const gray = await grayOfCanvas(canvas, slicer);
  return inkCoverageAsync(gray, canvas.width, canvas.height, words, slicer);
}
