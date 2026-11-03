import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInvoice } from '../../js/validation.js';

const good = () => ({
  supplier: { name: 'Acme Ltd' }, customer: { name: 'Buyer Inc' }, number: 'INV-1',
  issueDate: '2025-01-10', dueDate: '2025-02-10', currency: 'EUR',
  rows: [
    { description: 'Widget', qty: '2', unitMinor: 1000, totalMinor: 2000 },
    { description: 'Gadget', qty: '1.5', unitMinor: 1000, totalMinor: 1500 },
  ],
  subtotalMinor: 3500, taxMinor: 630, totalMinor: 4130, taxRatePercent: '18',
});
const codes = (m, o) => validateInvoice(m, o).map((i) => i.code);

test('clean invoice has no issues', () => assert.deepEqual(validateInvoice(good()), []));
test('does not mutate the model', () => {
  const m = good(); m.rows[0].totalMinor = 1; const before = JSON.stringify(m);
  validateInvoice(m); assert.equal(JSON.stringify(m), before);
});
test('row total mismatch is an error and not corrected', () => {
  const m = good(); m.rows[0].totalMinor = 2500;
  const i = validateInvoice(m).find((x) => x.code === 'row_total_mismatch');
  assert.equal(i.severity, 'error'); assert.equal(i.path, 'rows[0].totalMinor');
  assert.equal(m.rows[0].totalMinor, 2500);
});
test('1 minor unit difference is a warning; tolerance 0 makes it an error', () => {
  const m = good(); m.rows[0].totalMinor = 2001; m.subtotalMinor = 3501; m.totalMinor = 4131; m.taxMinor = 630;
  const w = validateInvoice(m).filter((x) => x.severity !== 'info');
  assert.ok(w.length > 0 && w.every((x) => x.severity === 'warning'), JSON.stringify(w));
  assert.ok(validateInvoice(m, { roundingToleranceMinor: 0 }).some((x) => x.severity === 'error'));
});
test('subtotal, total and tax-rate mismatches', () => {
  const m = good(); m.subtotalMinor = 3600;
  assert.ok(codes(m).includes('subtotal_mismatch'));
  const t = good(); t.totalMinor = 9999; assert.ok(codes(t).includes('total_mismatch'));
  const x = good(); x.taxMinor = 700; x.totalMinor = 4200; assert.ok(codes(x).includes('tax_rate_mismatch'));
});
test('missing required fields', () => {
  const c = codes({ rows: [] });
  assert.ok(c.filter((x) => x === 'missing_field').length >= 6);
  const r = good(); r.docType = 'receipt'; delete r.customer;
  const i = validateInvoice(r).find((x) => x.path === 'customer.name');
  assert.equal(i.severity, 'info');
});
test('dates: format, calendar validity, order', () => {
  const a = good(); a.issueDate = '10.01.2025'; assert.ok(codes(a).includes('invalid_date'));
  const b = good(); b.issueDate = '2025-02-30'; assert.ok(codes(b).includes('invalid_date'));
  const c = good(); c.issueDate = '2025-03-01'; assert.ok(codes(c).includes('date_order'));
  const d = good(); d.issueDate = '2024-02-29'; assert.ok(!codes(d).includes('invalid_date'));
});
test('currency inconsistency', () => {
  const a = good(); a.rows[0].currency = 'USD'; assert.ok(codes(a).includes('currency_mismatch'));
  const b = good(); b.detectedCurrencies = ['EUR', 'MKD']; assert.ok(codes(b).includes('currency_inconsistent'));
  const c = good(); c.currency = 'eur'; assert.ok(codes(c).includes('invalid_currency'));
});
test('float money is rejected', () => {
  const m = good(); m.totalMinor = 41.3; assert.ok(codes(m).includes('not_integer_minor'));
});
test('unverifiable items are info, not errors', () => {
  const m = good(); delete m.taxMinor; delete m.taxRatePercent;
  const i = validateInvoice(m).filter((x) => x.severity === 'error');
  assert.deepEqual(i, []);
  assert.ok(codes(m).includes('total_unverifiable'));
});
test('non-object model', () => assert.equal(validateInvoice(null)[0].code, 'invalid_model'));
