// util.js - pure helpers shared by the exporters: file names, exact decimal text for minor units, CSV/TSV.

/** "Invoice 03/11.png" -> "Invoice_03_11". Keeps letters/digits/._- ; never empty; no path separators. */
export function safeStem(name, fallback = 'document') {
  const base = String(name ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const s = base.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '').slice(0, 80);
  return s || fallback;
}

/** Make names unique inside one archive: a.pdf, a (2).pdf ... */
export function uniqueNames(names) {
  const seen = new Map();
  return names.map((n) => {
    const k = n.toLowerCase();
    const c = (seen.get(k) ?? 0) + 1;
    seen.set(k, c);
    if (c === 1) return n;
    const dot = n.lastIndexOf('.');
    return dot > 0 ? `${n.slice(0, dot)} (${c})${n.slice(dot)}` : `${n} (${c})`;
  });
}

/** Exact decimal text for integer minor units ("24500", 2 -> "245.00"). No floating point. */
export function minorToText(minor, exponent) {
  if (!Number.isSafeInteger(minor)) throw new RangeError('minor units must be a safe integer');
  const neg = minor < 0;
  const digits = BigInt(Math.abs(minor)).toString().padStart(exponent + 1, '0');
  const int = exponent ? digits.slice(0, -exponent) : digits;
  const frac = exponent ? digits.slice(-exponent) : '';
  return `${neg ? '-' : ''}${int}${exponent ? `.${frac}` : ''}`;
}

/**
 * Spreadsheet number for integer minor units. A cell must be a binary double, so this is the NEAREST double to
 * the exact decimal; the cell number format shows `exponent` decimals, so it displays the exact amount.
 */
export const minorToNumber = (minor, exponent) => Number(minorToText(minor, exponent));

// CSV / TSV. A text cell that a spreadsheet could execute as a formula (= + - @, tab, CR) gets a leading
// apostrophe-free guard: a single quote prefix is the convention Excel/Sheets show as plain text.
const FORMULA_START = /^[=+\-@\t\r]/;
export function guardCell(v) {
  const s = String(v);
  return FORMULA_START.test(s) && !/^-?\d+([.,]\d+)?$/.test(s) ? `'${s}` : s;
}
const csvQuote = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** cells: string | number | null. Numbers are written verbatim (caller supplies exact text for money). */
export function toCsv(rows) {
  return rows.map((r) => r.map((c) => (c === null || c === undefined ? '' : typeof c === 'number' ? String(c) : csvQuote(guardCell(c)))).join(',')).join('\r\n') + '\r\n';
}
export function toTsv(rows) {
  const clean = (c) => (c === null || c === undefined ? '' : typeof c === 'number' ? String(c) : guardCell(c).replace(/[\t\r\n]+/g, ' '));
  return rows.map((r) => r.map(clean).join('\t')).join('\n');
}
