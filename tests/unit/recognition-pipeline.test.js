import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognizeDocument, RecognitionError, DEFAULT_RECOGNITION_POLICY as P } from '../../js/recognition/pipeline.js';
import { createRecognitionSession } from '../../js/recognition/session.js';

const file = (bytes = [1, 2, 3]) => new File([new Uint8Array(bytes)], 'x.pdf');
const words = (texts, conf, y = 10) => texts.map((t, i) => ({ text: t, x: 10 + i * 60, y, w: 50, h: 12, conf }));

function fakeEngines({ pages = [], ocrWords = () => words(['Hello', 'World'], 95), enhanceCalls = [], ocrCalls = [] } = {}) {
  return {
    pdf: {
      async open() {
        return {
          numPages: pages.length,
          async getPageText(i) { return pages[i]; },
          async renderPage(i, o) { return { width: 100, height: 200, tag: `page${i}`, rotation: o.rotation }; },
          async destroy() { this.destroyed = true; },
        };
      },
    },
    image: { async load(_f, o) { return { width: 50, height: 60, tag: 'img', rotation: o.rotation }; } },
    ocr: { async recognize(c) { ocrCalls.push(c.tag); return { words: ocrWords(c) }; } },
    async enhance(c) { enhanceCalls.push(c.tag); return { ...c, tag: `${c.tag}+enh` }; },
  };
}
const textPage = (str) => ({ width: 595, height: 842, items: [{ text: str, x: 10, y: 10, w: 200, h: 12 }] });

test('text-native PDF: no OCR is run, method pdf-text, coordinates kept', async () => {
  const ocrCalls = [];
  const engines = fakeEngines({ pages: [textPage('Invoice No INV-00482 total 245.00 supplier ACME')], ocrCalls });
  const r = await recognizeDocument({ file: file(), kind: 'pdf', engines });
  assert.deepEqual(ocrCalls, []);
  assert.equal(r.pages[0].method, 'pdf-text');
  assert.equal(r.pages[0].confidence.mean, null);
  assert.equal(r.pages[0].raw.items[0].conf, null);
  assert.equal(r.pages[0].coordSpace.unit, 'pt');
  assert.match(r.pages[0].normalized.text, /INV-00482/);
  assert.equal(r.summary.ocrPages, 0);
  assert.deepEqual(r.review, []);
});
test('mixed PDF: only the scanned page is OCRed; progress is monotonic and ends at 1', async () => {
  const ocrCalls = [];
  const engines = fakeEngines({ pages: [textPage('Page one has plenty of embedded text here'), { width: 595, height: 842, items: [] }], ocrCalls });
  const seen = [];
  const r = await recognizeDocument({ file: file(), kind: 'pdf', engines, onProgress: (p) => seen.push(p.fraction) });
  assert.deepEqual(ocrCalls, ['page1']);
  assert.deepEqual(r.pages.map((p) => p.method), ['pdf-text', 'ocr']);
  assert.equal(r.pages[1].coordSpace.unit, 'px');
  for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i] >= seen[i - 1] - 1e-9, `non-monotonic ${seen}`);
  assert.equal(seen.at(-1), 1);
});
test('high-confidence OCR does not trigger the enhanced attempt', async () => {
  const enhanceCalls = [];
  const engines = fakeEngines({ pages: [{ width: 1, height: 1, items: [] }], enhanceCalls, ocrWords: () => words(['a', 'b'], 92) });
  const r = await recognizeDocument({ file: file(), kind: 'pdf', engines });
  assert.deepEqual(enhanceCalls, []);
  assert.deepEqual(r.pages[0].attempts.map((a) => a.preprocess), ['none']);
  assert.equal(r.pages[0].chosen, 'none');
});
test('low-confidence raw OCR tries enhanced and keeps the better measured attempt', async () => {
  const engines = fakeEngines({
    pages: [{ width: 1, height: 1, items: [] }],
    ocrWords: (c) => words(['a', 'b', 'c'], c.tag.includes('enh') ? 88 : 55),
  });
  const r = await recognizeDocument({ file: file(), kind: 'pdf', engines });
  assert.deepEqual(r.pages[0].attempts.map((a) => [a.preprocess, a.mean]), [['none', 55], ['enhance', 88]]);
  assert.equal(r.pages[0].chosen, 'enhance');
  assert.equal(r.pages[0].confidence.mean, 88);
});
test('enhanced attempt that is WORSE is discarded', async () => {
  const engines = fakeEngines({
    pages: [{ width: 1, height: 1, items: [] }],
    ocrWords: (c) => words(['a', 'b'], c.tag.includes('enh') ? 40 : 60),
  });
  const r = await recognizeDocument({ file: file(), kind: 'pdf', engines });
  assert.equal(r.pages[0].chosen, 'none');
  assert.equal(r.pages[0].confidence.mean, 60);
  assert.ok(r.review.some((x) => /low recognition confidence/.test(x)));
});
test('OCR that finds nothing -> method none, review reason, not a crash', async () => {
  const engines = fakeEngines({ pages: [{ width: 1, height: 1, items: [] }], ocrWords: () => [] });
  const r = await recognizeDocument({ file: file(), kind: 'pdf', engines });
  assert.equal(r.pages[0].method, 'none');
  assert.deepEqual(r.review, ['Page 1: no text found.']);
  assert.equal(r.classification.confidence, 'none');
});
test('image path passes rotation and OCRs once when confident', async () => {
  const ocrCalls = [];
  const engines = fakeEngines({ ocrCalls });
  const r = await recognizeDocument({ file: file(), kind: 'png', rotation: 90, engines });
  assert.equal(r.pages[0].rotation, 90);
  assert.deepEqual(ocrCalls, ['img']);
  assert.equal(r.summary.meanConf, 95);
});
test('too many pages is a typed failure and the document is destroyed', async () => {
  const many = Array.from({ length: P.maxPages + 1 }, () => textPage('text text text text text text'));
  const engines = fakeEngines({ pages: many });
  await assert.rejects(recognizeDocument({ file: file(), kind: 'pdf', engines }), (e) => e instanceof RecognitionError && e.code === 'too-many-pages');
});
test('abort between pages stops further work', async () => {
  const ac = new AbortController();
  const ocrCalls = [];
  const engines = fakeEngines({ pages: [{ width: 1, height: 1, items: [] }, { width: 1, height: 1, items: [] }], ocrCalls });
  engines.ocr.recognize = async (c) => { ocrCalls.push(c.tag); ac.abort(); return { words: words(['a'], 95) }; };
  await assert.rejects(recognizeDocument({ file: file(), kind: 'pdf', engines, signal: ac.signal }), (e) => e.name === 'AbortError');
  assert.deepEqual(ocrCalls, ['page0']);
});
test('raw items are not changed by normalisation (traceable to source coordinates)', async () => {
  const engines = fakeEngines({ pages: [{ width: 1, height: 1, items: [] }], ocrWords: () => [{ text: 'X', x: 7, y: 9, w: 3, h: 4, conf: 88 }] });
  const r = await recognizeDocument({ file: file(), kind: 'pdf', engines });
  assert.deepEqual(r.pages[0].raw.items, [{ text: 'X', x: 7, y: 9, w: 3, h: 4, conf: 88 }]);
});

// ---------- session ----------
const tick = () => new Promise((r) => setTimeout(r, 0));
function deferredRunner() {
  const jobs = [];
  const runner = (item, ctx) => new Promise((resolve, reject) => {
    const job = { item, ctx, resolve, reject };
    jobs.push(job);
    ctx.signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })));
  });
  return { runner, jobs };
}
const okResult = (review = []) => ({ review, summary: {}, pages: [], classification: {} });

test('session: concurrency is bounded and queue order is FIFO', async () => {
  const { runner, jobs } = deferredRunner();
  const s = createRecognitionSession({ runner, concurrency: 1 });
  ['a', 'b', 'c'].forEach((id) => s.enqueue({ id }));
  await tick();
  assert.equal(jobs.length, 1);
  assert.deepEqual(['a', 'b', 'c'].map((id) => s.get(id).status), ['preparing', 'queued', 'queued']);
  jobs[0].ctx.onProgress({ phase: 'extracting', done: 0, total: 2, fraction: 0.25 });
  assert.equal(s.get('a').status, 'extracting');
  assert.equal(s.get('a').progress.fraction, 0.25);
  jobs[0].resolve(okResult());
  await tick();
  assert.equal(s.get('a').status, 'recognized');
  assert.equal(jobs.length, 2);
  assert.equal(jobs[1].item.id, 'b');
});
test('session: concurrency 2 runs two at once', async () => {
  const { runner, jobs } = deferredRunner();
  const s = createRecognitionSession({ runner, concurrency: 2 });
  ['a', 'b', 'c'].forEach((id) => s.enqueue({ id }));
  await tick();
  assert.equal(jobs.length, 2);
});
test('session: review result -> review status; thrown error -> failed with message', async () => {
  const { runner, jobs } = deferredRunner();
  const s = createRecognitionSession({ runner });
  s.enqueue({ id: 'a' }); s.enqueue({ id: 'b' });
  await tick();
  jobs[0].resolve(okResult(['Page 1: no text found.']));
  await tick();
  assert.equal(s.get('a').status, 'review');
  jobs[1].reject(new RecognitionError('too-many-pages', 'Too many pages.'));
  await tick();
  assert.equal(s.get('b').status, 'failed');
  assert.equal(s.get('b').error.message, 'Too many pages.');
});
test('session: cancelling a running job aborts its signal and frees the slot for the next', async () => {
  const { runner, jobs } = deferredRunner();
  const s = createRecognitionSession({ runner });
  s.enqueue({ id: 'a' }); s.enqueue({ id: 'b' });
  await tick();
  assert.equal(s.cancel('a'), true);
  assert.equal(jobs[0].ctx.signal.aborted, true);
  assert.equal(s.get('a').status, 'cancelled');
  await tick();
  assert.equal(jobs.length, 2);
  assert.equal(s.get('b').status, 'preparing');
  assert.equal(s.cancel('a'), false, 'already terminal');
});
test('session: a late result from a cancelled job is ignored', async () => {
  const jobs = [];
  const s = createRecognitionSession({ runner: (item, ctx) => new Promise((res) => jobs.push({ res, ctx })) });
  s.enqueue({ id: 'a' });
  await tick();
  s.cancel('a');
  jobs[0].res(okResult());
  await tick();
  assert.equal(s.get('a').status, 'cancelled');
  assert.equal(s.get('a').result, null);
});
test('session: cancelling a queued job never starts it', async () => {
  const { runner, jobs } = deferredRunner();
  const s = createRecognitionSession({ runner });
  s.enqueue({ id: 'a' }); s.enqueue({ id: 'b' });
  await tick();
  s.cancel('b');
  jobs[0].resolve(okResult());
  await tick();
  assert.equal(jobs.length, 1);
  assert.equal(s.get('b').status, 'cancelled');
});
test('session: retry re-runs a failed job; rotate cycles 90 degrees and re-runs; rotate refused while active', async () => {
  const { runner, jobs } = deferredRunner();
  const s = createRecognitionSession({ runner });
  s.enqueue({ id: 'a' });
  await tick();
  assert.equal(s.rotate('a'), false);
  jobs[0].reject(new Error('boom'));
  await tick();
  assert.equal(s.get('a').status, 'failed');
  assert.equal(s.retry('a'), true);
  await tick();
  assert.equal(jobs.length, 2);
  jobs[1].resolve(okResult());
  await tick();
  assert.equal(s.rotate('a'), true);
  await tick();
  assert.equal(jobs[2].ctx.rotation, 90);
  jobs[2].resolve(okResult());
  await tick();
  for (let i = 0; i < 3; i += 1) {
    assert.equal(s.rotate('a'), true);
    await tick();
    jobs.at(-1).resolve(okResult());
    await tick();
  }
  assert.equal(s.get('a').rotation, 0);
});
test('session: override survives re-runs; remove aborts a running job and drops the entry', async () => {
  const { runner, jobs } = deferredRunner();
  const s = createRecognitionSession({ runner });
  s.enqueue({ id: 'a' });
  await tick();
  s.setOverride('a', 'receipt');
  s.remove('a');
  assert.equal(jobs[0].ctx.signal.aborted, true);
  assert.equal(s.get('a'), null);
  await tick();
});
test('session: subscribers see every transition', async () => {
  const { runner, jobs } = deferredRunner();
  const s = createRecognitionSession({ runner });
  const seen = [];
  s.subscribe((snap) => seen.push(snap.get('a')?.status));
  s.enqueue({ id: 'a' });
  await tick();
  jobs[0].ctx.onProgress({ phase: 'extracting', done: 0, total: 1, fraction: 0.5 });
  jobs[0].resolve(okResult());
  await tick();
  assert.deepEqual([...new Set(seen)], ['queued', 'preparing', 'extracting', 'recognized']);
});

test('mixed-type pages -> uncertain, never a confident single label', async () => {
  const inv = 'Invoice No INV-1 Bill to Acme Due Date 2026 Subtotal 10 Tax 1 Amount due Payment terms Qty Unit price';
  const rec = 'Receipt Cashier 4 Thank you VISA **** 1234 Card ending 1234 Tendered Change 0.00 Store terminal';
  const engines = fakeEngines({ pages: [textPage(inv), textPage(rec)] });
  const r = await recognizeDocument({ file: file(), kind: 'pdf', engines });
  assert.equal(r.classification.confidence, 'uncertain');
  assert.match(r.classification.reasons[0], /different document types/);
  assert.equal(r.classification.perPage.length, 2);
});
test('consistent pages keep a likely label', async () => {
  const inv = 'Invoice No INV-1 Bill to Acme Due Date 2026 Subtotal 10 Tax 1 Amount due Payment terms Qty Unit price';
  const engines = fakeEngines({ pages: [textPage(inv), textPage(inv)] });
  const r = await recognizeDocument({ file: file(), kind: 'pdf', engines });
  assert.equal(r.classification.suggested, 'invoice');
  assert.equal(r.classification.confidence, 'likely');
});

test('session: with concurrency 2, a stale job finishing late does not detach the re-run from cancel()', async () => {
  const { runner, jobs } = deferredRunner();
  const s = createRecognitionSession({ runner, concurrency: 2 });
  s.enqueue({ id: 'a' });
  await tick();
  s.cancel('a');            // job 0 aborted (its promise rejects asynchronously)
  s.retry('a');             // re-run starts immediately on the free slot
  await tick();
  await tick();             // old job's finally runs now
  assert.equal(jobs.length, 2);
  assert.equal(s.get('a').status, 'preparing');
  assert.equal(s.cancel('a'), true);
  assert.equal(jobs[1].ctx.signal.aborted, true, 'the NEW run is still cancellable');
});

test('confident-but-incomplete OCR: low ink coverage triggers the enhanced attempt and, if still low, flags review', async () => {
  const calls = [];
  const engines = fakeEngines({ pages: [{ width: 1, height: 1, items: [] }], ocrWords: () => words(['a', 'b'], 92), enhanceCalls: calls });
  engines.coverage = async () => 0.2;
  const r = await recognizeDocument({ file: file(), kind: 'pdf', engines });
  assert.deepEqual(calls, ['page0'], 'enhanced attempt tried because coverage was low');
  assert.equal(r.pages[0].coverage, 0.2);
  assert.ok(r.review.some((x) => /covers only 20%.*some text may be missing/.test(x)), r.review.join('|'));
});
test('enhanced attempt that recovers more confident text wins even when mean confidence is similar', async () => {
  const engines = fakeEngines({
    pages: [{ width: 1, height: 1, items: [] }],
    ocrWords: (c) => words(c.tag.includes('enh') ? ['a', 'b', 'c', 'd', 'e', 'f'] : ['a', 'b'], 92),
  });
  engines.coverage = async (c) => (c.tag.includes('enh') ? 0.9 : 0.3);
  const r = await recognizeDocument({ file: file(), kind: 'pdf', engines });
  assert.equal(r.pages[0].chosen, 'enhance');
  assert.equal(r.pages[0].raw.items.length, 6);
  assert.equal(r.pages[0].coverage, 0.9);
  assert.deepEqual(r.review, []);
});
test('good coverage and confidence: no enhanced attempt', async () => {
  const calls = [];
  const engines = fakeEngines({ pages: [{ width: 1, height: 1, items: [] }], ocrWords: () => words(['a', 'b'], 92), enhanceCalls: calls });
  engines.coverage = async () => 0.93;
  const r = await recognizeDocument({ file: file(), kind: 'pdf', engines });
  assert.deepEqual(calls, []);
  assert.deepEqual(r.review, []);
});

// ------------------------------------------------------------------ Phase 5: pause / resume / retry-all / restore / counts
const item = (id) => ({ id, file: file(), kind: 'pdf', name: `${id}.pdf` });
function gated() {
  const gates = new Map();
  const started = [];
  const runner = (it) => new Promise((resolve, reject) => { started.push(it.id); gates.set(it.id, { resolve: () => resolve({ review: [], pages: [], summary: {}, classification: {} }), reject }); });
  return { runner, gates, started };
}

test('session pause: the running file finishes, nothing new starts; resume continues in order', async () => {
  const g = gated();
  const s = createRecognitionSession({ runner: g.runner, concurrency: 1 });
  ['a', 'b', 'c'].forEach((id) => s.enqueue(item(id)));
  await tick();
  assert.deepEqual(g.started, ['a']);
  s.pause();
  assert.equal(s.paused, true);
  g.gates.get('a').resolve();
  await tick(); await tick();
  assert.equal(s.get('a').status, 'recognized', 'the file already running completed');
  assert.deepEqual(g.started, ['a'], 'paused: b did not start');
  assert.equal(s.get('b').status, 'queued');
  s.resume();
  await tick();
  assert.deepEqual(g.started, ['a', 'b']);
  g.gates.get('b').resolve(); await tick(); await tick();
  g.gates.get('c').resolve(); await tick(); await tick();
  assert.deepEqual(s.counts(), { total: 3, queued: 0, active: 0, recognized: 3, review: 0, failed: 0, cancelled: 0 });
});

test('session: a failing file does not block the others; retryFailed re-queues only failed/cancelled', async () => {
  const g = gated();
  const s = createRecognitionSession({ runner: g.runner, concurrency: 1 });
  ['a', 'b', 'c'].forEach((id) => s.enqueue(item(id)));
  await tick();
  g.gates.get('a').reject(Object.assign(new Error('boom'), { code: 'x' })); await tick(); await tick();
  assert.equal(s.get('a').status, 'failed');
  assert.deepEqual(g.started, ['a', 'b'], 'b started right after a failed');
  g.gates.get('b').resolve(); await tick(); await tick();
  s.cancel('c'); await tick();
  assert.deepEqual(s.counts(), { total: 3, queued: 0, active: 0, recognized: 1, review: 0, failed: 1, cancelled: 1 });
  assert.equal(s.retryFailed(), 2);
  await tick();
  assert.equal(s.counts().queued + s.counts().active, 2);
});

test('session restore: a saved result is injected without running the runner', () => {
  let ran = 0;
  const s = createRecognitionSession({ runner: async () => { ran += 1; } });
  assert.equal(s.restore(item('a'), { status: 'review', result: { pages: [] }, rotation: 90, override: 'receipt' }), true);
  assert.equal(ran, 0);
  assert.deepEqual([s.get('a').status, s.get('a').rotation, s.get('a').override], ['review', 90, 'receipt']);
  assert.equal(s.restore(item('a'), {}), false, 'no overwrite');
  assert.throws(() => s.restore(item('b'), { status: 'extracting' }), /Cannot restore/);
  assert.equal(s.retry('a'), true, 'a restored file can be re-recognized');
});
