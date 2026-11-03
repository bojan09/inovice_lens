// consolidated.js - ONE file from several documents, with every row traceable to its source file.
//   combined PDF      : the pages of each document's PDF, in the order given, each page labelled with its source
//   consolidated XLSX : sheets Documents (one row per file), Line items and Review notes, each with a "Source file" column
//   consolidated CSV  : the Documents or the Line items table
// Nothing is summed across documents (they may use different currencies); every amount stays on its own row.
import { loadPdfLib, loadXlsx } from './libs.js';
import { buildExportData } from './data.js';
import { currencyExponent } from '../money.js';
import { toCsv } from './util.js';
import { sheetName, EXCEL_CELL_LIMIT } from './xlsx.js';
import { winAnsi } from './pdf.js';

const aborted = (signal) => { if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' }); };
const val = (data, key) => data.fields.find((f) => f.key === key);

/** results: [{filename (of the single export), blob, data}] from exportOne (PDF). */
export async function buildCombinedPdf(results, { labelPages = true, signal, now = new Date() } = {}) {
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
  const out = await PDFDocument.create();
  out.setTitle('InvoiceLens combined export'); out.setProducer('InvoiceLens'); out.setCreator('InvoiceLens'); out.setCreationDate(now);
  out.setSubject(`Sources: ${results.map((r) => r.data.title).join(', ')}`.slice(0, 900));
  const font = await out.embedFont(StandardFonts.Helvetica);
  let replaced = 0;
  let total = 0;
  for (const r of results) {
    aborted(signal);
    const src = await PDFDocument.load(new Uint8Array(await r.blob.arrayBuffer()));
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p, i) => {
      out.addPage(p);
      total += 1;
      if (labelPages) {
        const w = winAnsi(font, `${r.data.title} · page ${i + 1} of ${pages.length}`);
        replaced += w.replaced;
        p.drawText(w.text.slice(0, 120), { x: 10, y: 6, size: 7, font, color: rgb(0.4, 0.42, 0.47), opacity: 0.9 });
      }
    });
  }
  const warnings = labelPages ? ['Each page carries a small label naming its source file.'] : [];
  if (replaced) warnings.push(`${replaced} character${replaced === 1 ? '' : 's'} in page labels could not be encoded and were replaced with "?".`);
  const bytes = await out.save();
  return { blob: new Blob([bytes], { type: 'application/pdf' }), mime: 'application/pdf', ext: 'pdf', warnings, pageCount: total };
}

/** docs: [{doc, result}] -> tables with a leading "Source file" column. */
export function consolidatedTables(docs, { now = new Date() } = {}) {
  const items = docs.map((d) => buildExportData(d.doc, { result: d.result, now }));
  const documents = [['Source file', 'Type', 'Supplier', 'Number', 'Issue date', 'Due date', 'Currency', 'Subtotal', 'Tax', 'Total', 'Open problems']];
  const lines = [['Source file', '#', 'Description', 'Qty', 'Unit price', 'Total', 'Currency']];
  const notes = [['Source file', 'Severity', 'Note']];
  const keyed = [];
  for (const d of items) {
    const money = (k) => { const f = val(d, k); return !f || f.text === '' ? null : f.kind === 'money' && f.status === 'ok' ? f.number : f.text; };
    const text = (k) => val(d, k)?.text || null;
    const problems = d.notes.filter((n) => n.severity !== 'info').length;
    documents.push([d.title, d.typeLabel, text('supplier') ?? text('customer'), text('number'), val(d, 'issueDate')?.text || null, val(d, 'dueDate')?.text || null, d.currency, money('subtotal'), money('tax'), money('total'), problems]);
    keyed.push(d);
    for (const i of d.items) lines.push([d.title, i.n, i.description, i.qty.number ?? i.qty.text, i.unit.status === 'ok' ? i.unit.number : i.unit.text, i.total.status === 'ok' ? i.total.number : i.total.text, d.currency ?? '']);
    for (const n of d.notes) notes.push([d.title, n.severity, n.message]);
  }
  return { documents, lines, notes, data: keyed };
}

export async function buildConsolidatedXlsx(docs, { signal, now = new Date() } = {}) {
  const write = await loadXlsx();
  aborted(signal);
  const { documents, lines, notes, data } = consolidatedTables(docs, { now });
  const cur = new Set(data.map((d) => d.currency).filter(Boolean));
  const exp = cur.size === 1 ? currencyExponent([...cur][0]) : 2;
  const fmt = exp ? `#,##0.${'0'.repeat(exp)}` : '#,##0';
  const cell = (v, { money = false, bold = false } = {}) => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return { value: v, type: Number, ...(money ? { format: fmt } : {}) };
    return bold ? { value: String(v).slice(0, EXCEL_CELL_LIMIT), fontWeight: 'bold' } : { value: String(v).slice(0, EXCEL_CELL_LIMIT), type: String };
  };
  const sheet = (name, rows, moneyCols) => ({
    sheet: sheetName(name), stickyRowsCount: 1,
    columns: rows[0].map((h, c) => ({ width: Math.min(50, Math.max(10, ...rows.slice(0, 100).map((r) => String(r[c] ?? '').length + 2))) })),
    data: rows.map((r, ri) => r.map((v, c) => (ri === 0 ? cell(v, { bold: true }) : cell(v, { money: moneyCols.includes(c) })))),
  });
  const sheets = [sheet('Documents', documents, [7, 8, 9])];
  if (lines.length > 1) sheets.push(sheet('Line items', lines, [4, 5]));
  if (notes.length > 1) sheets.push(sheet('Review notes', notes, []));
  const blob = await write(sheets).toBlob();
  const warnings = cur.size > 1 ? [`The documents use ${cur.size} currencies (${[...cur].join(', ')}). Amounts are NOT converted or added together.`] : [];
  return { blob, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', warnings, docsCount: docs.length };
}

export function buildConsolidatedCsv(docs, table = 'documents', { now = new Date() } = {}) {
  const t = consolidatedTables(docs, { now });
  const rows = table === 'items' ? t.lines : t.documents;
  const text = '﻿' + toCsv(rows);
  return { blob: new Blob([text], { type: 'text/csv;charset=utf-8' }), mime: 'text/csv;charset=utf-8', ext: 'csv', warnings: [], text, rows };
}
