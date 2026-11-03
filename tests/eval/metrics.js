// Evaluation metrics: pure functions, no dependencies.
import { parseAmount } from '../../js/money.js';

/** Levenshtein distance between two sequences (arrays or strings), O(n*m) time, O(min) memory. */
export function levenshtein(a, b) {
  const x = typeof a === 'string' ? Array.from(a) : a;
  const y = typeof b === 'string' ? Array.from(b) : b;
  if (x.length < y.length) return levenshtein(y, x);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}

/** edits / reference length (code points). Empty reference: 0 if hyp empty, else hyp.length (all insertions). Can exceed 1. */
export function characterErrorRate(ref, hyp) {
  const r = Array.from(ref), h = Array.from(hyp);
  const d = levenshtein(r, h);
  return r.length === 0 ? d : d / r.length;
}

/** Same over whitespace-separated tokens. */
export function wordErrorRate(ref, hyp) {
  const tok = (s) => s.split(/\s+/).filter(Boolean);
  const r = tok(ref), h = tok(hyp);
  const d = levenshtein(r, h);
  return r.length === 0 ? d : d / r.length;
}

// ---- normalisation ----
const normText = (v) => (v === null || v === undefined ? null : String(v).normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim() || null);

/** ISO YYYY-MM-DD, or DD.MM.YYYY / DD/MM/YYYY (day-first) -> ISO; anything else -> null. */
export function normDate(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return s;
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/** Integer minor units; strings are run through parseAmount (ambiguous/unparseable -> null = abstain). */
export function normMinor(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null;
  const r = parseAmount(String(v));
  return r.ambiguous ? null : r.minor;
}
const normQty = (v) => (v === null || v === undefined ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

export const SCALAR_FIELDS = {
  'supplier.name': [(d) => d.supplier?.name, normText],
  'customer.name': [(d) => d.customer?.name, normText],
  number: [(d) => d.number, normText],
  issueDate: [(d) => d.issueDate, normDate],
  dueDate: [(d) => d.dueDate, normDate],
  currency: [(d) => d.currency, (v) => normText(v)?.toUpperCase() ?? null],
  subtotalMinor: [(d) => d.subtotalMinor, normMinor],
  taxMinor: [(d) => d.taxMinor, normMinor],
  totalMinor: [(d) => d.totalMinor, normMinor],
};
const ROW_FIELDS = {
  'rows.description': ['description', normText],
  'rows.qty': ['qty', normQty],
  'rows.unitMinor': ['unitMinor', normMinor],
  'rows.totalMinor': ['totalMinor', normMinor],
};

const ratio = (a, b) => (b === 0 ? null : a / b);
function prf(tp, predicted, truth) {
  const precision = ratio(tp, predicted), recall = ratio(tp, truth);
  const f1 = precision === null || recall === null || precision + recall === 0 ? (precision === null && recall === null ? null : 0) : (2 * precision * recall) / (precision + recall);
  return { tp, predicted, truth, precision, recall, f1 };
}

/**
 * Per-field precision / recall / F1 plus exact-match rate.
 * predictions, truth: objects keyed by document id -> model (shape in js/validation.js).
 * Scored over the ids in `truth`; a missing prediction counts every truth value as missed.
 * Per field: truth value present = non-null after normalisation; predicted = non-null;
 * correct = both present and equal (text: NFC/case/whitespace-insensitive; amounts: minor units;
 * dates: ISO). Rows are aligned by index. exactMatchRate = share of docs where every
 * scored field (incl. row count) is correct or absent in both.
 */
export function fieldScores(predictions, truth) {
  const acc = {};
  const bump = (f, t, p) => {
    const a = (acc[f] ||= { tp: 0, predicted: 0, truth: 0 });
    if (t !== null) a.truth++;
    if (p !== null) a.predicted++;
    if (t !== null && p !== null && t === p) a.tp++;
  };
  const ids = Object.keys(truth);
  let exact = 0;
  for (const id of ids) {
    const t = truth[id] || {}, p = predictions?.[id] || {};
    let allOk = true;
    const cmp = (f, tv, pv) => { bump(f, tv, pv); if (tv !== pv) allOk = false; };
    for (const [f, [get, norm]] of Object.entries(SCALAR_FIELDS)) cmp(f, norm(get(t)) ?? null, norm(get(p)) ?? null);
    const tr = Array.isArray(t.rows) ? t.rows : [], pr = Array.isArray(p.rows) ? p.rows : [];
    if (tr.length !== pr.length) allOk = false;
    for (let i = 0; i < Math.max(tr.length, pr.length); i++) {
      for (const [f, [key, norm]] of Object.entries(ROW_FIELDS)) cmp(f, norm(tr[i]?.[key]) ?? null, norm(pr[i]?.[key]) ?? null);
    }
    if (allOk) exact++;
  }
  const perField = {};
  let TP = 0, PR = 0, TR = 0;
  for (const [f, a] of Object.entries(acc)) {
    perField[f] = prf(a.tp, a.predicted, a.truth);
    TP += a.tp; PR += a.predicted; TR += a.truth;
  }
  return { docs: ids.length, perField, micro: prf(TP, PR, TR), exactMatchRate: ratio(exact, ids.length) };
}

// ---- deterministic held-out split ----
function hash32(str) {
  let h = 0x811c9dc5;
  for (const ch of Buffer.from(str, 'utf8')) { h ^= ch; h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Deterministic, order-independent split. Each id is assigned by hash(seed:id), so
 * adding documents later NEVER moves an existing document between tune and held-out
 * (no leakage). The held-out share is approximate for small corpora.
 * @returns {{tune:string[], heldOut:string[]}} both sorted.
 */
export function splitDocs(ids, { seed = 'invoice-lens', heldOutFraction = 0.3 } = {}) {
  const tune = [], heldOut = [];
  for (const id of [...new Set(ids)].sort()) {
    (hash32(`${seed}:${id}`) / 2 ** 32 < heldOutFraction ? heldOut : tune).push(id);
  }
  return { tune, heldOut };
}
