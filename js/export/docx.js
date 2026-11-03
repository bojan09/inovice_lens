// docx.js - editable Word document reconstructed from the corrected data (headings, real tables, text).
// It does NOT reproduce the scanned layout: Word cannot faithfully rebuild an arbitrary page. Use the PDF's
// "Original appearance" mode for that.
import { loadDocx } from './libs.js';
import { minorToText } from './util.js';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export async function buildDocx(data, { signal } = {}) {
  const d = await loadDocx();
  if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, Footer } = d;

  const para = (text, opts = {}) => new Paragraph({ ...opts, children: [new TextRun({ text: String(text), ...(opts.run ?? {}) })] });
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'B8C0CC' };
  const borders = { top: border, bottom: border, left: border, right: border };
  const cell = (text, { bold = false, right = false, width } = {}) => new TableCell({
    borders, width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ alignment: right ? AlignmentType.RIGHT : AlignmentType.LEFT, children: [new TextRun({ text: String(text ?? ''), bold })] })],
  });
  const table = (rows, { header = true, widths = [], rightCols = [] } = {}) => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((r, ri) => new TableRow({ tableHeader: header && ri === 0, children: r.map((c, ci) => cell(c, { bold: header && ri === 0, right: rightCols.includes(ci), width: widths[ci] })) })),
  });

  const body = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: data.title })] }),
    para(`${data.typeLabel} · corrected values exported from InvoiceLens on ${data.generatedAt.toISOString().slice(0, 10)}`, { run: { color: '5B6578', size: 20 } }),
  ];

  const shown = data.fields.filter((f) => f.text !== '');
  if (shown.length) {
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Document details')] }));
    body.push(table(shown.map((f) => [f.label, f.text]), { header: false, widths: [35, 65] }));
  }
  if (data.docType === 'invoice' || data.docType === 'receipt') {
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 240 }, children: [new TextRun('Line items')] }));
    if (data.items.length) {
      body.push(table([['#', 'Description', 'Qty', 'Unit price', 'Total'],
        ...data.items.map((i) => [i.n, i.description, i.qty.text, i.unit.text, i.total.text])],
      { widths: [6, 44, 12, 19, 19], rightCols: [0, 2, 3, 4] }));
    } else body.push(para('No line items.'));
  }
  if (data.docType === 'table' && data.grid.length) {
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 240 }, children: [new TextRun('Table')] }));
    body.push(table(data.grid.map((r) => r.map((c) => c.text)), { header: false }));
  }
  if (data.notes.length) {
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 240 }, children: [new TextRun('Review notes')] }));
    body.push(para('These checks were still open when this file was exported.', { run: { color: '5B6578', size: 20 } }));
    for (const n of data.notes) body.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: `${n.severity}: `, bold: true }), new TextRun(n.message)] }));
  }
  data.pageText.forEach((p, i) => {
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: i > 0 || body.length > 6, children: [new TextRun(`Page ${p.position} text`)] }));
    for (const line of p.text.split(/\r?\n/)) body.push(para(line === '' ? ' ' : line));
  });

  const doc = new Document({
    creator: 'InvoiceLens', title: data.title, description: 'Corrected values exported on device by InvoiceLens',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{
      properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      footers: { default: new Footer({ children: [para('Created on your device by InvoiceLens. Recognition can be wrong; check against the original.', { run: { size: 16, color: '5B6578' } })] }) },
      children: body,
    }],
  });
  const blob = await Packer.toBlob(doc);
  return { blob, mime: DOCX_MIME, ext: 'docx', warnings: [] };
}


