// rail.js - page thumbnails in the CURRENT page order. Selecting a thumbnail shows that page in the viewer.
import { el, icon } from '../dom.js';
import { paint } from './pageSource.js';

const THUMB_PIXELS = 90_000;

export function createRail({ onGoto }) {
  const nodes = new Map(); // source index -> { btn, canvas, key }
  const addTile = el('a', { class: 'rail-add', href: '#/convert', title: 'Go to Convert to add another file' }, icon('plus'), el('span', {}, 'Add file'));
  const node = el('nav', { class: 'rail', 'aria-label': 'Pages' });
  let source = null;

  function build(pg, total) {
    const canvas = el('canvas', { class: 'thumb-canvas', 'aria-hidden': 'true' });
    const label = el('span', { class: 'thumb-num' });
    const btn = el('button', { type: 'button', class: 'thumb-btn' }, canvas, label);
    return { btn, canvas, label, key: null, total };
  }

  return {
    node,
    update({ doc, pageSource }, activePos) {
      if (source !== pageSource) { nodes.clear(); source = pageSource; }
      const want = new Set(doc.pages.map((p) => p.source));
      for (const k of [...nodes.keys()]) if (!want.has(k)) nodes.delete(k);
      const list = doc.pages.map((pg, i) => {
        let n = nodes.get(pg.source);
        if (!n) { n = build(pg, doc.pages.length); nodes.set(pg.source, n); n.btn.addEventListener('click', () => onGoto(doc.pages.findIndex((p) => p.source === pg.source))); }
        n.label.textContent = String(i + 1);
        n.btn.setAttribute('aria-label', `Go to page ${i + 1} of ${doc.pages.length}`);
        if (i === activePos) n.btn.setAttribute('aria-current', 'true'); else n.btn.removeAttribute('aria-current');
        const key = `${pg.rotation}`;
        if (n.key !== key) {
          n.key = key;
          pageSource.render(pg.source, THUMB_PIXELS).then((base) => { if (n.key === key) paint(n.canvas, base, pg.rotation); }, () => {});
        }
        return n.btn;
      });
      node.replaceChildren(...list, addTile);
    },
  };
}
