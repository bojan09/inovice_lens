// pdf.js (export) - two honest PDF modes built with pdf-lib:
//   "original"   : the page images in the user's page order and rotation, optionally with an invisible text layer
//                  made of the words AS RECOGNIZED (not the user's edits). Faithful, archival, not editable.
//   "structured" : a clean reconstructed document (details, line items, page text, review notes). Editable in the
//                  sense that the text is real text; it does not copy the original layout.
// Standard fonts are WinAnsi only: characters outside it are replaced by "?" and the count is reported.
import { loadPdfLib } from './libs.js';
import { refRect, rotateNormRect } from '../doc/geometry.js';

export const PDF_MIME = 'application/pdf';
const A4 = [595.28, 841.89];
const MARGIN = 48;
const aborted = (signal) => { if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' }); };

/** Replace what the font cannot encode; returns {text, replaced}. */
export function winAnsi(font, text) {
  let replaced = 0;
  let out = '';
  for (const ch of String(text)) {
    if (ch === '\t') { out += '  '; continue; }
    if (ch === '\n' || ch === '\r') continue;
    try { font.encodeText(ch); out += ch; } catch { out += '?'; replaced += 1; }
  }
  return { text: out, replaced };
}

function pageSizeFor(resultPage, rotation) {
  const cs = resultPage?.coordSpace;
  let w;
  let h;
  if (cs?.unit === 'pt') { w = cs.width; h = cs.height; }
  else if (cs?.width && cs?.height) { // pixels of an unknown DPI: fit inside an A4 page, keep the aspect ratio
    const landscape = cs.width > cs.height;
    const box = landscape ? [A4[1], A4[0]] : A4;
    const k = Math.min(box[0] / cs.width, box[1] / cs.height);
    w = cs.width * k; h = cs.height * k;
  } else { [w, h] = A4; }
  return rotation % 180 === 0 ? [w, h] : [h, w];
}

/**
 * @param {object} data  from buildExportData
 * @param {{pages: {source:number, rotation:number}[], result: object, renderPage: (source:number, rotation:number)=>Promise<HTMLCanvasElement>,
 *          textLayer?: boolean, signal?: AbortSignal, onProgress?: (done:number,total:number)=>void}} o
 */
export async function buildOriginalPdf(data, { pages, result, renderPage, textLayer = true, signal, onProgress = () => {} }) {
  const { PDFDocument, StandardFonts, degrees } = await loadPdfLib();
  const pdf = await PDFDocument.create();
  pdf.setTitle(data.title); pdf.setProducer('InvoiceLens'); pdf.setCreator('InvoiceLens'); pdf.setCreationDate(data.generatedAt);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let replaced = 0;
  const warnings = [];
  for (let i = 0; i < pages.length; i += 1) {
    aborted(signal);
    onProgress(i, pages.length);
    const { source, rotation } = pages[i];
    const rp = result.pages.find((p) => p.index === source);
    const canvas = await renderPage(source, rotation);
    aborted(signal);
    const jpeg = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the page image'))), 'image/jpeg', 0.88));
    canvas.width = 1; canvas.height = 1; // free the (large) page bitmap as soon as it is encoded
    const img = await pdf.embedJpg(new Uint8Array(await jpeg.arrayBuffer()));
    const [W, H] = pageSizeFor(rp, rotation);
    const page = pdf.addPage([W, H]);
    page.drawImage(img, { x: 0, y: 0, width: W, height: H });
    if (textLayer && rp?.raw?.items?.length) {
      for (let k = 0; k < rp.raw.items.length; k += 1) {
        const it = rp.raw.items[k];
        const r0 = refRect(rp, { items: [k] });
        if (!r0 || !it.text.trim()) continue;
        const r = rotateNormRect(r0, rotation);
        const { text, replaced: n } = winAnsi(font, it.text);
        replaced += n;
        if (!text.trim()) continue;
        // glyph height is the word box's height in the ORIGINAL orientation; the text runs along the rotated page
        const rot = ((rotation % 360) + 360) % 360;
        const glyph = (rot % 180 === 0 ? r.h * H : r.w * W);
        const size = Math.max(4, Math.min(48, glyph * 0.8));
        const inset = glyph * 0.2;
        const spots = {
          0: { x: r.x * W, y: H - (r.y + r.h) * H + inset, a: 0 },
          90: { x: r.x * W + inset, y: H - r.y * H, a: -90 },
          180: { x: (r.x + r.w) * W, y: H - r.y * H - inset, a: 180 },
          270: { x: (r.x + r.w) * W - inset, y: H - (r.y + r.h) * H, a: 90 },
        }[rot];
        page.drawText(text, { x: spots.x, y: spots.y, size, font, opacity: 0, rotate: degrees(spots.a) });
      }
    }
  }
  onProgress(pages.length, pages.length);
  if (textLayer) warnings.push('The invisible text layer holds the words as recognized, not your edits.');
  if (replaced) warnings.push(`${replaced} character${replaced === 1 ? '' : 's'} in the text layer could not be encoded and were replaced with "?".`);
  const bytes = await pdf.save();
  return { blob: new Blob([bytes], { type: PDF_MIME }), mime: PDF_MIME, ext: 'pdf', warnings, pageCount: pages.length };
}

export async function buildStructuredPdf(data, { signal } = {}) {
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
  const pdf = await PDFDocument.create();
  pdf.setTitle(data.title); pdf.setProducer('InvoiceLens'); pdf.setCreator('InvoiceLens'); pdf.setSubject(`${data.typeLabel} (corrected values)`); pdf.setCreationDate(data.generatedAt);
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  let replaced = 0;
  const clean = (f, t) => { const r = winAnsi(f, t); replaced += r.replaced; return r.text; };

  let page = pdf.addPage(A4);
  let y = A4[1] - MARGIN;
  const W = A4[0] - 2 * MARGIN;
  const ensure = (h) => { if (y - h < MARGIN) { page = pdf.addPage(A4); y = A4[1] - MARGIN; } };
  const wrap = (text, font, size, width) => {
    const words = clean(font, text).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(t, size) <= width) cur = t;
      else {
        if (cur) lines.push(cur);
        let rest = w;
        while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) { // hard-break a very long token
          let n = rest.length - 1;
          while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > width) n -= 1;
          lines.push(rest.slice(0, n)); rest = rest.slice(n);
        }
        cur = rest;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  };
  const text = (t, { font = reg, size = 10, color = rgb(0.06, 0.09, 0.16), x = MARGIN, width = W, gap = 3 } = {}) => {
    for (const line of wrap(t, font, size, width)) {
      ensure(size + gap);
      page.drawText(line, { x, y: y - size, size, font, color });
      y -= size + gap;
    }
  };
  const heading = (t) => { y -= 10; ensure(30); text(t, { font: bold, size: 13 }); page.drawLine({ start: { x: MARGIN, y: y + 1 }, end: { x: MARGIN + W, y: y + 1 }, thickness: 0.6, color: rgb(0.75, 0.78, 0.82) }); y -= 6; };

  text(data.title, { font: bold, size: 18, gap: 6 });
  text(`${data.typeLabel} · corrected values exported by InvoiceLens on ${data.generatedAt.toISOString().slice(0, 10)}`, { size: 9, color: rgb(0.36, 0.4, 0.47), gap: 8 });

  const shown = data.fields.filter((f) => f.text !== '');
  if (shown.length) {
    heading('Document details');
    for (const f of shown) {
      const lines = wrap(f.text, reg, 10, W - 150);
      ensure(14 * lines.length);
      page.drawText(clean(bold, f.label), { x: MARGIN, y: y - 10, size: 10, font: bold });
      lines.forEach((l, i) => page.drawText(l, { x: MARGIN + 150, y: y - 10 - i * 13, size: 10, font: reg }));
      y -= 13 * lines.length + 3;
    }
  }
  const tableOut = (heads, rows, widths, rightCols) => {
    const xs = widths.reduce((a, w, i) => (a.push((a[i] ?? MARGIN) + 0), a.push(a[a.length - 1] + w), a), []).filter((_, i) => i % 2 === 1);
    const starts = [MARGIN, ...xs.slice(0, -1)];
    const drawRow = (cells, font, shade) => {
      const wrapped = cells.map((c, i) => wrap(String(c), font, 9, widths[i] - 8));
      const h = Math.max(...wrapped.map((l) => l.length)) * 12 + 6;
      ensure(h + 2);
      if (shade) page.drawRectangle({ x: MARGIN, y: y - h, width: W, height: h, color: rgb(0.93, 0.95, 0.98) });
      wrapped.forEach((lines, i) => lines.forEach((l, k) => {
        const tw = font.widthOfTextAtSize(l, 9);
        page.drawText(l, { x: rightCols.includes(i) ? starts[i] + widths[i] - 4 - tw : starts[i] + 4, y: y - 12 - k * 12, size: 9, font });
      }));
      page.drawLine({ start: { x: MARGIN, y: y - h }, end: { x: MARGIN + W, y: y - h }, thickness: 0.4, color: rgb(0.8, 0.83, 0.87) });
      y -= h;
    };
    if (heads) drawRow(heads, bold, true);
    rows.forEach((r) => drawRow(r, reg, false));
  };
  if (data.docType === 'invoice' || data.docType === 'receipt') {
    heading('Line items');
    if (data.items.length) tableOut(['#', 'Description', 'Qty', 'Unit price', 'Total'], data.items.map((i) => [i.n, i.description, i.qty.text, i.unit.text, i.total.text]), [26, W - 26 - 50 - 90 - 90, 50, 90, 90], [0, 2, 3, 4]);
    else text('No line items.');
  }
  if (data.docType === 'table' && data.grid.length) {
    heading('Table');
    const cols = Math.max(...data.grid.map((r) => r.length));
    tableOut(null, data.grid.map((r) => r.map((c) => c.text)), Array.from({ length: cols }, () => W / cols), []);
  }
  if (data.notes.length) {
    heading('Review notes');
    text('These checks were still open when this file was exported.', { size: 9, color: rgb(0.36, 0.4, 0.47) });
    for (const n of data.notes) text(`${n.severity}: ${n.message}`, { size: 9, x: MARGIN + 10, width: W - 10 });
  }
  for (const p of data.pageText) {
    aborted(signal);
    page = pdf.addPage(A4); y = A4[1] - MARGIN;
    heading(`Page ${p.position} text`);
    for (const line of p.text.split(/\r?\n/)) text(line === '' ? ' ' : line, { font: mono, size: 8.5, gap: 2 });
  }
  const warnings = [];
  if (replaced) warnings.push(`${replaced} character${replaced === 1 ? '' : 's'} could not be written with the PDF's standard font and ${replaced === 1 ? 'was' : 'were'} replaced with "?". Use Word or Excel for full Unicode.`);
  const bytes = await pdf.save();
  return { blob: new Blob([bytes], { type: PDF_MIME }), mime: PDF_MIME, ext: 'pdf', warnings, pageCount: pdf.getPageCount() };
}
