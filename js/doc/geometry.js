// geometry.js - source-region maths for highlighting recognized text on the page image.
// Rects are NORMALIZED to 0..1 of the page (x, y, w, h) so they are independent of render scale.

/** Normalized union rect of the referenced raw items, or null when there is nothing to point at. */
export function refRect(resultPage, ref) {
  if (!resultPage || !ref || !Array.isArray(ref.items) || !ref.items.length) return null;
  const { width, height } = resultPage.coordSpace ?? {};
  if (!(width > 0) || !(height > 0)) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of ref.items) {
    const it = resultPage.raw.items[i];
    if (!it || !Number.isFinite(it.x) || !Number.isFinite(it.y)) continue;
    x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y);
    x1 = Math.max(x1, it.x + (it.w || 0)); y1 = Math.max(y1, it.y + (it.h || 0));
  }
  if (!Number.isFinite(x0)) return null;
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const nx0 = clamp(x0 / width), ny0 = clamp(y0 / height), nx1 = clamp(x1 / width), ny1 = clamp(y1 / height);
  return { x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0 };
}

/** Rect of ONE raw item (for the optional "show all recognized text" overlay). */
export function itemRect(resultPage, index) {
  return refRect(resultPage, { items: [index] });
}

/** Rotate a normalized rect by a multiple of 90 degrees clockwise together with its page. */
export function rotateNormRect(r, deg) {
  const d = ((deg % 360) + 360) % 360;
  if (d === 0) return r;
  if (d === 90) return { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w };
  if (d === 180) return { x: 1 - r.x - r.w, y: 1 - r.y - r.h, w: r.w, h: r.h };
  if (d === 270) return { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w };
  throw new RangeError(`rotation must be a multiple of 90, got ${deg}`);
}

/** Pixel aspect ratio (w/h) of a page after a clockwise rotation. */
export const rotatedAspect = (aspect, deg) => (((deg % 360) + 360) % 360) % 180 === 0 ? aspect : 1 / aspect;
