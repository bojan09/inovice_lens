// index.js (export) - one entry point for every format, support rules, file names and ZIP bundling.
import { buildExportData, tablesOf } from './data.js';
import { buildXlsx } from './xlsx.js';
import { buildDocx } from './docx.js';
import { buildOriginalPdf, buildStructuredPdf } from './pdf.js';
import { buildCsv, buildPasteText } from './csv.js';
import { safeStem, uniqueNames } from './util.js';
import { loadFflate } from './libs.js';

export const FORMATS = Object.freeze({
  pdf: { label: 'PDF', ext: 'pdf', modes: ['original', 'structured'] },
  docx: { label: 'Word', ext: 'docx', modes: ['structured'] },
  xlsx: { label: 'Excel', ext: 'xlsx', modes: ['structured'] },
  csv: { label: 'Google Sheets', ext: 'csv', modes: ['structured'] },
});

/** Why a format/mode pair is not offered, or null when it is. Shown to the user instead of silently hiding it. */
export function unsupportedReason(format, mode) {
  if (!FORMATS[format]) return 'Unknown format.';
  if (mode === 'original' && format !== 'pdf') {
    return `${FORMATS[format].label} cannot reproduce a scanned page faithfully. Use PDF with "Original appearance" for that.`;
  }
  return null;
}

/** CSV/Sheets table choices for a document type (ids from tablesOf). */
export const tableChoices = (data) => tablesOf(data).map((t) => ({ id: t.id, name: t.name }));

export const defaultCsvTable = (data) => (tableChoices(data).find((t) => t.id === 'items') ?? tableChoices(data).find((t) => t.id === 'table') ?? tableChoices(data)[0])?.id ?? null;

/**
 * Build ONE file for one document.
 * @param {{entry: {doc, result}, format: string, mode: string, pages?: number[]|null, includeNotes: boolean, includeText: boolean,
 *   textLayer: boolean, csvTable?: string, stem?: string, renderPage?: Function, signal?: AbortSignal, onProgress?: Function, now?: Date}} o
 */
export async function exportOne(o) {
  const { entry, format, mode = 'structured', pages = null, includeNotes = true, includeText = true, textLayer = true, csvTable = null, signal, onProgress } = o;
  const bad = unsupportedReason(format, mode);
  if (bad) throw new Error(bad);
  const { doc, result } = entry;
  const data = buildExportData(doc, { result, pages, includeNotes, includeText, now: o.now });
  const stem = safeStem(o.stem || doc.name);
  let out;
  if (format === 'pdf' && mode === 'original') {
    const chosen = doc.pages.filter((p) => !pages || pages.includes(p.source));
    if (!chosen.length) throw new Error('Select at least one page.');
    out = await buildOriginalPdf(data, { pages: chosen.map((p) => ({ source: p.source, rotation: p.rotation })), result, renderPage: o.renderPage, textLayer, signal, onProgress });
    return { ...out, data, doc, filename: `${stem}_original.pdf` };
  }
  if (format === 'pdf') { out = await buildStructuredPdf(data, { signal }); return { ...out, data, doc, filename: `${stem}_structured.pdf` }; }
  if (format === 'docx') { out = await buildDocx(data, { signal }); return { ...out, data, doc, filename: `${stem}.docx` }; }
  if (format === 'xlsx') { out = await buildXlsx(data, { signal }); return { ...out, data, doc, filename: `${stem}.xlsx` }; }
  const table = csvTable ?? defaultCsvTable(data);
  out = buildCsv(data, table);
  return { ...out, data, doc, filename: `${stem}_${safeStem(out.table, 'table').toLowerCase()}.csv` };
}

export { buildPasteText };

/** Bundle several results into one ZIP (fflate). Names are made unique. */
export async function zipResults(results, { now = new Date() } = {}) {
  const { zipSync } = await loadFflate();
  const names = uniqueNames(results.map((r) => r.filename));
  const files = {};
  for (let i = 0; i < results.length; i += 1) files[names[i]] = new Uint8Array(await results[i].blob.arrayBuffer());
  const bytes = zipSync(files, { level: 6, mtime: now });
  return { blob: new Blob([bytes], { type: 'application/zip' }), filename: `invoicelens-export-${now.toISOString().slice(0, 10)}.zip`, mime: 'application/zip', names };
}
