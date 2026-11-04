// money.js - pure, dependency-free money handling for InvoiceLens.
//
// INVARIANTS
//  * Money is an integer count of minor units (e.g. cents) plus an ISO 4217
//    currency code. Floats are never used to hold or compute money.
//  * Text is parsed digit-by-digit (no parseFloat). Multiplication uses BigInt
//    rational math. Results must be safe integers or the call throws/returns null.
//  * Ambiguity is FLAGGED, never guessed: "1,234" / "1.234" with no cue returns
//    {minor:null, ambiguous:true}. A caller may only resolve it via localeHint
//    or an explicit user decision.
//
// ROUNDING RULE (single, explicit, used everywhere in this file):
//  When an exact product/percentage is not a whole number of minor units it is
//  rounded to the nearest minor unit, ties away from zero ("commercial"
//  rounding): 0.5 -> 1, -0.5 -> -1, 2.5 -> 3. This is applied once, on the final
//  exact rational result, never on intermediate values.

/** Number of minor-unit digits per currency (default 2). */
const EXPONENTS = { JPY: 0, KRW: 0, VND: 0, HUF: 2, BHD: 3, KWD: 3, JOD: 3, TND: 3 };
export function currencyExponent(currency) {
  const e = EXPONENTS[String(currency || '').toUpperCase()];
  return e === undefined ? 2 : e;
}

// Order matters only for readability. Symbols map to a single currency; "$" is
// reported as USD (other dollar currencies need an explicit code).
const CODES = ['EUR', 'MKD', 'USD', 'GBP', 'CHF', 'RSD', 'BGN', 'JPY', 'CAD', 'AUD', 'ALL', 'KRW', 'INR'];
// "ALL" is also an ordinary English word ("All payments..."): it only counts as the lek when it touches a number.
const NEEDS_NUMBER = new Set(['ALL']);
const SYMBOLS = [
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['$', 'USD'],
  ['¥', 'JPY'],
  ['₹', 'INR'],
];
const RUPEE_WORD = /(?<![A-Za-z])Rs\.?(?=\s?\d)/g; // "Rs 1939", "Rs.1,939.00"


const GROUP_SPACES = /[    ']|’/;

/** Strip currency tokens; returns {text, currencies:Set}. */
function extractCurrency(input) {
  let text = input;
  const found = new Set();
  for (const code of CODES) {
    const bare = `(?<![A-Za-z])${code}(?![A-Za-z])`;
    const re = NEEDS_NUMBER.has(code) ? new RegExp(`${bare}(?=\\s?\\d)|(?<=\\d\\s?)${bare}`, 'g') : new RegExp(bare, 'gi');
    text = text.replace(re, () => (found.add(code), ' '));
  }
  if (RUPEE_WORD.test(text)) { found.add('INR'); }
  RUPEE_WORD.lastIndex = 0;
  text = text.replace(RUPEE_WORD, ' ');
  for (const [sym, code] of SYMBOLS) {
    if (text.includes(sym)) {
      found.add(code);
      text = text.split(sym).join(' ');
    }
  }
  return { text, currencies: found };
}

/** Currencies mentioned anywhere in free text (codes and symbols), e.g. ['EUR','USD']. "$" is reported as USD. */
export function detectCurrencies(text) {
  return [...extractCurrency(String(text ?? '')).currencies].sort();
}

function result(minor, currency, ambiguous, reason, extra) {
  return { minor, currency, ambiguous, reason, ...(extra || {}) };
}

/** digits string -> minor units as Number, or null if not exactly representable. */
function toMinor(intDigits, fracDigits, exp) {
  let frac = fracDigits;
  if (frac.length > exp) {
    // Extra decimals are acceptable only if they are zeros (12.500 -> 12.50).
    if (/[1-9]/.test(frac.slice(exp))) return { error: 'too_many_decimals' };
    frac = frac.slice(0, exp);
  }
  frac = frac.padEnd(exp, '0');
  const big = BigInt((intDigits || '0') + frac);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) return { error: 'out_of_range' };
  return { value: Number(big) };
}

const THOUSANDS_RE = (sep) => new RegExp(`^\\d{1,3}(?:\\${sep}\\d{3})+$`);

/**
 * Parse a printed amount.
 * @param {string} text
 * @param {{localeHint?: string|null, currencyHint?: string|null}} [opts]
 *   localeHint: 'de' | 'fr' | 'sr' | 'bg' ... => comma is the decimal mark
 *               'en' | 'us' | 'uk' | 'gb' | 'ch' ... => dot is the decimal mark
 *               (language prefix of a BCP-47 tag is used, e.g. 'mk-MK').
 *   currencyHint: used only to pick the minor-unit exponent when the text has no currency.
 * @returns {{minor:number|null, currency:string|null, ambiguous:boolean, reason:string, candidates?:number[]}}
 *   candidates (only when ambiguous): every valid reading in minor units.
 */
export function parseAmount(text, opts = {}) {
  const { localeHint = null, currencyHint = null } = opts || {};
  if (typeof text !== 'string') return result(null, null, false, 'not_a_string');
  const raw = text.trim();
  if (!raw) return result(null, null, false, 'empty');

  const { text: noCur, currencies } = extractCurrency(raw);
  if (currencies.size > 1) return result(null, null, true, 'conflicting_currencies');
  const currency = currencies.size === 1 ? [...currencies][0] : null;
  const exp = currencyExponent(currency || currencyHint);

  // ---- sign ----
  let body = noCur.replace(/[−–—]/g, '-').trim();
  let negative = false;
  let signMarks = 0;
  const paren = /^\((.*)\)$/s.exec(body);
  if (paren) { negative = true; signMarks++; body = paren[1].trim(); }
  if (/^\+/.test(body)) body = body.slice(1).trim();
  if (/^-/.test(body)) { negative = true; signMarks++; body = body.slice(1).trim(); }
  if (/-$/.test(body)) { negative = true; signMarks++; body = body.slice(0, -1).trim(); }
  if (signMarks > 1) return result(null, currency, false, 'conflicting_signs');
  if (!body) return result(null, currency, false, 'no_digits');

  // ---- charset ----
  if (!/^[\d.,\s   '’]+$/.test(body) || !/\d/.test(body)) {
    return result(null, currency, false, 'unparseable');
  }
  if (/^[.,]|[.,]$/.test(body)) return result(null, currency, false, 'dangling_separator');

  // ---- space / apostrophe grouping: always thousands, never decimal ----
  const hasGroupSep = GROUP_SPACES.test(body);
  let intPart;
  let fracPart = '';
  let decimalChar = null;

  const finish = (ip, fp, amb, reason) => {
    const m = toMinor(ip, fp, exp);
    if (m.error) return result(null, currency, false, m.error);
    return result(negative ? -m.value : m.value, currency, amb, reason);
  };

  if (hasGroupSep) {
    // Split off the decimal part first: the only [.,] allowed is one decimal mark.
    const marks = body.match(/[.,]/g) || [];
    if (marks.length > 1) return result(null, currency, false, 'unparseable');
    let head = body;
    if (marks.length === 1) {
      const i = body.search(/[.,]/);
      head = body.slice(0, i);
      fracPart = body.slice(i + 1);
      decimalChar = body[i];
      if (!/^\d+$/.test(fracPart)) return result(null, currency, false, 'unparseable');
    }
    const groups = head.split(/[    '’]+/);
    if (!/^\d{1,3}$/.test(groups[0]) || !groups.slice(1).every((g) => /^\d{3}$/.test(g))) {
      return result(null, currency, false, 'bad_grouping');
    }
    intPart = groups.join('');
    return finish(intPart, fracPart, false, decimalChar ? `group_sep+decimal(${decimalChar})` : 'group_sep');
  }

  const hasDot = body.includes('.');
  const hasComma = body.includes(',');

  if (hasDot && hasComma) {
    // The LAST separator is the decimal mark; the other must be a valid thousands mark.
    const decIdx = Math.max(body.lastIndexOf('.'), body.lastIndexOf(','));
    decimalChar = body[decIdx];
    const thousandsChar = decimalChar === '.' ? ',' : '.';
    const head = body.slice(0, decIdx);
    fracPart = body.slice(decIdx + 1);
    if (head.includes(decimalChar) || !/^\d+$/.test(fracPart) || !THOUSANDS_RE(thousandsChar).test(head)) {
      return result(null, currency, false, 'bad_grouping');
    }
    return finish(head.split(thousandsChar).join(''), fracPart, false, `mixed(decimal=${decimalChar})`);
  }

  if (!hasDot && !hasComma) {
    return finish(body, '', false, 'integer');
  }

  // ---- exactly one kind of separator ----
  const sep = hasDot ? '.' : ',';
  const parts = body.split(sep);
  if (!parts.every((p) => /^\d+$/.test(p))) return result(null, currency, false, 'unparseable');

  if (parts.length > 2) {
    // 1.234.567 : repeated separator can only be thousands.
    if (!THOUSANDS_RE(sep).test(body)) return result(null, currency, false, 'bad_grouping');
    return finish(parts.join(''), '', false, `repeated_thousands(${sep})`);
  }

  const [ip, fp] = parts;
  const thousandsShaped = fp.length === 3 && /^[1-9]\d{0,2}$/.test(ip);
  if (!thousandsShaped) {
    // 12,5  12.50  0,500  1234,567 -> cannot be a thousands group, so decimal.
    return finish(ip, fp, false, `decimal(${sep})`);
  }

  // thousandsShaped: "1,234" / "1.234" -> genuinely ambiguous without a cue.
  const hint = hintKind(localeHint);
  if (hint) {
    const decimalMark = hint === 'comma-decimal' ? ',' : '.';
    if (sep !== decimalMark) {
      return finish(ip + fp, '', false, `locale_hint:${hint}:thousands(${sep})`);
    }
    // The hint says this is a decimal mark, giving 3 decimals.
    const m = toMinor(ip, fp, exp);
    if (!m.error) return result(negative ? -m.value : m.value, currency, false, `locale_hint:${hint}:decimal(${sep})`);
    // 3 non-zero decimals cannot be money here: the hint contradicts the text. Do not guess.
    return result(null, currency, true, 'hint_conflicts_with_text', { candidates: candidatesFor(ip, fp, exp, negative) });
  }
  return result(null, currency, true, `ambiguous_separator(${sep})`, { candidates: candidatesFor(ip, fp, exp, negative) });
}

function candidatesFor(ip, fp, exp, negative) {
  const out = [];
  const sgn = negative ? -1 : 1;
  const t = toMinor(ip + fp, '', exp);
  if (!t.error) out.push(sgn * t.value);
  const d = toMinor(ip, fp, exp);
  if (!d.error) out.push(sgn * d.value);
  return out;
}

const COMMA_DECIMAL = new Set(['mk', 'de', 'fr', 'sr', 'bg', 'ru', 'it', 'es', 'pt', 'nl', 'sq', 'al', 'tr', 'hr', 'sl', 'pl', 'cs', 'sk', 'hu', 'ro', 'el', 'comma']);
const DOT_DECIMAL = new Set(['en', 'us', 'uk', 'gb', 'ch', 'jp', 'dot']);
function hintKind(hint) {
  if (!hint) return null;
  const lang = String(hint).toLowerCase().split(/[-_]/)[0];
  if (COMMA_DECIMAL.has(lang)) return 'comma-decimal';
  if (DOT_DECIMAL.has(lang)) return 'dot-decimal';
  return null;
}

const LOCALE_FORMATS = {
  de: { group: '.', decimal: ',' },
  en: { group: ',', decimal: '.' },
  fr: { group: ' ', decimal: ',' },
  ch: { group: "'", decimal: '.' },
};

/**
 * Format integer minor units. Locale: 'de' (1.234,56; also any comma-decimal locale code), 'en' (1,234.56),
 * 'fr' (1 234,56 narrow nbsp), 'ch' (1'234.56). Output is "<number> <CODE>"
 * and always shows every minor digit, so it parses back with parseAmount.
 */
export function formatAmount(minor, currency, locale = 'en') {
  assertMinor(minor);
  const lang = String(locale).toLowerCase().split(/[-_]/)[0];
  const fmt = LOCALE_FORMATS[lang] || (hintKind(lang) === 'comma-decimal' ? LOCALE_FORMATS.de : LOCALE_FORMATS.en);
  const exp = currencyExponent(currency);
  const neg = minor < 0;
  let digits = BigInt(Math.abs(minor)).toString().padStart(exp + 1, '0');
  const frac = exp ? digits.slice(-exp) : '';
  let int = exp ? digits.slice(0, -exp) : digits;
  int = int.replace(/\B(?=(\d{3})+(?!\d))/g, fmt.group);
  const num = (neg ? '-' : '') + int + (exp ? fmt.decimal + frac : '');
  return currency ? `${num} ${String(currency).toUpperCase()}` : num;
}

function assertMinor(v) {
  if (!Number.isSafeInteger(v)) throw new RangeError(`minor units must be a safe integer, got ${v}`);
}

/** Exact sum of minor units. Throws RangeError on non-integer or unsafe results. */
export function addMinor(...values) {
  let total = 0n;
  for (const v of values.flat()) { assertMinor(v); total += BigInt(v); }
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('sum out of safe integer range');
  }
  return Number(total);
}
export const sumMinor = (values) => addMinor(values);

/** Quantity / rate as an exact rational {num:BigInt, den:BigInt} from a decimal string or number. */
export function toRational(value) {
  const s = typeof value === 'number' ? String(value) : String(value).trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new TypeError(`not a plain decimal: ${s}`);
  const frac = m[3] || '';
  const num = BigInt(m[2] + frac) * (m[1] ? -1n : 1n);
  return { num, den: 10n ** BigInt(frac.length) };
}

/** Round num/den to nearest integer, ties away from zero (see header). */
function roundDiv(num, den) {
  const neg = (num < 0n) !== (den < 0n);
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  let q = n / d;
  if ((n % d) * 2n >= d) q += 1n;
  return neg ? -q : q;
}

function toSafeNumber(big) {
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('result out of safe integer range');
  }
  return Number(big);
}

/**
 * unitMinor * qty, qty a decimal (string or number such as 1.5, "0.333").
 * Exact rational multiplication, then ONE rounding (half away from zero).
 */
export function multiplyMinor(unitMinor, qty) {
  assertMinor(unitMinor);
  const { num, den } = toRational(qty);
  return toSafeNumber(roundDiv(BigInt(unitMinor) * num, den));
}

/** baseMinor * ratePercent / 100, e.g. percentOfMinor(10000, "18") === 1800. Same rounding rule. */
export function percentOfMinor(baseMinor, ratePercent) {
  assertMinor(baseMinor);
  const { num, den } = toRational(ratePercent);
  return toSafeNumber(roundDiv(BigInt(baseMinor) * num, den * 100n));
}
