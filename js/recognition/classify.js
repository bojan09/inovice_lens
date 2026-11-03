// classify.js - heuristic, English-only document category suggestion. It SUGGESTS; the user can
// always override. It never claims certainty: result.confidence is 'likely' | 'uncertain' | 'none'.

export const CATEGORIES = Object.freeze(['invoice', 'receipt', 'table', 'general']);
export const CATEGORY_LABELS = Object.freeze({ invoice: 'Invoice', receipt: 'Receipt', table: 'Table', general: 'General document' });

const INVOICE_TERMS = [
  /\binvoice\b/, /\binv(?:oice)?\s*(?:no|number|#)/, /\bbill\s*to\b/, /\bdue\s*date\b/, /\bpayment\s*terms?\b/,
  /\bsub\s*-?\s*total\b/, /\bvat\b|\btax\b/, /\bamount\s*due\b/, /\bpurchase\s*order\b|\bp\.?o\.?\s*(?:no|number|#)/,
  /\bunit\s*price\b/, /\bqty\b|\bquantity\b/, /\bsupplier\b|\bvendor\b/, /\bdescription\b/,
];
const RECEIPT_TERMS = [
  /\breceipt\b/, /\bcash(?:ier)?\b/, /\bchange\b/, /\bthank\s*you\b/, /\btender(?:ed)?\b/, /\b(?:visa|mastercard|amex|debit|credit)\b/,
  /\bcard\s*(?:no|number|ending)\b|\*{2,}\s*\d{4}/, /\bstore\b|\bshop\b/, /\bterminal\b|\bpos\b/, /\bitems?\s*sold\b|\bbalance\b/,
  /\bsubtotal\b|\bsub\s*-?\s*total\b/, /\btotal\b/,
];

const NUM = /(?:^|\s)[-+]?[$€£]?\d[\d.,]*%?(?=\s|$)/g;

/** @param {string[]} lines normalized lines (see text.js) */
export function classify(lines) {
  const text = lines.join('\n').toLowerCase();
  const chars = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const zero = { invoice: 0, receipt: 0, table: 0, general: 0 };
  if (chars < 20) return { suggested: 'general', scores: zero, confidence: 'none', reasons: ['Not enough text to suggest a type.'] };

  const hits = (terms) => terms.filter((re) => re.test(text)).length;
  const inv = hits(INVOICE_TERMS);
  const rec = hits(RECEIPT_TERMS);
  // a bare "total" appears on both; only count receipt-specific signals strongly
  const receiptSpecific = hits(RECEIPT_TERMS.slice(0, 8));

  const numericLines = lines.filter((l) => (l.match(NUM) ?? []).length >= 2).length;
  const numericRatio = lines.length ? numericLines / lines.length : 0;
  const tableScore = lines.length >= 4 && numericLines >= 3 ? Math.round(numericRatio * 6 * 10) / 10 : 0;

  const scores = {
    invoice: inv,
    receipt: receiptSpecific * 1.5 + (rec - receiptSpecific) * 0.5,
    table: Math.max(0, tableScore - Math.min(inv, 3) * 0.5),
    general: 1.5,
  };

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [top, topScore] = ranked[0];
  const second = ranked[1][1];
  let confidence = 'uncertain';
  if (top !== 'general' && topScore >= 3 && topScore - second >= 1.5) confidence = 'likely';
  else if (top === 'general') confidence = 'uncertain';

  const reasons = [];
  if (inv) reasons.push(`${inv} invoice term${inv === 1 ? '' : 's'}`);
  if (receiptSpecific) reasons.push(`${receiptSpecific} receipt-specific term${receiptSpecific === 1 ? '' : 's'}`);
  if (tableScore) reasons.push(`${numericLines} of ${lines.length} lines are number-heavy`);
  if (!reasons.length) reasons.push('No strong invoice, receipt or table signals.');
  return { suggested: top, scores, confidence, reasons };
}
