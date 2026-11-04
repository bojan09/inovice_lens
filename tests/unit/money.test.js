import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatAmount, addMinor, multiplyMinor, percentOfMinor } from '../../js/money.js';

const ok = (text, minor, currency = null, opts) => {
  const r = parseAmount(text, opts);
  assert.equal(r.minor, minor, `${text}: ${JSON.stringify(r)}`);
  assert.equal(r.ambiguous, false, text);
  assert.equal(r.currency, currency, text);
};

test('formats: dot-thousands comma-decimal', () => { ok('1.234,56', 123456); ok('1.234.567,89', 123456789); });
test('formats: comma-thousands dot-decimal', () => { ok('1,234.56', 123456); ok('1,234,567.89', 123456789); });
test('formats: space grouping', () => { ok('1 234,56', 123456); ok('1 234,56', 123456); ok('1 234.56', 123456); ok('1 234', 123400); });
test('formats: apostrophe grouping', () => { ok("1'234.56", 123456); ok('1’234,56', 123456); });
test('formats: short decimals', () => { ok('12,5', 1250); ok('12.50', 1250); ok('12.5', 1250); ok('0,99', 99); ok('0.500', 50); ok('12', 1200); });
test('formats: negatives', () => {
  ok('-12.50', -1250); ok('(12.50)', -1250); ok('12.50-', -1250); ok('−12,50', -1250);
  ok('(1.234,56)', -123456); ok('€-5', -500, 'EUR'); ok('-€5.00', -500, 'EUR');
});
test('formats: currencies', () => {
  ok('€12.50', 1250, 'EUR'); ok('12,50 EUR', 1250, 'EUR'); ok('EUR 1.234,56', 123456, 'EUR');
  ok('1.234,56 MKD', 123456, 'MKD'); ok('$1,234.56', 123456, 'USD'); ok('USD 10', 1000, 'USD');
  ok('£9.99', 999, 'GBP'); ok('GBP 9.99', 999, 'GBP'); ok('1000 JPY', 1000, 'JPY');
  ok('(€12.50)', -1250, 'EUR');
});
test('ambiguous 1,234 and 1.234 are flagged, not guessed', () => {
  for (const t of ['1,234', '1.234', '€1,234', '999.999']) {
    const r = parseAmount(t);
    assert.equal(r.minor, null, t);
    assert.equal(r.ambiguous, true, t);
    assert.ok(r.candidates.length >= 1);
  }
  assert.deepEqual(parseAmount('1,234').candidates, [123400]);
  assert.deepEqual(parseAmount('1,230').candidates, [123000, 123]);
});
test('localeHint resolves ambiguity', () => {
  ok('1,234', 123400, null, { localeHint: 'en' });
  ok('1.234', 123400, null, { localeHint: 'de' });
  ok('1.234', 123400, null, { localeHint: 'de-DE' });
  ok('1,230', 123, null, { localeHint: 'de' });
  const r = parseAmount('1,234', { localeHint: 'de' }); // 3 real decimals: hint contradicts text
  assert.equal(r.minor, null); assert.equal(r.ambiguous, true);
});
test('unambiguous shapes never need the hint', () => {
  ok('1.234.567', 123456700); ok('1234,567'.replace('567', '500'), 123450);
  assert.equal(parseAmount('1234,567').minor, null); // 3 non-zero decimals not representable
  assert.equal(parseAmount('1234,567').ambiguous, false);
  assert.equal(parseAmount('0,500').minor, 50);
});
test('rejects garbage rather than guessing', () => {
  for (const t of ['', 'abc', '1,2,3', '12..5', '1.234,56,7', '--5', '(5)-', '€ $ 5', 'EUR 5 USD', '1 23', '.5', '5.', '1,23.456,78']) {
    const r = parseAmount(t);
    assert.equal(r.minor, null, t);
  }
  assert.equal(parseAmount('EUR 5 USD').ambiguous, true);
});
test('out of range yields null', () => assert.equal(parseAmount('99999999999999999999').minor, null));

test('formatAmount', () => {
  assert.equal(formatAmount(123456, 'EUR', 'de'), '1.234,56 EUR');
  assert.equal(formatAmount(123456, 'EUR', 'en'), '1,234.56 EUR');
  assert.equal(formatAmount(-5, 'USD', 'en'), '-0.05 USD');
  assert.equal(formatAmount(1234, 'JPY', 'en'), '1,234 JPY');
  assert.equal(formatAmount(123456, 'EUR', "ch"), "1'234.56 EUR");
  assert.throws(() => formatAmount(1.5, 'EUR'), RangeError);
});

test('integer minor-unit arithmetic', () => {
  assert.equal(addMinor(10, 20, 30), 60);
  assert.equal(addMinor([1, 2], 3), 6);
  assert.throws(() => addMinor(0.1, 0.2), RangeError);
  assert.equal(multiplyMinor(1999, 3), 5997);
  assert.equal(multiplyMinor(1000, '1.5'), 1500);
  assert.equal(multiplyMinor(333, '0.5'), 167); // 166.5 -> half away from zero
  assert.equal(multiplyMinor(-333, '0.5'), -167);
  assert.equal(multiplyMinor(1, 0.1), 0);
  assert.equal(multiplyMinor(10, 0.1), 1);
  assert.equal(multiplyMinor(1999, '2.5'), 4998); // 4997.5 -> 4998
  assert.equal(percentOfMinor(10000, '18'), 1800);
  assert.equal(percentOfMinor(1050, '18'), 189);
  assert.equal(percentOfMinor(5, '10'), 1); // 0.5 -> 1
  assert.throws(() => multiplyMinor(1, '1e3'), TypeError);
});

// ---- found on real-world documents (invoice2data samples), generic English behaviour
import { detectCurrencies as _detect, parseAmount as _parse } from '../../js/money.js';
test('currency detection: "All" is an English word, not the lek; rupee forms are recognised', () => {
  assert.deepEqual(_detect('Note : All Payment to be made in favor of Oravel'), []);
  assert.deepEqual(_detect('ALL 1,200.00'), ['ALL']);
  assert.deepEqual(_detect('Grand Total Rs 1939'), ['INR']);
  assert.deepEqual(_detect('Rs.1,939.00'), ['INR']);
  assert.deepEqual(_detect('₹ 250'), ['INR']);
  assert.equal(_parse('Rs 1939').minor, 193900);
});
