import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { parseAmount, formatAmount, addMinor, multiplyMinor, percentOfMinor, sumMinor } from '../../js/money.js';

const minorArb = fc.integer({ min: -9_000_000_000_000, max: 9_000_000_000_000 });
const cur2 = fc.constantFrom('EUR', 'USD', 'GBP', 'MKD', 'CHF');
const locales = fc.constantFrom('de', 'en', 'fr', 'ch');

test('round trip format->parse, 2-decimal currencies, with and without hint', () => {
  fc.assert(fc.property(minorArb, cur2, locales, (m, c, loc) => {
    const text = formatAmount(m, c, loc);
    for (const opts of [{ localeHint: loc }, {}]) {
      const r = parseAmount(text, opts);
      assert.equal(r.minor, m, text);
      assert.equal(r.currency, c);
      assert.equal(r.ambiguous, false);
    }
  }), { numRuns: 2000 });
});

test('round trip for zero-decimal currency needs the matching hint', () => {
  fc.assert(fc.property(fc.integer({ min: -1e12, max: 1e12 }), locales, (m, loc) => {
    const r = parseAmount(formatAmount(m, 'JPY', loc), { localeHint: loc });
    assert.equal(r.minor, m);
    assert.equal(r.ambiguous, false);
  }), { numRuns: 1000 });
});

test('thousands-shaped single separator is always flagged without hint', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 999 }), fc.integer({ min: 0, max: 999 }), fc.constantFrom(',', '.'), (a, b, sep) => {
    const r = parseAmount(`${a}${sep}${String(b).padStart(3, '0')}`);
    assert.equal(r.minor, null);
    assert.equal(r.ambiguous, true);
  }));
});

test('sum invariants: order independent, matches BigInt, integer', () => {
  const arr = fc.array(fc.integer({ min: -1e9, max: 1e9 }), { maxLength: 50 });
  fc.assert(fc.property(arr, (xs) => {
    const s = sumMinor(xs);
    assert.ok(Number.isInteger(s));
    assert.equal(BigInt(s), xs.reduce((a, b) => a + BigInt(b), 0n));
    assert.equal(sumMinor([...xs].reverse()), s);
    assert.equal(addMinor(...xs, 0), s);
  }));
});

test('no float drift: 0.1+0.2 style decimal quantities are exact', () => {
  // qty given as a decimal with k digits: result must equal round-half-away(unit*qtyInt/10^k) via BigInt.
  fc.assert(fc.property(fc.integer({ min: -1e9, max: 1e9 }), fc.integer({ min: 0, max: 1e6 }), fc.integer({ min: 0, max: 4 }), (unit, qInt, k) => {
    const qty = k === 0 ? String(qInt) : `${Math.floor(qInt / 10 ** k)}.${String(qInt % 10 ** k).padStart(k, '0')}`;
    const num = BigInt(unit) * BigInt(qInt), den = 10n ** BigInt(k);
    let q = (num < 0n ? -num : num) / den;
    if (((num < 0n ? -num : num) % den) * 2n >= den) q += 1n;
    if (num < 0n) q = -q;
    assert.equal(BigInt(multiplyMinor(unit, qty)), q);
  }));
  assert.equal(multiplyMinor(10, 0.1) + multiplyMinor(10, 0.2), 3);
  assert.equal(multiplyMinor(100, 3), 300);
});

test('integer quantity multiplication is exact and distributes over addition', () => {
  fc.assert(fc.property(fc.integer({ min: -1e6, max: 1e6 }), fc.integer({ min: -1e6, max: 1e6 }), fc.integer({ min: 0, max: 1000 }), (a, b, n) => {
    assert.equal(multiplyMinor(a + b, n), multiplyMinor(a, n) + multiplyMinor(b, n));
  }));
});

test('percentOfMinor is within half a minor unit of the exact value', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 1e10 }), fc.integer({ min: 0, max: 100 }), (base, rate) => {
    const got = percentOfMinor(base, String(rate));
    assert.ok(Math.abs(got * 100 - base * rate) <= 50);
  }));
});
