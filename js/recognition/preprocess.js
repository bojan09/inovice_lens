// preprocess.js - pure image maths on grayscale arrays (no DOM). Canvas glue is in canvasOps.js.

/** RGBA bytes -> 8-bit luma. */
export function toGray(rgba) {
  const n = rgba.length / 4;
  const g = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i += 1, p += 4) g[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114 + 500) / 1000;
  return g;
}

/** Linear contrast stretch between the lowPct / highPct percentiles. Returns a new array. */
export function stretchContrast(gray, lowPct = 0.01, highPct = 0.99) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 1) hist[gray[i]] += 1;
  const lowTarget = gray.length * lowPct;
  const highTarget = gray.length * highPct;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let v = 0; v < 256; v += 1) { acc += hist[v]; if (acc >= lowTarget) { lo = v; break; } }
  acc = 0;
  for (let v = 0; v < 256; v += 1) { acc += hist[v]; if (acc >= highTarget) { hi = v; break; } }
  if (hi - lo < 16) return Uint8Array.from(gray); // already flat or nearly so: leave alone
  const out = new Uint8Array(gray.length);
  const scale = 255 / (hi - lo);
  for (let i = 0; i < gray.length; i += 1) out[i] = Math.max(0, Math.min(255, (gray[i] - lo) * scale));
  return out;
}

/** Otsu threshold (0..255). */
export function otsu(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 1) hist[gray[i]] += 1;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t += 1) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

/**
 * Estimate text skew in degrees (positive = text runs clockwise-downward) by maximising the
 * variance of the row projection profile of dark pixels. Returns { angle, confident }.
 * `confident` is false when the page has too little ink or no angle clearly wins, in which
 * case callers must not rotate.
 */
export function estimateSkew(gray, width, height, { maxAngle = 5, step = 0.25, maxPoints = 250000 } = {}) {
  const t = otsu(gray);
  const pts = [];
  const stride = Math.max(1, Math.floor((width * height) / (maxPoints * 6)));
  for (let y = 0; y < height; y += 1) {
    for (let x = (y % stride); x < width; x += stride) if (gray[y * width + x] <= t) pts.push(x, y); // <=: a pure black/white page has Otsu threshold 0
  }
  const count = pts.length / 2;
  if (count < 200) return { angle: 0, confident: false };

  const bins = Math.ceil(Math.hypot(width, height)) + 2;
  const off = Math.floor(bins / 2);
  const scoreAt = (deg) => {
    const rad = (deg * Math.PI) / 180;
    const sin = Math.sin(rad);
    const cos = Math.cos(rad);
    const hist = new Float64Array(bins);
    for (let i = 0; i < pts.length; i += 2) {
      const yy = Math.round(pts[i + 1] * cos - pts[i] * sin) + off;
      if (yy >= 0 && yy < bins) hist[yy] += 1;
    }
    let s = 0;
    for (let i = 1; i < bins; i += 1) { const d = hist[i] - hist[i - 1]; s += d * d; } // sharpness of row transitions
    return s;
  };

  const base = scoreAt(0);
  let best = 0;
  let bestScore = base;
  for (let a = -maxAngle; a <= maxAngle + 1e-9; a += step) {
    const s = scoreAt(a);
    if (s > bestScore) { bestScore = s; best = Math.round(a * 100) / 100; }
  }
  const gain = base > 0 ? bestScore / base : 1;
  return { angle: best, confident: Math.abs(best) >= 0.5 && gain > 1.08 };
}

/**
 * Illumination flattening: estimate the paper background per block (90th-percentile brightness,
 * which text strokes cannot reach), smooth it, and divide it out. Fixes shadows / uneven light
 * that defeat a single global threshold. Returns a new array.
 */
export function flattenBackground(gray, width, height, block = 24) {
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
      let acc = 0;
      let v = 255;
      const target = n * 0.9;
      for (let t = 0; t < 256; t += 1) { acc += hist[t]; if (acc >= target) { v = t; break; } }
      bg[by * gw + bx] = v;
    }
  }
  for (let pass = 0; pass < 2; pass += 1) { // 3x3 mean, twice
    const next = new Float32Array(bg.length);
    for (let y = 0; y < gh; y += 1) {
      for (let x = 0; x < gw; x += 1) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
          const yy = Math.min(gh - 1, Math.max(0, y + dy)); // clamp: edge cells see themselves, not a biased half-neighbourhood
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
  }
  return out;
}

/** Shrink by an integer factor keeping the DARKEST pixel of each cell, so thin strokes survive. */
export function downsampleMin(gray, width, height, factor) {
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
  }
  return { data, width: w, height: h };
}

/**
 * Share of the page's dark marks (after illumination flattening + Otsu) that lie inside the
 * recognised word boxes. Low = text was probably missed even if the words found look confident.
 * Boxes are {x,y,w,h} in the same pixel space as the gray image. Returns null when the page has
 * (almost) no ink, since there is nothing to compare against.
 */
export function inkCoverage(gray, width, height, boxes, { maxSide = 1200, pad = 3, minInk = 0.0008 } = {}) {
  const factor = Math.max(1, Math.ceil(Math.max(width, height) / maxSide));
  // Shrink first (keeping the darkest pixel per cell) so flattening runs on <= ~1.4 MP, not the full page.
  const small = downsampleMin(gray, width, height, factor);
  const ds = { ...small, data: stretchContrast(flattenBackground(small.data, small.width, small.height, Math.max(8, Math.round(24 / factor)))) };
  const t = otsu(ds.data);
  const mask = new Uint8Array(ds.data.length);
  let ink = 0;
  for (let i = 0; i < ds.data.length; i += 1) if (ds.data[i] <= t && t < 200) { mask[i] = 1; ink += 1; }
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
