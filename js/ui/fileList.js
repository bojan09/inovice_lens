// fileList.js - renders accepted / rejected files plus their recognition state.
// Cards are created once and UPDATED IN PLACE (progress ticks, status changes) so previews do not
// re-decode and an open <details> or focused <select> is never destroyed by a re-render.

import { el, icon } from './dom.js';
import { formatBytes } from '../format.js';
import { STATUS, isActive, isTerminal } from '../recognition/states.js';
import { CATEGORIES, CATEGORY_LABELS } from '../recognition/classify.js';

const STATUS_VIEW = {
  [STATUS.QUEUED]: { label: 'Queued', cls: '', tip: 'Waiting for its turn. Files are recognized one at a time to keep the browser responsive.' },
  [STATUS.PREPARING]: { label: 'Preparing', cls: 'chip-info', tip: 'Opening the file.' },
  [STATUS.EXTRACTING]: { label: 'Recognizing', cls: 'chip-info', tip: 'Reading text from the document.' },
  [STATUS.RECOGNIZED]: { label: 'Recognized', cls: 'chip-success', tip: 'Text was read from the document. Not yet reviewed or edited.' },
  [STATUS.REVIEW]: { label: 'Needs review', cls: 'chip-warning', tip: 'Some text is missing or low confidence. Check the result before relying on it.' },
  [STATUS.FAILED]: { label: 'Failed', cls: 'chip-danger', tip: 'This file could not be processed.' },
  [STATUS.CANCELLED]: { label: 'Cancelled', cls: '', tip: 'Cancelled by you.' },
};

const pct = (f) => Math.max(0, Math.min(100, Math.round(f * 100)));

export function createFileList({ store, session, workspace = null, panel, listEl, rejectEl, countEl, noMatchEl, cancelAllBtn }) {
  const cards = new Map(); // id -> { node, update }
  const rejectedNodes = new Map();
  let query = '';
  let recSnap = session.snapshot();

  // ------------------------------------------------------------------ accepted card
  function buildCard(item) {
    const id = item.id;
    const thumb = el('div', { class: `thumb${item.isImage ? '' : ' thumb-pdf'}` });
    const name = el('p', { class: 'file-name', title: item.name }, item.name);
    const statusChip = el('span', { class: 'chip' }, '');
    const meta = el('div', { class: 'file-meta' },
      el('span', { class: 'chip' }, item.label),
      el('span', {}, formatBytes(item.size)),
      item.width ? el('span', {}, `${item.width} × ${item.height} px`) : null,
      statusChip,
    );
    const bar = el('span', {});
    const meter = el('div', { class: 'meter', role: 'progressbar', 'aria-label': `Recognition progress for ${item.name}`, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, bar);
    const note = el('p', { class: 'rec-note' });
    const progress = el('div', { class: 'rec-progress' }, meter, note);
    const summary = el('p', { class: 'rec-summary' });
    const error = el('p', { class: 'rec-error', role: 'alert' });
    const review = el('ul', { class: 'rec-review' });
    const warnings = el('div', { class: 'rec-warnings' });

    // document type
    const selectId = `type-${id}`;
    const select = el('select', { id: selectId, class: 'select' },
      ...CATEGORIES.map((c) => el('option', { value: c }, CATEGORY_LABELS[c])));
    select.addEventListener('change', () => session.setOverride(id, select.value));
    const typeHint = el('span', { class: 'type-hint' });
    const reset = el('button', { type: 'button', class: 'link-btn' }, 'Use suggestion');
    reset.addEventListener('click', () => session.setOverride(id, null));
    const typeRow = el('div', { class: 'rec-type' }, el('label', { for: selectId }, 'Document type'), select, typeHint, reset);

    const textBody = el('div', { class: 'rec-text-body' });
    const details = el('details', { class: 'rec-text' }, el('summary', {}, 'Recognized text'), textBody);

    const info = el('div', { class: 'file-info' }, name, meta, progress, summary, error, review, warnings, typeRow, details);

    const rotateBtn = el('button', { type: 'button', class: 'icon-btn', title: 'Rotate 90° clockwise and recognize again' }, icon('rotate'));
    rotateBtn.addEventListener('click', () => session.rotate(id));
    const cancelBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, 'Cancel');
    cancelBtn.addEventListener('click', () => session.cancel(id));
    const retryBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('refresh', 'icon-sm'), 'Retry');
    retryBtn.addEventListener('click', () => session.retry(id));
    const removeBtn = el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove ${item.name}`, title: 'Remove' }, icon('x'));
    removeBtn.addEventListener('click', () => store.remove(id));
    const editLink = el('a', { class: 'btn btn-primary btn-sm', href: `#/editor/${id}` }, icon('pencil', 'icon-sm'), 'Review & edit');
    const editedChip = el('span', { class: 'chip chip-info', hidden: true, title: 'You have edits for this file. They are kept only while this tab stays open.' }, 'Edited');
    const actions = el('div', { class: 'card-actions' }, editedChip, editLink, rotateBtn, cancelBtn, retryBtn, removeBtn);

    const node = el('li', { class: 'file-card', 'data-id': id }, thumb, info, actions);

    let thumbKey = null;
    let renderedResult = null;
    let renderedRotation = null;

    function update(it, rec) {
      // thumbnail (only rebuilt when its state changes)
      const key = `${it.url ?? ''}|${it.previewFailed}`;
      if (key !== thumbKey) {
        thumbKey = key;
        thumb.replaceChildren();
        if (it.isImage && it.url && !it.previewFailed) {
          const img = el('img', { src: it.url, alt: '', width: 56, height: 56, decoding: 'async' });
          img.addEventListener('error', () => store.markPreviewFailed(it.id), { once: true });
          thumb.append(img);
        } else thumb.append(icon(it.isImage ? 'image' : 'file'));
      }
      warnings.replaceChildren(
        ...(it.previewFailed ? [el('p', { class: 'file-warn' }, icon('alert'), 'Preview unavailable. The browser could not decode this image; it may be damaged.')] : []),
        ...it.warnings.map((w) => el('p', { class: 'file-warn' }, icon('alert'), w)),
      );

      const status = rec?.status ?? STATUS.QUEUED;
      const sv = STATUS_VIEW[status];
      statusChip.className = `chip ${sv.cls}`.trim();
      statusChip.textContent = sv.label;
      statusChip.title = sv.tip;
      node.dataset.status = status;

      // progress: shown only while work is real and in flight
      const active = isActive(status);
      progress.hidden = !active;
      if (active) {
        const p = rec.progress;
        const v = status === STATUS.PREPARING ? 0 : pct(p.fraction);
        bar.style.width = `${v}%`;
        meter.setAttribute('aria-valuenow', String(v));
        meter.setAttribute('aria-valuetext', `${v}%${p.note ? `, ${p.note}` : ''}`);
        note.textContent = status === STATUS.PREPARING ? 'Opening file…' : `${p.note || 'Working…'} (${v}%)`;
      }

      // outcome
      const res = rec?.result;
      const done = status === STATUS.RECOGNIZED || status === STATUS.REVIEW;
      summary.hidden = !done || !res;
      if (done && res) summary.textContent = summaryText(res);
      error.hidden = status !== STATUS.FAILED;
      if (status === STATUS.FAILED) error.textContent = `Not processed: ${rec.error?.message ?? 'Recognition failed.'}`;
      review.hidden = !(status === STATUS.REVIEW && res);
      if (status === STATUS.REVIEW && res) review.replaceChildren(...res.review.map((r) => el('li', {}, r)));

      // document type (suggestion + user override)
      typeRow.hidden = !(done && res);
      if (done && res) {
        const c = res.classification;
        const effective = rec.override ?? c.suggested;
        if (select.value !== effective) select.value = effective;
        const changed = rec.override && rec.override !== c.suggested;
        typeHint.textContent = changed
          ? `Changed by you. Suggested: ${CATEGORY_LABELS[c.suggested]}.`
          : c.confidence === 'likely' ? 'Suggested, likely match.'
            : c.confidence === 'none' ? 'Not enough text to suggest a type. Please choose.'
              : `Suggested, uncertain. ${c.reasons[0] ?? ''}`.trim();
        typeHint.dataset.confidence = changed ? 'user' : c.confidence;
        reset.hidden = !changed;
      }

      // recognized text (rebuilt only when the result object or rotation changes)
      details.hidden = !(done && res);
      if (done && res && (res !== renderedResult || rec.rotation !== renderedRotation)) {
        renderedResult = res;
        renderedRotation = rec.rotation;
        textBody.replaceChildren(...res.pages.map(pageBlock));
      }

      // actions
      editLink.hidden = !(done && res);
      editLink.setAttribute('aria-label', `Review and edit ${it.name}`);
      editedChip.hidden = !(done && res && workspace?.get(id)?.modified);
      const canRotate = !active && status !== STATUS.FAILED && (it.isImage || (res && (res.summary.ocrPages > 0 || res.summary.emptyPages > 0)));
      rotateBtn.hidden = !canRotate;
      rotateBtn.setAttribute('aria-label', `Rotate ${it.name} 90 degrees clockwise and recognize again${rec?.rotation ? ` (currently ${rec.rotation} degrees)` : ''}`);
      cancelBtn.hidden = !(status === STATUS.QUEUED || active);
      cancelBtn.setAttribute('aria-label', `Cancel recognition of ${it.name}`);
      retryBtn.hidden = !(status === STATUS.FAILED || status === STATUS.CANCELLED || status === STATUS.REVIEW);
      retryBtn.setAttribute('aria-label', `Retry recognition of ${it.name}`);
      node.setAttribute('aria-busy', String(active));
    }
    return { node, update };
  }

  function summaryText(res) {
    const s = res.summary;
    const parts = [`${s.pages} ${s.pages === 1 ? 'page' : 'pages'}`];
    if (s.textPages && !s.ocrPages) parts.push('embedded text, no OCR needed');
    else if (s.textPages) parts.push(`${s.textPages} with embedded text, ${s.ocrPages} read by OCR`);
    else if (s.ocrPages) parts.push('read by OCR');
    if (s.meanConf !== null) parts.push(`${s.meanConf}% mean confidence`);
    if (s.emptyPages) parts.push(`${s.emptyPages} without text`);
    return parts.join(' · ');
  }

  function pageBlock(p) {
    const how = p.method === 'pdf-text' ? 'Embedded text'
      : p.method === 'ocr' ? `OCR, ${p.confidence.mean}% confidence${p.confidence.lowWords ? `, ${p.confidence.lowWords} low-confidence ${p.confidence.lowWords === 1 ? 'word' : 'words'}` : ''}${p.chosen === 'enhance' ? ', enhanced image' : ''}`
        : 'No text found';
    return el('section', { class: 'rec-page' },
      el('h3', {}, `Page ${p.index + 1} · ${how}`),
      p.normalized.text ? el('pre', { class: 'rec-pre', tabindex: '0', 'aria-label': `Recognized text of page ${p.index + 1}` }, p.normalized.text) : el('p', { class: 'rec-empty' }, 'Nothing could be read on this page.'),
    );
  }

  // ------------------------------------------------------------------ rejected card
  function rejectedCard(r) {
    const actions = el('div', { class: 'card-actions' });
    if (r.retryable) {
      actions.append(el('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'aria-label': `Retry ${r.name}`, onclick: () => store.retry(r.id) }, icon('refresh', 'icon-sm'), 'Retry'));
    }
    actions.append(el('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'aria-label': `Dismiss ${r.name}`, onclick: () => store.dismissRejected(r.id) }, 'Dismiss'));
    return el('li', { class: 'reject-card', 'data-id': r.id },
      el('div', { class: 'thumb' }, icon('alert')),
      el('div', { class: 'file-info' },
        el('p', { class: 'file-name', title: r.name }, r.name || '(unnamed file)'),
        el('p', { class: 'reject-msg' }, `Not accepted: ${r.message}`)),
      actions);
  }

  const matches = (name) => !query || name.toLowerCase().includes(query);

  function placeInOrder(container, nodes) {
    let prev = null;
    for (const node of nodes) {
      const anchor = prev ? prev.nextSibling : container.firstChild;
      if (node !== anchor) container.insertBefore(node, anchor);
      prev = node;
    }
  }

  function render() {
    const { items, rejected, busy } = store.getState();
    const total = items.length + rejected.length;
    panel.hidden = total === 0;
    countEl.textContent = items.length ? `(${items.length})` : '';

    const want = new Set(items.map((i) => i.id));
    for (const [id, c] of cards) if (!want.has(id)) { c.node.remove(); cards.delete(id); }
    const nodes = [];
    for (const it of items) {
      let c = cards.get(it.id);
      if (!c) { c = buildCard(it); cards.set(it.id, c); }
      c.update(it, recSnap.get(it.id));
      c.node.hidden = !matches(it.name);
      nodes.push(c.node);
    }
    placeInOrder(listEl, nodes);

    const wantR = new Set(rejected.map((r) => r.id));
    for (const [id, n] of rejectedNodes) if (!wantR.has(id)) { n.remove(); rejectedNodes.delete(id); }
    const rnodes = rejected.map((r) => {
      let n = rejectedNodes.get(r.id);
      if (!n) { n = rejectedCard(r); rejectedNodes.set(r.id, n); }
      n.hidden = !matches(r.name);
      return n;
    });
    placeInOrder(rejectEl, rnodes);

    const visible = [...items, ...rejected].filter((e) => matches(e.name)).length;
    noMatchEl.hidden = !(query && total > 0 && visible === 0);
    panel.setAttribute('aria-busy', String(busy));
    cancelAllBtn.hidden = !items.some((i) => {
      const s = recSnap.get(i.id)?.status;
      return s === STATUS.QUEUED || (s && isActive(s));
    });
  }

  store.subscribe(render);
  session.subscribe((snap) => { recSnap = snap; render(); });
  workspace?.subscribe(() => render()); // the "Edited" chip follows the editor
  render();

  return {
    setQuery(q) { query = q.trim().toLowerCase(); render(); },
    isTerminal,
  };
}
