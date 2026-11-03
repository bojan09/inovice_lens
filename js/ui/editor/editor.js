// editor.js - the editor view: page rail + original viewer + inspector (Extracted Data / Table / Text),
// review panel, undo/redo and the "not saved" indicator. Desktop shows the three columns; below 1024 px
// one pane at a time (Original / Edit / Preview) so every control keeps a touch-sized target.
import { el, icon } from '../dom.js';
import { validateDocument } from '../../doc/validate.js';
import { createPageSource } from './pageSource.js';
import { createViewer } from './viewer.js';
import { createRail } from './rail.js';
import { createFields } from './fields.js';
import { createTable } from './table.js';
import { createTextTab } from './textTab.js';
import { createIssues } from './issues.js';
import { createPreview } from './preview.js';
import { rotatePage, movePage, labelFor, ROW_LABELS } from '../../doc/model.js';
import { STATUS } from '../../recognition/states.js';

const TABS = [['fields', 'Extracted Data'], ['table', 'Table'], ['text', 'Text']];
const PANES = [['original', 'Original'], ['edit', 'Edit'], ['preview', 'Preview']];

export function createEditor({ root, workspace, session, store, engines, toaster, srLive, onExport = () => {}, saveInfo = () => null }) {
  let current = null; // { id, entry, pos }
  let tab = 'fields';
  let pane = 'original';
  let lastIssues = [];
  const wide = window.matchMedia('(min-width: 1024px)');

  // ------------------------------------------------------------------ actions shared with the sub-views
  const actions = {
    edit: (fn, key) => current?.entry?.commit(fn, key),
    seal: () => current?.entry?.seal(),
    setType: (t) => current && session.setOverride(current.id, t),
    locate(key) {
      const e = current.entry;
      const f = e.doc.fields[key];
      showRegion(f.ref, labelFor(key, e.doc.docType), true);
    },
    locateCell(which, rowId, col) {
      const e = current.entry;
      const row = (which === 'grid' ? e.doc.grid.rows : e.doc.items).find((r) => r.id === rowId);
      const f = row?.cells[col];
      const idx = (which === 'grid' ? e.doc.grid.rows : e.doc.items).findIndex((r) => r.id === rowId) + 1;
      showRegion(f?.ref ?? null, `Row ${idx} ${which === 'grid' ? `column ${col + 1}` : ROW_LABELS[col].toLowerCase()}`, true);
    },
    goto(target) {
      const e = current.entry;
      if (!wide.matches && pane !== 'edit' && target.type !== 'page') setPane('edit');
      if (target.type === 'field') {
        setTab('fields');
        fields.focusKey(target.key);
        showRegion(e.doc.fields[target.key]?.ref ?? null, labelFor(target.key, e.doc.docType), false);
      } else if (target.type === 'cell') {
        setTab('table');
        table.focusCell(target.rowId, target.col);
        const f = e.doc.items.find((r) => r.id === target.rowId)?.cells[target.col];
        showRegion(f?.ref ?? null, 'This cell', false);
      } else if (target.type === 'tab') {
        setTab(target.tab, true);
      } else if (target.type === 'page') gotoPos(target.page);
    },
  };

  function showRegion(ref, label, reveal) {
    const p = viewer.show(ref, label); // sets the highlight + status text; returns the page position, or -1 when there is no region
    if (p >= 0) { current.pos = p; if (reveal && !wide.matches) setPane('original'); render(); }
    else if (!wide.matches && reveal) toaster.show(`${label}: no source region on the page.`, 'info');
  }

  // ------------------------------------------------------------------ pieces
  const viewer = createViewer({
    onRotate: (pos) => current.entry.commit((d) => rotatePage(d, pos, 90)),
    onMove: (pos, delta) => { current.entry.commit((d) => movePage(d, pos, pos + delta)); current.pos = Math.min(Math.max(0, pos + delta), current.entry.doc.pages.length - 1); render(); },
    onGoto: (pos) => gotoPos(pos),
  });
  const rail = createRail({ onGoto: (pos) => gotoPos(pos) });
  const fields = createFields({ actions });
  const table = createTable({ actions });
  const textTab = createTextTab({ actions });
  const issuesUi = createIssues({ actions });
  const preview = createPreview();

  function gotoPos(pos) {
    if (!current) return;
    current.pos = Math.min(Math.max(0, pos), current.entry.doc.pages.length - 1);
    render();
  }

  // ------------------------------------------------------------------ frame
  const title = el('h1', { class: 'ed-title', id: 'editor-title' }, 'Editor');
  const saveText = el('span', { class: 'save-text' });
  const saveState = el('p', { class: 'save-state', role: 'status', 'data-state': 'clean' }, el('span', { class: 'save-dot', 'aria-hidden': 'true' }), saveText);
  const undoBtn = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Undo', title: 'Undo (Ctrl+Z)', disabled: true }, icon('undo'));
  const redoBtn = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Redo', title: 'Redo (Ctrl+Shift+Z)', disabled: true }, icon('redo'));
  const exportBtn = el('button', { type: 'button', class: 'btn btn-primary', id: 'ed-export' }, icon('download', 'icon-sm'), 'Export');
  exportBtn.addEventListener('click', () => current?.entry && onExport([current.id], exportBtn));
  const bar = el('div', { class: 'ed-bar' },
    el('a', { class: 'back-link', href: '#/convert' }, icon('arrow-left', 'icon-sm'), 'Back to Workspace'),
    title, el('span', { class: 'ed-spacer' }), saveState, undoBtn, redoBtn, exportBtn);

  const staleMsg = el('span', {}, 'This file was recognized again, but you have edits. Your edits belong to the previous recognition.');
  const staleUse = el('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, 'Use new recognition (discards my edits)');
  const staleKeep = el('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, 'Keep my edits');
  const stale = el('div', { class: 'notice ed-stale', role: 'alert', hidden: true }, icon('alert'), staleMsg, el('span', { class: 'stale-actions' }, staleUse, staleKeep));

  const paneTabs = el('div', { class: 'pane-tabs', role: 'tablist', 'aria-label': 'Editor sections' });
  const paneBtns = {};
  for (const [id, label] of PANES) {
    const b = el('button', { type: 'button', class: 'pane-tab', role: 'tab', id: `pane-tab-${id}`, 'aria-controls': `pane-${id}`, tabindex: '-1' }, label);
    b.addEventListener('click', () => setPane(id));
    b.addEventListener('keydown', (e) => roving(e, PANES.map(([i]) => i), id, setPane, (i) => paneBtns[i]));
    paneBtns[id] = b;
    paneTabs.append(b);
  }

  const tabList = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Document data' });
  const tabBtns = {};
  const panels = { fields: fields.node, table: table.node, text: textTab.node };
  for (const [id, label] of TABS) {
    const b = el('button', { type: 'button', class: 'tab', role: 'tab', id: `tab-${id}`, 'aria-controls': `tabpanel-${id}`, tabindex: '-1' }, label);
    b.addEventListener('click', () => setTab(id));
    b.addEventListener('keydown', (e) => roving(e, TABS.map(([i]) => i), id, (n) => setTab(n, true), (i) => tabBtns[i]));
    tabBtns[id] = b;
    tabList.append(b);
    const p = panels[id];
    p.setAttribute('role', 'tabpanel');
    p.id = `tabpanel-${id}`;
    p.setAttribute('aria-labelledby', `tab-${id}`);
    p.classList.add('tabpanel');
  }
  const inspector = el('section', { class: 'inspector', id: 'pane-edit', role: 'tabpanel', 'aria-labelledby': 'pane-tab-edit', 'aria-label': 'Extracted data' },
    tabList, el('div', { class: 'insp-body' }, fields.node, table.node, textTab.node), issuesUi.node);
  const original = el('section', { class: 'original', id: 'pane-original', role: 'tabpanel', 'aria-labelledby': 'pane-tab-original', 'aria-label': 'Original document' }, rail.node, viewer.node);
  const previewPane = el('section', { class: 'preview-pane', id: 'pane-preview', role: 'tabpanel', 'aria-labelledby': 'pane-tab-preview', 'aria-label': 'Preview of corrected document' }, preview.node);
  const grid = el('div', { class: 'ed-grid', 'data-pane': pane }, original, inspector, previewPane);

  const emptyTitle = el('h2', {}, '');
  const emptyText = el('p', {});
  const empty = el('div', { class: 'coming ed-empty', hidden: true }, icon('file', 'coming-icon'), emptyTitle, emptyText, el('a', { class: 'btn btn-secondary', href: '#/convert' }, 'Go to Convert'));

  const frame = el('div', { class: 'editor', hidden: true }, bar, stale, paneTabs, grid);
  root.replaceChildren(frame, empty);

  function roving(e, ids, id, set, get) {
    const i = ids.indexOf(id);
    const key = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: ids.length - 1 }[e.key];
    if (key === undefined) return;
    e.preventDefault();
    const next = ids[(key + ids.length) % ids.length];
    set(next);
    get(next).focus();
  }

  function setTab(id, focus = false) {
    tab = id;
    for (const [k, b] of Object.entries(tabBtns)) { b.setAttribute('aria-selected', String(k === id)); b.tabIndex = k === id ? 0 : -1; panels[k].hidden = k !== id; }
    if (focus) tabBtns[id].focus();
  }
  function setPane(id) {
    pane = id;
    grid.dataset.pane = id;
    for (const [k, b] of Object.entries(paneBtns)) { b.setAttribute('aria-selected', String(k === id)); b.tabIndex = k === id ? 0 : -1; }
    if (id === 'preview' && current) preview.update({ doc: current.entry.doc });
  }

  undoBtn.addEventListener('click', () => { if (current?.entry.undo()) srLive('Undone.'); });
  redoBtn.addEventListener('click', () => { if (current?.entry.redo()) srLive('Redone.'); });
  staleUse.addEventListener('click', () => current?.entry.acceptPending());
  staleKeep.addEventListener('click', () => current?.entry.keepCurrent());

  // Our history is the single source of truth, so the browser's own field-level undo is replaced.
  root.addEventListener('keydown', (e) => {
    if (e.isComposing || !current?.entry) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); if (current.entry.undo()) srLive('Undone.'); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); if (current.entry.redo()) srLive('Redone.'); }
  });

  // ------------------------------------------------------------------ rendering
  function saveLine(mod) {
    const si = saveInfo();
    if (si?.project) {
      if (si.state === 'error') return `Not saved: ${si.error}`;
      if (si.state === 'saving' || (mod && si.state !== 'saved')) return `Saving to project “${si.project.name}”…`;
      return mod ? `Edited. Saved in project “${si.project.name}”` : `No changes yet. Autosaving to “${si.project.name}”`;
    }
    return mod ? 'Edited. Kept for this session only, not saved to disk' : 'No changes yet';
  }
  function pageSourceOf(e) {
    e.pageSource ??= createPageSource({ item: e.item, result: e.result, engines });
    return e.pageSource;
  }

  function render() {
    if (!current) return;
    const e = current.entry;
    const doc = e.doc;
    current.pos = Math.min(current.pos, doc.pages.length - 1);
    lastIssues = validateDocument(doc, { result: e.result });
    const state = { doc, issues: lastIssues, result: e.result, pageSource: pageSourceOf(e) };

    title.textContent = doc.name;
    title.title = doc.name;
    const mod = e.modified;
    const si0 = saveInfo();
    saveState.dataset.state = si0?.state === 'error' || (mod && !(si0?.project && si0.state === 'saved')) ? 'dirty' : 'clean';
    saveText.textContent = saveLine(mod);
    undoBtn.disabled = !e.history.canUndo;
    redoBtn.disabled = !e.history.canRedo;
    stale.hidden = !e.pendingResult;

    fields.update(state);
    table.update(state);
    textTab.update(state);
    issuesUi.update(state);
    rail.update(state, current.pos);
    viewer.update(state, current.pos);
    if (pane === 'preview') preview.update(state);
  }

  // ------------------------------------------------------------------ open / close
  let unsub = null;
  function showEmpty(id) {
    const rec = id ? session.get(id) : null;
    const item = id ? store.getState().items.find((i) => i.id === id) : null;
    let t = 'No file selected';
    let m = 'Choose a recognized file on the Convert page and press "Review & edit".';
    if (id && !item) { t = 'This file is no longer in your workspace'; m = 'It was removed. Add it again on the Convert page.'; }
    else if (id && rec && [STATUS.QUEUED, STATUS.PREPARING, STATUS.EXTRACTING].includes(rec.status)) { t = 'Still recognizing this file'; m = 'The editor opens as soon as recognition finishes.'; }
    else if (id && rec && !rec.result) { t = 'Nothing to edit yet'; m = `Recognition ${rec.status === STATUS.FAILED ? 'failed' : 'did not finish'} for this file. Go back to Convert and try again.`; }
    emptyTitle.textContent = t;
    emptyText.textContent = m;
    frame.hidden = true;
    empty.hidden = false;
    document.title = 'Editor · InvoiceLens';
  }

  function open(id) {
    close(false);
    const entry = id ? workspace.ensure(id) : null;
    if (!entry) { showEmpty(id); current = id ? { id, entry: null, pos: 0, waiting: true } : null; wait(id); return; }
    empty.hidden = true;
    frame.hidden = false;
    current = { id, entry, pos: 0 };
    setTab(tab);
    setPane(wide.matches ? 'edit' : pane);
    unsub = workspace.subscribe((changed) => { if (changed !== id) return; if (workspace.get(id)) render(); else open(id); });
    document.title = `${entry.doc.name} · Editor · InvoiceLens`;
    render();
  }

  let unwait = null;
  function wait(id) {
    unwait?.();
    if (!id) return;
    unwait = session.subscribe(() => {
      if (current?.id === id && current.waiting && workspace.ensure(id)) { unwait?.(); unwait = null; open(id); }
    });
  }

  function close(clear = true) {
    unsub?.(); unsub = null;
    unwait?.(); unwait = null;
    if (current?.entry) viewer.destroy();
    if (clear) current = null;
  }

  wide.addEventListener('change', () => { if (current?.entry) { if (wide.matches) setPane('edit'); render(); } });
  setTab('fields');
  setPane('original');

  return { open, close, refreshSave() { if (current?.entry) { const mod = current.entry.modified; saveText.textContent = saveLine(mod); const si1 = saveInfo(); saveState.dataset.state = si1?.state === 'error' || (mod && !(si1?.project && si1.state === 'saved')) ? 'dirty' : 'clean'; } }, get id() { return current?.id ?? null; } };
}
