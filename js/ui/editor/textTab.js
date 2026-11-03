// textTab.js - "Text" tab: the recognized text of every page, editable, in the current page order.
// The recognized text itself (doc.text[i].extracted and the raw OCR items) is never changed.
import { el, icon } from '../dom.js';
import { setPageText } from '../../doc/model.js';

export function createTextTab({ actions }) {
  const blocks = new Map(); // source -> { node, area, meta, reset }
  let sig = null;
  const node = el('div', { class: 'tab-text' });

  function build(source, resultPage) {
    const id = `txt-${source}`;
    const area = el('textarea', { id, class: 'input text-area', rows: 10, spellcheck: 'false', autocomplete: 'off' });
    const meta = el('p', { class: 'ed-note' });
    const reset = el('button', { type: 'button', class: 'link-btn' }, 'Reset to recognized text');
    const h = el('h2', { class: 'ed-h3' }, el('label', { for: id }));
    area.addEventListener('input', () => actions.edit((d) => setPageText(d, source, area.value), `text:${source}`));
    area.addEventListener('blur', () => actions.seal());
    reset.addEventListener('click', () => actions.edit((d) => setPageText(d, source, d.text[source].extracted)));
    const how = resultPage.method === 'pdf-text' ? 'Embedded PDF text' : resultPage.method === 'ocr' ? `OCR${resultPage.confidence.mean !== null ? `, ${resultPage.confidence.mean}% mean confidence` : ''}` : 'No text found';
    const b = { node: el('section', { class: 'txt-block' }, h, meta, area, reset), area, meta, reset, label: h.firstChild, how };
    blocks.set(source, b);
    return b;
  }

  return {
    node,
    update({ doc, result }) {
      const nextSig = doc.pages.map((p) => p.source).join(',');
      for (const k of [...blocks.keys()]) if (!doc.pages.some((p) => p.source === k)) blocks.delete(k);
      const els = doc.pages.map((pg, i) => {
        const rp = result.pages.find((p) => p.index === pg.source);
        const b = blocks.get(pg.source) ?? build(pg.source, rp);
        const t = doc.text[pg.source];
        b.label.textContent = `Page ${i + 1} text`;
        if (b.area.value !== t.value) b.area.value = t.value;
        const edited = t.value !== t.extracted;
        b.meta.textContent = `${b.how}${edited ? ' · edited by you' : ''}. Changing this text does not change the fields or table.`;
        b.reset.hidden = !edited;
        return b.node;
      });
      if (nextSig !== sig || node.childElementCount !== els.length) { sig = nextSig; node.replaceChildren(...els); }
    },
  };
}
