// model.js - the editable document model (schema "invoicelens.document", version 1).
//
// SEPARATION OF DATA
//  * SOURCE: the recognition result (raw OCR / PDF text items). Never copied, never edited, frozen
//    when the editor opens. Fields point back at it with a `ref` ({page, items:[index...]}).
//  * CORRECTED: this document. Every user-visible value is a "field":
//        { value, extracted, ref, note, noteLevel }
//    `value` is what the user sees/edits (the printed text, e.g. "EUR 245.00"), `extracted` is what the
//    extractor proposed and is never changed afterwards, so "edited" == (value !== extracted).
//  * Money stays TEXT here. It is parsed to integer minor units only when validating/exporting
//    (js/doc/validate.js -> js/money.js), so nothing is rounded or "fixed" behind the user's back.
//
// All updaters are PURE: they return a new document (structural sharing) and leave the old one intact,
// which is what makes undo/redo a list of snapshots.

export const SCHEMA = 'invoicelens.document';
export const VERSION = 1;

export const DOC_TYPES = Object.freeze(['invoice', 'receipt', 'table', 'general']);
export const FIELD_KEYS = Object.freeze(['supplier', 'customer', 'number', 'issueDate', 'dueDate', 'currency', 'subtotal', 'tax', 'taxRate', 'total']);
export const FIELD_LABELS = Object.freeze({
  supplier: 'Supplier', customer: 'Customer', number: 'Invoice number', issueDate: 'Invoice date', dueDate: 'Due date',
  currency: 'Currency', subtotal: 'Subtotal', tax: 'Tax', taxRate: 'Tax rate (%)', total: 'Total amount',
});
export const MONEY_FIELDS = Object.freeze(['subtotal', 'tax', 'total']);
export const FIELDS_BY_TYPE = Object.freeze({
  invoice: FIELD_KEYS,
  receipt: Object.freeze(['supplier', 'number', 'issueDate', 'currency', 'subtotal', 'tax', 'taxRate', 'total']),
  table: Object.freeze([]),
  general: Object.freeze([]),
});
export const ROW_COLUMNS = Object.freeze(['description', 'qty', 'unit', 'total']);
export const ROW_LABELS = Object.freeze({ description: 'Description', qty: 'Qty', unit: 'Unit price', total: 'Total' });
const RECEIPT_LABELS = { number: 'Receipt number', supplier: 'Store', issueDate: 'Date' };
export const labelFor = (key, docType) => (docType === 'receipt' && RECEIPT_LABELS[key]) || FIELD_LABELS[key];

export const emptyField = () => ({ value: '', extracted: '', ref: null, note: null, noteLevel: null });
export const makeField = (value, ref = null, note = null, noteLevel = 'info') => ({ value, extracted: value, ref, note, noteLevel: note ? noteLevel : null });
export const isEdited = (f) => f.value !== f.extracted;

const emptyRowCells = () => Object.fromEntries(ROW_COLUMNS.map((c) => [c, emptyField()]));

/**
 * @param {object} a
 * @param {string} a.fileId  @param {string} a.name  @param {object} a.result  recognition result (kept by reference)
 * @param {string} a.docType @param {'suggested'|'user'} [a.typeOrigin]
 * @param {object} a.extraction  output of extractDocument()
 */
export function createDocument({ fileId, name, result, docType, typeOrigin = 'suggested', extraction }) {
  const fields = {};
  for (const k of FIELD_KEYS) fields[k] = extraction.fields[k] ?? emptyField();
  const text = {};
  result.pages.forEach((p) => { text[p.index] = { value: p.normalized.text, extracted: p.normalized.text }; });
  return {
    schema: SCHEMA, version: VERSION, fileId, name, sourceKind: result.kind,
    docType, typeOrigin,
    fields,
    items: extraction.items, // [{id, cells:{description,qty,unit,total}}]
    grid: extraction.grid, // {columns, rows:[{id, cells:[field...]}]}
    text, // sourceIndex -> {value, extracted}
    pages: result.pages.map((p) => ({ source: p.index, rotation: 0 })), // display order + view rotation
    detectedCurrencies: extraction.detectedCurrencies ?? [],
    nextId: extraction.nextId ?? 1,
  };
}

// ----------------------------------------------------------------------------- updaters
const replaceAt = (arr, i, v) => { const c = arr.slice(); c[i] = v; return c; };

export function setField(doc, key, value) {
  const f = doc.fields[key];
  if (!f || f.value === value) return doc;
  return { ...doc, fields: { ...doc.fields, [key]: { ...f, value } } };
}

const listOf = (doc, which) => (which === 'grid' ? doc.grid.rows : doc.items);
function withRows(doc, which, rows) {
  return which === 'grid' ? { ...doc, grid: { ...doc.grid, rows } } : { ...doc, items: rows };
}

/** key: column name for items, column index for grid rows. */
export function setCell(doc, which, rowId, key, value) {
  const rows = listOf(doc, which);
  const i = rows.findIndex((r) => r.id === rowId);
  if (i < 0) return doc;
  const row = rows[i];
  const cell = row.cells[key];
  if (!cell || cell.value === value) return doc;
  const cells = Array.isArray(row.cells) ? replaceAt(row.cells, key, { ...cell, value }) : { ...row.cells, [key]: { ...cell, value } };
  return withRows(doc, which, replaceAt(rows, i, { ...row, cells }));
}

export function addRow(doc, which, afterId = null) {
  const rows = listOf(doc, which);
  const id = `r${doc.nextId}`;
  const cells = which === 'grid' ? Array.from({ length: doc.grid.columns }, emptyField) : emptyRowCells();
  const at = afterId ? rows.findIndex((r) => r.id === afterId) + 1 : rows.length;
  const next = [...rows.slice(0, at), { id, cells }, ...rows.slice(at)];
  return { ...withRows(doc, which, next), nextId: doc.nextId + 1 };
}

export function removeRow(doc, which, rowId) {
  const rows = listOf(doc, which);
  if (!rows.some((r) => r.id === rowId)) return doc;
  return withRows(doc, which, rows.filter((r) => r.id !== rowId));
}

export function moveRow(doc, which, rowId, delta) {
  const rows = listOf(doc, which);
  const i = rows.findIndex((r) => r.id === rowId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= rows.length) return doc;
  const next = rows.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return withRows(doc, which, next);
}

export function setPageText(doc, source, value) {
  const t = doc.text[source];
  if (!t || t.value === value) return doc;
  return { ...doc, text: { ...doc.text, [source]: { ...t, value } } };
}

/** Move the page at display position `from` to position `to`. */
export function movePage(doc, from, to) {
  const n = doc.pages.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return doc;
  const next = doc.pages.slice();
  const [p] = next.splice(from, 1);
  next.splice(to, 0, p);
  return { ...doc, pages: next };
}

/** Rotate the page at display position `pos` (view rotation, clockwise, multiples of 90). */
export function rotatePage(doc, pos, delta = 90) {
  const p = doc.pages[pos];
  if (!p) return doc;
  const rotation = (((p.rotation + delta) % 360) + 360) % 360;
  return { ...doc, pages: replaceAt(doc.pages, pos, { ...p, rotation }) };
}

/** Switch document type: structured parts come from the new extraction; page text and page order are kept. */
export function retype(doc, docType, extraction, typeOrigin = 'user') {
  const fields = {};
  for (const k of FIELD_KEYS) fields[k] = extraction.fields[k] ?? emptyField();
  return { ...doc, docType, typeOrigin, fields, items: extraction.items, grid: extraction.grid, detectedCurrencies: extraction.detectedCurrencies ?? [], nextId: Math.max(doc.nextId, extraction.nextId ?? 1) };
}

// ----------------------------------------------------------------------------- helpers
export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** Plain JSON-safe copy (what later phases persist/export). Contains no raw OCR items. */
export const toPlain = (doc) => JSON.parse(JSON.stringify(doc));

/** Quick structural summary used in tests/UI. */
export function countEdits(doc) {
  let n = 0;
  for (const k of FIELD_KEYS) if (isEdited(doc.fields[k])) n += 1;
  for (const r of doc.items) for (const c of ROW_COLUMNS) if (isEdited(r.cells[c])) n += 1;
  for (const r of doc.grid.rows) for (const c of r.cells) if (isEdited(c)) n += 1;
  for (const t of Object.values(doc.text)) if (t.value !== t.extracted) n += 1;
  return n;
}
