// canvasOps.js - canvas glue around preprocess.js (browser only).
import { toGray, stretchContrast, estimateSkew, flattenBackground, inkCoverage } from './preprocess.js';

export function newCanvas(width, height) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
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
export function enhanceCanvas(src) {
  const w = src.width;
  const h = src.height;
  const ctx = src.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const gray = stretchContrast(flattenBackground(toGray(img.data), w, h));
  const skew = estimateSkew(gray, w, h);

  const flat = newCanvas(w, h);
  const fctx = flat.getContext('2d');
  const out = fctx.createImageData(w, h);
  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    out.data[p] = out.data[p + 1] = out.data[p + 2] = gray[i];
    out.data[p + 3] = 255;
  }
  fctx.putImageData(out, 0, 0);
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
export function computeCoverage(canvas, words) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return inkCoverage(toGray(img.data), canvas.width, canvas.height, words);
}
