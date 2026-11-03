import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemsToLineObjects, itemsToLines } from '../../js/recognition/text.js';
import { parseDate, findDate } from '../../js/doc/dates.js';
import { refRect, rotateNormRect, rotatedAspect } from '../../js/doc/geometry.js';
import * as M from '../../js/doc/model.js';
import { createHistory } from '../../js/doc/history.js';
import { extractDocument } from '../../js/doc/extract.js';
import { layout, resultOf, invoiceItems } from './doc-helpers.js';

const invoiceResult = () => resultOf(invoiceItems());
const mk = (docType = 'invoice', result = invoiceResult()) =>
  M.createDocument({ fileId: 'f1', name: 'a.png', result, docType, extraction: extractDocument({ result, docType }) });

// ------------------------------------------------------------------ line objects
test('itemsToLineObjects: offsets point back at raw item indices, columns become segments', () => {
  const items = layout([{ y: 10, x: 0, text: 'ACME Supplies' }, { y: 10, x: 700, text: 'INVOICE' }, { y: 60, x: 0, text: 'Bill to:' }]);
  const lines = itemsToLineObjects(items);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'ACME Supplies INVOICE');
  assert.equal(lines[0].segments.length, 2, 'wide gap splits the row into column segments');
  const seg = lines[0].segments[0];
  assert.equal(lines[0].text.slice(seg.start, seg.end), 'ACME Supplies');
  assert.deepEqual(seg.idxs, [0, 1]);
  for (const p of lines[0].parts) assert.equal(items[p.idx].text, lines[0].text.slice(p.start, p.end));
  assert.deepEqual(itemsToLines(items), ['ACME Supplies INVOICE', 'Bill to:']);
});

test('itemsToLineObjects keeps ORIGINAL indices when unusable items are skipped', () => {
  const items = [{ text: ' ', x: 0, y: 0, w: 5, h: 10 }, { text: 'Hello', x: 10, y: 0, w: 30, h: 10 }];
  assert.deepEqual(itemsToLineObjects(items)[0].parts.map((p) => p.idx), [1]);
});

// ------------------------------------------------------------------ dates
test('parseDate: unambiguous formats become ISO', () => {
  for (const [t, iso] of [['03 Nov 2026', '2026-11-03'], ['2026-11-03', '2026-11-03'], ['Nov 3, 2026', '2026-11-03'], ['3rd November 2026', '2026-11-03'], ['13/04/2026', '2026-04-13'], ['04/13/2026', '2026-04-13'], ['11/11/2026', '2026-11-11']]) {
    const r = parseDate(t);
    assert.equal(r.iso, iso, t);
    assert.equal(r.ambiguous, false, t);
  }
});
test('parseDate: day/month order that cannot be decided is ambiguous, never guessed', () => {
  const r = parseDate('03/04/2026');
  assert.equal(r.iso, null);
  assert.equal(r.ambiguous, true);
  assert.deepEqual(r.candidates.sort(), ['2026-03-04', '2026-04-03']);
});
test('parseDate: impossible and unrecognised dates give no ISO value', () => {
  assert.equal(parseDate('31 Feb 2026').iso, null);
  assert.equal(parseDate('2026-02-30').iso, null);
  assert.equal(parseDate('soon').reason, 'unrecognized');
  assert.equal(parseDate('13/13/2026').iso, null);
});
test('findDate anchored only reads a date that starts at the position', () => {
  assert.equal(findDate('Date: 03 Nov 2026', 5, { anchored: true }).iso, '2026-11-03');
  assert.equal(findDate('Date: by 03 Nov 2026', 5, { anchored: true }), null);
});

// ------------------------------------------------------------------ geometry
test('rotateNormRect: four rotations return to the start; 90 degrees maps the top-left to the top-right', () => {
  const r = { x: 0.1, y: 0.2, w: 0.3, h: 0.05 };
  let cur = r;
  for (let i = 0; i < 4; i += 1) cur = rotateNormRect(cur, 90);
  for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(cur[k] - r[k]) < 1e-12, k);
  const tl = rotateNormRect({ x: 0, y: 0, w: 0.1, h: 0.1 }, 90);
  assert.ok(Math.abs(tl.x - 0.9) < 1e-12 && tl.y === 0);
  assert.deepEqual(rotateNormRect(r, 360), r);
  assert.throws(() => rotateNormRect(r, 45), RangeError);
  assert.equal(rotatedAspect(0.5, 90), 2);
});
test('refRect normalizes the union of referenced raw items and rejects bad refs', () => {
  const page = { coordSpace: { width: 1000, height: 500 }, raw: { items: [{ x: 100, y: 50, w: 100, h: 50 }, { x: 300, y: 100, w: 100, h: 50 }] } };
  const r = refRect(page, { items: [0, 1] });
  for (const [k, v] of Object.entries({ x: 0.1, y: 0.1, w: 0.3, h: 0.2 })) assert.ok(Math.abs(r[k] - v) < 1e-9, k);
  assert.equal(refRect(page, null), null);
  assert.equal(refRect(page, { items: [] }), null);
  assert.equal(refRect(page, { items: [9] }), null);
  assert.equal(refRect({ ...page, coordSpace: { width: 0, height: 0 } }, { items: [0] }), null);
});

// ------------------------------------------------------------------ extraction
test('extract invoice: fields, rows and refs from a realistic layout', () => {
  const r = invoiceResult();
  const ex = extractDocument({ result: r, docType: 'invoice' });
  const v = (k) => ex.fields[k].value;
  assert.equal(v('supplier'), 'ACME Supplies');
  assert.equal(v('customer'), 'Bright Tech Ltd');
  assert.equal(v('number'), 'INV-00482');
  assert.equal(v('issueDate'), '2026-11-03');
  assert.equal(v('dueDate'), '2026-11-17');
  assert.equal(v('currency'), 'EUR');
  assert.equal(v('subtotal'), '245.00');
  assert.equal(v('tax'), '0.00');
  assert.equal(v('taxRate'), '0');
  assert.equal(v('total'), 'EUR 245.00');
  assert.deepEqual(ex.items.map((i) => ['description', 'qty', 'unit', 'total'].map((c) => i.cells[c].value)), [['Product A', '2', '80.00', '160.00'], ['Product B', '1', '85.00', '85.00']]);
  // every ref points at real raw items that spell the value
  const raw = r.pages[0].raw.items;
  assert.equal(ex.fields.number.ref.items.map((i) => raw[i].text).join(' '), 'INV-00482');
  assert.equal(ex.fields.total.ref.items.map((i) => raw[i].text).join(' '), 'EUR 245.00');
  assert.ok(ex.fields.supplier.note, 'heuristic fields say so');
  assert.equal(ex.fields.number.note, null);
});

test('extract: a label with no readable value leaves the field EMPTY instead of guessing', () => {
  const items = layout([{ y: 10, x: 10, text: 'Invoice No: Date' }, { y: 60, x: 10, text: 'Total' }, { y: 110, x: 10, text: 'Due Date: soon' }]);
  const ex = extractDocument({ result: resultOf(items), docType: 'invoice' });
  assert.equal(ex.fields.number.value, '');
  assert.equal(ex.fields.total.value, '');
  assert.equal(ex.fields.dueDate.value, '');
});

test('extract: ambiguous date keeps the printed text with a warning note; tax rate comma is read, with a note', () => {
  const items = layout([{ y: 10, x: 10, text: 'Acme Ltd' }, { y: 60, x: 10, text: 'Date: 03/04/2026' }, { y: 110, x: 10, text: 'VAT (7,5%) 7.50' }, { y: 160, x: 10, text: 'Total 107.50' }]);
  const ex = extractDocument({ result: resultOf(items), docType: 'invoice' });
  assert.equal(ex.fields.issueDate.value, '03/04/2026');
  assert.equal(ex.fields.issueDate.noteLevel, 'warning');
  assert.match(ex.fields.issueDate.note, /2026-03-04 or 2026-04-03|2026-04-03 or 2026-03-04/);
  assert.equal(ex.fields.taxRate.value, '7.5');
  assert.match(ex.fields.taxRate.note, /7,5%/);
  assert.equal(ex.fields.tax.value, '7.50');
});

test('extract: "$" alone is assumed USD but flagged; two currencies leave the field empty', () => {
  const one = extractDocument({ result: resultOf(layout([{ y: 10, x: 10, text: 'Shop' }, { y: 60, x: 10, text: 'Total $12.50' }])), docType: 'receipt' });
  assert.equal(one.fields.currency.value, 'USD');
  assert.equal(one.fields.currency.noteLevel, 'warning');
  const two = extractDocument({ result: resultOf(layout([{ y: 10, x: 10, text: 'Shop' }, { y: 60, x: 10, text: 'Total €12.50 or $13.00' }])), docType: 'receipt' });
  assert.equal(two.fields.currency.value, '');
  assert.deepEqual(two.detectedCurrencies, ['EUR', 'USD']);
});

test('extract: amount with a space as thousands separator is read whole, not split', () => {
  const ex = extractDocument({ result: resultOf(layout([{ y: 10, x: 10, text: 'Shop Ltd' }, { y: 60, x: 10, text: 'Total EUR 1 234.56' }])), docType: 'invoice' });
  assert.equal(ex.fields.total.value, 'EUR 1 234.56');
});

test('extract: row where "2 100.00" could be one amount or two is flagged, a clearly separated one is not', () => {
  const header = [{ y: 10, x: 10, text: 'Shop Ltd' }, { y: 100, x: 10, text: 'Description' }, { y: 100, x: 400, text: 'Qty' }, { y: 100, x: 500, text: 'Unit' }, { y: 100, x: 600, text: 'Total' }];
  const tight = layout([...header, { y: 150, x: 10, text: 'Pipe' }, { y: 150, x: 400, text: '2 100.00' }, { y: 150, x: 600, text: '200.00' }]);
  const ex1 = extractDocument({ result: resultOf(tight), docType: 'invoice' });
  assert.equal(ex1.items[0].cells.unit.noteLevel, 'warning', 'adjacent digits that could be "2,100.00"');
  const apart = layout([...header, { y: 150, x: 10, text: 'Pipe' }, { y: 150, x: 400, text: '2' }, { y: 150, x: 470, text: '100.00' }, { y: 150, x: 620, text: '200.00' }]);
  const ex2 = extractDocument({ result: resultOf(apart), docType: 'invoice' });
  assert.equal(ex2.items[0].cells.unit.noteLevel, null);
});

test('extract receipt: line items are description + amount; totals/card lines are not items', () => {
  const rc = layout([{ y: 50, x: 170, text: 'CORNER STORE', h: 48 }, { y: 120, x: 190, text: 'Receipt', h: 36 }, { y: 270, x: 60, text: 'Milk 1L' }, { y: 270, x: 500, text: '1.20' }, { y: 325, x: 60, text: 'Bread' }, { y: 325, x: 500, text: '2.10' }, { y: 480, x: 60, text: 'Total', h: 40 }, { y: 480, x: 470, text: '8.70', h: 40 }, { y: 560, x: 60, text: 'VISA **** 1234' }]);
  const ex = extractDocument({ result: resultOf(rc, { width: 700, height: 1100 }), docType: 'receipt' });
  assert.equal(ex.fields.supplier.value, 'CORNER STORE');
  assert.equal(ex.fields.total.value, '8.70');
  assert.deepEqual(ex.items.map((i) => [i.cells.description.value, i.cells.total.value]), [['Milk 1L', '1.20'], ['Bread', '2.10']]);
  assert.equal(ex.fields.customer, undefined, 'receipts have no customer field');
});

test('extract table: columns are clustered by position and cells keep refs', () => {
  const rows = [['Product', 'Jan', 'Feb'], ['Widget', '10', '20'], ['Gadget', '15', '25']];
  const items = layout(rows.flatMap((r, i) => r.map((t, c) => ({ y: 100 + i * 70, x: 100 + c * 300, text: t }))));
  const ex = extractDocument({ result: resultOf(items), docType: 'table' });
  assert.equal(ex.grid.columns, 3);
  assert.deepEqual(ex.grid.rows.map((r) => r.cells.map((c) => c.value)), rows);
  assert.ok(ex.grid.rows[1].cells[1].ref.items.length);
  assert.deepEqual(extractDocument({ result: resultOf([]), docType: 'table' }).grid, { columns: 0, rows: [] });
});

test('extract general: no structured data', () => {
  const ex = extractDocument({ result: invoiceResult(), docType: 'general' });
  assert.deepEqual(ex.fields, {});
  assert.deepEqual(ex.items, []);
});

// ------------------------------------------------------------------ model
test('model: updaters are pure; the previous document is untouched', () => {
  const d0 = mk();
  const snapshot = JSON.stringify(d0);
  const d1 = M.setField(d0, 'supplier', 'Other Ltd');
  assert.equal(d0.fields.supplier.value, 'ACME Supplies');
  assert.equal(d1.fields.supplier.value, 'Other Ltd');
  assert.equal(d1.fields.supplier.extracted, 'ACME Supplies', 'extracted value is never overwritten');
  assert.equal(M.isEdited(d1.fields.supplier), true);
  assert.equal(JSON.stringify(d0), snapshot);
  assert.equal(M.setField(d0, 'supplier', 'ACME Supplies'), d0, 'no-op returns the same object');
  assert.equal(M.setField(d0, 'nope', 'x'), d0);
  assert.equal(d1.fields.number, d0.fields.number, 'untouched parts are shared');
});

test('model: row add / edit / move / remove with stable ids', () => {
  let d = mk();
  const [a, b] = d.items.map((i) => i.id);
  d = M.setCell(d, 'items', a, 'qty', '3');
  assert.equal(d.items[0].cells.qty.value, '3');
  assert.equal(d.items[0].cells.qty.extracted, '2');
  d = M.addRow(d, 'items', a);
  assert.equal(d.items.length, 3);
  assert.equal(d.items[1].cells.description.value, '');
  const newId = d.items[1].id;
  assert.ok(![a, b].includes(newId));
  d = M.moveRow(d, 'items', newId, 1);
  assert.deepEqual(d.items.map((i) => i.id), [a, b, newId]);
  assert.equal(M.moveRow(d, 'items', a, -1), d, 'cannot move past the top');
  d = M.removeRow(d, 'items', b);
  assert.deepEqual(d.items.map((i) => i.id), [a, newId]);
  assert.equal(M.removeRow(d, 'items', 'nope'), d);
  assert.equal(M.addRow(d, 'items').items.at(-1).id === newId, false);
});

test('model: grid cells are edited by column index', () => {
  const items = layout([['A', 'B'], ['1', '2']].flatMap((r, i) => r.map((t, c) => ({ y: 100 + i * 70, x: 100 + c * 300, text: t }))));
  const result = resultOf(items);
  let d = M.createDocument({ fileId: 'f', name: 'n', result, docType: 'table', extraction: extractDocument({ result, docType: 'table' }) });
  const id = d.grid.rows[1].id;
  d = M.setCell(d, 'grid', id, 1, '99');
  assert.equal(d.grid.rows[1].cells[1].value, '99');
  assert.equal(d.grid.rows[1].cells[0].value, '1');
  d = M.addRow(d, 'grid');
  assert.equal(d.grid.rows.at(-1).cells.length, 2);
});

test('model: page order and view rotation', () => {
  const r = invoiceResult();
  r.pages.push({ ...r.pages[0], index: 1, normalized: { lines: [], text: 'second' } });
  let d = M.createDocument({ fileId: 'f', name: 'n', result: r, docType: 'general', extraction: extractDocument({ result: r, docType: 'general' }) });
  assert.deepEqual(d.pages.map((p) => p.source), [0, 1]);
  d = M.movePage(d, 0, 1);
  assert.deepEqual(d.pages.map((p) => p.source), [1, 0]);
  assert.equal(M.movePage(d, 0, 5), d);
  d = M.rotatePage(d, 0, 90);
  d = M.rotatePage(d, 0, 90);
  assert.equal(d.pages[0].rotation, 180);
  d = M.rotatePage(d, 0, -270);
  assert.equal(d.pages[0].rotation, 270);
  d = M.setPageText(d, 1, 'edited');
  assert.equal(d.text[1].value, 'edited');
  assert.equal(d.text[1].extracted, 'second');
});

test('model: retype re-extracts structured parts but keeps page text edits and page order', () => {
  let d = mk('invoice');
  d = M.setPageText(d, 0, 'my text');
  d = M.movePage(d, 0, 0);
  const r2 = invoiceResult();
  const re = M.retype(d, 'receipt', extractDocument({ result: r2, docType: 'receipt' }));
  assert.equal(re.docType, 'receipt');
  assert.equal(re.typeOrigin, 'user');
  assert.equal(re.text[0].value, 'my text');
  assert.equal(re.fields.customer.value, '', 'receipt has no customer');
});

test('model: source result is frozen and no edit can change it (source OCR is never overwritten)', () => {
  const r = invoiceResult();
  const before = JSON.stringify(r);
  M.deepFreeze(r);
  assert.throws(() => { 'use strict'; r.pages[0].raw.items[0].text = 'X'; }, TypeError);
  let d = M.createDocument({ fileId: 'f', name: 'n', result: r, docType: 'invoice', extraction: extractDocument({ result: r, docType: 'invoice' }) });
  d = M.setField(d, 'total', '999');
  d = M.setPageText(d, 0, 'zzz');
  assert.equal(JSON.stringify(r), before);
  assert.equal(M.countEdits(d), 2);
  const plain = M.toPlain(d);
  assert.equal(plain.schema, 'invoicelens.document');
  assert.equal(plain.version, 1);
  assert.equal(JSON.stringify(plain).includes('"raw"'), false, 'the serialised document contains no raw OCR items');
});

// ------------------------------------------------------------------ history
test('history: undo / redo / redo cleared by a new edit', () => {
  const h = createHistory(0);
  h.commit((n) => n + 1); h.commit((n) => n + 10);
  assert.equal(h.present, 11);
  assert.equal(h.undo(), true); assert.equal(h.present, 1);
  assert.equal(h.redo(), true); assert.equal(h.present, 11);
  h.undo(); h.commit((n) => n + 100);
  assert.equal(h.present, 101);
  assert.equal(h.canRedo, false);
  assert.equal(createHistory(0).undo(), false);
});

test('history: typing in one field coalesces into one undo step; a different field or a pause starts a new one', () => {
  let t = 0;
  const h = createHistory('', { now: () => t, coalesceMs: 1000 });
  for (const ch of ['a', 'ab', 'abc']) { t += 100; h.commit(() => ch, 'field:x'); }
  assert.equal(h.present, 'abc');
  h.undo();
  assert.equal(h.present, '', 'one step for the whole word');
  h.redo();
  t += 5000; h.commit(() => 'abcd', 'field:x');
  h.undo();
  assert.equal(h.present, 'abc', 'a pause starts a new step');
  h.commit(() => 'q', 'field:y'); h.commit(() => 'r', 'field:z');
  h.undo();
  assert.equal(h.present, 'q');
});

test('history: seal() stops coalescing; no-op edits are not recorded; limit drops the oldest', () => {
  let t = 0;
  const h = createHistory(0, { now: () => t, limit: 3 });
  h.commit((n) => n + 1, 'k'); h.seal(); h.commit((n) => n + 1, 'k');
  assert.equal(h.canUndo, true);
  h.undo();
  assert.equal(h.present, 1);
  assert.equal(h.commit((n) => n), false);
  const small = createHistory(0, { limit: 2 });
  for (let i = 1; i <= 5; i += 1) small.commit((n) => n + 1);
  let steps = 0;
  while (small.undo()) steps += 1;
  assert.equal(steps, 2);
});
