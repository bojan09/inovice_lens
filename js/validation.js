// validation.js - arithmetic / completeness checks for an extracted invoice.
//
// EXPECTED MODEL SHAPE (all money fields are integer minor units; null/undefined = not extracted):
// {
//   docType?: 'invoice' | 'receipt' | ...   // receipts do not require customer/dueDate
//   supplier: { name, taxId?, address? },    // required: supplier.name
//   customer: { name, taxId?, address? },    // required unless docType === 'receipt'
//   number: string,                          // invoice/receipt number, required
//   issueDate: 'YYYY-MM-DD',                 // required, real calendar date
//   dueDate?:  'YYYY-MM-DD',                 // must not be before issueDate
//   currency: 'EUR' | 'MKD' | ...,           // ISO 4217, required
//   detectedCurrencies?: string[],           // every currency seen on the page; >1 distinct => flagged
//   rows: [{ description, qty, unitMinor, totalMinor, currency? }],
//                                            // qty: decimal string or number (e.g. "1.5")
//   subtotalMinor, taxMinor, totalMinor: integer,
//   taxRatePercent?: string|number           // e.g. "18"; checked against taxMinor/subtotalMinor
// }
//
// RESULT: array of { code, severity: 'error'|'warning'|'info', path, message }.
// The model is never mutated and nothing is auto-corrected; every mismatch is reported.
//
// TOLERANCE POLICY: amounts are compared exactly. A difference of at most
// `roundingToleranceMinor` (default 1 minor unit; options arg) is reported as a
// 'warning' (typical per-line rounding on printed documents); anything larger is an 'error'.
// A tolerance of 0 makes every difference an error.

import { multiplyMinor, percentOfMinor, addMinor, formatAmount } from './money.js';

const isNil = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const isInt = (v) => Number.isSafeInteger(v);

function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= dim;
}

export function validateInvoice(model, options = {}) {
  const tol = options.roundingToleranceMinor ?? 1;
  const issues = [];
  const add = (code, severity, path, message) => issues.push({ code, severity, path, message });
  if (model === null || typeof model !== 'object') {
    add('invalid_model', 'error', '', 'model must be an object');
    return issues;
  }
  const cur = model.currency;
  const fmt = (v) => (isInt(v) ? formatAmount(v, typeof cur === 'string' ? cur : null, 'en') : String(v));

  /** Compare expected vs stated; emits one issue if they differ. */
  const compare = (code, path, label, stated, expected) => {
    if (stated === expected) return;
    const diff = Math.abs(stated - expected);
    add(code, diff <= tol ? 'warning' : 'error', path,
      `${label}: stated ${fmt(stated)} but computed ${fmt(expected)} (difference ${diff} minor units)`);
  };

  // ---- required fields ----
  const requiredText = (path, value, severity = 'error') => {
    if (isNil(value)) add('missing_field', severity, path, `${path} is missing`);
  };
  requiredText('supplier.name', model.supplier?.name);
  const isReceipt = model.docType === 'receipt';
  requiredText('customer.name', model.customer?.name, isReceipt ? 'info' : 'error');
  requiredText('number', model.number);
  requiredText('issueDate', model.issueDate);
  requiredText('currency', cur);
  if (isNil(model.totalMinor)) add('missing_field', 'error', 'totalMinor', 'totalMinor is missing');
  if (!Array.isArray(model.rows) || model.rows.length === 0) {
    add('missing_field', 'warning', 'rows', 'no line items extracted');
  }

  // ---- money fields must be integers (never floats) ----
  for (const k of ['subtotalMinor', 'taxMinor', 'totalMinor']) {
    if (!isNil(model[k]) && !isInt(model[k])) {
      add('not_integer_minor', 'error', k, `${k} must be an integer number of minor units, got ${model[k]}`);
    }
  }

  // ---- currency ----
  if (!isNil(cur) && !/^[A-Z]{3}$/.test(cur)) {
    add('invalid_currency', 'error', 'currency', `currency "${cur}" is not an uppercase ISO 4217 code`);
  }
  const seen = new Set();
  if (!isNil(cur)) seen.add(cur);
  (model.detectedCurrencies || []).forEach((c) => seen.add(c));
  const rows = Array.isArray(model.rows) ? model.rows : [];
  rows.forEach((r, i) => {
    if (r && !isNil(r.currency) && r.currency !== cur) {
      add('currency_mismatch', 'error', `rows[${i}].currency`, `row currency ${r.currency} differs from document currency ${cur}`);
    }
  });
  if (seen.size > 1) {
    add('currency_inconsistent', 'error', 'currency', `multiple currencies present: ${[...seen].sort().join(', ')}`);
  }

  // ---- dates ----
  const dateOk = {};
  for (const k of ['issueDate', 'dueDate']) {
    const v = model[k];
    if (isNil(v)) continue;
    dateOk[k] = typeof v === 'string' && isRealDate(v);
    if (!dateOk[k]) add('invalid_date', 'error', k, `${k} "${v}" is not a real YYYY-MM-DD date`);
  }
  if (dateOk.issueDate && dateOk.dueDate && model.issueDate > model.dueDate) {
    add('date_order', 'error', 'dueDate', `issueDate ${model.issueDate} is after dueDate ${model.dueDate}`);
  }

  // ---- rows ----
  const rowTotals = [];
  let rowsComplete = rows.length > 0;
  rows.forEach((r, i) => {
    const p = `rows[${i}]`;
    if (r === null || typeof r !== 'object') {
      add('invalid_row', 'error', p, 'row is not an object');
      rowsComplete = false;
      return;
    }
    if (isNil(r.description)) add('missing_field', 'warning', `${p}.description`, 'row description is missing');
    for (const k of ['unitMinor', 'totalMinor']) {
      if (!isNil(r[k]) && !isInt(r[k])) add('not_integer_minor', 'error', `${p}.${k}`, `${k} must be an integer, got ${r[k]}`);
    }
    if (isNil(r.totalMinor) || !isInt(r.totalMinor)) {
      add('missing_field', 'error', `${p}.totalMinor`, 'row total is missing');
      rowsComplete = false;
    } else {
      rowTotals.push(r.totalMinor);
    }
    if (isNil(r.qty) || !isInt(r.unitMinor) || !isInt(r.totalMinor)) {
      add('row_unverifiable', 'info', p, 'row qty * unit price cannot be checked (qty or unit price missing)');
      return;
    }
    let expected;
    try {
      expected = multiplyMinor(r.unitMinor, r.qty);
    } catch (e) {
      add('invalid_quantity', 'error', `${p}.qty`, `qty "${r.qty}" is not a plain decimal number`);
      return;
    }
    compare('row_total_mismatch', `${p}.totalMinor`, 'row total vs qty*unit price', r.totalMinor, expected);
  });

  // ---- subtotal / tax / total ----
  if (isInt(model.subtotalMinor)) {
    if (rowsComplete) {
      compare('subtotal_mismatch', 'subtotalMinor', 'subtotal vs sum of rows', model.subtotalMinor, addMinor(rowTotals));
    } else if (rows.length) {
      add('subtotal_unverifiable', 'info', 'subtotalMinor', 'subtotal cannot be checked because some row totals are missing');
    }
  }
  if (isInt(model.subtotalMinor) && isInt(model.taxMinor) && isInt(model.totalMinor)) {
    compare('total_mismatch', 'totalMinor', 'total vs subtotal + tax', model.totalMinor, addMinor(model.subtotalMinor, model.taxMinor));
  } else if (!isNil(model.totalMinor) && (isNil(model.subtotalMinor) || isNil(model.taxMinor))) {
    add('total_unverifiable', 'info', 'totalMinor', 'total cannot be checked against subtotal + tax (a component is missing)');
  }
  if (!isNil(model.taxRatePercent) && isInt(model.subtotalMinor) && isInt(model.taxMinor)) {
    try {
      compare('tax_rate_mismatch', 'taxMinor', `tax vs ${model.taxRatePercent}% of subtotal`, model.taxMinor,
        percentOfMinor(model.subtotalMinor, model.taxRatePercent));
    } catch (e) {
      add('invalid_tax_rate', 'error', 'taxRatePercent', `taxRatePercent "${model.taxRatePercent}" is not a plain decimal number`);
    }
  }
  return issues;
}
