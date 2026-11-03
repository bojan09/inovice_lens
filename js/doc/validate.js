// validate.js - checks on the CORRECTED document. Builds the model js/validation.js expects (integer
// minor units, via js/money.js), runs it, and adds what the editor needs on top:
//   * amounts that cannot be read, or are ambiguous, are reported - never guessed
//   * extraction notes (ambiguous date, assumed "$") until the user edits that field
//   * low OCR confidence on the words a value came from
//   * the recognition review reasons (missing text, low page confidence)
// Nothing here changes the document. There is no auto-fix: a mismatch stays visible until the user edits it.

import { parseAmount } from '../money.js';
import { validateInvoice } from '../validation.js';
import { FIELDS_BY_TYPE, FIELD_LABELS, ROW_COLUMNS, ROW_LABELS, MONEY_FIELDS, isEdited, labelFor } from './model.js';
import { DEFAULT_RECOGNITION_POLICY } from '../recognition/pipeline.js';

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };
const REASONS = {
  too_many_decimals: 'has more decimal places than this currency allows',
  out_of_range: 'is too large',
  bad_grouping: 'has thousands separators in odd places',
  unparseable: 'is not a plain amount',
  dangling_separator: 'ends or starts with a separator',
  conflicting_signs: 'has more than one minus sign or bracket',
  conflicting_currencies: 'mentions more than one currency',
  no_digits: 'has no digits',
};

const trim = (s) => (typeof s === 'string' ? s.trim() : '');

/** Parse a money field's text. status: 'empty' | 'ok' | 'ambiguous' | 'invalid'. */
export function readAmount(text, { currencyHint = null, localeHint = null } = {}) {
  const t = trim(text);
  if (!t) return { status: 'empty', minor: null, currency: null };
  const p = parseAmount(t, { currencyHint, localeHint });
  if (p.minor !== null) return { status: 'ok', minor: p.minor, currency: p.currency };
  if (p.ambiguous) return { status: 'ambiguous', minor: null, currency: p.currency, candidates: p.candidates ?? [], reason: p.reason };
  return { status: 'invalid', minor: null, currency: p.currency, reason: p.reason };
}

/** Convert the document into the model js/validation.js expects, collecting amount-reading issues. */
export function toValidationModel(doc, { localeHint = null } = {}) {
  const issues = [];
  const f = (k) => doc.fields[k]?.value ?? '';
  const cur = trim(f('currency')) || undefined;
  const hint = { currencyHint: cur && /^[A-Z]{3}$/.test(cur) ? cur : null, localeHint };
  const useFields = new Set(FIELDS_BY_TYPE[doc.docType] ?? []);

  const money = (key, path, label, target, text) => {
    const r = readAmount(text, hint);
    if (r.status === 'ambiguous') {
      issues.push({ code: 'ambiguous_amount', severity: 'warning', path, target, message: `${label} "${trim(text)}" is ambiguous: the "${/[.,]/.exec(trim(text))?.[0] ?? ','}" could be a thousands separator or a decimal mark. Retype it with its decimals, e.g. 1234.00.` });
    } else if (r.status === 'invalid') {
      issues.push({ code: 'unreadable_amount', severity: 'error', path, target, message: `${label} "${trim(text)}" ${REASONS[r.reason] ?? 'could not be read as an amount'}.` });
    } else if (r.status === 'ok' && r.currency && cur && r.currency !== cur) {
      issues.push({ code: 'amount_currency_mismatch', severity: 'error', path, target, message: `${label} is written in ${r.currency} but the document currency is ${cur}.` });
    }
    return r;
  };

  const model = {
    docType: doc.docType,
    supplier: { name: f('supplier') },
    customer: { name: f('customer') },
    number: f('number'),
    issueDate: trim(f('issueDate')) || undefined,
    dueDate: trim(f('dueDate')) || undefined,
    currency: cur,
    rows: [],
  };
  const fieldVal = (key, path, extraTarget) => {
    const r = money(key, path, labelFor(key, doc.docType), { type: 'field', key }, f(key));
    return r.status === 'ok' ? r.minor : undefined;
  };
  if (useFields.has('subtotal')) model.subtotalMinor = fieldVal('subtotal', 'subtotalMinor');
  if (useFields.has('tax')) model.taxMinor = fieldVal('tax', 'taxMinor');
  model.totalMinor = fieldVal('total', 'totalMinor');
  if (trim(f('taxRate'))) model.taxRatePercent = trim(f('taxRate'));
  // Currencies seen on the page matter only while the user has not made their own currency choice.
  if (doc.fields.currency && !isEdited(doc.fields.currency)) model.detectedCurrencies = doc.detectedCurrencies;
  if (!useFields.has('dueDate')) delete model.dueDate;

  doc.items.forEach((row, i) => {
    const t = (col) => ({ type: 'cell', rowId: row.id, col });
    const unit = money('unit', `rows[${i}].unitMinor`, 'Unit price', t('unit'), row.cells.unit.value);
    const tot = money('total', `rows[${i}].totalMinor`, 'Row total', t('total'), row.cells.total.value);
    const qty = trim(row.cells.qty.value);
    model.rows.push({
      description: row.cells.description.value,
      qty: qty === '' ? undefined : qty,
      unitMinor: unit.status === 'ok' ? unit.minor : undefined,
      totalMinor: tot.status === 'ok' ? tot.minor : undefined,
      ...(tot.currency || unit.currency ? { currency: tot.currency ?? unit.currency } : {}),
    });
  });
  return { model, issues };
}

// ----------------------------------------------------------------------------- targets
function targetOf(path, doc) {
  const m = /^rows\[(\d+)\](?:\.(\w+))?$/.exec(path);
  if (m) {
    const row = doc.items[+m[1]];
    const col = { description: 'description', qty: 'qty', unitMinor: 'unit', totalMinor: 'total', currency: 'total' }[m[2]];
    return row ? { type: 'cell', rowId: row.id, col: col ?? 'description' } : { type: 'tab', tab: 'table' };
  }
  if (path === 'rows') return { type: 'tab', tab: 'table' };
  const key = { 'supplier.name': 'supplier', 'customer.name': 'customer', number: 'number', issueDate: 'issueDate', dueDate: 'dueDate', currency: 'currency', subtotalMinor: 'subtotal', taxMinor: 'tax', totalMinor: 'total', taxRatePercent: 'taxRate' }[path];
  return key ? { type: 'field', key } : { type: 'tab', tab: 'fields' };
}

export const targetKey = (t) => (t.type === 'field' ? `field:${t.key}` : t.type === 'cell' ? `cell:${t.rowId}:${t.col}` : t.type === 'page' ? `page:${t.page}` : `tab:${t.tab}`);

const sentence = (m) => (m ? m[0].toUpperCase() + m.slice(1) : m);
function tidy(issue, doc) {
  if (issue.code === 'missing_field' && /^[\w.]+$/.test(issue.path)) {
    const t = issue.target;
    const label = t.type === 'field' ? labelFor(t.key, doc.docType) : issue.path;
    return { ...issue, message: `${label} is missing.` };
  }
  return { ...issue, message: sentence(issue.message) };
}

/**
 * @param {object} doc  corrected document
 * @param {{result?: object, localeHint?: string|null, policy?: object, roundingToleranceMinor?: number}} [opts]
 * @returns {{id:string, code:string, severity:'error'|'warning'|'info', message:string, target:object, path?:string}[]}
 */
export function validateDocument(doc, { result = null, localeHint = null, policy = DEFAULT_RECOGNITION_POLICY, roundingToleranceMinor = 1 } = {}) {
  const out = [];
  const push = (i) => out.push({ ...i, id: `${i.code}|${targetKey(i.target)}|${i.path ?? ''}` });
  const structured = doc.docType === 'invoice' || doc.docType === 'receipt';

  if (structured) {
    const { model, issues: parseIssues } = toValidationModel(doc, { localeHint });
    const parseTargets = new Set(parseIssues.map((i) => i.path));
    parseIssues.forEach(push);
    for (const i of validateInvoice(model, { roundingToleranceMinor })) {
      // an amount that exists but could not be read is already reported once; don't also say "missing"
      if (i.code === 'missing_field' && parseTargets.has(i.path)) continue;
      let sev = i.severity;
      if (doc.docType === 'receipt' && i.code === 'missing_field' && i.path === 'number') sev = 'info';
      if (doc.docType === 'receipt' && i.code === 'missing_field' && i.path === 'rows') sev = 'info';
      // receipts have no customer field and usually no qty/unit price; those notes would point at nothing
      if (doc.docType === 'receipt' && ((i.code === 'missing_field' && i.path === 'customer.name') || i.code === 'row_unverifiable')) continue;
      const target = targetOf(i.path, doc);
      push(tidy({ code: i.code, severity: sev, path: i.path, message: i.message, target }, doc));
    }

    // extraction notes: shown until the user edits that field
    for (const k of FIELDS_BY_TYPE[doc.docType]) {
      const fl = doc.fields[k];
      if (fl.note && fl.noteLevel === 'warning' && !isEdited(fl)) push({ code: 'extraction_note', severity: 'warning', path: k, target: { type: 'field', key: k }, message: fl.note });
    }
    doc.items.forEach((row) => ROW_COLUMNS.forEach((c) => {
      const fl = row.cells[c];
      if (fl.note && fl.noteLevel === 'warning' && !isEdited(fl)) push({ code: 'extraction_note', severity: 'warning', path: `${row.id}.${c}`, target: { type: 'cell', rowId: row.id, col: c }, message: fl.note });
    }));

    // OCR confidence of the words a value was read from
    if (result) {
      const low = (ref) => {
        const p = result.pages.find((x) => x.index === ref?.page);
        const confs = (ref?.items ?? []).map((i) => p?.raw.items[i]?.conf).filter(Number.isFinite);
        return confs.length ? Math.min(...confs) : null;
      };
      const check = (fl, label, target, path) => {
        if (!fl.ref || isEdited(fl) || !trim(fl.value)) return;
        const c = low(fl.ref);
        if (c !== null && c < policy.lowWordConf) push({ code: 'low_confidence', severity: 'warning', path, target, message: `${label}: low recognition confidence (${Math.round(c)}%). Check it against the original.` });
      };
      for (const k of FIELDS_BY_TYPE[doc.docType]) check(doc.fields[k], labelFor(k, doc.docType), { type: 'field', key: k }, k);
      doc.items.forEach((row, i) => ROW_COLUMNS.forEach((c) => check(row.cells[c], `Row ${i + 1} ${ROW_LABELS[c].toLowerCase()}`, { type: 'cell', rowId: row.id, col: c }, `${row.id}.${c}`)));
    }
  }

  // source-level review reasons from recognition (missing text, low page confidence)
  (result?.review ?? []).forEach((r, i) => push({ code: 'source_review', severity: 'warning', path: String(i), target: { type: 'tab', tab: 'text' }, message: r }));
  if (!Object.values(doc.text).some((t) => trim(t.value))) push({ code: 'no_text', severity: 'info', target: { type: 'tab', tab: 'text' }, message: 'No text in this document.' });

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** Issues for one field/cell target. */
export const issuesFor = (issues, target) => issues.filter((i) => targetKey(i.target) === targetKey(target));
export const reviewCount = (issues) => issues.filter((i) => i.severity !== 'info').length;
export { FIELD_LABELS, MONEY_FIELDS };
