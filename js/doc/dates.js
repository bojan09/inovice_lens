// dates.js - strict, English-only date reading for extracted documents. Dates are returned as ISO
// "YYYY-MM-DD" only when the reading is unambiguous. "03/04/2026" could be 3 April or 4 March, so it
// is reported as ambiguous with both candidates and the caller keeps the printed text instead of guessing.

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

export function isRealDate(y, m, d) {
  if (!Number.isInteger(y) || y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

const iso = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const monthOf = (w) => MONTHS[String(w).toLowerCase().replace(/\.$/, '')] ?? null;

// Each pattern knows how to turn its captures into a reading.
const PATTERNS = [
  { re: /(?<![\d])(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?![\d])/y, read: (m) => ymd(+m[1], +m[2], +m[3]) },
  { re: /(?<![\d])(\d{1,2})(?:st|nd|rd|th)?[\s.\-/]+([A-Za-z]{3,9})\.?,?[\s.\-/]+(\d{4})(?![\d])/y, read: (m) => (monthOf(m[2]) ? ymd(+m[3], monthOf(m[2]), +m[1]) : null) },
  { re: /(?<![A-Za-z\d])([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?![\d])/y, read: (m) => (monthOf(m[1]) ? ymd(+m[3], monthOf(m[1]), +m[2]) : null) },
  { re: /(?<![\d])(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?![\d])/y, read: (m) => numeric(+m[1], +m[2], +m[3]) },
];

function ymd(y, m, d) {
  return isRealDate(y, m, d)
    ? { iso: iso(y, m, d), ambiguous: false, candidates: [iso(y, m, d)], reason: 'ok' }
    : { iso: null, ambiguous: false, candidates: [], reason: 'not_a_real_date' };
}

function numeric(a, b, y) {
  const dmy = isRealDate(y, b, a) ? iso(y, b, a) : null; // a = day, b = month
  const mdy = isRealDate(y, a, b) ? iso(y, a, b) : null; // a = month, b = day
  if (a === b && dmy) return { iso: dmy, ambiguous: false, candidates: [dmy], reason: 'ok' };
  if (dmy && mdy) return { iso: null, ambiguous: true, candidates: [dmy, mdy], reason: 'day_month_order' };
  const only = dmy || mdy;
  if (only) return { iso: only, ambiguous: false, candidates: [only], reason: 'ok' };
  return { iso: null, ambiguous: false, candidates: [], reason: 'not_a_real_date' };
}

/**
 * Find the first date in `text` at or after `from`. With anchored:true the date must START at `from`
 * (after optional spaces), which is how a value directly after a "Date:" label is read.
 * @returns {{start:number,end:number,match:string,iso:string|null,ambiguous:boolean,candidates:string[],reason:string}|null}
 */
export function findDate(text, from = 0, { anchored = false } = {}) {
  const s = String(text ?? '');
  let best = null;
  const first = anchored ? from + (/^\s*/.exec(s.slice(from))?.[0].length ?? 0) : from;
  const last = anchored ? first : s.length - 1;
  for (let pos = first; pos <= last; pos += 1) {
    for (const { re, read } of PATTERNS) {
      re.lastIndex = pos;
      const m = re.exec(s);
      if (!m) continue;
      const r = read(m);
      if (r) { best = { start: m.index, end: m.index + m[0].length, match: m[0], ...r }; break; }
    }
    if (best) break;
  }
  return best;
}

/** Whole-string parse (used by tests and by field editing). */
export function parseDate(text) {
  const s = String(text ?? '').trim();
  const f = findDate(s, 0, { anchored: true });
  if (!f || f.end !== s.length) return { iso: null, ambiguous: false, candidates: [], reason: 'unrecognized' };
  return { iso: f.iso, ambiguous: f.ambiguous, candidates: f.candidates, reason: f.reason };
}
