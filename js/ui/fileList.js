// fileList.js - renders accepted / rejected files from the store. Keyed reconciliation so
// existing <img> previews are not re-created (no flicker, no repeated decode).

import { el, icon } from './dom.js';
import { formatBytes } from '../format.js';

export function createFileList({ store, panel, listEl, rejectEl, countEl, noMatchEl, onRemoved }) {
  const nodes = new Map(); // id -> li
  let query = '';

  function acceptedCard(item) {
    const thumb = el('div', { class: `thumb${item.isImage ? '' : ' thumb-pdf'}` });
    if (item.isImage && item.url && !item.previewFailed) {
      const img = el('img', { src: item.url, alt: '', width: 56, height: 56, decoding: 'async' });
      img.addEventListener('error', () => store.markPreviewFailed(item.id), { once: true });
      thumb.append(img);
    } else if (item.isImage) {
      thumb.append(icon('image'));
    } else {
      thumb.append(icon('file'));
    }

    const meta = el('div', { class: 'file-meta' },
      el('span', { class: 'chip' }, item.label),
      el('span', {}, formatBytes(item.size)),
      item.width ? el('span', {}, `${item.width} × ${item.height} px`) : null,
      el('span', { class: 'chip chip-info', title: 'Format, size and content were verified on this device. Recognition arrives in Phase 2.' }, 'Checked'),
    );
    const info = el('div', { class: 'file-info' },
      el('p', { class: 'file-name', title: item.name }, item.name),
      meta,
      item.previewFailed ? el('p', { class: 'file-warn' }, icon('alert'), 'Preview unavailable. The browser could not decode this image; it may be damaged.') : null,
      ...item.warnings.map((w) => el('p', { class: 'file-warn' }, icon('alert'), w)),
    );
    const remove = el('button', {
      type: 'button', class: 'icon-btn', 'aria-label': `Remove ${item.name}`, title: 'Remove',
      onclick: () => { store.remove(item.id); onRemoved?.(item); },
    }, icon('x'));
    return el('li', { class: 'file-card', 'data-id': item.id }, thumb, info, el('div', { class: 'card-actions' }, remove));
  }

  function rejectedCard(r) {
    const actions = el('div', { class: 'card-actions' });
    if (r.retryable) {
      actions.append(el('button', {
        type: 'button', class: 'btn btn-secondary btn-sm', 'aria-label': `Retry ${r.name}`,
        onclick: () => store.retry(r.id),
      }, icon('refresh', 'icon-sm'), 'Retry'));
    }
    actions.append(el('button', {
      type: 'button', class: 'btn btn-secondary btn-sm', 'aria-label': `Dismiss ${r.name}`,
      onclick: () => store.dismissRejected(r.id),
    }, 'Dismiss'));
    return el('li', { class: 'reject-card', 'data-id': r.id },
      el('div', { class: 'thumb' }, icon('alert')),
      el('div', { class: 'file-info' },
        el('p', { class: 'file-name', title: r.name }, r.name || '(unnamed file)'),
        el('p', { class: 'reject-msg' }, `Not accepted: ${r.message}`),
      ),
      actions,
    );
  }

  const matches = (name) => !query || name.toLowerCase().includes(query);

  function sync(container, list, build, keyOf) {
    const want = new Set(list.map(keyOf));
    for (const [id, node] of nodes) {
      if (node.parentElement === container && !want.has(id)) { node.remove(); nodes.delete(id); }
    }
    let prev = null;
    for (const entry of list) {
      const id = keyOf(entry);
      let node = nodes.get(id);
      const sig = JSON.stringify([entry.previewFailed, entry.url ? 1 : 0, entry.message]);
      if (node && node.dataset.sig !== sig) { node.remove(); nodes.delete(id); node = null; }
      if (!node) {
        node = build(entry);
        node.dataset.sig = sig;
        nodes.set(id, node);
      }
      node.hidden = !matches(entry.name);
      const anchor = prev ? prev.nextSibling : container.firstChild;
      if (node !== anchor) container.insertBefore(node, anchor);
      prev = node;
    }
  }

  function render({ items, rejected, busy }) {
    const total = items.length + rejected.length;
    panel.hidden = total === 0;
    countEl.textContent = items.length ? `(${items.length})` : '';
    sync(listEl, items, acceptedCard, (i) => i.id);
    sync(rejectEl, rejected, rejectedCard, (r) => r.id);
    const visible = [...items, ...rejected].filter((e) => matches(e.name)).length;
    noMatchEl.hidden = !(query && total > 0 && visible === 0);
    panel.setAttribute('aria-busy', String(busy));
  }

  store.subscribe(render);
  render(store.getState());

  return {
    setQuery(q) {
      query = q.trim().toLowerCase();
      render(store.getState());
    },
  };
}
