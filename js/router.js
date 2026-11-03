// router.js - hash routes. Pure parsing; DOM wiring lives in js/ui/nav.js.

export const VIEWS = Object.freeze({
  convert: { title: 'Convert' },
  batch: { title: 'Batch Processing' },
  projects: { title: 'Saved Projects' },
  settings: { title: 'Settings' },
});

export const DEFAULT_VIEW = 'convert';

/** "#/batch" -> "batch". Unknown or empty -> "convert". */
export function parseRoute(hash) {
  const m = /^#\/?([a-z-]+)/.exec(hash || '');
  return m && Object.hasOwn(VIEWS, m[1]) ? m[1] : DEFAULT_VIEW;
}
