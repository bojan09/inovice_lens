// theme.js - light / dark / system preference. Persisted in localStorage (preference only,
// never document data). The same read logic is duplicated in js/theme-init.js, which must
// run synchronously before first paint (CSP forbids inline scripts).

export const THEME_KEY = 'invoicelens.theme';
export const PREFS = ['light', 'dark', 'system'];

/** Anything that is not a known preference falls back to "system". */
export function parsePref(raw) {
  return PREFS.includes(raw) ? raw : 'system';
}

/** The theme actually shown. */
export function resolveTheme(pref, systemDark) {
  if (pref === 'light' || pref === 'dark') return pref;
  return systemDark ? 'dark' : 'light';
}

export function readPref(storage) {
  try {
    return parsePref(storage.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

/** Returns true when persisted. Storage may be blocked; the preference still applies for the session. */
export function writePref(storage, pref) {
  try {
    if (pref === 'system') storage.removeItem(THEME_KEY);
    else storage.setItem(THEME_KEY, pref);
    return true;
  } catch {
    return false;
  }
}

/** "system" removes data-theme so tokens.css follows prefers-color-scheme. */
export function applyPref(root, pref) {
  if (pref === 'light' || pref === 'dark') root.setAttribute('data-theme', pref);
  else root.removeAttribute('data-theme');
}
