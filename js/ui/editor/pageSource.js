// pageSource.js - renders pages of the ORIGINAL document for the viewer and the page rail.
// Canvases returned by render() belong to the cache and are never attached to the DOM: callers paint()
// them into their own canvas, so evicting/releasing a cached bitmap cannot blank something on screen.

import { releaseCanvas } from '../../recognition/canvasOps.js';

const BIG_CACHE = 2;

export function paint(target, src, deg = 0) {
  const d = ((deg % 360) + 360) % 360;
  const swap = d === 90 || d === 270;
  target.width = swap ? src.height : src.width;
  target.height = swap ? src.width : src.height;
  const ctx = target.getContext('2d');
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, target.width, target.height);
  ctx.translate(target.width / 2, target.height / 2);
  ctx.rotate((d * Math.PI) / 180);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  ctx.restore();
}

/**
 * @param {{item: {file: File, kind: string, width?: number, height?: number}, result: object, engines: {pdf, image}}} a
 */
export function createPageSource({ item, result, engines }) {
  let pdf = null;
  let disposed = false;
  const cache = new Map(); // key -> Promise<canvas>
  const bigOrder = [];

  async function openPdf() {
    pdf ??= (async () => engines.pdf.open(new Uint8Array(await item.file.arrayBuffer())))();
    return pdf;
  }

  function render(index, maxPixels) {
    const key = `${index}:${maxPixels}`;
    if (cache.has(key)) return cache.get(key);
    const rp = result.pages.find((p) => p.index === index);
    const task = (async () => {
      if (!rp) throw new Error('No such page');
      const canvas = item.kind === 'pdf'
        ? await (await openPdf()).renderPage(index, { rotation: rp.rotation, maxPixels })
        : await engines.image.load(item.file, { rotation: rp.rotation, hint: { width: item.width, height: item.height }, maxPixels });
      if (disposed) { releaseCanvas(canvas); throw new Error('Closed'); }
      return canvas;
    })();
    cache.set(key, task);
    task.catch(() => cache.delete(key));
    if (maxPixels > 500_000) {
      bigOrder.push(key);
      while (bigOrder.length > BIG_CACHE) {
        const old = bigOrder.shift();
        cache.get(old)?.then(releaseCanvas, () => {});
        cache.delete(old);
      }
    }
    return task;
  }

  return {
    render,
    dispose() {
      disposed = true;
      for (const t of cache.values()) t.then(releaseCanvas, () => {});
      cache.clear();
      bigOrder.length = 0;
      pdf?.then((d) => d.destroy?.(), () => {});
      pdf = null;
    },
  };
}
