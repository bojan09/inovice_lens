// preprocessAsync.js - time-sliced twins of the heavy loops in preprocess.js. Same arithmetic, same results (unit-tested for
// exact equality), but they `await slicer.tick()` between bands so a 12 MP page never blocks the main thread for hundreds of ms.
import { otsu, estimateSkew } from './preprocess.js';

const BAND = 64; // rows per unit of work between budget checks

export async function toGrayAsync(rgba, slicer) {
  const n = rgba.length / 4;
  const g = new Uint8Array(n);
  const step = 262144; // pixels
  for (let s = 0; s < n; s += step) {
    const e = Math.min(n, s + step);
    for (let i = s, p = s * 4; i < e; i += 1, p += 4) g[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114 + 500) / 1000;
    await slicer.tick();
  }
  return g;
}

export async function stretchContrastAsync(gray, slicer, lowPct = 0.01, highPct = 0.99) {
  const hist = new Uint32Array(256);
  const step = 524288;
  for (let s = 0; s < gray.length; s += step) {
    const e = Math.min(gray.length, s + step);
    for (let i = s; i < e; i += 1) hist[gray[i]] += 1;
    await slicer.tick();
  }
  const lowTarget = gray.length * lowPct;
  const highTarget = gray.length * highPct;
  let acc = 0; let lo = 0; let hi = 255;
  for (let v = 0; v < 256; v += 1) { acc += hist[v]; if (acc >= lowTarget) { lo = v; break; } }
  acc = 0;
  for (let v = 0; v < 256; v += 1) { acc += hist[v]; if (acc >= highTarget) { hi = v; break; } }
  if (hi - lo < 16) return Uint8Array.from(gray);
  const out = new Uint8Array(gray.length);
  const scale = 255 / (hi - lo);
  for (let s = 0; s < gray.length; s += step) {
    const e = Math.min(gray.length, s + step);
    for (let i = s; i < e; i += 1) out[i] = Math.max(0, Math.min(255, (gray[i] - lo) * scale));
    await slicer.tick();
  }
  return out;
}

export async function downsampleMinAsync(gray, width, height, factor, slicer) {
  if (factor <= 1) return { data: gray, width, height };
  const w = Math.ceil(width / factor);
  const h = Math.ceil(height / factor);
  const data = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < height; y += 1) {
    const row = Math.floor(y / factor) * w;
    for (let x = 0; x < width; x += 1) {
      const i = row + Math.floor(x / factor);
      const v = gray[y * width + x];
      if (v < data[i]) data[i] = v;
    }
    if (y % BAND === BAND - 1) await slicer.tick();
  }
  return { data, width: w, height: h };
}

export async function flattenBackgroundAsync(gray, width, height, slicer, block = 24) {
  const gw = Math.ceil(width / block);
  const gh = Math.ceil(height / block);
  let bg = new Float32Array(gw * gh);
  const hist = new Uint32Array(256);
  for (let by = 0; by < gh; by += 1) {
    for (let bx = 0; bx < gw; bx += 1) {
      hist.fill(0);
      let n = 0;
      const y1 = Math.min(height, (by + 1) * block);
      const x1 = Math.min(width, (bx + 1) * block);
      for (let y = by * block; y < y1; y += 1) for (let x = bx * block; x < x1; x += 1) { hist[gray[y * width + x]] += 1; n += 1; }
      let acc = 0; let v = 255;
      const target = n * 0.9;
      for (let t = 0; t < 256; t += 1) { acc += hist[t]; if (acc >= target) { v = t; break; } }
      bg[by * gw + bx] = v;
    }
    await slicer.tick();
  }
  for (let pass = 0; pass < 2; pass += 1) {
    const next = new Float32Array(bg.length);
    for (let y = 0; y < gh; y += 1) {
      for (let x = 0; x < gw; x += 1) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
          const yy = Math.min(gh - 1, Math.max(0, y + dy));
          const xx = Math.min(gw - 1, Math.max(0, x + dx));
          sum += bg[yy * gw + xx];
        }
        next[y * gw + x] = sum / 9;
      }
    }
    bg = next;
  }
  const out = new Uint8Array(gray.length);
  for (let y = 0; y < height; y += 1) {
    const fy = Math.min(gh - 1, Math.max(0, y / block - 0.5));
    const y0 = Math.floor(fy); const y1 = Math.min(gh - 1, y0 + 1); const ty = fy - y0;
    for (let x = 0; x < width; x += 1) {
      const fx = Math.min(gw - 1, Math.max(0, x / block - 0.5));
      const x0 = Math.floor(fx); const x1 = Math.min(gw - 1, x0 + 1); const tx = fx - x0;
      const top = bg[y0 * gw + x0] * (1 - tx) + bg[y0 * gw + x1] * tx;
      const bot = bg[y1 * gw + x0] * (1 - tx) + bg[y1 * gw + x1] * tx;
      const b = Math.max(32, top * (1 - ty) + bot * ty);
      out[y * width + x] = Math.min(255, (gray[y * width + x] * 255) / b);
    }
    if (y % BAND === BAND - 1) await slicer.tick();
  }
  return out;
}

/** Same contract as preprocess.inkCoverage, time-sliced. */
export async function inkCoverageAsync(gray, width, height, boxes, slicer, { maxSide = 1200, pad = 3, minInk = 0.0008 } = {}) {
  const factor = Math.max(1, Math.ceil(Math.max(width, height) / maxSide));
  const small = await downsampleMinAsync(gray, width, height, factor, slicer);
  const flat = await flattenBackgroundAsync(small.data, small.width, small.height, slicer, Math.max(8, Math.round(24 / factor)));
  const ds = { ...small, data: await stretchContrastAsync(flat, slicer) };
  const t = otsu(ds.data);
  const mask = new Uint8Array(ds.data.length);
  let ink = 0;
  for (let i = 0; i < ds.data.length; i += 1) if (ds.data[i] <= t && t < 200) { mask[i] = 1; ink += 1; }
  await slicer.tick();
  if (ink / ds.data.length < minInk) return null;
  const covered = new Uint8Array(ds.data.length);
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x / factor) - pad);
    const y0 = Math.max(0, Math.floor(b.y / factor) - pad);
    const x1 = Math.min(ds.width - 1, Math.ceil((b.x + b.w) / factor) + pad);
    const y1 = Math.min(ds.height - 1, Math.ceil((b.y + b.h) / factor) + pad);
    for (let y = y0; y <= y1; y += 1) covered.fill(1, y * ds.width + x0, y * ds.width + x1 + 1);
  }
  let inside = 0;
  for (let i = 0; i < mask.length; i += 1) if (mask[i] && covered[i]) inside += 1;
  return Math.round((inside / ink) * 1000) / 1000;
}

export { estimateSkew };
