// pageSource.js - renders pages of the ORIGINAL document for the viewer and the page rail.
// Canvases returned by render() belong to the cache and are never attached to the DOM: callers paint()
// them into their own canvas, so evicting/releasing a cached bitmap cannot blank something on screen.

import { releaseCanvas } from '../../recognition/canvasOps.js';

const BIG_CACHE = 2;

function applyOrientation(ctx, target, src, d) {
  const W = src.width; const H = src.height;
  if (d === 90) ctx.setTransform(0, 1, -1, 0, H, 0);
  else if (d === 180) ctx.setTransform(-1, 0, 0, -1, W, H);
  else if (d === 270) ctx.setTransform(0, -1, 1, 0, 0, W);
  else if (d !== 0) { ctx.translate(target.width / 2, target.height / 2); ctx.rotate((d * Math.PI) / 180); ctx.translate(-W / 2, -H / 2); }
}

const PAINT_ROWS = 512;

/**
 * Same result as paint(), but copies the bitmap in horizontal bands and hands the thread back between
 * bands, so showing a 4 MP page never blocks input for one long task. `isCurrent()` lets the caller
 * abandon a stale paint (page changed while we were copying).
 */
export async function paintAsync(target, src, deg = 0, { slicer, isCurrent = () => true } = {}) {
  const d = ((deg % 360) + 360) % 360;
  const swap = d === 90 || d === 270;
  target.width = swap ? src.height : src.width;
  target.height = swap ? src.width : src.height;
  const ctx = target.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  if (d !== 0) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, target.width, target.height); }
  applyOrientation(ctx, target, src, d);
  for (let y = 0; y < src.height; y += PAINT_ROWS) {
    const rows = Math.min(PAINT_ROWS, src.height - y);
    ctx.drawImage(src, 0, y, src.width, rows, 0, y, src.width, rows);
    if (slicer) await slicer.tick();
    if (!isCurrent()) return false;
  }
  return true;
}

export function paint(target, src, deg = 0) {
  const d = ((deg % 360) + 360) % 360;
  const swap = d === 90 || d === 270;
  target.width = swap ? src.height : src.width;
  target.height = swap ? src.width : src.height;
  const ctx = target.getContext('2d');
  ctx.save();
  ctx.imageSmoothingEnabled = false; // always a 1:1 copy (right-angle rotation): resampling would only cost time
  if (d === 0) {
    ctx.drawImage(src, 0, 0); // source canvases are already opaque, no white fill needed
  } else {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, target.width, target.height);
    // exact integer transforms for 90/180/270 instead of a generic rotate() about the centre
    const W = src.width; const H = src.height;
    if (d === 90) ctx.setTransform(0, 1, -1, 0, H, 0);
    else if (d === 180) ctx.setTransform(-1, 0, 0, -1, W, H);
    else if (d === 270) ctx.setTransform(0, -1, 1, 0, 0, W);
    else { ctx.translate(target.width / 2, target.height / 2); ctx.rotate((d * Math.PI) / 180); ctx.translate(-W / 2, -H / 2); }
    ctx.drawImage(src, 0, 0);
  }
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
