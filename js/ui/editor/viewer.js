// viewer.js - original-document viewer: zoom, page navigation, rotate, source-region highlight.
// The bitmap is painted into one canvas; highlight boxes are absolutely positioned in percentages of
// the page, so they stay aligned at any zoom. When a value has no recorded region the viewer says so.

import { el, icon } from '../dom.js';
import { refRect, itemRect, rotateNormRect } from '../../doc/geometry.js';
import { paintAsync } from './pageSource.js';
import { createSlicer } from '../../recognition/yield.js';

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const VIEW_PIXELS = 2_500_000; // ~1760x1420: sharp at full width on a phone and 2x zoom; keeps one paint short

export function createViewer({ onRotate, onMove, onGoto }) {
  let ctx = null; // { doc, result, pageSource }
  let pos = 0;
  let zoom = 1;
  let showAll = false;
  let highlight = null; // { page: sourceIndex, ref, label }
  let paintedKey = null;
  let renderToken = 0;

  const canvas = el('canvas', { class: 'vw-canvas', 'aria-hidden': 'true' });
  const layer = el('div', { class: 'hl-layer', 'aria-hidden': 'true' });
  const stage = el('div', { class: 'vw-stage' }, canvas, layer);
  const busy = el('p', { class: 'vw-busy', role: 'status' }, 'Rendering page…');
  const scroller = el('div', { class: 'vw-scroll', tabindex: '0', role: 'region', 'aria-label': 'Original page, scrollable' }, stage);
  const status = el('p', { class: 'vw-status', role: 'status', 'aria-live': 'polite' });

  const btn = (name, label, onclick, extra = {}) => el('button', { type: 'button', class: 'icon-btn tb-btn', 'aria-label': label, title: label, onclick, ...extra }, icon(name));
  const zoomOut = btn('zoom-out', 'Zoom out', () => setZoom(-1));
  const zoomIn = btn('zoom-in', 'Zoom in', () => setZoom(1));
  const zoomLabel = el('button', { type: 'button', class: 'tb-text', title: 'Reset zoom to fit width', 'aria-label': 'Zoom 100%. Reset to fit width', onclick: () => { zoom = 1; applyZoom(); } }, '100%');
  const prev = btn('chevron-left', 'Previous page', () => onGoto(pos - 1));
  const next = btn('chevron-right', 'Next page', () => onGoto(pos + 1));
  const pageLabel = el('span', { class: 'tb-page', 'aria-live': 'polite' });
  const rotate = btn('rotate', 'Rotate page 90 degrees clockwise', () => onRotate(pos));
  const earlier = btn('arrow-up', 'Move page earlier', () => onMove(pos, -1));
  const later = btn('arrow-down', 'Move page later', () => onMove(pos, 1));
  const all = el('button', { type: 'button', class: 'icon-btn tb-btn', 'aria-pressed': 'false', 'aria-label': 'Show all recognized text regions', title: 'Show all recognized text regions', onclick: () => { showAll = !showAll; all.setAttribute('aria-pressed', String(showAll)); paintLayer(); } }, icon('text'));

  const toolbar = el('div', { class: 'vw-toolbar', role: 'toolbar', 'aria-label': 'Viewer tools' },
    el('div', { class: 'tb-group' }, zoomOut, zoomLabel, zoomIn),
    el('div', { class: 'tb-group' }, prev, pageLabel, next),
    el('div', { class: 'tb-group' }, rotate, earlier, later, all));
  const node = el('div', { class: 'viewer' }, toolbar, scroller, busy, status);

  function setZoom(dir) {
    const i = ZOOMS.findIndex((z) => z >= zoom - 1e-9);
    zoom = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, i + dir))];
    applyZoom();
  }
  function applyZoom() {
    stage.style.width = `${zoom * 100}%`;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    zoomLabel.setAttribute('aria-label', `Zoom ${Math.round(zoom * 100)}%. Reset to fit width`);
    zoomOut.disabled = zoom <= ZOOMS[0];
    zoomIn.disabled = zoom >= ZOOMS[ZOOMS.length - 1];
  }

  const pageInfo = () => ctx?.doc.pages[pos];
  const resultPage = (src) => ctx?.result.pages.find((p) => p.index === src);

  function placeBox(div, r) {
    div.style.left = `${r.x * 100}%`;
    div.style.top = `${r.y * 100}%`;
    div.style.width = `${Math.max(r.w, 0.004) * 100}%`;
    div.style.height = `${Math.max(r.h, 0.004) * 100}%`;
    return div;
  }

  function paintLayer() {
    layer.replaceChildren();
    const pg = pageInfo();
    if (!ctx || !pg) return;
    const rp = resultPage(pg.source);
    if (showAll && rp) {
      const frag = document.createDocumentFragment();
      rp.raw.items.forEach((_, i) => {
        const r = itemRect(rp, i);
        if (r) frag.append(placeBox(el('div', { class: 'hl hl-word' }), rotateNormRect(r, pg.rotation)));
      });
      layer.append(frag);
    }
    if (highlight && highlight.page === pg.source) {
      const r = refRect(rp, highlight.ref);
      if (r) {
        const d = placeBox(el('div', { class: 'hl hl-active' }), rotateNormRect(r, pg.rotation));
        layer.append(d);
        d.scrollIntoView({ block: 'center', inline: 'center' });
      }
    }
  }

  async function paintPage() {
    const pg = pageInfo();
    if (!pg) return;
    const key = `${pg.source}|${pg.rotation}`;
    if (key === paintedKey) return;
    const token = (renderToken += 1);
    busy.hidden = false;
    busy.textContent = 'Rendering page…';
    scroller.setAttribute('aria-busy', 'true');
    try {
      const base = await ctx.pageSource.render(pg.source, VIEW_PIXELS);
      if (token !== renderToken) return;
      if (!(await paintAsync(canvas, base, pg.rotation, { slicer: createSlicer(8), isCurrent: () => token === renderToken }))) return;
      stage.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
      paintedKey = key;
      busy.hidden = true;
      paintLayer();
    } catch (err) {
      if (token !== renderToken) return;
      paintedKey = null;
      busy.hidden = false;
      busy.textContent = 'This page could not be displayed. You can still edit the extracted data and text.';
    } finally {
      if (token === renderToken) scroller.removeAttribute('aria-busy');
    }
  }

  applyZoom();

  return {
    node,
    /** Called after every document change. */
    update(state, position) {
      const changedDoc = !ctx || ctx.pageSource !== state.pageSource || ctx.result !== state.result;
      ctx = state;
      if (changedDoc) { paintedKey = null; highlight = null; status.textContent = ''; }
      const n = state.doc.pages.length;
      pos = Math.min(Math.max(0, position), Math.max(0, n - 1));
      pageLabel.textContent = `Page ${pos + 1} of ${n}`;
      prev.disabled = pos <= 0;
      next.disabled = pos >= n - 1;
      earlier.disabled = pos <= 0;
      later.disabled = pos >= n - 1;
      paintPage().then(() => paintLayer());
      paintLayer();
    },
    /** Point at a region (or say there is none). Returns the page position that should become active. */
    show(ref, label) {
      if (ref && refRect(resultPage(ref.page), ref)) {
        highlight = { page: ref.page, ref, label };
        status.textContent = `Showing ${label} on page ${(ctx.doc.pages.findIndex((p) => p.source === ref.page) + 1) || 1}.`;
        return ctx.doc.pages.findIndex((p) => p.source === ref.page);
      }
      highlight = null;
      status.textContent = `${label}: no source region on the page (typed by you, or its position was not recorded).`;
      paintLayer();
      return -1;
    },
    clearHighlight() { highlight = null; paintLayer(); },
    get position() { return pos; },
    destroy() { renderToken += 1; ctx = null; paintedKey = null; canvas.width = 1; canvas.height = 1; },
  };
}
