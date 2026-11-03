// settings.js - user preferences. Only PREFERENCES are stored (localStorage, key below): never document content, file
// names or any identifier. Values are validated against an allow-list on every load, so a hand-edited or old value can
// never put the app in an invalid state; unknown keys are dropped. Versioned for future migrations.

export const SETTINGS_KEY = 'invoicelens.settings';
export const SETTINGS_VERSION = 1;

export const CHOICES = Object.freeze({
  'ocr.enhance': ['auto', 'never'],
  'ocr.maxPages': [10, 25, 50],
  'ocr.maxMegapixels': [4, 8, 12],
  'processing.autosaveSeconds': [1.5, 3, 5, 10],
  'appearance.motion': ['system', 'reduce'],
  'export.format': ['pdf', 'docx', 'xlsx', 'csv'],
  'export.pdfMode': ['structured', 'original'],
});
const BOOLEANS = ['general.warnUnsaved', 'export.includeNotes', 'export.includeText', 'export.textLayer', 'export.labelPages'];

export const DEFAULTS = Object.freeze({
  general: Object.freeze({ warnUnsaved: true }),
  appearance: Object.freeze({ motion: 'system' }),
  ocr: Object.freeze({ enhance: 'auto', maxPages: 50, maxMegapixels: 12 }),
  processing: Object.freeze({ autosaveSeconds: 1.5 }),
  export: Object.freeze({ format: 'pdf', pdfMode: 'structured', includeNotes: true, includeText: true, textLayer: true, labelPages: true }),
});

const get = (o, path) => path.split('.').reduce((a, k) => a?.[k], o);

/** Build a complete, valid settings object from anything (null, junk, partial, older version). */
export function sanitize(raw) {
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (Number.isInteger(raw.version) && raw.version > SETTINGS_VERSION) return out; // written by a newer app: do not reinterpret
  const src = raw.values && typeof raw.values === 'object' ? raw.values : {};
  for (const [path, allowed] of Object.entries(CHOICES)) {
    const v = get(src, path);
    if (allowed.includes(v)) { const [a, b] = path.split('.'); out[a][b] = v; }
  }
  for (const path of BOOLEANS) {
    const v = get(src, path);
    if (typeof v === 'boolean') { const [a, b] = path.split('.'); out[a][b] = v; }
  }
  return out;
}

/** The OCR policy implied by the settings (merged over DEFAULT_RECOGNITION_POLICY by the caller). */
export function ocrPolicy(s) {
  return { maxPages: s.ocr.maxPages, maxOcrPixels: s.ocr.maxMegapixels * 1_000_000, enhance: s.ocr.enhance !== 'never' };
}

export function createSettings({ storage = globalThis.localStorage } = {}) {
  let values = DEFAULTS;
  let persisted = true;
  const listeners = new Set();
  const read = () => { try { return JSON.parse(storage.getItem(SETTINGS_KEY)); } catch { return null; } };
  values = sanitize(read());
  const emit = () => listeners.forEach((fn) => fn(values));

  function write() {
    try {
      const isDefault = JSON.stringify(values) === JSON.stringify(DEFAULTS);
      if (isDefault) storage.removeItem(SETTINGS_KEY);
      else storage.setItem(SETTINGS_KEY, JSON.stringify({ version: SETTINGS_VERSION, values }));
      persisted = true;
    } catch { persisted = false; } // storage blocked/full: the choice still applies for this session
  }

  return {
    get value() { return values; },
    get persisted() { return persisted; },
    /** set('ocr.maxPages', 25). Unknown or invalid values are ignored (returns false). */
    set(path, v) {
      const ok = CHOICES[path] ? CHOICES[path].includes(v) : BOOLEANS.includes(path) && typeof v === 'boolean';
      if (!ok) return false; // an invalid value must never reset the setting to its default
      const next = sanitize({ version: SETTINGS_VERSION, values: { ...values, [path.split('.')[0]]: { ...values[path.split('.')[0]], [path.split('.')[1]]: v } } });
      if (JSON.stringify(next) === JSON.stringify(values)) return get(values, path) === v;
      values = next;
      write();
      emit();
      return true;
    },
    reset() { values = sanitize(null); write(); emit(); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
