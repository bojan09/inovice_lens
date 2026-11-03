// fields.js - "Extracted Data" tab: document type, label-left / field-right rows, "Items (n)" link.
import { el, icon } from '../dom.js';
import { CATEGORIES, CATEGORY_LABELS } from '../../recognition/classify.js';
import { FIELDS_BY_TYPE, labelFor, isEdited, setField } from '../../doc/model.js';
import { messagesFor, renderMessages } from './messages.js';

const PLACEHOLDER = { issueDate: 'YYYY-MM-DD', dueDate: 'YYYY-MM-DD', currency: 'EUR', taxRate: '0', subtotal: '0.00', tax: '0.00', total: '0.00' };
const INPUTMODE = { subtotal: 'decimal', tax: 'decimal', total: 'decimal', taxRate: 'decimal' };

export function createFields({ actions }) {
  const rows = new Map(); // key -> { node, input, msgs, tag, locate, label }
  let builtFor = null;

  const typeSelect = el('select', { id: 'ed-type', class: 'select' }, ...CATEGORIES.map((c) => el('option', { value: c }, CATEGORY_LABELS[c])));
  typeSelect.addEventListener('change', () => actions.setType(typeSelect.value));
  const typeHint = el('p', { class: 'fld-hint', id: 'ed-type-hint' });
  const typeChip = el('span', { class: 'chip chip-success', id: 'ed-type-chip' });
  const details = el('details', { class: 'ed-section', open: true });
  const summary = el('summary', {}, icon('chevron-down', 'chev'), el('span', { class: 'sec-title' }, 'Document details'), typeChip);
  const fieldBox = el('div', { class: 'fld-list' });
  const typeRow = el('div', { class: 'fld fld-type' },
    el('label', { for: 'ed-type' }, 'Document type'),
    el('div', { class: 'fld-main' }, typeSelect, typeHint));
  const empty = el('p', { class: 'ed-note' });
  details.append(summary, typeRow, fieldBox, empty);

  const itemsBtn = el('button', { type: 'button', class: 'ed-link-row', onclick: () => actions.goto({ type: 'tab', tab: 'table' }) }, icon('chevron-right', 'chev'), el('span', { class: 'sec-title' }, 'Items'), el('span', { class: 'count' }));
  const node = el('div', { class: 'tab-fields' }, details, itemsBtn);

  function build(doc) {
    rows.clear();
    const keys = FIELDS_BY_TYPE[doc.docType];
    const els = keys.map((key) => {
      const id = `fld-${key}`;
      const label = el('label', { for: id });
      const input = el('input', { id, class: 'input', type: 'text', autocomplete: 'off', spellcheck: 'false', inputmode: INPUTMODE[key] ?? null, placeholder: PLACEHOLDER[key] ?? null });
      const tag = el('span', { class: 'fld-tag' });
      const locate = el('button', { type: 'button', class: 'icon-btn loc-btn' }, icon('target'));
      const msgs = el('div', { class: 'fld-msgs' });
      const node2 = el('div', { class: 'fld', 'data-key': key }, label, el('div', { class: 'fld-main' }, el('div', { class: 'fld-input' }, input, locate), tag, msgs));
      input.addEventListener('input', () => actions.edit((d) => setField(d, key, input.value), `field:${key}`));
      input.addEventListener('blur', () => actions.seal());
      locate.addEventListener('click', () => actions.locate(key));
      const r = { node: node2, input, msgs, tag, locate, label };
      rows.set(key, r);
      return node2;
    });
    fieldBox.replaceChildren(...els);
    builtFor = doc.docType;
  }

  return {
    node,
    focusKey(key) { rows.get(key)?.input.focus(); },
    update({ doc, issues }) {
      if (builtFor !== doc.docType) build(doc);
      if (typeSelect.value !== doc.docType) typeSelect.value = doc.docType;
      typeChip.textContent = CATEGORY_LABELS[doc.docType];
      typeChip.className = `chip ${doc.docType === 'invoice' ? 'chip-success' : doc.docType === 'receipt' ? 'chip-warning' : 'chip-info'}`;
      typeHint.textContent = doc.typeOrigin === 'user' ? 'Chosen by you. Changing it re-reads the data (undo restores it).' : 'Suggested from the text. Change it if wrong.';
      const keys = FIELDS_BY_TYPE[doc.docType];
      empty.hidden = keys.length > 0;
      empty.textContent = doc.docType === 'table' ? 'Tables have no named fields. Edit the cells on the Table tab.' : 'General documents have no named fields. Edit the page text on the Text tab.';
      for (const key of keys) {
        const r = rows.get(key);
        const f = doc.fields[key];
        r.label.textContent = labelFor(key, doc.docType);
        if (r.input.value !== f.value && document.activeElement !== r.input) r.input.value = f.value;
        else if (r.input.value !== f.value) r.input.value = f.value; // undo/redo while focused
        const edited = isEdited(f);
        r.tag.textContent = edited ? 'Edited by you' : '';
        r.tag.dataset.kind = edited ? 'edited' : '';
        const lab = labelFor(key, doc.docType);
        r.locate.setAttribute('aria-label', `Show ${lab} on the page`);
        r.locate.title = f.ref ? `Show ${lab} on the page` : `${lab} has no source region`;
        r.locate.dataset.region = f.ref ? 'yes' : 'no';
        renderMessages(r.msgs, r.input, messagesFor(issues, { type: 'field', key }, f), `fld-${key}-m`);
      }
      const n = doc.items.length + doc.grid.rows.length;
      itemsBtn.hidden = doc.docType === 'general';
      itemsBtn.querySelector('.sec-title').textContent = doc.docType === 'table' ? 'Table rows' : 'Items';
      itemsBtn.querySelector('.count').textContent = `(${doc.docType === 'table' ? doc.grid.rows.length : doc.items.length})`;
      itemsBtn.setAttribute('aria-label', `${doc.docType === 'table' ? 'Table rows' : 'Items'} (${doc.docType === 'table' ? doc.grid.rows.length : doc.items.length}). Open the Table tab`);
      void n;
    },
  };
}
