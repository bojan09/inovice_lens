// batchView.js - Batch Processing: real counts from the recognition queue, per-file status/progress, selection, and
// controls that act on the REAL queue (pause/resume, retry, cancel, remove) plus export of the selection.
// Progress bars exist only while a file is actually being processed; nothing is estimated or faked.
import { el, icon } from '../dom.js';
import { STATUS, isActive } from '../../recognition/states.js';
import { CATEGORY_LABELS } from '../../recognition/classify.js';
import { formatBytes } from '../../format.js';

const STATUS_VIEW = {
  [STATUS.QUEUED]: ['Queued', ''], [STATUS.PREPARING]: ['Preparing', 'chip-info'], [STATUS.EXTRACTING]: ['Recognizing', 'chip-info'],
  [STATUS.RECOGNIZED]: ['Completed', 'chip-success'], [STATUS.REVIEW]: ['Needs review', 'chip-warning'], [STATUS.FAILED]: ['Failed', 'chip-danger'], [STATUS.CANCELLED]: ['Cancelled', ''],
};

export function createBatchView({ root, store, session, workspace, onExport, toaster, srLive }) {
  const selected = new Set();
  const rows = new Map();

  const tile = (id, label, ic, tone) => {
    const n = el('p', { class: 'stat-n', id: `stat-${id}` }, '0');
    return { n, node: el('li', { class: `stat stat-${tone}` }, el('span', { class: 'stat-ic' }, icon(ic)), el('div', {}, n, el('p', { class: 'stat-l' }, label))) };
  };
  const t = { total: tile('total', 'Total files', 'file', 'neutral'), done: tile('done', 'Completed', 'check-circle', 'success'), review: tile('review', 'Needs review', 'alert', 'warning'), failed: tile('failed', 'Failed', 'x', 'danger'), queue: tile('queue', 'In queue', 'refresh', 'info') };
  const stats = el('ul', { class: 'stats', 'aria-label': 'Queue summary' }, ...Object.values(t).map((x) => x.node));

  const head = el('div', { class: 'page-head batch-head' },
    el('div', {}, el('h1', { class: 'page-title', id: 'batch-title' }, 'Batch Processing'), el('p', { class: 'page-sub' }, 'Convert and export multiple documents at once.')),
    el('button', { type: 'button', class: 'btn btn-primary', 'data-browse': '', id: 'batch-add' }, icon('plus', 'icon-sm'), 'Add files'));

  const qState = el('p', { class: 'queue-state', id: 'queue-state', role: 'status' });
  const pauseBtn = el('button', { type: 'button', class: 'btn btn-secondary', id: 'q-pause' }, 'Pause queue');
  const retryAll = el('button', { type: 'button', class: 'btn btn-secondary', id: 'q-retry-all' }, icon('refresh', 'icon-sm'), 'Retry failed');
  const cancelAll = el('button', { type: 'button', class: 'btn btn-secondary', id: 'q-cancel-all' }, 'Cancel all');
  const qbar = el('div', { class: 'qbar' }, qState, el('div', { class: 'qbar-actions' }, pauseBtn, retryAll, cancelAll));
  const note = el('p', { class: 'opt-help' }, 'Files are recognized one at a time to keep the browser responsive. Pause stops new files from starting; the file being recognized finishes first (use Cancel to stop it now). Cancel stops OCR work immediately.');

  const selAll = el('input', { type: 'checkbox', id: 'sel-all', 'aria-label': 'Select all files' });
  const tbody = el('tbody');
  const table = el('table', { class: 'batch-table', id: 'batch-table' },
    el('caption', { class: 'visually-hidden' }, 'Files in the queue'),
    el('thead', {}, el('tr', {}, el('th', { scope: 'col', class: 'c-sel' }, el('label', { class: 'chk' }, selAll)), el('th', { scope: 'col' }, 'File'), el('th', { scope: 'col' }, 'Type'), el('th', { scope: 'col' }, 'Status'), el('th', { scope: 'col' }, 'Progress'), el('th', { scope: 'col', class: 'c-act' }, 'Actions'))),
    tbody);
  const empty = el('div', { class: 'coming', id: 'batch-empty' }, icon('batch', 'coming-icon'), el('h2', {}, 'No files in the queue'),
    el('p', {}, 'Add images or PDFs here or on Convert. They are recognized on this device, one at a time.'));

  const selCount = el('span', { class: 'sel-count', id: 'sel-count', role: 'status' });
  const bExport = el('button', { type: 'button', class: 'btn btn-primary', id: 'b-export' }, icon('download', 'icon-sm'), 'Export…');
  const bRetry = el('button', { type: 'button', class: 'btn btn-secondary', id: 'b-retry' }, icon('refresh', 'icon-sm'), 'Retry');
  const bCancel = el('button', { type: 'button', class: 'btn btn-secondary', id: 'b-cancel' }, 'Cancel');
  const bRemove = el('button', { type: 'button', class: 'btn btn-secondary', id: 'b-remove' }, icon('trash', 'icon-sm'), 'Remove');
  const abar = el('div', { class: 'abar', hidden: true, role: 'region', 'aria-label': 'Actions for selected files' }, selCount, el('div', { class: 'abar-actions' }, bExport, bRetry, bCancel, bRemove));
  root.replaceChildren(head, stats, qbar, note, empty, table, abar);

  const status = (id) => session.get(id)?.status ?? STATUS.QUEUED;
  const label = (it) => { const r = session.get(it.id); return r?.result ? CATEGORY_LABELS[r.override ?? r.result.classification.suggested] : it.label; };

  function buildRow(it) {
    const cb = el('input', { type: 'checkbox', 'aria-label': `Select ${it.name}` });
    cb.addEventListener('change', () => { if (cb.checked) selected.add(it.id); else selected.delete(it.id); renderSelection(); });
    const type = el('span', { class: 'chip' });
    const st = el('span', { class: 'chip' });
    const bar = el('span', {});
    const meter = el('div', { class: 'meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': `Progress of ${it.name}` }, bar);
    const prog = el('span', { class: 'prog-text' });
    const review = el('a', { class: 'btn btn-secondary btn-sm', href: `#/editor/${it.id}` }, 'Review');
    const retry = el('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, 'Retry');
    const cancel = el('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, 'Cancel');
    const remove = el('button', { type: 'button', class: 'icon-btn', title: 'Remove', 'aria-label': `Remove ${it.name}` }, icon('x'));
    retry.addEventListener('click', () => session.retry(it.id));
    cancel.addEventListener('click', () => session.cancel(it.id));
    remove.addEventListener('click', () => { selected.delete(it.id); store.remove(it.id); });
    const name = el('span', { class: 'b-name', title: it.name }, it.name);
    const tr = el('tr', { 'data-id': it.id },
      el('td', { class: 'c-sel' }, el('label', { class: 'chk' }, cb)), el('td', { class: 'c-file', 'data-label': 'File' }, name, el('span', { class: 'b-meta' }, `${it.label} · ${formatBytes(it.size)}`)),
      el('td', { 'data-label': 'Type' }, type), el('td', { 'data-label': 'Status' }, st), el('td', { 'data-label': 'Progress' }, meter, prog), el('td', { class: 'c-act' }, review, retry, cancel, remove));
    return { tr, cb, type, st, meter, bar, prog, review, retry, cancel, remove };
  }

  function update() {
    const items = store.getState().items;
    const ids = new Set(items.map((i) => i.id));
    for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
    for (const [id, r] of rows) if (!ids.has(id)) { r.tr.remove(); rows.delete(id); }
    const c = session.counts();
    t.total.n.textContent = String(items.length);
    t.done.n.textContent = String(c.recognized);
    t.review.n.textContent = String(c.review);
    t.failed.n.textContent = String(c.failed);
    t.queue.n.textContent = String(c.queued + c.active);
    empty.hidden = items.length > 0;
    table.hidden = items.length === 0;
    qbar.hidden = items.length === 0; note.hidden = items.length === 0;
    const running = c.active > 0;
    qState.textContent = session.paused ? `Queue paused${running ? ' after the current file' : ''}. ${c.queued} waiting.` : running ? `Recognizing… ${c.queued} waiting.` : c.queued ? 'Starting…' : 'Queue idle.';
    qState.dataset.state = session.paused ? 'paused' : running ? 'running' : 'idle';
    pauseBtn.textContent = session.paused ? 'Resume queue' : 'Pause queue';
    pauseBtn.setAttribute('aria-pressed', String(session.paused));
    pauseBtn.disabled = !session.paused && c.queued + c.active === 0;
    retryAll.disabled = c.failed + c.cancelled === 0;
    cancelAll.disabled = c.queued + c.active === 0;

    const order = [];
    for (const it of items) {
      let r = rows.get(it.id);
      if (!r) { r = buildRow(it); rows.set(it.id, r); }
      const rec = session.get(it.id);
      const s = rec?.status ?? STATUS.QUEUED;
      const [text, cls] = STATUS_VIEW[s];
      r.st.className = `chip ${cls}`.trim(); r.st.textContent = text;
      r.type.textContent = label(it); r.type.className = 'chip';
      const active = isActive(s);
      r.meter.hidden = !active;
      if (active) {
        const v = s === STATUS.PREPARING ? 0 : Math.round(Math.max(0, Math.min(1, rec.progress.fraction)) * 100);
        r.bar.style.width = `${v}%`; r.meter.setAttribute('aria-valuenow', String(v)); r.meter.setAttribute('aria-valuetext', `${v}%${rec.progress.note ? `, ${rec.progress.note}` : ''}`);
        r.prog.textContent = s === STATUS.PREPARING ? 'Opening…' : `${v}%`;
      } else r.prog.textContent = s === STATUS.QUEUED ? (session.paused ? 'Paused' : 'Waiting') : s === STATUS.FAILED ? (rec.error?.message ?? 'Failed') : '';
      const done = s === STATUS.RECOGNIZED || s === STATUS.REVIEW;
      r.review.hidden = !done;
      r.review.setAttribute('aria-label', `Review ${it.name}`);
      r.retry.hidden = !(s === STATUS.FAILED || s === STATUS.CANCELLED); r.retry.setAttribute('aria-label', `Retry ${it.name}`);
      r.cancel.hidden = !(s === STATUS.QUEUED || active); r.cancel.setAttribute('aria-label', `Cancel ${it.name}`);
      r.cb.checked = selected.has(it.id);
      r.tr.dataset.status = s;
      r.tr.classList.toggle('is-edited', !!workspace.get(it.id)?.modified);
      order.push(r.tr);
    }
    let prev = null;
    for (const tr of order) { const anchor = prev ? prev.nextSibling : tbody.firstChild; if (tr !== anchor) tbody.insertBefore(tr, anchor); prev = tr; }
    renderSelection();
  }

  function renderSelection() {
    const items = store.getState().items;
    selAll.checked = items.length > 0 && items.every((i) => selected.has(i.id));
    selAll.indeterminate = selected.size > 0 && !selAll.checked;
    abar.hidden = selected.size === 0;
    selCount.textContent = `${selected.size} selected`;
    const ss = [...selected].map(status);
    bExport.disabled = !ss.some((s) => s === STATUS.RECOGNIZED || s === STATUS.REVIEW);
    bExport.title = bExport.disabled ? 'Only recognized files can be exported' : '';
    bRetry.disabled = !ss.some((s) => s === STATUS.FAILED || s === STATUS.CANCELLED);
    bCancel.disabled = !ss.some((s) => s === STATUS.QUEUED || isActive(s));
    for (const [id, r] of rows) r.cb.checked = selected.has(id);
  }

  selAll.addEventListener('change', () => { selected.clear(); if (selAll.checked) store.getState().items.forEach((i) => selected.add(i.id)); renderSelection(); srLive(`${selected.size} selected.`); });
  pauseBtn.addEventListener('click', () => { if (session.paused) session.resume(); else session.pause(); srLive(session.paused ? 'Queue paused.' : 'Queue resumed.'); });
  retryAll.addEventListener('click', () => { const n = session.retryFailed(); srLive(`${n} files queued again.`); });
  cancelAll.addEventListener('click', () => session.cancelAll());
  bExport.addEventListener('click', () => onExport([...selected].filter((id) => [STATUS.RECOGNIZED, STATUS.REVIEW].includes(status(id))), bExport));
  bRetry.addEventListener('click', () => { for (const id of selected) session.retry(id); });
  bCancel.addEventListener('click', () => { for (const id of selected) session.cancel(id); });
  bRemove.addEventListener('click', () => { const n = selected.size; [...selected].forEach((id) => store.remove(id)); selected.clear(); srLive(`${n} files removed.`); toaster.show(`Removed ${n} ${n === 1 ? 'file' : 'files'} from the queue.`, 'info'); });

  store.subscribe(update);
  session.subscribe(update);
  workspace.subscribe(() => update());
  update();
  return { update, selection: () => [...selected] };
}
