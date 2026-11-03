import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { levenshtein, characterErrorRate, wordErrorRate, fieldScores, splitDocs, normDate } from './metrics.js';

test('levenshtein known values', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('', 'abc'), 3);
  assert.equal(levenshtein('abc', 'abc'), 0);
});
test('levenshtein is symmetric and bounded', () => {
  fc.assert(fc.property(fc.string(), fc.string(), (a, b) => {
    const d = levenshtein(a, b);
    assert.equal(d, levenshtein(b, a));
    assert.ok(d <= Math.max(Array.from(a).length, Array.from(b).length));
  }));
});
test('CER / WER', () => {
  assert.equal(characterErrorRate('abcd', 'abcd'), 0);
  assert.equal(characterErrorRate('abcd', 'abxd'), 0.25);
  assert.equal(characterErrorRate('', ''), 0);
  assert.equal(wordErrorRate('the quick brown fox', 'the quick red fox'), 0.25);
  assert.equal(wordErrorRate('a b', 'a  b'), 0);
});
test('fieldScores: minor-unit amounts and ISO dates', () => {
  const truth = { d1: { number: 'A1', issueDate: '2025-01-02', totalMinor: 1250, currency: 'EUR', rows: [{ description: 'x', qty: 1, unitMinor: 1250, totalMinor: 1250 }] } };
  const good = { d1: { number: 'a1', issueDate: '02.01.2025', totalMinor: '12,50', currency: 'EUR', rows: [{ description: 'X', qty: '1', unitMinor: 1250, totalMinor: 1250 }] } };
  const s = fieldScores(good, truth);
  assert.equal(s.exactMatchRate, 1);
  assert.equal(s.perField.totalMinor.f1, 1);
  const bad = fieldScores({ d1: { number: 'A1', issueDate: '2025-02-01', totalMinor: 1251, currency: 'EUR', rows: [] } }, truth);
  assert.equal(bad.exactMatchRate, 0);
  assert.equal(bad.perField.totalMinor.precision, 0);
  assert.equal(bad.perField.number.f1, 1);
  assert.equal(bad.perField['rows.totalMinor'].recall, 0);
  const none = fieldScores({}, truth);
  assert.equal(none.micro.recall, 0);
  assert.equal(none.micro.precision, null);
  assert.equal(normDate('2025-13-45'), '2025-13-45'); // format-only normaliser; validity is validation.js's job
});
test('fieldScores: spurious prediction hurts precision, not recall', () => {
  const s = fieldScores({ d: { dueDate: '2025-01-01' } }, { d: {} });
  assert.equal(s.perField.dueDate.precision, 0);
  assert.equal(s.perField.dueDate.recall, null);
  assert.equal(s.exactMatchRate, 0);
});
test('splitDocs deterministic, order independent, growth stable', () => {
  const ids = Array.from({ length: 200 }, (_, i) => `doc${i}`);
  const a = splitDocs(ids, { seed: 's1', heldOutFraction: 0.3 });
  const b = splitDocs([...ids].reverse(), { seed: 's1', heldOutFraction: 0.3 });
  assert.deepEqual(a, b);
  assert.equal(a.tune.length + a.heldOut.length, 200);
  assert.ok(a.heldOut.length > 40 && a.heldOut.length < 80);
  assert.notDeepEqual(a, splitDocs(ids, { seed: 's2', heldOutFraction: 0.3 }));
  const grown = splitDocs([...ids, 'new1', 'new2'], { seed: 's1', heldOutFraction: 0.3 });
  for (const id of a.heldOut) assert.ok(grown.heldOut.includes(id));
  assert.deepEqual(splitDocs(ids, { heldOutFraction: 0 }).heldOut, []);
  assert.equal(splitDocs(ids, { heldOutFraction: 1 }).tune.length, 0);
});
const truthDir = fileURLToPath(new URL('../../corpus/truth/', import.meta.url));
const corpusEmpty = !existsSync(truthDir) || !readdirSync(truthDir).some((f) => f.endsWith('.json') && f !== 'schema.json' && !f.startsWith('_'));
test('run.js exits 0 with "No documents" on an empty corpus', { skip: !corpusEmpty && 'corpus is populated' }, () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./run.js', import.meta.url))], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No documents/);
});
