// text.js - derive normalized text from RAW items. Raw items are never modified; everything here
// returns new data. Item shape: { text, x, y, w, h, conf } (conf is null for embedded PDF text).

/** Count letters and digits (Unicode-aware). Used to decide whether a page has real text. */
export function meaningfulChars(text) {
  const m = String(text ?? '').match(/[\p{L}\p{N}]/gu);
  return m ? m.length : 0;
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** Median dy/dx between horizontally neighbouring words of one line; 0 when the page looks level or there is too little evidence. */
export function estimateSlope(items, medH) {
  const xs = [...items].sort((a, b) => a.x - b.x);
  const samples = [];
  for (let i = 0; i < xs.length; i += 1) {
    const a = xs[i];
    const ax = a.x + (a.w || 0) / 2;
    for (let j = i + 1; j < xs.length && xs[j].x - a.x < 8 * medH + (a.w || 0); j += 1) {
      const b = xs[j];
      const dx = b.x + (b.w || 0) / 2 - ax;
      const dy = b.y + b.h / 2 - (a.y + a.h / 2);
      if (dx > 1.5 * medH && dx < 8 * medH && Math.abs(dy) < 0.8 * medH) samples.push(dy / dx);
    }
  }
  if (samples.length < 12) return 0;
  const m = median(samples);
  return Math.abs(m) < 0.004 || Math.abs(m) > 0.1 ? 0 : m; // under ~0.25 degrees: ignore; over ~6: not a tilt we trust
}

/**
 * Group items into reading-order lines, keeping WHERE each piece of line text came from.
 * Pure: never mutates the items. Each line is
 *   { text, parts:[{idx,start,end}], segments:[{start,end,x,idxs}], x, y, x1, y1 }
 * `idx` is the index into the ORIGINAL `items` array (so callers can point back at raw data),
 * `start/end` are character offsets into `text`, and `segments` split a row where the horizontal
 * gap is wide (columns), so "ACME Supplies      INVOICE" yields two segments.
 */
export function itemsToLineObjects(items) {
  const usable = [];
  items.forEach((it, idx) => {
    if (typeof it.text === 'string' && it.text.trim() !== '' && Number.isFinite(it.x) && Number.isFinite(it.y)) usable.push({ it, idx });
  });
  if (!usable.length) return [];
  const medH = median(usable.map((u) => u.it.h).filter((h) => h > 0)) || 10;
  // A photographed page is rarely level: over a full page width a 1.5 degree tilt moves a baseline by
  // more than a text height, which would split one printed line into several. Estimate the tilt from
  // neighbouring words and measure heights along the tilted baseline. Raw coordinates are not touched.
  const slope = estimateSlope(usable.map((u) => u.it), medH);
  const cyOf = (it) => it.y + it.h / 2 - slope * (it.x + (it.w || 0) / 2);
  const sorted = [...usable].sort((a, b) => cyOf(a.it) - cyOf(b.it) || a.it.x - b.it.x);

  const rows = [];
  for (const u of sorted) {
    const cy = cyOf(u.it);
    const row = rows[rows.length - 1];
    if (row && Math.abs(cy - row.cy) <= 0.5 * Math.max(medH, u.it.h || 0)) {
      row.items.push(u);
      row.cy = row.items.reduce((s, i) => s + cyOf(i.it), 0) / row.items.length;
    } else {
      rows.push({ cy, items: [u] });
    }
  }

  return rows.map((row) => {
    const xs = [...row.items].sort((a, b) => a.it.x - b.it.x);
    let text = '';
    const parts = [];
    const segments = [];
    let seg = null;
    let prevEnd = null;
    let prevTrail = false;
    for (const { it, idx } of xs) {
      const raw = it.text.replace(/\s+/g, ' ');
      const piece = raw.trim();
      const gap = prevEnd === null ? 0 : it.x - prevEnd;
      const space = text !== '' && (prevTrail || /^\s/.test(raw) || gap > 0.2 * (it.h || medH));
      const start = text.length + (space ? 1 : 0);
      text += (space ? ' ' : '') + piece;
      parts.push({ idx, start, end: text.length });
      const wide = seg && gap > 1.5 * Math.max(it.h || 0, medH);
      if (!seg || wide) { seg = { start, end: text.length, x: it.x, idxs: [idx] }; segments.push(seg); }
      else { seg.end = text.length; seg.idxs.push(idx); }
      prevEnd = it.x + (it.w || 0);
      prevTrail = /\s$/.test(raw);
    }
    return {
      text, parts, segments,
      x: Math.min(...xs.map((u) => u.it.x)),
      y: Math.min(...xs.map((u) => u.it.y)),
      x1: Math.max(...xs.map((u) => u.it.x + (u.it.w || 0))),
      y1: Math.max(...xs.map((u) => u.it.y + (u.it.h || 0))),
    };
  });
}

/** Group items into reading-order lines. Pure: does not mutate the items. */
export function itemsToLines(items) {
  return itemsToLineObjects(items).map((l) => l.text).filter((l) => l !== '');
}

export function normalizePage(items) {
  const lines = itemsToLines(items);
  return { lines, text: lines.join('\n') };
}

/** Mean confidence over items that carry one (0..100). Null when none do. */
export function confidenceStats(items, lowBelow = 60) {
  const scored = items.filter((i) => Number.isFinite(i.conf) && i.text.trim() !== '');
  if (!scored.length) return { mean: null, words: 0, lowWords: 0 };
  const mean = scored.reduce((s, i) => s + i.conf, 0) / scored.length;
  return { mean: Math.round(mean * 10) / 10, words: scored.length, lowWords: scored.filter((i) => i.conf < lowBelow).length };
}
