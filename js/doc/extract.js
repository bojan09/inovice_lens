// extract.js - turn a recognition result into a first-draft structured document. HEURISTIC and English-only.
//
// Design rules (they exist because a wrong number that looks right is worse than an empty field):
//  * Every value is SUGGESTED and carries a `ref` to the raw items it came from, so the editor can
//    highlight it on the page. Nothing here is "confirmed".
//  * Money keeps the printed text ("EUR 245.00"); nothing is parsed, rounded or recomputed here.
//  * When something is unclear the field stays empty or gets a note (e.g. an ambiguous date keeps the
//    printed text). Notes with level 'warning' become validation warnings until the user edits the field.
//  * Layout limits are real: multi-line descriptions, rows without a recognizable
//    "description qty unit total" shape, and amounts split across lines are NOT reconstructed.

import { itemsToLineObjects } from '../recognition/text.js';
import { parseAmount, detectCurrencies } from '../money.js';
import { findDate } from './dates.js';
import { emptyField, makeField, ROW_COLUMNS } from './model.js';

const TITLE_WORDS = /^(?:tax\s+)?(?:invoice|receipt|bill|credit\s+note|statement|quotation|quote|proforma(?:\s+invoice)?)\s*$/i;
const NUMBER_LABELS = /\b(?:invoice|inv|receipt|bill|order|document|doc|ref(?:erence)?)\s*(?:no\.?|number|num\.?|nr\.?|#)\s*[:#.\-]?\s*|\b(?:invoice|receipt)\s*#\s*/gi;
const ISSUE_LABEL = /\b(?:invoice\s*date|date\s*of\s*issue|issue\s*date|issued(?:\s*on)?|receipt\s*date|(?<!due\s)(?<!payment\s)(?<!due\s*)date)\b\s*[:.\-]?\s*/gi;
const DUE_LABEL = /\b(?:due\s*date|payment\s*due(?:\s*date)?|due\s*on|pay\s*by)\b\s*[:.\-]?\s*/gi;
const SUBTOTAL_LABEL = /\bsub\s*-?\s*total\b/i;
const TAX_LABEL = /\b(?:vat|gst|sales\s*tax|tax)\b/i;
const TOTAL_LABEL = /\b(?:grand\s*total|total\s*(?:due|amount|payable)|amount\s*(?:due|payable)|balance\s*due|total)\b/i;
const BILL_TO = /\b(?:bill(?:ed)?\s*to|sold\s*to|customer|client)\b\s*[:.\-]?\s*/i;
const RECEIPT_SKIP = /\b(?:total|sub\s*-?\s*total|tax|vat|gst|change|cash|card|visa|mastercard|amex|debit|credit|tender(?:ed)?|balance|thank|terminal|cashier|receipt|auth|approval)\b/i;

// One amount as printed: optional sign/parenthesis, optional currency code/symbol, digits with grouping.
const AMOUNT_RE = /[-(]?\s*(?:[A-Z]{3}\s*)?[$€£¥]?\s*\d{1,3}(?:[  ' ]\d{3})+(?:[.,]\d+)?\)?(?:\s*[A-Z]{3}\b)?|[-(]?\s*(?:[A-Z]{3}\s*)?[$€£¥]?\s*\d[\d.,]*\)?(?:\s*[A-Z]{3}\b)?/;
const AMOUNT_ANCHORED = new RegExp(`^[\\s:.\\-]*(${AMOUNT_RE.source})`);
const AMOUNT_TOKEN = /^[-(]?(?:[A-Z]{3})?[$€£¥]?\d[\d.,]*\)?(?:[A-Z]{3})?$/;
const PLAIN_QTY = /^\d+(?:[.,]\d+)?$/;
const PERCENT = /\(?\s*(\d+(?:[.,]\d+)?)\s*%\s*\)?/;

const rangeIdxs = (line, from, to) => line.parts.filter((p) => p.end > from && p.start < to).map((p) => p.idx);
const refOf = (page, line, from, to) => ({ page, items: rangeIdxs(line, from, to) });

/** The amount printed at/after `from`, or null. Returns {text,start,end} when parseAmount can make sense of it. */
function amountAfter(line, from) {
  const rest = line.text.slice(from);
  const m = AMOUNT_ANCHORED.exec(rest); // the amount must follow the label directly, not just appear later on the row
  if (!m) return null;
  const text = m[1].trim();
  const p = parseAmount(text);
  if (p.minor === null && !p.ambiguous) return null;
  const start = from + m[0].length - m[1].length + (m[1].length - m[1].trimStart().length);
  return { text, start, end: start + text.length };
}

function labelled(pages, labelRe, pickValue) {
  // first match across pages in reading order
  for (const pg of pages) {
    for (const line of pg.lines) {
      labelRe.lastIndex = 0;
      let m;
      while ((m = labelRe.exec(line.text))) {
        const v = pickValue(line, m.index + m[0].length, pg.index);
        if (v) return v;
        if (m[0].length === 0) labelRe.lastIndex += 1;
      }
    }
  }
  return null;
}

function dateField(pages, labelRe) {
  const hit = labelled(pages, labelRe, (line, at, page) => {
    const d = findDate(line.text, at, { anchored: true });
    return d ? { page, line, d } : null;
  });
  if (!hit) return null;
  const { page, line, d } = hit;
  const ref = refOf(page, line, d.start, d.end);
  if (d.ambiguous) return makeField(d.match, ref, `"${d.match}" could be ${d.candidates.join(' or ')} (day/month order is not stated). Type the date as YYYY-MM-DD.`, 'warning');
  if (d.iso) return makeField(d.iso, ref);
  return makeField(d.match, ref, `"${d.match}" is not a real calendar date. Check it against the original.`, 'warning');
}

function numberField(pages) {
  const hit = labelled(pages, NUMBER_LABELS, (line, at, page) => {
    const m = /^([A-Za-z0-9][A-Za-z0-9\-_/.]*)/.exec(line.text.slice(at));
    if (!m) return null;
    const value = m[1].replace(/[.,;:]+$/, '');
    if (!/\d/.test(value)) return null; // "Invoice No: Date" is a label, not a number
    return { page, line, value, from: at, to: at + value.length };
  });
  return hit ? makeField(hit.value, refOf(hit.page, hit.line, hit.from, hit.to)) : null;
}

/** First non-title text block at the top of page 1 (left-most column segment). */
function topBlock(pages) {
  const pg = pages[0];
  if (!pg) return null;
  for (const line of pg.lines.slice(0, 6)) {
    for (const seg of line.segments) {
      const t = line.text.slice(seg.start, seg.end).trim();
      if (/\p{L}{2,}/u.test(t) && !TITLE_WORDS.test(t) && !/\d{3,}/.test(t)) return { page: pg.index, line, seg, text: t };
    }
  }
  return null;
}

function supplierField(pages) {
  const b = topBlock(pages);
  return b ? makeField(b.text, refOf(b.page, b.line, b.seg.start, b.seg.end), 'Guessed from the page top. Check it.') : null;
}

function customerField(pages) {
  for (const pg of pages) {
    for (let i = 0; i < pg.lines.length; i += 1) {
      const line = pg.lines[i];
      const m = BILL_TO.exec(line.text);
      if (!m) continue;
      const at = m.index + m[0].length;
      const seg = line.segments.find((s) => s.start <= at && s.end > at); // value in the SAME column block as the label
      const sameRow = seg ? line.text.slice(at, seg.end).trim() : '';
      if (/\p{L}{2,}/u.test(sameRow)) return makeField(sameRow, refOf(pg.index, line, at, seg.end), 'Guessed from "Bill to". Check it.');
      const next = pg.lines[i + 1];
      if (!next) continue;
      const first = next.segments[0];
      const t = next.text.slice(first.start, first.end).trim();
      if (/\p{L}{2,}/u.test(t)) return makeField(t, refOf(pg.index, next, first.start, first.end), 'Guessed from below "Bill to". Check it.');
    }
  }
  return null;
}

/** Last labelled amount in the document (a grand total sits at the end). */
function moneyField(pages, labelRe, { exclude } = {}) {
  let found = null;
  for (const pg of pages) {
    for (const line of pg.lines) {
      const m = labelRe.exec(line.text);
      if (!m || (exclude && exclude.test(line.text))) continue;
      let from = m.index + m[0].length;
      // skip a printed rate such as "(18%)" so it is not mistaken for the amount
      const pm = PERCENT.exec(line.text.slice(from));
      let rate = null;
      if (pm && pm.index < 4) { from += pm.index + pm[0].length; rate = pm[1]; }
      const a = amountAfter(line, from);
      if (!a) continue;
      found = { page: pg.index, line, a, rate, ratePos: pm && pm.index < 4 ? { from: m.index + m[0].length + pm.index, to: m.index + m[0].length + pm.index + pm[0].length } : null };
    }
  }
  return found;
}

function moneyFieldOut(hit) {
  if (!hit) return null;
  const p = parseAmount(hit.a.text);
  const note = p.ambiguous ? `"${hit.a.text}" could be read two ways (thousands or decimals). Retype it with two decimals, e.g. 1234.00.` : null;
  return makeField(hit.a.text, refOf(hit.page, hit.line, hit.a.start, hit.a.end), note, 'warning');
}

function currencyField(allText) {
  const found = detectCurrencies(allText);
  if (found.length !== 1) return { field: emptyField(), found };
  const code = found[0];
  const dollar = code === 'USD' && !/\bUSD\b/i.test(allText);
  return { field: makeField(code, null, dollar ? 'Read from a "$" sign. $ can also mean CAD, AUD or others; confirm the currency.' : null, 'warning'), found };
}

// ----------------------------------------------------------------------------- rows
function tokensOf(line, from) {
  const out = [];
  const re = /\S+/g;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(line.text))) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

const HEADER_DESC = /\b(?:description|item|product|service|details?|article)\b/i;
const HEADER_NUM = /\b(?:qty|quantity|price|amount|total|unit)\b/i;

/** Horizontal gap (in line heights) between two tokens; null when both sit inside ONE raw item (cannot tell). */
function tokenGap(line, raw, a, b) {
  const ia = line.parts.find((p) => p.start <= a.start && p.end > a.start)?.idx;
  const ib = line.parts.find((p) => p.start <= b.start && p.end > b.start)?.idx;
  if (ia === undefined || ib === undefined || ia === ib) return null;
  const A = raw[ia];
  const B = raw[ib];
  return (B.x - (A.x + (A.w || 0))) / Math.max(B.h || 0, A.h || 0, 1);
}

function parseItemRow(pg, line, { stripIndex, raw }) {
  const toks = tokensOf(line, 0);
  if (toks.length < 3) return null;
  const total = toks[toks.length - 1];
  const unit = toks[toks.length - 2];
  if (!AMOUNT_TOKEN.test(total.text) || !AMOUNT_TOKEN.test(unit.text)) return null;
  const qty = toks[toks.length - 3];
  if (!PLAIN_QTY.test(qty.text)) return null;
  let descToks = toks.slice(0, -3);
  if (stripIndex && descToks.length > 1 && /^\d{1,3}\.?$/.test(descToks[0].text)) descToks = descToks.slice(1);
  if (!descToks.length || !/\p{L}/u.test(descToks.map((t) => t.text).join(' '))) return null;
  const d0 = descToks[0].start;
  const d1 = descToks[descToks.length - 1].end;
  const cell = (tok, key) => {
    const f = makeField(tok.text, refOf(pg.index, line, tok.start, tok.end));
    const prev = toks[toks.indexOf(tok) - 1];
    // "1 234.50" printed with a space can be one amount or two values; do not guess
    if (key === 'unit' && prev && /^\d{1,3}$/.test(prev.text) && /^\d{3}(?:[.,]\d{1,2})?$/.test(tok.text)) {
      const gap = tokenGap(line, raw, prev, tok);
      if (gap !== null && gap > 0.4) return f; // clearly separate columns

      f.note = `"${prev.text} ${tok.text}" may be one amount or two separate values. Check it.`;
      f.noteLevel = 'warning';
    }
    return f;
  };
  return {
    description: makeField(line.text.slice(d0, d1), refOf(pg.index, line, d0, d1)),
    qty: cell(qty, 'qty'),
    unit: cell(unit, 'unit'),
    total: cell(total, 'total'),
  };
}

function extractInvoiceRows(pages, rawOf) {
  const rows = [];
  for (const pg of pages) {
    let inTable = false;
    let stripIndex = false;
    for (const line of pg.lines) {
      if (!inTable) {
        if (HEADER_DESC.test(line.text) && (line.text.match(new RegExp(HEADER_NUM.source, 'gi')) ?? []).length >= 2) {
          inTable = true;
          stripIndex = /^\s*(?:#|no\.?)\s/i.test(line.text);
        }
        continue;
      }
      if (SUBTOTAL_LABEL.test(line.text) || TAX_LABEL.test(line.text) || TOTAL_LABEL.test(line.text)) { inTable = false; continue; }
      const r = parseItemRow(pg, line, { stripIndex, raw: rawOf(pg.index) });
      if (r) rows.push(r);
      else if (rows.length) inTable = false; // first non-row after data ends the table
    }
  }
  return rows;
}

function extractReceiptRows(pages) {
  const rows = [];
  for (const pg of pages) {
    for (const line of pg.lines) {
      if (RECEIPT_SKIP.test(line.text)) continue;
      const toks = tokensOf(line, 0);
      if (toks.length < 2) continue;
      const last = toks[toks.length - 1];
      if (!AMOUNT_TOKEN.test(last.text) || !/[.,]\d{1,2}$/.test(last.text)) continue;
      const desc = line.text.slice(toks[0].start, toks[toks.length - 2].end);
      if (!/\p{L}{2,}/u.test(desc)) continue;
      const a = parseAmount(last.text);
      if (a.minor === null && !a.ambiguous) continue;
      rows.push({
        description: makeField(desc, refOf(pg.index, line, toks[0].start, toks[toks.length - 2].end)),
        qty: emptyField(), unit: emptyField(),
        total: makeField(last.text, refOf(pg.index, line, last.start, last.end)),
      });
    }
  }
  return rows;
}

// ----------------------------------------------------------------------------- generic table
function extractGrid(pages) {
  const rows = [];
  for (const pg of pages) {
    for (const line of pg.lines) {
      const segs = line.segments.map((s) => ({ x: s.x, text: line.text.slice(s.start, s.end).trim(), ref: refOf(pg.index, line, s.start, s.end) })).filter((s) => s.text);
      if (segs.length) rows.push(segs);
    }
  }
  if (!rows.length) return { columns: 0, rows: [] };
  const hs = pages.flatMap((p) => p.lines.map((l) => l.y1 - l.y)).filter((h) => h > 0).sort((a, b) => a - b);
  const medH = hs.length ? hs[Math.floor(hs.length / 2)] : 10;
  const xs = rows.flat().map((s) => s.x).sort((a, b) => a - b);
  const clusters = [];
  for (const x of xs) {
    const c = clusters[clusters.length - 1];
    if (c && x - c.max <= 1.2 * medH) { c.max = x; c.n += 1; } else clusters.push({ min: x, max: x, n: 1 });
  }
  let cols = clusters.filter((c) => c.n >= 2).map((c) => c.min);
  if (!cols.length) cols = [clusters[0].min];
  cols = cols.slice(0, 12);
  const nearest = (x) => cols.reduce((best, c, i) => (Math.abs(x - c) < Math.abs(x - cols[best]) ? i : best), 0);
  let id = 1;
  const out = rows.map((segs) => {
    const cells = cols.map(() => []);
    for (const s of segs) cells[nearest(s.x)].push(s);
    return {
      id: `g${id++}`,
      cells: cells.map((list) => (list.length ? makeField(list.map((s) => s.text).join(' '), list[0].ref) : emptyField())),
    };
  });
  return { columns: cols.length, rows: out };
}

// ----------------------------------------------------------------------------- entry point
/**
 * @param {{result: object, docType: 'invoice'|'receipt'|'table'|'general'}} a
 * @returns {{fields: object, items: object[], grid: object, detectedCurrencies: string[], nextId: number}}
 */
export function extractDocument({ result, docType }) {
  const pages = result.pages.map((p) => ({ index: p.index, lines: itemsToLineObjects(p.raw.items) }));
  const allText = pages.flatMap((p) => p.lines.map((l) => l.text)).join('\n');
  const out = { fields: {}, items: [], grid: { columns: 0, rows: [] }, detectedCurrencies: [], nextId: 1 };
  let id = 1;

  if (docType === 'table') {
    out.grid = extractGrid(pages);
    out.nextId = out.grid.rows.length + 1;
    return out;
  }
  if (docType === 'general') return out;

  const f = out.fields;
  f.supplier = supplierField(pages) ?? emptyField();
  if (docType === 'invoice') f.customer = customerField(pages) ?? emptyField();
  f.number = numberField(pages) ?? emptyField();
  f.issueDate = dateField(pages, ISSUE_LABEL)
    ?? (docType === 'receipt' ? firstDate(pages) : null) ?? emptyField();
  if (docType === 'invoice') f.dueDate = dateField(pages, DUE_LABEL) ?? emptyField();

  const cur = currencyField(allText);
  f.currency = cur.field;
  out.detectedCurrencies = cur.found;

  const sub = moneyField(pages, SUBTOTAL_LABEL);
  const tax = moneyField(pages, TAX_LABEL, { exclude: SUBTOTAL_LABEL });
  const tot = moneyField(pages, TOTAL_LABEL, { exclude: SUBTOTAL_LABEL });
  f.subtotal = moneyFieldOut(sub) ?? emptyField();
  f.tax = moneyFieldOut(tax) ?? emptyField();
  f.total = moneyFieldOut(tot) ?? emptyField();
  if (tax?.rate) {
    const r = tax.rate.replace(',', '.');
    f.taxRate = makeField(r, { page: tax.page, items: rangeIdxs(tax.line, tax.ratePos.from, tax.ratePos.to) }, tax.rate !== r ? `Printed as ${tax.rate}%; read as ${r}.` : null);
  } else f.taxRate = emptyField();

  const rows = docType === 'invoice' ? extractInvoiceRows(pages, (i) => result.pages.find((p) => p.index === i).raw.items) : extractReceiptRows(pages);
  out.items = rows.map((cells) => ({ id: `r${id++}`, cells }));
  out.nextId = id;
  return out;
}

function firstDate(pages) {
  for (const pg of pages) {
    for (const line of pg.lines) {
      const d = findDate(line.text, 0);
      if (d && !d.ambiguous && d.iso) return makeField(d.iso, refOf(pg.index, line, d.start, d.end));
    }
  }
  return null;
}

export { ROW_COLUMNS };
