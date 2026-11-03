// ocrEngine.js - Tesseract.js adapter (vendored, loaded lazily, English only).
// One worker, jobs serialised. Cancelling TERMINATES the worker (the only way to stop a running
// wasm recognise call); the next job transparently creates a fresh one.

const VENDOR = new URL('../../vendor/tesseract/', import.meta.url);

let libPromise = null;
const loadLib = () => (libPromise ??= import(new URL('tesseract.esm.min.js', VENDOR).href).then((m) => m.default ?? m));

const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });

export function createOcrEngine() {
  let worker = null;
  let workerPromise = null;
  let currentProgress = null;
  let chain = Promise.resolve();
  let generation = 0; // bumped by kill(): a worker still being created when a job is cancelled must not be adopted

  async function ensureWorker() {
    if (worker) return worker;
    workerPromise ??= (async () => {
      const mine = generation;
      const T = await loadLib();
      const w = await T.createWorker('eng', 1, {
        workerPath: new URL('worker.min.js', VENDOR).href,
        corePath: new URL('tesseract-core-simd-lstm.wasm.js', VENDOR).href,
        langPath: new URL('.', VENDOR).href.replace(/\/$/, ''),
        workerBlobURL: false, // load the worker straight from same-origin /vendor (strict CSP, no blob: workers)
        cacheMethod: 'none', // do not duplicate the 3 MB model into IndexedDB
        gzip: true,
        logger: (m) => { if (m.status === 'recognizing text' && currentProgress) currentProgress(m.progress); },
      });
      if (mine !== generation) { try { await w.terminate(); } catch { /* ignore */ } throw abortError(); }
      worker = w;
      return w;
    })().finally(() => { workerPromise = null; });
    return workerPromise;
  }

  async function kill() {
    generation += 1;
    const w = worker;
    worker = null;
    workerPromise = null;
    if (w) { try { await w.terminate(); } catch { /* already gone */ } }
  }

  function recognizeOnce(canvas, { signal, onProgress }) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError()); return; }
      const onAbort = () => { kill(); reject(abortError()); };
      signal?.addEventListener('abort', onAbort, { once: true });
      (async () => {
        const w = await ensureWorker();
        if (signal?.aborted) return;
        currentProgress = onProgress;
        const { data } = await w.recognize(canvas, {}, { text: true, blocks: true });
        return data;
      })().then((data) => {
        if (signal?.aborted) return;
        resolve({ words: extractWords(data) });
      }, (err) => {
        if (signal?.aborted) return;
        kill(); // a failed worker is not trusted for the next job
        const e = new Error('Text recognition failed in the browser. Try again.');
        e.code = 'ocr-error';
        e.cause = err;
        e.userMessage = e.message;
        reject(e);
      }).finally(() => {
        currentProgress = null;
        signal?.removeEventListener('abort', onAbort);
      });
    });
  }

  return {
    recognize(canvas, opts = {}) {
      const run = () => recognizeOnce(canvas, opts);
      const p = chain.then(run, run);
      chain = p.catch(() => {});
      return p;
    },
    dispose: kill,
  };
}

/** blocks -> paragraphs -> lines -> words. Coordinates are pixels of the recognised canvas. */
export function extractWords(data) {
  const words = [];
  for (const b of data?.blocks ?? []) {
    for (const p of b.paragraphs ?? []) {
      for (const l of p.lines ?? []) {
        for (const w of l.words ?? []) {
          const text = (w.text ?? '').trim();
          if (!text || !w.bbox) continue;
          words.push({ text, x: w.bbox.x0, y: w.bbox.y0, w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0, conf: w.confidence });
        }
      }
    }
  }
  return words;
}
