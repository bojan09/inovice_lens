// data.js - the neutral, format-independent export model built from the CORRECTED document.
// Every exporter reads this and nothing else, so PDF / Word / Excel / CSV cannot disagree.
// Money is parsed with js/money.js to integer minor units; unreadable or ambiguous amounts stay TEXT
// (never guessed). Nothing is recomputed: totals are exactly what the user's document says.

import { currencyExponent } from '../money.js';
import { readAmount, validateDocument } from '../doc/validate.js';
import { FIELDS_BY_TYPE, labelFor, ROW_COLUMNS, ROW_LABELS, MONEY_FIELDS } from '../doc/model.js';
import { isRealDate } from '../doc/dates.js';
import { minorToText, minorToNumber } from './util.js';
import { CATEGORY_LABELS } from '../recognition/classify.js';

const PLAIN_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function money(text, currency) {
  const r = readAmount(text, { currencyHint: currency });
  if (r.status !== 'ok') return { text, minor: null, status: r.status };
  const exp = currencyExponent(r.currency ?? currency);
  return { text, minor: r.minor, exp, canonical: minorToText(r.minor, exp), number: minorToNumber(r.minor, exp), status: 'ok' };
}
const isoDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  return m && isRealDate(+m[1], +m[2], +m[3]) ? m[0] : null;
};

/**
 * @param {object} doc  corrected document
 * @param {{result?: object, pages?: number[], includeNotes?: boolean, includeText?: boolean, now?: Date}} opts
 *   pages: SOURCE page indexes to include (default all), always emitted in the document's page order.
 */
export function buildExportData(doc, { result = null, pages = null, includeNotes = true, includeText = true, now = new Date() } = {}) {
  const cur = /^[A-Z]{3}$/.test((doc.fields.currency?.value ?? '').trim()) ? doc.fields.currency.value.trim() : null;
  const keys = FIELDS_BY_TYPE[doc.docType];
  const fields = keys.map((key) => {
    const text = doc.fields[key].value.trim();
    const label = labelFor(key, doc.docType);
    if (!text) return { key, label, kind: 'text', text: '' };
    if (MONEY_FIELDS.includes(key)) return { key, label, kind: 'money', ...money(text, cur) };
    if (key === 'issueDate' || key === 'dueDate') return { key, label, kind: 'date', text, iso: isoDate(text) };
    if (key === 'taxRate') return { key, label, kind: 'percent', text, number: PLAIN_NUMBER.test(text) ? Number(text) : null };
    return { key, label, kind: 'text', text };
  });

  const items = doc.items.map((row, i) => {
    const c = row.cells;
    const qty = c.qty.value.trim();
    return {
      n: i + 1,
      description: c.description.value.trim(),
      qty: { text: qty, number: PLAIN_NUMBER.test(qty) ? Number(qty) : null },
      unit: money(c.unit.value.trim(), cur),
      total: money(c.total.value.trim(), cur),
    };
  });

  const grid = doc.grid.rows.map((r) => r.cells.map((cell) => {
    const t = cell.value.trim();
    // only plain numbers without leading zeros become numbers; "007", "1,234", phone numbers stay text
    return { text: t, number: PLAIN_NUMBER.test(t) && !/^-?0\d/.test(t) && t.length < 16 ? Number(t) : null };
  }));

  const want = pages ? new Set(pages) : null;
  const pageText = doc.pages.filter((p) => !want || want.has(p.source)).map((p) => ({ position: doc.pages.indexOf(p) + 1, source: p.source, rotation: p.rotation, text: doc.text[p.source].value }));

  const notes = includeNotes && result !== null
    ? validateDocument(doc, { result }).map((i) => ({ severity: i.severity, message: i.message }))
    : [];

  return {
    title: doc.name,
    docType: doc.docType,
    typeLabel: CATEGORY_LABELS[doc.docType],
    currency: cur,
    fields, items, grid,
    pageText: includeText ? pageText : [],
    allPages: doc.pages.map((p, i) => ({ position: i + 1, source: p.source, rotation: p.rotation })),
    selectedPages: pageText.map((p) => p.source),
    notes,
    generatedAt: now,
    itemColumns: ROW_COLUMNS.map((c) => ({ key: c, label: ROW_LABELS[c] })),
  };
}

/** The tabular views an exporter / CSV can write: [{id, name, rows: (string|number|null)[][] , header:boolean}] */
export function tablesOf(data) {
  const out = [];
  if (data.fields.length) {
    out.push({ id: 'summary', name: 'Summary', header: true, rows: [['Field', 'Value'], ...data.fields.filter((f) => f.text !== '' || f.kind === 'money').map((f) => [f.label, f.kind === 'money' && f.status === 'ok' ? f.number : f.kind === 'percent' && f.number !== null ? f.number : f.text])] });
  }
  if (data.docType === 'invoice' || data.docType === 'receipt') {
    out.push({
      id: 'items', name: 'Line items', header: true,
      rows: [['#', 'Description', 'Qty', 'Unit price', 'Total', 'Currency'], ...data.items.map((i) => [i.n, i.description, i.qty.number ?? i.qty.text, i.unit.status === 'ok' ? i.unit.number : i.unit.text, i.total.status === 'ok' ? i.total.number : i.total.text, data.currency ?? ''])],
    });
  }
  if (data.docType === 'table' && data.grid.length) {
    out.push({ id: 'table', name: 'Table', header: false, rows: data.grid.map((r) => r.map((c) => c.number ?? c.text)) });
  }
  if (data.pageText.length) {
    out.push({ id: 'text', name: 'Page text', header: true, rows: [['Page', 'Line', 'Text'], ...data.pageText.flatMap((p) => p.text.split(/\r?\n/).map((line, i) => [p.position, i + 1, line]))] });
  }
  if (data.notes.length) {
    out.push({ id: 'notes', name: 'Review notes', header: true, rows: [['Severity', 'Note'], ...data.notes.map((n) => [n.severity, n.message])] });
  }
  return out;
}

/** CSV rows for a table: money cells use the exact canonical decimal text (never a float). */
export function csvRows(table, data) {
  if (table.id === 'items') {
    return [table.rows[0], ...data.items.map((i) => [i.n, i.description, i.qty.text, i.unit.status === 'ok' ? i.unit.canonical : i.unit.text, i.total.status === 'ok' ? i.total.canonical : i.total.text, data.currency ?? ''])]; // amounts are plain decimals: the currency travels in its own column
  }
  if (table.id === 'summary') {
    return [table.rows[0], ...data.fields.filter((f) => f.text !== '').map((f) => [f.label, f.kind === 'money' && f.status === 'ok' ? f.canonical : f.text])];
  }
  return table.rows.map((r) => r.map((c) => (typeof c === 'number' ? String(c) : c)));
}
