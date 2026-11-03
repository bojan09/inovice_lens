// table.js - "Table" tab: invoice/receipt line items, or the generic grid of a table document.
// Cells are plain text inputs (money stays text until validated). Arrow Up/Down and Enter move between
// rows in the same column; Ctrl+Enter adds a row below. Rows can be added, removed and re-ordered.
import { el, icon } from '../dom.js';
import { ROW_COLUMNS, ROW_LABELS, setCell, addRow, removeRow, moveRow, isEdited } from '../../doc/model.js';
import { messagesFor, renderMessages } from './messages.js';

export function createTable({ actions }) {
  let sig = null;
  const cells = new Map(); // `${rowId}:${col}` -> { input, msgs, locate }
  const title = el('h2', { class: 'ed-h3', id: 'tbl-title' }, 'Line items');
  const hint = el('p', { class: 'ed-note', id: 'tbl-hint' }, 'Up/Down arrows or Enter move between rows. Ctrl+Enter adds a row below.');
  const caption = el('caption', { class: 'visually-hidden' });
  const thead = el('thead');
  const tbody = el('tbody');
  const table = el('table', { class: 'ed-table', 'aria-describedby': 'tbl-hint' }, caption, thead, tbody);
  const wrap = el('div', { class: 'tbl-wrap' }, table);
  const addBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('plus', 'icon-sm'), 'Add row');
  const emptyMsg = el('p', { class: 'ed-note', id: 'tbl-empty' });
  const node = el('div', { class: 'tab-table' }, title, hint, emptyMsg, wrap, addBtn);

  const which = (doc) => (doc.docType === 'table' ? 'grid' : 'items');
  const rowsOf = (doc) => (doc.docType === 'table' ? doc.grid.rows : doc.items);
  const colKeys = (doc) => (doc.docType === 'table' ? Array.from({ length: doc.grid.columns }, (_, i) => i) : ROW_COLUMNS);
  const colLabel = (doc, k) => (doc.docType === 'table' ? `Column ${k + 1}` : ROW_LABELS[k]);

  function focusCell(rowId, key) {
    cells.get(`${rowId}:${key}`)?.input.focus();
  }

  function buildRow(doc, row, index, ctx) {
    const w = which(doc);
    const keys = colKeys(doc);
    const tr = el('tr', { 'data-row': row.id });
    tr.append(el('th', { scope: 'row', class: 'rownum' }, el('span', { class: 'visually-hidden' }, 'Row '), String(index + 1)));
    for (const key of keys) {
      const id = `c-${row.id}-${key}`;
      const input = el('input', { id, class: 'input cell-input', type: 'text', autocomplete: 'off', spellcheck: 'false', inputmode: key === 'qty' || key === 'unit' || key === 'total' ? 'decimal' : null, 'aria-label': `Row ${index + 1}, ${colLabel(doc, key)}` });
      const msgs = el('div', { class: 'fld-msgs' });
      const locate = el('button', { type: 'button', class: 'icon-btn loc-btn cell-loc' }, icon('target'));
      locate.addEventListener('click', () => actions.locateCell(w, row.id, key));
      input.addEventListener('input', () => actions.edit((d) => setCell(d, w, row.id, key, input.value), `cell:${row.id}:${key}`));
      input.addEventListener('blur', () => actions.seal());
      input.addEventListener('keydown', (e) => {
        const rows = rowsOf(ctx.current);
        const i = rows.findIndex((r) => r.id === row.id);
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          actions.edit((d) => addRow(d, w, row.id));
          queueMicrotask(() => { const r = rowsOf(ctx.current)[i + 1]; if (r) focusCell(r.id, key); });
        } else if (e.key === 'ArrowDown' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          if (rows[i + 1]) focusCell(rows[i + 1].id, key);
        } else if (e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey)) {
          e.preventDefault();
          if (rows[i - 1]) focusCell(rows[i - 1].id, key);
        }
      });
      cells.set(`${row.id}:${key}`, { input, msgs, locate, key });
      tr.append(el('td', { 'data-label': colLabel(doc, key) }, el('div', { class: 'cell-box' }, input, locate), msgs));
    }
    const up = el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Move row ${index + 1} up`, title: 'Move up' }, icon('arrow-up'));
    const down = el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Move row ${index + 1} down`, title: 'Move down' }, icon('arrow-down'));
    const del = el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Delete row ${index + 1}`, title: 'Delete row' }, icon('trash'));
    up.addEventListener('click', () => actions.edit((d) => moveRow(d, w, row.id, -1)));
    down.addEventListener('click', () => actions.edit((d) => moveRow(d, w, row.id, 1)));
    del.addEventListener('click', () => {
      const rows = rowsOf(ctx.current);
      const i = rows.findIndex((r) => r.id === row.id);
      const neighbour = rows[i + 1] ?? rows[i - 1];
      actions.edit((d) => removeRow(d, w, row.id));
      queueMicrotask(() => { if (neighbour) focusCell(neighbour.id, keys[0]); else addBtn.focus(); });
    });
    tr.append(el('td', { class: 'row-actions' }, up, down, del));
    tr._buttons = { up, down, del };
    return tr;
  }

  const ctx = { current: null };
  addBtn.addEventListener('click', () => {
    const doc = ctx.current;
    const w = which(doc);
    actions.edit((d) => addRow(d, w));
    queueMicrotask(() => { const rows = rowsOf(ctx.current); const last = rows[rows.length - 1]; if (last) focusCell(last.id, colKeys(ctx.current)[0]); });
  });

  return {
    node,
    focusCell,
    update({ doc, issues }) {
      ctx.current = doc;
      const rows = rowsOf(doc);
      const keys = colKeys(doc);
      const nextSig = `${doc.docType}|${keys.length}|${rows.map((r) => r.id).join(',')}`;
      title.textContent = doc.docType === 'table' ? 'Table' : doc.docType === 'general' ? 'Table' : 'Line items';
      const na = doc.docType === 'general';
      wrap.hidden = na || (rows.length === 0 && doc.docType === 'table' && doc.grid.columns === 0);
      addBtn.hidden = na || (doc.docType === 'table' && doc.grid.columns === 0);
      hint.hidden = na || wrap.hidden;
      emptyMsg.hidden = !(na || rows.length === 0);
      emptyMsg.textContent = na ? 'General documents have no table. Choose another document type on the Extracted Data tab to read a table.'
        : doc.docType === 'table' ? 'No table was found in this document. Use the Text tab to edit the text.'
          : 'No line items were found. Add rows if the document has them.';
      caption.textContent = doc.docType === 'table' ? 'Table cells' : 'Line items';
      if (nextSig !== sig) {
        sig = nextSig;
        cells.clear();
        thead.replaceChildren(el('tr', {}, el('th', { scope: 'col', class: 'rownum' }, '#'), ...keys.map((k) => el('th', { scope: 'col' }, colLabel(doc, k))), el('th', { scope: 'col', class: 'visually-hidden' }, 'Row actions')));
        tbody.replaceChildren(...rows.map((r, i) => buildRow(doc, r, i, ctx)));
      }
      rows.forEach((row, i) => {
        const tr = tbody.children[i];
        if (!tr) return;
        tr._buttons.up.disabled = i === 0;
        tr._buttons.down.disabled = i === rows.length - 1;
        for (const k of keys) {
          const c = cells.get(`${row.id}:${k}`);
          if (!c) continue;
          const f = row.cells[k];
          if (c.input.value !== f.value) c.input.value = f.value;
          const target = which(doc) === 'items' ? { type: 'cell', rowId: row.id, col: k } : null;
          const list = target ? messagesFor(issues, target, f) : [];
          renderMessages(c.msgs, c.input, list, `c-${row.id}-${k}-m`);
          c.locate.dataset.region = f.ref ? 'yes' : 'no';
          c.locate.setAttribute('aria-label', `Show row ${i + 1} ${colLabel(doc, k).toLowerCase()} on the page`);
          c.input.dataset.edited = isEdited(f) ? 'true' : '';
        }
      });
    },
  };
}
