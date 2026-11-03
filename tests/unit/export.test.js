// Export tests. Pure helpers are tested directly; the generated PDF / DOCX / XLSX / CSV files are then re-opened
// with INDEPENDENT tools (poppler pdftotext/pdfinfo, python-docx, openpyxl, LibreOffice) and compared with the
// corrected model. Tests that need an external tool are skipped (and reported as skipped) when it is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeStem, uniqueNames, minorToText, minorToNumber, guardCell, toCsv, toTsv } from '../../js/export/util.js';
import { buildExportData, tablesOf, csvRows } from '../../js/export/data.js';
import { exportOne, unsupportedReason, zipResults, FORMATS } from '../../js/export/index.js';
import { winAnsi } from '../../js/export/pdf.js';
import { extractDocument } from '../../js/doc/extract.js';
import * as M from '../../js/doc/model.js';
import { invoiceItems, resultOf, layout } from './doc-helpers.js';

const have = (cmd, args = ['--version']) => { try { return spawnSync(cmd, args, { encoding: 'utf8' }).status !== null; } catch { return false; } };
const py = (code, ...args) => spawnSync('python3', ['-I', '-c', code, ...args], { encoding: 'utf8' });
const HAVE = {
  poppler: have('pdftotext', ['-v']),
  openpyxl: py('import openpyxl').status === 0,
  docx: py('import docx').status === 0,
  soffice: have('soffice'),
};
const tmp = () => mkdtempSync(join(tmpdir(), 'il-export-'));

function fixtureDoc({ edit = true } = {}) {
  const result = resultOf(invoiceItems());
  let doc = M.createDocument({ fileId: 'f1', name: 'Invoice 03/11 é.png', result, docType: 'invoice', extraction: extractDocument({ result, docType: 'invoice' }) });
  if (edit) {
    doc = M.setField(doc, 'supplier', 'Müller & Söhne GmbH – “Test”, 100% <ok>');
    doc = M.setCell(doc, 'items', doc.items[0].id, 'description', 'Spéciale “quote”, with, commas\nand a newline');
  }
  return { entry: { doc, result }, doc, result };
}
const bytesOf = async (r) => Buffer.from(await r.blob.arrayBuffer());

// ------------------------------------------------------------------ pure helpers
test('safeStem: no path separators, accents folded, never empty', () => {
  assert.equal(safeStem('Invoice 03/11 é.png'), 'Invoice_03_11_e');
  assert.equal(safeStem('../../etc/passwd'), 'etc_passwd');
  assert.equal(safeStem('.pdf'), 'document');
  assert.equal(safeStem(''), 'document');
  assert.ok(safeStem('x'.repeat(300)).length <= 80);
  assert.deepEqual(uniqueNames(['a.pdf', 'A.pdf', 'b.pdf', 'a.pdf']), ['a.pdf', 'A (2).pdf', 'b.pdf', 'a (3).pdf']);
});

test('minorToText is exact for every exponent and sign; minorToNumber matches it', () => {
  assert.equal(minorToText(24500, 2), '245.00');
  assert.equal(minorToText(5, 2), '0.05');
  assert.equal(minorToText(-5, 2), '-0.05');
  assert.equal(minorToText(7, 0), '7');
  assert.equal(minorToText(1234, 3), '1.234');
  assert.equal(minorToText(Number.MAX_SAFE_INTEGER, 2), '90071992547409.91');
  assert.equal(minorToNumber(1023016, 2), 10230.16);
  assert.throws(() => minorToText(1.5, 2), RangeError);
});

test('CSV: RFC 4180 quoting, CRLF, formula-injection guard on text only, numbers verbatim', () => {
  assert.equal(guardCell('=HYPERLINK("x")'), `'=HYPERLINK("x")`);
  assert.equal(guardCell('-5'), '-5', 'a real negative number is not text');
  assert.equal(guardCell('@cmd'), "'@cmd");
  assert.equal(guardCell('Total'), 'Total');
  const csv = toCsv([['a,b', 'say "hi"', 'x\ny', null, 12.5, '=1+1']]);
  assert.equal(csv, '"a,b","say ""hi""","x\ny",,12.5,\'=1+1\r\n');
  assert.equal(toTsv([['a\tb', 'c\nd', 1]]), 'a b\tc d\t1');
});

test('winAnsi replaces what the standard font cannot encode and counts it', async () => {
  const { PDFDocument, StandardFonts } = await import('../../vendor/pdf-lib/pdf-lib.esm.min.js');
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  assert.deepEqual(winAnsi(font, 'Müller – “x” €'), { text: 'Müller – “x” €', replaced: 0 });
  assert.deepEqual(winAnsi(font, 'Привет 日本'), { text: '?????? ??', replaced: 8 });
});

// ------------------------------------------------------------------ export data
test('export data: amounts parsed to minor units, typed text kept, ambiguous/unreadable amounts stay text', () => {
  let { doc, result } = fixtureDoc({ edit: false });
  doc = M.setField(doc, 'subtotal', '1,234');
  doc = M.setField(doc, 'tax', 'lots');
  const d = buildExportData(doc, { result });
  const f = (k) => d.fields.find((x) => x.key === k);
  assert.equal(f('total').minor, 24500);
  assert.equal(f('total').canonical, '245.00');
  assert.equal(f('total').text, 'EUR 245.00', 'the user-visible text is not rewritten');
  assert.equal(f('subtotal').status, 'ambiguous');
  assert.equal(f('subtotal').minor, null);
  assert.equal(f('tax').status, 'invalid');
  assert.equal(f('issueDate').iso, '2026-11-03');
  assert.equal(d.items[0].unit.minor, 8000);
  assert.equal(d.items[0].qty.number, 2);
  const sheets = tablesOf(d);
  assert.deepEqual(sheets.map((s) => s.id), ['summary', 'items', 'text', 'notes']);
  const summary = Object.fromEntries(sheets[0].rows.slice(1));
  assert.equal(summary['Total amount'], 245, 'numeric cell');
  assert.equal(summary['Subtotal'], '1,234', 'ambiguous amount stays text, never guessed');
  assert.ok(d.notes.some((n) => /ambiguous/.test(n.message)), 'open problems travel with the export');
});

test('export data: selected pages only, in the document page order; table docs and general docs', () => {
  const result = resultOf(invoiceItems());
  result.pages.push({ ...result.pages[0], index: 1, normalized: { lines: [], text: 'second page' } });
  let doc = M.createDocument({ fileId: 'f', name: 'n.pdf', result, docType: 'general', extraction: extractDocument({ result, docType: 'general' }) });
  doc = M.movePage(doc, 1, 0);
  const all = buildExportData(doc, { result });
  assert.deepEqual(all.pageText.map((p) => [p.position, p.source]), [[1, 1], [2, 0]]);
  assert.deepEqual(buildExportData(doc, { result, pages: [0] }).pageText.map((p) => p.source), [0]);
  assert.deepEqual(buildExportData(doc, { result, includeText: false }).pageText, []);
  const grid = layout([['Product', 'Jan'], ['Widget', '007'], ['Gadget', '15']].flatMap((r, i) => r.map((t, c) => ({ y: 100 + i * 70, x: 100 + c * 300, text: t }))));
  const r2 = resultOf(grid);
  const tdoc = M.createDocument({ fileId: 'f', name: 't.png', result: r2, docType: 'table', extraction: extractDocument({ result: r2, docType: 'table' }) });
  const t = tablesOf(buildExportData(tdoc, { result: r2 })).find((x) => x.id === 'table');
  assert.deepEqual(t.rows, [['Product', 'Jan'], ['Widget', '007'], ['Gadget', 15]], 'leading-zero ids stay text, plain numbers become numbers');
});

test('format support: only PDF has "original appearance"; others say why', () => {
  assert.equal(unsupportedReason('pdf', 'original'), null);
  for (const f of ['docx', 'xlsx', 'csv']) assert.match(unsupportedReason(f, 'original'), /cannot reproduce a scanned page/);
  assert.deepEqual(Object.keys(FORMATS), ['pdf', 'docx', 'xlsx', 'csv']);
});

// ------------------------------------------------------------------ real files, re-opened by independent readers
test('CSV: BOM + CRLF, exact decimal text, and Python csv reads back the same cells', async () => {
  const { entry } = fixtureDoc();
  const r = await exportOne({ entry, format: 'csv', csvTable: 'items', now: new Date('2026-11-03T00:00:00Z') });
  assert.equal(r.filename, 'Invoice_03_11_e_line_items.csv');
  const buf = await bytesOf(r);
  assert.deepEqual([...buf.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM');
  const dir = tmp(); const f = join(dir, 'a.csv'); writeFileSync(f, buf);
  const out = py('import csv,sys,json;print(json.dumps(list(csv.reader(open(sys.argv[1],encoding="utf-8-sig",newline=""))), ensure_ascii=False))', f);
  const rows = JSON.parse(out.stdout);
  assert.deepEqual(rows[0], ['#', 'Description', 'Qty', 'Unit price', 'Total']);
  assert.deepEqual(rows[1], ['1', 'Spéciale “quote”, with, commas\nand a newline', '2', '80.00', '160.00'], 'quotes, commas, newlines and Unicode survive');
  assert.deepEqual(rows[2], ['2', 'Product B', '1', '85.00', '85.00']);
});

test('XLSX: numeric cells, number formats, real dates, Unicode; openpyxl and LibreOffice both open it', { skip: !HAVE.openpyxl }, async () => {
  const { entry } = fixtureDoc();
  const r = await exportOne({ entry, format: 'xlsx' });
  assert.equal(r.mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const dir = tmp(); const f = join(dir, 'a.xlsx'); writeFileSync(f, await bytesOf(r));
  const code = `
import openpyxl,sys,json,datetime
wb=openpyxl.load_workbook(sys.argv[1])
out={'sheets':wb.sheetnames}
s=wb['Summary']; out['summary']={r[0].value:[r[1].value,r[1].data_type,r[1].number_format] for r in s.iter_rows(min_row=2)}
i=wb['Line items']; out['items']=[[c.value for c in r] for r in i.iter_rows()]; out['item_types']=[[c.data_type for c in r] for r in i.iter_rows(min_row=2)]
out['fmt']=[c.number_format for c in list(i.iter_rows(min_row=2))[0]]
out['date']=str(s['B5'].value)
print(json.dumps(out,ensure_ascii=False,default=str))`;
  const o = JSON.parse(py(code, f).stdout);
  assert.deepEqual(o.sheets, ['Summary', 'Line items', 'Page text', 'Review notes'].filter((n) => o.sheets.includes(n)));
  assert.equal(o.summary['Supplier'][0], 'Müller & Söhne GmbH – “Test”, 100% <ok>');
  assert.deepEqual(o.summary['Total amount'].slice(0, 2), [245, 'n'], 'a NUMBER, not the text "EUR 245.00"');
  assert.equal(o.summary['Total amount'][2], '#,##0.00');
  assert.match(o.summary['Invoice date'][0], /^2026-11-03/);
  assert.equal(o.summary['Invoice date'][1], 'd', 'a real date cell');
  assert.deepEqual(o.items[1].slice(0, 1).concat(o.items[1].slice(2)), [1, 2, 80, 160]);
  assert.deepEqual(o.item_types[0].slice(2), ['n', 'n', 'n']);
  assert.deepEqual(o.items[2], [2, 'Product B', 1, 85, 85]);
  if (HAVE.soffice) {
    const conv = spawnSync('soffice', ['--headless', '--convert-to', 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1', '--outdir', dir, f], { encoding: 'utf8', timeout: 120000 });
    assert.equal(conv.status, 0, conv.stderr);
    const csvs = readdirSync(dir).filter((n) => n.endsWith('.csv'));
    assert.ok(csvs.length >= 2, `LibreOffice opened the workbook and wrote its sheets (${csvs.join(', ')})`);
    const items = readFileSync(join(dir, csvs.find((n) => /Line/.test(n))), 'utf8');
    assert.match(items, /\n2,Product B,1,85,85\n/, "LibreOffice reads the amounts as numbers");
  }
});

test('DOCX: python-docx reads headings, the details table and the line-item table', { skip: !HAVE.docx }, async () => {
  const { entry } = fixtureDoc();
  const r = await exportOne({ entry, format: 'docx' });
  const dir = tmp(); const f = join(dir, 'a.docx'); writeFileSync(f, await bytesOf(r));
  const o = JSON.parse(py(`
import docx,sys,json
d=docx.Document(sys.argv[1])
print(json.dumps({'paras':[p.text for p in d.paragraphs],'tables':[[[c.text for c in r.cells] for r in t.rows] for t in d.tables],'title':d.core_properties.title,'author':d.core_properties.author},ensure_ascii=False))`, f).stdout);
  assert.equal(o.title, 'Invoice 03/11 é.png');
  assert.equal(o.author, 'InvoiceLens');
  assert.ok(o.paras.includes('Document details') && o.paras.includes('Line items'));
  const details = Object.fromEntries(o.tables[0]);
  assert.equal(details['Supplier'], 'Müller & Söhne GmbH – “Test”, 100% <ok>');
  assert.equal(details['Total amount'], 'EUR 245.00');
  assert.deepEqual(o.tables[1][0], ['#', 'Description', 'Qty', 'Unit price', 'Total']);
  assert.deepEqual(o.tables[1][2], ['2', 'Product B', '1', '85.00', '85.00']);
  if (HAVE.soffice) {
    const conv = spawnSync('soffice', ['--headless', '--convert-to', 'txt:Text', '--outdir', dir, f], { encoding: 'utf8', timeout: 120000 });
    assert.equal(conv.status, 0, conv.stderr);
    assert.match(readFileSync(join(dir, 'a.txt'), 'utf8'), /Product A/);
  }
});

test('structured PDF: pdfinfo + pdftotext find the corrected values, metadata and the page text', { skip: !HAVE.poppler }, async () => {
  const { entry } = fixtureDoc();
  const r = await exportOne({ entry, format: 'pdf', mode: 'structured' });
  assert.equal(r.filename, 'Invoice_03_11_e_structured.pdf');
  const dir = tmp(); const f = join(dir, 'a.pdf'); writeFileSync(f, await bytesOf(r));
  const info = spawnSync('pdfinfo', [f], { encoding: 'utf8' }).stdout;
  assert.match(info, /Pages:\s+2/);
  assert.match(info, /Title:\s+Invoice 03\/11 é\.png/);
  assert.match(info, /Producer:\s+InvoiceLens/);
  const text = spawnSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }).stdout;
  for (const must of ['Müller & Söhne GmbH – “Test”, 100% <ok>', 'INV-00482', '2026-11-03', 'EUR 245.00', 'Product B', '85.00', 'Product A']) assert.ok(text.includes(must), `pdftotext output contains "${must}"`);
  assert.equal((r.warnings ?? []).length, 0);
});

test('structured PDF: non-WinAnsi characters are replaced AND reported (not silently dropped)', { skip: !HAVE.poppler }, async () => {
  let { entry, doc } = fixtureDoc({ edit: false });
  doc = M.setField(doc, 'supplier', 'Привет ООО');
  const r = await exportOne({ entry: { doc, result: entry.result }, format: 'pdf', mode: 'structured' });
  assert.ok(r.warnings.some((w) => /8 characters|\d+ characters? could not be written/.test(w)));
  const dir = tmp(); const f = join(dir, 'a.pdf'); writeFileSync(f, await bytesOf(r));
  assert.match(spawnSync('pdftotext', [f, '-'], { encoding: 'utf8' }).stdout, /\?{6}/);
});

test('structured PDF: a long document paginates and every line is still present', { skip: !HAVE.poppler }, async () => {
  const result = resultOf(invoiceItems());
  let doc = M.createDocument({ fileId: 'f', name: 'long.png', result, docType: 'invoice', extraction: extractDocument({ result, docType: 'invoice' }) });
  for (let i = 0; i < 70; i += 1) { doc = M.addRow(doc, 'items'); const id = doc.items.at(-1).id; doc = M.setCell(doc, 'items', id, 'description', `Extra row number ${i + 1} with a rather long description that has to wrap onto another line`); doc = M.setCell(doc, 'items', id, 'total', `${i + 1}.00`); }
  const r = await exportOne({ entry: { doc, result }, format: 'pdf', mode: 'structured' });
  const dir = tmp(); const f = join(dir, 'a.pdf'); writeFileSync(f, await bytesOf(r));
  assert.ok(Number(/Pages:\s+(\d+)/.exec(spawnSync('pdfinfo', [f], { encoding: 'utf8' }).stdout)[1]) >= 3);
  const text = spawnSync('pdftotext', [f, '-'], { encoding: 'utf8' }).stdout.replace(/\s+/g, ' ');
  for (const n of [1, 35, 70]) assert.ok(text.includes(`Extra row number ${n} with`), `row ${n} present`);
});

test('unsupported combination throws with the reason; empty selections are rejected', async () => {
  const { entry } = fixtureDoc();
  await assert.rejects(exportOne({ entry, format: 'docx', mode: 'original' }), /cannot reproduce a scanned page/);
  await assert.rejects(exportOne({ entry, format: 'pdf', mode: 'original', pages: [], renderPage: async () => null }), /Select at least one page/);
});

test('cancellation: an aborted signal stops the build with AbortError', async () => {
  const { entry } = fixtureDoc();
  const c = new AbortController(); c.abort();
  for (const format of ['docx', 'xlsx']) await assert.rejects(exportOne({ entry, format, signal: c.signal }), (e) => e.name === 'AbortError');
});

test('ZIP: several exports bundled with unique names; python zipfile validates and re-reads each member', async () => {
  const a = fixtureDoc();
  const rs = [await exportOne({ entry: a.entry, format: 'csv', csvTable: 'items' }), await exportOne({ entry: a.entry, format: 'csv', csvTable: 'items' })];
  const z = await zipResults(rs, { now: new Date('2026-11-03T12:00:00Z') });
  assert.equal(z.filename, 'invoicelens-export-2026-11-03.zip');
  assert.deepEqual(z.names, ['Invoice_03_11_e_line_items.csv', 'Invoice_03_11_e_line_items (2).csv']);
  const dir = tmp(); const f = join(dir, 'a.zip'); writeFileSync(f, Buffer.from(await z.blob.arrayBuffer()));
  const o = JSON.parse(py('import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps({"bad":z.testzip(),"names":z.namelist(),"sizes":[len(z.read(n)) for n in z.namelist()]}))', f).stdout);
  assert.equal(o.bad, null);
  assert.deepEqual(o.names, z.names);
  assert.ok(o.sizes.every((n) => n > 50));
});

// ------------------------------------------------------------------ Office package integrity (what Word/Excel reject files for)
const ooxmlReport = (file) => JSON.parse(py(`
import zipfile,sys,json,re,posixpath
import xml.etree.ElementTree as ET
z=zipfile.ZipFile(sys.argv[1]); names=z.namelist(); out={'bad':z.testzip(),'problems':[],'parts':len(names)}
ct=ET.fromstring(z.read('[Content_Types].xml')); ns='{http://schemas.openxmlformats.org/package/2006/content-types}'
defaults={d.get('Extension').lower() for d in ct.findall(ns+'Default')}; overrides={o.get('PartName') for o in ct.findall(ns+'Override')}
for n in names:
    if n=='[Content_Types].xml' or n.endswith('/'): continue
    if '/'+n not in overrides and n.rsplit('.',1)[-1].lower() not in defaults: out['problems'].append('no content type: '+n)
    if n.endswith(('.xml','.rels')):
        try: ET.fromstring(z.read(n))
        except Exception as e: out['problems'].append('not well-formed: '+n+' '+str(e))
    if n.endswith('.rels'):
        base=posixpath.dirname(posixpath.dirname(n))
        for r in ET.fromstring(z.read(n)):
            if r.get('TargetMode')=='External': continue
            t=r.get('Target'); p=t.lstrip('/') if t.startswith('/') else posixpath.normpath(posixpath.join(base,t))
            if p not in names: out['problems'].append('dangling relationship: '+n+' -> '+t)
if len(set(n.lower() for n in names))!=len(names): out['problems'].append('duplicate part names')
print(json.dumps(out))`, file).stdout);

test('XLSX and DOCX packages: every part has a content type, every relationship resolves, all XML is well-formed', { skip: !HAVE.openpyxl }, async () => {
  const { entry } = fixtureDoc();
  for (const format of ['xlsx', 'docx']) {
    const r = await exportOne({ entry, format });
    const f = join(tmp(), `a.${format}`); writeFileSync(f, await bytesOf(r));
    const rep = ooxmlReport(f);
    assert.equal(rep.bad, null);
    assert.deepEqual(rep.problems, [], `${format}: ${rep.problems.join('; ')}`);
    assert.ok(rep.parts >= 5);
  }
});

test('XLSX limits Excel enforces: sheet names are legal and over-long cells are shortened with a warning', async () => {
  const { sheetName, EXCEL_CELL_LIMIT } = await import('../../js/export/xlsx.js');
  assert.equal(sheetName('Page/text: [1]*?'), 'Page text 1');
  assert.equal(sheetName('x'.repeat(50)).length, 31);
  assert.equal(sheetName('///'), 'Sheet');
  let { entry, doc } = fixtureDoc({ edit: false });
  doc = M.setPageText(doc, 0, 'x'.repeat(EXCEL_CELL_LIMIT + 500));
  const r = await exportOne({ entry: { doc, result: entry.result }, format: 'xlsx' });
  assert.match(r.warnings[0], /longer than Excel's 32,767-character limit/);
  if (HAVE.openpyxl) {
    const f = join(tmp(), 'a.xlsx'); writeFileSync(f, await bytesOf(r));
    const n = py('import openpyxl,sys;wb=openpyxl.load_workbook(sys.argv[1]);ws=wb["Page text"];print(max(len(str(c.value or "")) for row in ws.iter_rows() for c in row))', f).stdout.trim();
    assert.equal(Number(n), EXCEL_CELL_LIMIT);
  }
});

// ------------------------------------------------------------------ Phase 5: combined / consolidated exports
import { exportCombined, combineReason } from '../../js/export/index.js';
import { consolidatedTables } from '../../js/export/consolidated.js';

function twoDocs() {
  const mkDoc = (name, supplier, qtyTotal, cur = 'EUR') => {
    const items = layout([
      { y: 90, x: 90, text: supplier, h: 54 }, { y: 190, x: 820, text: 'Invoice No: INV-' + name.slice(0, 2) }, { y: 240, x: 820, text: 'Date: 03 Nov 2026' },
      { y: 574, x: 100, text: 'Description' }, { y: 574, x: 640, text: 'Qty' }, { y: 574, x: 780, text: 'Unit Price' }, { y: 574, x: 1000, text: 'Total' },
      { y: 650, x: 100, text: 'Widget' }, { y: 650, x: 660, text: '1' }, { y: 650, x: 800, text: qtyTotal }, { y: 650, x: 1010, text: qtyTotal },
      { y: 840, x: 780, text: `Subtotal ${qtyTotal}`, h: 34 }, { y: 895, x: 780, text: 'Tax (0%) 0.00', h: 34 }, { y: 960, x: 780, text: `Total ${cur} ${qtyTotal}`, h: 40 },
    ]);
    const result = resultOf(items);
    const doc = M.createDocument({ fileId: name, name, result, docType: 'invoice', extraction: extractDocument({ result, docType: 'invoice' }) });
    return { doc, result };
  };
  return [mkDoc('first.png', 'Alpha Ltd', '100.00'), mkDoc('second.png', 'Beta GmbH', '250.50', 'USD')];
}

test('consolidated tables: one row per document, every line item carries its source file, nothing is summed across currencies', () => {
  const t = consolidatedTables(twoDocs());
  assert.deepEqual(t.documents[0].slice(0, 4), ['Source file', 'Type', 'Supplier', 'Number']);
  assert.deepEqual(t.documents.slice(1).map((r) => [r[0], r[2], r[6], r[9]]), [['first.png', 'Alpha Ltd', 'EUR', 100], ['second.png', 'Beta GmbH', 'USD', 250.5]]);
  assert.deepEqual(t.lines.slice(1).map((r) => [r[0], r[2], r[5]]), [['first.png', 'Widget', 100], ['second.png', 'Widget', 250.5]]);
  assert.equal(t.documents.length, 3, 'no totals row was invented');
});

test('consolidated XLSX: openpyxl reads numeric cells with the source file on every row; a currency warning is raised', { skip: !HAVE.openpyxl }, async () => {
  const r = await exportCombined({ format: 'xlsx', entries: twoDocs(), now: new Date('2026-11-03T00:00:00Z') });
  assert.equal(r.filename, 'invoicelens-consolidated_2026-11-03.xlsx');
  assert.match(r.warnings[0], /2 currencies \(EUR, USD\).*NOT converted or added together/);
  const f = join(tmp(), 'c.xlsx'); writeFileSync(f, await bytesOf(r));
  const o = JSON.parse(py(`
import openpyxl,sys,json
wb=openpyxl.load_workbook(sys.argv[1]); d=wb['Documents']; l=wb['Line items']
print(json.dumps({'sheets':wb.sheetnames,'docs':[[c.value for c in r] for r in d.iter_rows(min_row=2)],'types':[c.data_type for c in list(d.iter_rows(min_row=2))[0]],'lines':[[c.value for c in r] for r in l.iter_rows(min_row=2)]},default=str))`, f).stdout);
  assert.deepEqual(o.sheets.slice(0, 2), ['Documents', 'Line items']);
  assert.deepEqual(o.docs.map((r) => [r[0], r[2], r[6], r[9]]), [['first.png', 'Alpha Ltd', 'EUR', 100], ['second.png', 'Beta GmbH', 'USD', 250.5]]);
  assert.equal(o.types[9], 'n');
  assert.deepEqual(o.lines.map((r) => [r[0], r[5]]), [['first.png', 100], ['second.png', 250.5]]);
});

test('consolidated CSV: source file column, exact text, BOM', async () => {
  const r = await exportCombined({ format: 'csv', entries: twoDocs(), csvTable: 'items', now: new Date('2026-11-03T00:00:00Z') });
  assert.equal(r.filename, 'invoicelens-consolidated_items_2026-11-03.csv');
  assert.match(r.text, /^﻿Source file,#,Description,Qty,Unit price,Total\r\nfirst\.png,1,Widget,1,100,100\r\n/);
});

test('combined PDF: page count is the sum, pages are labelled with their source, order is kept (poppler)', { skip: !HAVE.poppler }, async () => {
  const [a, b] = twoDocs();
  const ra = await exportOne({ entry: a, format: 'pdf', mode: 'structured' });
  const rb = await exportOne({ entry: b, format: 'pdf', mode: 'structured' });
  const r = await exportCombined({ format: 'pdf', entries: [a, b], results: [ra, rb], now: new Date('2026-11-03T00:00:00Z') });
  assert.equal(r.filename, 'invoicelens-combined_2026-11-03.pdf');
  const f = join(tmp(), 'c.pdf'); writeFileSync(f, await bytesOf(r));
  const info = pdfinfoOf(f);
  assert.equal(Number(/Pages:\s+(\d+)/.exec(info)[1]), r.pageCount);
  assert.equal(r.pageCount, ra.pageCount + rb.pageCount);
  const text = spawnSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }).stdout;
  assert.ok(text.indexOf('Alpha Ltd') < text.indexOf('Beta GmbH'), 'order kept');
  assert.match(text, /first\.png · page 1 of \d/);
  assert.match(text, /second\.png · page 1 of \d/);
  const unlabeled = await exportCombined({ format: 'pdf', entries: [a, b], results: [ra, rb], labelPages: false });
  const f2 = join(tmp(), 'd.pdf'); writeFileSync(f2, await bytesOf(unlabeled));
  assert.ok(!/page 1 of/.test(spawnSync('pdftotext', [f2, '-'], { encoding: 'utf8' }).stdout));
});
const pdfinfoOf = (f) => spawnSync('pdfinfo', [f], { encoding: 'utf8' }).stdout;

test('combining Word is refused with a reason', async () => {
  assert.match(combineReason('docx'), /one per document/);
  assert.equal(combineReason('pdf'), null);
  await assert.rejects(exportCombined({ format: 'docx', entries: twoDocs() }), /one per document/);
});
