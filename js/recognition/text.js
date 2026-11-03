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

/** Group items into reading-order lines. Pure: does not mutate the items. */
export function itemsToLines(items) {
  const usable = items.filter((i) => typeof i.text === 'string' && i.text.trim() !== '' && Number.isFinite(i.x) && Number.isFinite(i.y));
  if (!usable.length) return [];
  const medH = median(usable.map((i) => i.h).filter((h) => h > 0)) || 10;
  const sorted = [...usable].sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2) || a.x - b.x);

  const rows = [];
  for (const it of sorted) {
    const cy = it.y + it.h / 2;
    const row = rows[rows.length - 1];
    if (row && Math.abs(cy - row.cy) <= 0.5 * Math.max(medH, it.h || 0)) {
      row.items.push(it);
      row.cy = row.items.reduce((s, i) => s + i.y + i.h / 2, 0) / row.items.length;
    } else {
      rows.push({ cy, items: [it] });
    }
  }

  return rows
    .map((row) => {
      const xs = [...row.items].sort((a, b) => a.x - b.x);
      let line = '';
      let prevEnd = null;
      for (const it of xs) {
        const piece = it.text.replace(/\s+/g, ' ');
        if (line === '') line = piece.trimStart();
        else {
          const gap = it.x - prevEnd;
          const needsSpace = !/\s$/.test(line) && !/^\s/.test(piece) && gap > 0.2 * (it.h || medH);
          line += (needsSpace ? ' ' : '') + piece;
        }
        prevEnd = it.x + (it.w || 0);
      }
      return line.replace(/\s+/g, ' ').trim();
    })
    .filter((l) => l !== '');
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
