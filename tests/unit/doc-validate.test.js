import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../js/doc/model.js';
import { extractDocument } from '../../js/doc/extract.js';
import { validateDocument, readAmount, reviewCount, issuesFor } from '../../js/doc/validate.js';
import { createWorkspace } from '../../js/doc/workspace.js';
import { layout, resultOf, invoiceItems } from './doc-helpers.js';

const mk = (docType = 'invoice', result = resultOf(invoiceItems())) =>
  ({ result, doc: M.createDocument({ fileId: 'f1', name: 'a.png', result, docType, extraction: extractDocument({ result, docType }) }) });
const codes = (issues) => issues.map((i) => `${i.severity}:${i.code}`);

test('a consistent document produces no warnings or errors', () => {
  const { doc, result } = mk();
  assert.deepEqual(validateDocument(doc, { result }), []);
});

test('total that disagrees with subtotal + tax is an error; the document is NOT corrected', () => {
  let { doc, result } = mk();
  doc = M.setField(doc, 'total', 'EUR 250.00');
  const before = JSON.stringify(doc);
  const issues = validateDocument(doc, { result });
  assert.deepEqual(codes(issues), ['error:total_mismatch']);
  assert.deepEqual(issues[0].target, { type: 'field', key: 'total' });
  assert.match(issues[0].message, /stated 250\.00 EUR but computed 245\.00 EUR/);
  assert.equal(JSON.stringify(doc), before, 'validation never mutates or auto-fixes');
  assert.equal(reviewCount(issues), 1);
});

test('one minor unit of rounding is a warning, more is an error', () => {
  let { doc, result } = mk();
  doc = M.setField(doc, 'total', 'EUR 245.01');
  assert.deepEqual(codes(validateDocument(doc, { result })), ['warning:total_mismatch']);
  doc = M.setField(doc, 'total', 'EUR 245.02');
  assert.deepEqual(codes(validateDocument(doc, { result })), ['error:total_mismatch']);
});

test('row total vs qty x unit price, and subtotal vs sum of rows, point at the right cell', () => {
  let { doc, result } = mk();
  const id = doc.items[0].id;
  doc = M.setCell(doc, 'items', id, 'qty', '3'); // 3 x 80.00 = 240.00, row says 160.00
  const issues = validateDocument(doc, { result });
  assert.ok(issues.some((i) => i.code === 'row_total_mismatch' && i.target.type === 'cell' && i.target.rowId === id && i.target.col === 'total'));
  assert.ok(!issues.some((i) => i.code === 'subtotal_mismatch'), 'rows still sum to the subtotal');
  doc = M.setCell(doc, 'items', id, 'total', '240.00');
  assert.ok(validateDocument(doc, { result }).some((i) => i.code === 'subtotal_mismatch'));
});

test('fractional quantities use exact money maths', () => {
  let { doc, result } = mk();
  const id = doc.items[1].id;
  doc = M.setCell(doc, 'items', id, 'qty', '1.5'); // 1.5 x 85.00 = 127.50
  doc = M.setCell(doc, 'items', id, 'total', '127.50');
  assert.ok(!validateDocument(doc, { result }).some((i) => i.code === 'row_total_mismatch'));
});

test('ambiguous and unreadable amounts are reported once and never guessed', () => {
  let { doc, result } = mk();
  doc = M.setField(doc, 'subtotal', '1,234');
  let issues = validateDocument(doc, { result });
  assert.ok(issues.some((i) => i.code === 'ambiguous_amount' && i.target.key === 'subtotal'));
  doc = M.setField(doc, 'total', 'twelve');
  issues = validateDocument(doc, { result });
  assert.ok(issues.some((i) => i.code === 'unreadable_amount' && i.target.key === 'total'));
  assert.ok(!issues.some((i) => i.code === 'missing_field' && i.target?.key === 'total'), 'present-but-unreadable is not also "missing"');
  assert.deepEqual(readAmount('1.234', {}).status, 'ambiguous');
  assert.equal(readAmount('1.234', { localeHint: 'de' }).minor, 123400);
  assert.equal(readAmount('', {}).status, 'empty');
  assert.equal(readAmount('1.2345', {}).status, 'invalid');
});

test('an empty required field is reported as missing with a readable label', () => {
  let { doc, result } = mk();
  doc = M.setField(doc, 'supplier', '');
  doc = M.setField(doc, 'issueDate', '');
  const issues = validateDocument(doc, { result });
  const msgs = issues.filter((i) => i.code === 'missing_field').map((i) => i.message).sort();
  assert.deepEqual(msgs, ['Invoice date is missing.', 'Supplier is missing.']);
});

test('dates: invalid calendar date and due-before-issue are errors on the right field', () => {
  let { doc, result } = mk();
  doc = M.setField(doc, 'issueDate', '2026-02-30');
  assert.ok(validateDocument(doc, { result }).some((i) => i.code === 'invalid_date' && i.target.key === 'issueDate'));
  doc = M.setField(doc, 'issueDate', '2026-12-01');
  assert.ok(validateDocument(doc, { result }).some((i) => i.code === 'date_order' && i.target.key === 'dueDate'));
});

test('currency: lower-case code, amount in another currency, and two currencies on the page are all flagged', () => {
  let { doc, result } = mk();
  assert.ok(validateDocument(M.setField(doc, 'currency', 'eur'), { result }).some((i) => i.code === 'invalid_currency'));
  assert.ok(validateDocument(M.setField(doc, 'total', 'USD 245.00'), { result }).some((i) => i.code === 'amount_currency_mismatch'));
  const items = layout([{ y: 10, x: 10, text: 'Shop Ltd' }, { y: 60, x: 10, text: 'Total EUR 10.00 and USD 11.00' }]);
  const two = mk('invoice', resultOf(items));
  assert.ok(validateDocument(two.doc, { result: two.result }).some((i) => i.code === 'currency_inconsistent'));
  // once the user picks a currency themselves, the page-level conflict is their decision and stops being flagged
  const chosen = M.setField(two.doc, 'currency', 'EUR');
  assert.ok(!validateDocument(chosen, { result: two.result }).some((i) => i.code === 'currency_inconsistent'));
});

test('extraction notes are warnings until the user edits the field', () => {
  const items = layout([{ y: 10, x: 10, text: 'Acme Ltd' }, { y: 60, x: 10, text: 'Date: 03/04/2026' }]);
  let { doc, result } = mk('invoice', resultOf(items));
  assert.ok(validateDocument(doc, { result }).some((i) => i.code === 'extraction_note' && i.target.key === 'issueDate'));
  doc = M.setField(doc, 'issueDate', '2026-04-03');
  assert.ok(!validateDocument(doc, { result }).some((i) => i.code === 'extraction_note'));
});

test('low OCR confidence on the source words of a value is a warning with the confidence; typing over it clears it', () => {
  const items = invoiceItems().map((it) => (it.text === 'INV-00482' ? { ...it, conf: 41 } : it));
  let { doc, result } = mk('invoice', resultOf(items));
  const issues = validateDocument(doc, { result });
  const low = issues.find((i) => i.code === 'low_confidence');
  assert.ok(low && low.target.key === 'number');
  assert.match(low.message, /41%/);
  doc = M.setField(doc, 'number', 'INV-00482');
  assert.equal(validateDocument(doc, { result }).filter((i) => i.code === 'low_confidence').length, 1, 'same text re-typed equals extracted, so still flagged');
  doc = M.setField(doc, 'number', 'INV-00483');
  assert.equal(validateDocument(doc, { result }).filter((i) => i.code === 'low_confidence').length, 0);
});

test('receipts do not require an invoice number or customer', () => {
  const rc = layout([{ y: 50, x: 170, text: 'CORNER STORE', h: 48 }, { y: 270, x: 60, text: 'Milk 1L' }, { y: 270, x: 500, text: '1.20' }, { y: 480, x: 60, text: 'Total' }, { y: 480, x: 470, text: '1.20' }]);
  const { doc, result } = mk('receipt', resultOf(rc));
  const issues = validateDocument(doc, { result });
  assert.ok(!issues.some((i) => i.severity === 'error' && /number|customer/.test(i.path ?? '')), codes(issues).join());
});

test('table and general documents run no financial checks; recognition review reasons are carried over', () => {
  const result = { ...resultOf(invoiceItems()), review: ['Page 1: low recognition confidence (55%).'] };
  const table = M.createDocument({ fileId: 'f', name: 'n', result, docType: 'table', extraction: extractDocument({ result, docType: 'table' }) });
  const issues = validateDocument(table, { result });
  assert.deepEqual(codes(issues), ['warning:source_review']);
  assert.ok(!codes(validateDocument(M.createDocument({ fileId: 'f', name: 'n', result, docType: 'general', extraction: extractDocument({ result, docType: 'general' }) }), { result })).some((c) => /mismatch/.test(c)));
});

test('issuesFor selects by target', () => {
  let { doc, result } = mk();
  doc = M.setField(doc, 'total', '1');
  const issues = validateDocument(doc, { result });
  assert.equal(issuesFor(issues, { type: 'field', key: 'total' }).length, 1);
  assert.equal(issuesFor(issues, { type: 'field', key: 'supplier' }).length, 0);
});

// ------------------------------------------------------------------ workspace (fake store + session)
function fakes(result, over = {}) {
  const items = [{ id: 'f1', name: 'a.png' }];
  const recs = new Map([['f1', { status: 'recognized', result, override: null, rotation: 0, ...over }]]);
  const storeL = new Set(), sessL = new Set();
  const store = { getState: () => ({ items }), subscribe: (f) => { storeL.add(f); return () => storeL.delete(f); } };
  const session = { get: (id) => recs.get(id) ?? null, subscribe: (f) => { sessL.add(f); return () => sessL.delete(f); } };
  return {
    store, session, recs, items,
    push: () => sessL.forEach((f) => f(new Map([...recs].map(([k, v]) => [k, { ...v }])))),
    removeItem: () => { items.length = 0; recs.delete('f1'); storeL.forEach((f) => f({ items })); },
  };
}

test('workspace: opened once, kept; edits survive "navigation" (ensure again returns the same document)', () => {
  const fk = fakes(resultOf(invoiceItems()));
  const ws = createWorkspace(fk);
  const e = ws.ensure('f1');
  assert.ok(e);
  e.commit((d) => M.setField(d, 'supplier', 'Edited Ltd'));
  assert.equal(e.modified, true);
  assert.equal(ws.hasUnsavedEdits(), true);
  assert.equal(ws.ensure('f1'), e);
  assert.equal(ws.ensure('f1').doc.fields.supplier.value, 'Edited Ltd');
  e.undo();
  assert.equal(e.modified, false);
  e.redo();
  e.commit((d) => M.setField(d, 'supplier', 'ACME Supplies'));
  e.undo(); // back to the edited one; then re-typing the original value is "unchanged"
  e.commit((d) => M.setField(d, 'supplier', 'ACME Supplies'));
  assert.equal(e.modified, false, 'content equal to the extracted draft counts as unchanged');
});

test('workspace: source result is frozen when opened', () => {
  const result = resultOf(invoiceItems());
  createWorkspace(fakes(result)).ensure('f1');
  assert.equal(Object.isFrozen(result.pages[0].raw.items[0]), true);
});

test('workspace: no document until recognition produced a result', () => {
  const fk = fakes(null, { status: 'extracting' });
  assert.equal(createWorkspace(fk).ensure('f1'), null);
});

test('workspace: re-recognition rebuilds an unedited document but holds the new result back when there are edits', () => {
  const r1 = resultOf(invoiceItems());
  const fk = fakes(r1);
  const ws = createWorkspace(fk);
  const e = ws.ensure('f1');
  const r2 = resultOf(invoiceItems());
  fk.recs.get('f1').result = r2; fk.push();
  assert.equal(e.result, r2, 'unedited: rebuilt silently');
  e.commit((d) => M.setField(d, 'supplier', 'Mine'));
  const r3 = resultOf(invoiceItems());
  fk.recs.get('f1').result = r3; fk.push();
  assert.equal(e.result, r2, 'edited: current source kept');
  assert.equal(e.pendingResult, r3);
  assert.equal(e.doc.fields.supplier.value, 'Mine', 'edits are not lost');
  e.keepCurrent();
  assert.equal(e.pendingResult, null);
  fk.recs.get('f1').result = resultOf(invoiceItems()); fk.push();
  assert.ok(e.pendingResult, 'a later result is offered again');
  assert.equal(e.acceptPending(), true);
  assert.equal(e.doc.fields.supplier.value, 'ACME Supplies', 'accepting discards edits on purpose');
});

test('workspace: changing the type on the Convert page retypes the document as an undoable step', () => {
  const fk = fakes(resultOf(invoiceItems()));
  const ws = createWorkspace(fk);
  const e = ws.ensure('f1');
  fk.recs.get('f1').override = 'receipt'; fk.push();
  assert.equal(e.doc.docType, 'receipt');
  assert.equal(e.doc.typeOrigin, 'user');
  e.undo();
  assert.equal(e.doc.docType, 'invoice');
  fk.recs.get('f1').override = null; fk.push();
  assert.equal(e.doc.docType, 'invoice', 'back to the suggestion; nothing to change');
});

test('workspace: removing the file drops its document and disposes its page source', () => {
  const fk = fakes(resultOf(invoiceItems()));
  const ws = createWorkspace(fk);
  const e = ws.ensure('f1');
  let disposed = 0;
  e.pageSource = { dispose: () => { disposed += 1; } };
  fk.removeItem();
  assert.equal(ws.get('f1'), null);
  assert.equal(disposed, 1);
});

// ------------------------------------------------------------------ restoring a saved document (project resume)
test('restoreDocument: a saved document round-trips through JSON and keeps edits, refs, page order and rotation', () => {
  let { doc, result } = mk();
  doc = M.setField(doc, 'supplier', 'Saved Ltd');
  doc = M.setCell(doc, 'items', doc.items[0].id, 'qty', '9');
  doc = M.rotatePage(doc, 0, 90);
  const back = M.restoreDocument(JSON.parse(JSON.stringify(M.toPlain(doc))), result, { fileId: 'f77', name: 'x.png' });
  assert.equal(back.fileId, 'f77', 'bound to the NEW file id');
  assert.equal(back.fields.supplier.value, 'Saved Ltd');
  assert.equal(back.fields.supplier.extracted, 'ACME Supplies', 'extracted draft preserved');
  assert.equal(back.items[0].cells.qty.value, '9');
  assert.equal(back.pages[0].rotation, 90);
  assert.deepEqual(back.fields.number.ref, doc.fields.number.ref);
  assert.deepEqual(validateDocument(back, { result }).map((i) => i.code), validateDocument(doc, { result }).map((i) => i.code));
});

test('restoreDocument: damaged, foreign or mismatching documents are refused (null), never half-loaded', () => {
  const { doc, result } = mk();
  const plain = () => JSON.parse(JSON.stringify(M.toPlain(doc)));
  const opt = { fileId: 'f1', name: 'n' };
  const breakers = [
    (p) => { p.schema = 'other'; }, (p) => { p.version = 99; }, (p) => { p.docType = 'passport'; },
    (p) => { delete p.fields.total; }, (p) => { p.fields.total.value = 5; }, (p) => { p.items[0].cells.qty = null; },
    (p) => { p.items.push({ id: p.items[0].id, cells: p.items[0].cells }); }, (p) => { p.items[0].id = '../x'; },
    (p) => { p.grid.columns = 'x'; }, (p) => { p.text = {}; }, (p) => { p.pages = []; },
    (p) => { p.pages[0].source = 7; }, (p) => { p.pages[0].rotation = 45; },
  ];
  for (const [i, f] of breakers.entries()) { const p = plain(); f(p); assert.equal(M.restoreDocument(p, result, opt), null, `breaker ${i}`); }
  assert.equal(M.restoreDocument(null, result, opt), null);
  assert.equal(M.restoreDocument('x', result, opt), null);
  // a ref that points outside the raw items is dropped, not trusted
  const p = plain(); p.fields.number.ref = { page: 0, items: [99999] };
  assert.equal(M.restoreDocument(p, result, opt).fields.number.ref, null);
});

test('workspace.restoreDoc: restored edits count as modified against the fresh draft, are not an undo step, and bad data keeps the draft', () => {
  const result = resultOf(invoiceItems());
  const fk = fakes(result);
  const ws = createWorkspace(fk);
  const e = ws.ensure('f1');
  let edited = M.setField(e.doc, 'supplier', 'Restored Ltd');
  const plain = JSON.parse(JSON.stringify(M.toPlain(edited)));
  const fresh = fakes(result); // a new session = a reopened project
  const ws2 = createWorkspace(fresh);
  assert.equal(ws2.restoreDoc('f1', plain), true);
  const e2 = ws2.get('f1');
  assert.equal(e2.doc.fields.supplier.value, 'Restored Ltd');
  assert.equal(e2.modified, true);
  assert.equal(e2.history.canUndo, false, 'resume does not create an undo step');
  e2.commit((d) => M.setField(d, 'supplier', 'Again'));
  assert.equal(e2.undo(), true);
  assert.equal(e2.doc.fields.supplier.value, 'Restored Ltd');
  const ws3 = createWorkspace(fakes(result));
  assert.equal(ws3.restoreDoc('f1', { schema: 'junk' }), false);
  assert.equal(ws3.get('f1').doc.fields.supplier.value, 'ACME Supplies', 'fresh extraction kept');
});
