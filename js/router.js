// router.js - hash routes. Pure parsing; DOM wiring lives in js/ui/nav.js.

export const VIEWS = Object.freeze({
  convert: { title: 'Convert' },
  batch: { title: 'Batch Processing' },
  projects: { title: 'Saved Projects' },
  settings: { title: 'Settings' },
  editor: { title: 'Editor', parent: 'convert' }, // opened from a file card: #/editor/<fileId>
});

export const DEFAULT_VIEW = 'convert';

/** "#/batch" -> "batch". Unknown or empty -> "convert". */
export function parseRoute(hash) {
  const m = /^#\/?([a-z-]+)/.exec(hash || '');
  return m && Object.hasOwn(VIEWS, m[1]) ? m[1] : DEFAULT_VIEW;
}

/** "#/editor/f12" -> "f12". Anything else -> null. File ids look like f<number>. */
export function parseEditorId(hash) {
  const m = /^#\/?editor\/(f\d+)\/?$/.exec(hash || '');
  return m ? m[1] : null;
}

export const SETTINGS_SECTIONS = Object.freeze(['general', 'ocr', 'export', 'storage', 'appearance', 'processing']);

/** "#/settings/ocr" -> "ocr"; anything else (including unknown sections) -> "general". */
export function parseSettingsSection(hash) {
  const m = /^#\/?settings\/([a-z-]+)\/?$/.exec(hash || '');
  return m && SETTINGS_SECTIONS.includes(m[1]) ? m[1] : 'general';
}
