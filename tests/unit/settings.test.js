import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, createSettings, ocrPolicy, DEFAULTS, SETTINGS_KEY, SETTINGS_VERSION, CHOICES } from '../../js/settings.js';

const memory = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

test('sanitize: junk, partial and hostile input always yields a complete valid object', () => {
  for (const junk of [null, undefined, 5, 'x', [], {}, { version: 1 }, { version: 1, values: 'nope' }, { values: { ocr: 7 } }]) assert.deepEqual(sanitize(junk), DEFAULTS, String(JSON.stringify(junk)));
  const s = sanitize({ version: 1, values: { ocr: { maxPages: 25, enhance: 'sometimes', maxMegapixels: 999 }, export: { format: 'docx', includeNotes: 'yes', __proto__: { polluted: true } }, extra: { x: 1 }, general: { warnUnsaved: false } } });
  assert.equal(s.ocr.maxPages, 25);
  assert.equal(s.ocr.enhance, 'auto', 'invalid choice falls back to the default');
  assert.equal(s.ocr.maxMegapixels, 12);
  assert.equal(s.export.format, 'docx');
  assert.equal(s.export.includeNotes, true, 'non-boolean ignored');
  assert.equal(s.general.warnUnsaved, false);
  assert.equal('extra' in s, false, 'unknown keys are dropped');
  assert.equal(({}).polluted, undefined);
  assert.equal(sanitize({ version: SETTINGS_VERSION + 1, values: { ocr: { maxPages: 10 } } }).ocr.maxPages, 50, 'newer-version data is not reinterpreted');
});

test('every allowed choice round-trips; every default is itself an allowed choice', () => {
  for (const [path, allowed] of Object.entries(CHOICES)) {
    const [a, b] = path.split('.');
    assert.ok(allowed.includes(DEFAULTS[a][b]), `${path} default is allowed`);
    for (const v of allowed) assert.equal(sanitize({ version: 1, values: { [a]: { [b]: v } } })[a][b], v);
  }
});

test('settings store: persists only preferences, removes the key at defaults, survives blocked storage, notifies', () => {
  const st = memory();
  const s = createSettings({ storage: st });
  assert.deepEqual(s.value, DEFAULTS);
  const seen = [];
  s.subscribe((v) => seen.push(v.ocr.maxPages));
  assert.equal(s.set('ocr.maxPages', 25), true);
  assert.equal(s.value.ocr.maxPages, 25);
  const stored = JSON.parse(st.getItem(SETTINGS_KEY));
  assert.deepEqual(Object.keys(stored), ['version', 'values']);
  assert.equal(JSON.stringify(stored).includes('invoice'), false, 'no file names / content');
  assert.equal(s.set('ocr.maxPages', 7), false, 'invalid value rejected');
  assert.equal(s.value.ocr.maxPages, 25);
  assert.equal(createSettings({ storage: st }).value.ocr.maxPages, 25, 'reload keeps it');
  s.reset();
  assert.equal(st.getItem(SETTINGS_KEY), null, 'defaults store nothing');
  assert.deepEqual(seen, [25, 50]);
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const b = createSettings({ storage: blocked });
  assert.equal(b.set('general.warnUnsaved', false), true);
  assert.equal(b.value.general.warnUnsaved, false, 'applies for the session');
  assert.equal(b.persisted, false, 'and says it was not saved');
});

test('ocrPolicy maps settings to pipeline limits', () => {
  const s = sanitize({ version: 1, values: { ocr: { enhance: 'never', maxPages: 10, maxMegapixels: 4 } } });
  assert.deepEqual(ocrPolicy(s), { maxPages: 10, maxOcrPixels: 4_000_000, enhance: false });
  assert.deepEqual(ocrPolicy(DEFAULTS), { maxPages: 50, maxOcrPixels: 12_000_000, enhance: true });
});
