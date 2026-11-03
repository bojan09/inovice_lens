import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePref, resolveTheme, readPref, writePref, applyPref, THEME_KEY } from '../../js/theme.js';
import { formatBytes, usageFraction } from '../../js/format.js';
import { parseRoute } from '../../js/router.js';

function fakeStorage(initial = {}, { throws = false } = {}) {
  const m = new Map(Object.entries(initial));
  const guard = () => { if (throws) throw new Error('SecurityError'); };
  return {
    getItem: (k) => { guard(); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { guard(); m.set(k, String(v)); },
    removeItem: (k) => { guard(); m.delete(k); },
    _m: m,
  };
}
function fakeRoot() {
  const attrs = new Map();
  return {
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
    getAttribute: (k) => attrs.get(k) ?? null,
  };
}

test('parsePref: only light/dark/system pass through', () => {
  assert.equal(parsePref('light'), 'light');
  assert.equal(parsePref('dark'), 'dark');
  assert.equal(parsePref('system'), 'system');
  for (const bad of [null, undefined, '', 'DARK', 'blue', '<script>']) assert.equal(parsePref(bad), 'system');
});

test('resolveTheme: explicit wins, system follows OS', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
});

test('persistence round trip; system clears the key', () => {
  const s = fakeStorage();
  assert.equal(readPref(s), 'system');
  assert.equal(writePref(s, 'dark'), true);
  assert.equal(s._m.get(THEME_KEY), 'dark');
  assert.equal(readPref(s), 'dark');
  writePref(s, 'system');
  assert.equal(s._m.has(THEME_KEY), false);
});

test('blocked storage degrades without throwing', () => {
  const s = fakeStorage({}, { throws: true });
  assert.equal(readPref(s), 'system');
  assert.equal(writePref(s, 'dark'), false);
});

test('applyPref sets or removes data-theme', () => {
  const r = fakeRoot();
  applyPref(r, 'dark');
  assert.equal(r.getAttribute('data-theme'), 'dark');
  applyPref(r, 'light');
  assert.equal(r.getAttribute('data-theme'), 'light');
  applyPref(r, 'system');
  assert.equal(r.getAttribute('data-theme'), null);
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-5), '0 B');
  assert.equal(formatBytes(NaN), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024), '1 MB');
  assert.equal(formatBytes(312 * 1024 * 1024), '312 MB');
  assert.equal(formatBytes(2 * 1024 ** 3), '2 GB');
  assert.equal(formatBytes(25 * 1024 * 1024), '25 MB');
});

test('usageFraction', () => {
  assert.equal(usageFraction(1, 4), 0.25);
  assert.equal(usageFraction(10, 4), 1);
  assert.equal(usageFraction(0, 100), 0);
  assert.equal(usageFraction(1, 0), null);
  assert.equal(usageFraction(undefined, 5), null);
});

test('parseRoute', () => {
  assert.equal(parseRoute('#/batch'), 'batch');
  assert.equal(parseRoute('#/projects'), 'projects');
  assert.equal(parseRoute('#settings'), 'settings');
  assert.equal(parseRoute(''), 'convert');
  assert.equal(parseRoute('#/nope'), 'convert');
  assert.equal(parseRoute('#/__proto__'), 'convert');
  assert.equal(parseRoute('#/constructor'), 'convert');
  assert.equal(parseRoute(undefined), 'convert');
});
