// pdfEngine.js - pdf.js adapter (vendored, loaded lazily). Text extraction + page rendering.
// Scripting is disabled and all assets come from /vendor/pdfjs (same origin, no CDN).
import { newCanvas } from './canvasOps.js';

const VENDOR = new URL('../../vendor/pdfjs/', import.meta.url);
const RENDER_DPI_SCALE = 300 / 72; // PDF points -> ~300 DPI, capped by maxPixels

let libPromise = null;
function loadLib() {
  libPromise ??= import(new URL('pdf.min.mjs', VENDOR).href).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', VENDOR).href;
    return lib;
  });
  return libPromise;
}

function friendly(err) {
  const name = err?.name ?? '';
  const out = new Error(err?.message ?? 'Could not read this PDF.');
  out.code = 'pdf-error';
  if (name === 'PasswordException') { out.code = 'pdf-encrypted'; out.message = 'This PDF is password-protected. Remove the password and add it again.'; }
  else if (name === 'InvalidPDFException' || name === 'FormatError') { out.code = 'pdf-invalid'; out.message = 'This PDF is damaged or not a valid PDF.'; }
  else if (name === 'MissingPDFException') { out.code = 'pdf-missing'; out.message = 'The PDF could not be read.'; }
  out.userMessage = out.message;
  return out;
}

export function createPdfEngine() {
  return {
    async open(bytes, { signal } = {}) {
      const lib = await loadLib();
      const task = lib.getDocument({
        data: bytes,
        wasmUrl: new URL('wasm/', VENDOR).href,
        standardFontDataUrl: new URL('standard_fonts/', VENDOR).href,
        iccUrl: new URL('iccs/', VENDOR).href,
        enableScripting: false,
      });
      const onAbort = () => task.destroy();
      signal?.addEventListener('abort', onAbort, { once: true });
      let pdf;
      try {
        pdf = await task.promise;
      } catch (err) {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
        throw friendly(err);
      }
      return {
        numPages: pdf.numPages,

        async getPageText(i) {
          const page = await pdf.getPage(i + 1);
          try {
            const vp = page.getViewport({ scale: 1 });
            const content = await page.getTextContent();
            const items = [];
            for (const it of content.items) {
              if (typeof it.str !== 'string' || it.str.trim() === '') continue;
              const [a, b, , d, e, f] = it.transform;
              const h = it.height || Math.abs(d) || Math.hypot(a, b);
              items.push({ text: it.str, x: e, y: vp.height - f - h, w: it.width, h });
            }
            return { width: vp.width, height: vp.height, items };
          } finally {
            page.cleanup();
          }
        },

        async renderPage(i, { rotation = 0, maxPixels, signal: s } = {}) {
          const page = await pdf.getPage(i + 1);
          let renderTask;
          const cancel = () => renderTask?.cancel();
          s?.addEventListener('abort', cancel, { once: true });
          try {
            const rot = (page.rotate + rotation) % 360;
            const base = page.getViewport({ scale: 1, rotation: rot });
            const scale = Math.min(RENDER_DPI_SCALE, Math.sqrt(maxPixels / (base.width * base.height)));
            const viewport = page.getViewport({ scale, rotation: rot });
            const canvas = newCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.fillStyle = '#fff'; // pdf.js renders onto transparency; OCR needs a white page
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            renderTask = page.render({ canvasContext: ctx, viewport, canvas });
            await renderTask.promise;
            return canvas;
          } catch (err) {
            if (s?.aborted || err?.name === 'RenderingCancelledException') throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
            throw friendly(err);
          } finally {
            s?.removeEventListener('abort', cancel);
            page.cleanup();
          }
        },

        async destroy() {
          signal?.removeEventListener('abort', onAbort);
          await task.destroy();
        },
      };
    },
  };
}
