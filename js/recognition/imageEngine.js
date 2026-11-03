// imageEngine.js - decode an image file to a canvas sized for OCR (browser only).
import { newCanvas, rotateCanvas, releaseCanvas } from './canvasOps.js';

const SMALL_LONG_SIDE = 1500; // below this, OCR benefits from upscaling
const TARGET_LONG_SIDE = 2000;

export function createImageEngine() {
  return {
    async load(file, { rotation = 0, hint = {}, maxPixels }) {
      // Only pre-shrink during decode when the declared size is far beyond the budget.
      let opts;
      if (hint.width && hint.height && hint.width * hint.height > maxPixels * 1.5) {
        const k = Math.sqrt(maxPixels / (hint.width * hint.height));
        opts = { resizeWidth: Math.round(hint.width * k), resizeQuality: 'high' };
      }
      let bitmap;
      try {
        bitmap = await createImageBitmap(file, opts);
      } catch {
        const err = new Error('The browser could not decode this image. It may be damaged.');
        err.code = 'decode-failed';
        throw err;
      }
      try {
        const long = Math.max(bitmap.width, bitmap.height);
        let scale = 1;
        if (long < SMALL_LONG_SIDE) scale = Math.min(2, TARGET_LONG_SIDE / long);
        if (bitmap.width * bitmap.height * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (bitmap.width * bitmap.height));
        const canvas = newCanvas(bitmap.width * scale, bitmap.height * scale);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#fff'; // flatten transparency onto white so OCR sees dark text on light
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const rotated = rotateCanvas(canvas, rotation);
        if (rotated !== canvas) releaseCanvas(canvas);
        return rotated;
      } finally {
        bitmap.close?.();
      }
    },
  };
}
