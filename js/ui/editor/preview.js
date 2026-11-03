// preview.js - read-only summary of the CORRECTED document (what later export will be built from).
import { el } from '../dom.js';
import { FIELDS_BY_TYPE, labelFor, ROW_COLUMNS, ROW_LABELS } from '../../doc/model.js';
import { CATEGORY_LABELS } from '../../recognition/classify.js';

export function createPreview() {
  const node = el('div', { class: 'preview-body' });
  return {
    node,
    update({ doc }) {
      const parts = [el('h2', { class: 'ed-h2' }, doc.name), el('p', { class: 'ed-note' }, `${CATEGORY_LABELS[doc.docType]} · ${doc.pages.length} ${doc.pages.length === 1 ? 'page' : 'pages'} · your corrected values (not yet exported)`)];
      const keys = FIELDS_BY_TYPE[doc.docType].filter((k) => doc.fields[k].value.trim());
      if (keys.length) parts.push(el('dl', { class: 'pv-dl' }, ...keys.flatMap((k) => [el('dt', {}, labelFor(k, doc.docType)), el('dd', {}, doc.fields[k].value)])));
      if (doc.items.length) {
        parts.push(el('table', { class: 'pv-table' }, el('caption', { class: 'visually-hidden' }, 'Line items'),
          el('thead', {}, el('tr', {}, ...ROW_COLUMNS.map((c) => el('th', { scope: 'col' }, ROW_LABELS[c])))),
          el('tbody', {}, ...doc.items.map((r) => el('tr', {}, ...ROW_COLUMNS.map((c) => el('td', {}, r.cells[c].value)))))));
      }
      if (doc.grid.rows.length) {
        parts.push(el('table', { class: 'pv-table' }, el('caption', { class: 'visually-hidden' }, 'Table'),
          el('tbody', {}, ...doc.grid.rows.map((r) => el('tr', {}, ...r.cells.map((c) => el('td', {}, c.value)))))));
      }
      doc.pages.forEach((p, i) => {
        const t = doc.text[p.source].value;
        parts.push(el('details', { class: 'pv-text' }, el('summary', {}, `Page ${i + 1} text`), el('pre', { class: 'rec-pre', tabindex: '0', 'aria-label': `Text of page ${i + 1}` }, t || '(empty)')));
      });
      node.replaceChildren(...parts);
    },
  };
}
