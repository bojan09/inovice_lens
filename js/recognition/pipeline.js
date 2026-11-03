// pipeline.js - recognise ONE document. Engines are injected so this logic is unit-testable
// with fakes; the real engines are pdfEngine.js / ocrEngine.js / imageEngine.js.
//
// Result model (version 1). `raw` is what the engines produced and is never edited afterwards.
// `normalized` is derived from raw. User edits (Phase 3) must live in a separate structure.
//   { version, kind, pages: [{ index, method: 'pdf-text'|'ocr'|'none', coordSpace: {unit,width,height},
//        raw: { items: [{text,x,y,w,h,conf}] }, normalized: { lines, text },
//        confidence: {mean, words, lowWords}, attempts: [{preprocess, mean, words}], chosen, rotation }],
//     classification, summary: {pages, textPages, ocrPages, emptyPages, meanConf}, review: [reasons] }

import { KINDS } from '../intake.js';
import { meaningfulChars, normalizePage, confidenceStats } from './text.js';
import { classify } from './classify.js';

export const DEFAULT_RECOGNITION_POLICY = Object.freeze({
  maxPages: 50,
  minTextChars: 25, // meaningful chars on a page before embedded text is trusted (else OCR)
  enhanceBelow: 75, // raw OCR mean confidence under this triggers the "enhanced" attempt
  reviewBelow: 70, // page mean confidence under this requires review
  lowWordConf: 60,
  minCoverage: 0.6, // share of dark marks inside recognised words; lower = text probably missed
  maxOcrPixels: 12_000_000,
  enhance: true, // false = never try the enhanced (flattened/deskewed) pass
});

export class RecognitionError extends Error {
  constructor(code, message) { super(message); this.name = 'RecognitionError'; this.code = code; }
}
export class AbortedError extends Error {
  constructor() { super('Cancelled'); this.name = 'AbortError'; }
}

const throwIfAborted = (signal) => { if (signal?.aborted) throw new AbortedError(); };

/**
 * @param {object} args
 * @param {File} args.file  validated by intake.js
 * @param {string} args.kind  'pdf' | 'jpeg' | 'png' | 'webp'
 * @param {{width?:number,height?:number}} [args.hint]
 * @param {0|90|180|270} [args.rotation]
 * @param {{pdf, image, ocr, enhance}} args.engines
 * @param {AbortSignal} [args.signal]
 * @param {(p:{phase:string, done:number, total:number, fraction:number, note?:string})=>void} [args.onProgress]
 */
export async function recognizeDocument({ file, kind, hint = {}, rotation = 0, engines, signal, onProgress = () => {}, policy = DEFAULT_RECOGNITION_POLICY }) {
  throwIfAborted(signal);
  onProgress({ phase: 'preparing', done: 0, total: 0, fraction: 0 });
  const pages = [];

  if (KINDS[kind]?.image) {
    onProgress({ phase: 'extracting', done: 0, total: 1, fraction: 0, note: 'Reading image' });
    const canvas = await engines.image.load(file, { rotation, hint, maxPixels: policy.maxOcrPixels, signal });
    throwIfAborted(signal);
    pages.push(await ocrPage({ canvas, index: 0, rotation, engines, policy, signal, onFraction: (f) => onProgress({ phase: 'extracting', done: 0, total: 1, fraction: f, note: 'Recognizing text' }) }));
    onProgress({ phase: 'extracting', done: 1, total: 1, fraction: 1 });
  } else if (kind === 'pdf') {
    const bytes = new Uint8Array(await file.arrayBuffer());
    throwIfAborted(signal);
    const doc = await engines.pdf.open(bytes, { signal });
    try {
      if (doc.numPages > policy.maxPages) {
        throw new RecognitionError('too-many-pages', `This PDF has ${doc.numPages} pages; the limit is ${policy.maxPages}.`);
      }
      const total = doc.numPages;
      for (let i = 0; i < total; i += 1) {
        throwIfAborted(signal);
        const report = (f, note) => onProgress({ phase: 'extracting', done: i, total, fraction: (i + f) / total, note });
        report(0, `Reading page ${i + 1} of ${total}`);
        const text = await doc.getPageText(i);
        throwIfAborted(signal);
        const joined = text.items.map((t) => t.text).join(' ');
        if (meaningfulChars(joined) >= policy.minTextChars) {
          pages.push(textPage(text, i));
        } else {
          const canvas = await doc.renderPage(i, { rotation, maxPixels: policy.maxOcrPixels, signal });
          throwIfAborted(signal);
          pages.push(await ocrPage({ canvas, index: i, rotation, engines, policy, signal, onFraction: (f) => report(f, `Recognizing page ${i + 1} of ${total}`) }));
        }
        onProgress({ phase: 'extracting', done: i + 1, total, fraction: (i + 1) / total });
      }
    } finally {
      await doc.destroy?.();
    }
  } else {
    throw new RecognitionError('unsupported', `Unsupported kind: ${kind}`);
  }

  return buildResult(kind, pages, policy);
}

function textPage(text, index) {
  const items = text.items.map((t) => ({ ...t, conf: null }));
  return {
    index, method: 'pdf-text', rotation: 0,
    coordSpace: { unit: 'pt', width: text.width, height: text.height },
    raw: { items }, normalized: normalizePage(items),
    confidence: { mean: null, words: 0, lowWords: 0 }, attempts: [], chosen: null,
  };
}

async function ocrPage({ canvas, index, rotation, engines, policy, signal, onFraction }) {
  const attempts = [];
  const made = [canvas];
  const goodMass = (words) => words.reduce((s, w) => s + (w.conf >= policy.lowWordConf ? w.conf : 0), 0);
  const run = async (c, label, fractionScale, fractionBase) => {
    const out = await engines.ocr.recognize(c, { signal, onProgress: (f) => onFraction(fractionBase + f * fractionScale) });
    throwIfAborted(signal);
    const stats = confidenceStats(out.words, policy.lowWordConf);
    const coverage = engines.coverage ? await engines.coverage(c, out.words) : null;
    const mass = goodMass(out.words);
    attempts.push({ preprocess: label, mean: stats.mean, words: stats.words, coverage, mass });
    return { out, stats, coverage, mass, canvas: c, label };
  };

  let best = await run(canvas, 'none', 0.5, 0);
  // Measure, don't assume: only try the enhanced variant when the raw pass looks weak (low
  // confidence, nothing found, or text covering too little of the ink on the page), and keep
  // whichever attempt recognised more confident text. Never keep it just because it ran.
  const weak = (r) => r.stats.words === 0 || r.stats.mean < policy.enhanceBelow || (r.coverage !== null && r.coverage < policy.minCoverage);
  if (policy.enhance !== false && weak(best)) { // settings can switch the enhanced pass off entirely
    const enhanced = await engines.enhance(canvas, { signal });
    made.push(enhanced);
    throwIfAborted(signal);
    const second = await run(enhanced, 'enhance', 0.5, 0.5);
    if (second.stats.words > 0 && (best.stats.words === 0 || second.mass > best.mass * 1.05)) best = second;
  }
  const items = best.out.words.map((w) => ({ text: w.text, x: w.x, y: w.y, w: w.w, h: w.h, conf: w.conf }));
  const empty = items.length === 0;
  const coordSpace = { unit: 'px', width: best.canvas.width, height: best.canvas.height };
  // Page bitmaps are large (up to ~12 MP): free them as soon as OCR is done.
  new Set(made).forEach((c) => engines.release?.(c));
  return {
    index, method: empty ? 'none' : 'ocr', rotation,
    coordSpace,
    raw: { items }, normalized: normalizePage(items),
    confidence: best.stats, coverage: best.coverage, attempts, chosen: empty ? null : best.label,
  };
}

function buildResult(kind, pages, policy) {
  const lines = pages.flatMap((p) => p.normalized.lines);
  const ocr = pages.filter((p) => p.method === 'ocr');
  const scored = ocr.filter((p) => p.confidence.mean !== null);
  const meanConf = scored.length ? Math.round((scored.reduce((s, p) => s + p.confidence.mean, 0) / scored.length) * 10) / 10 : null;
  const classification = classifyDocument(pages, lines);

  const review = [];
  pages.forEach((p, i) => {
    if (p.method === 'none') review.push(`Page ${i + 1}: no text found.`);
    else if (p.method === 'ocr' && p.confidence.mean < policy.reviewBelow) review.push(`Page ${i + 1}: low recognition confidence (${p.confidence.mean}%).`);
    else if (p.method === 'ocr' && p.coverage !== null && p.coverage < policy.minCoverage) {
      review.push(`Page ${i + 1}: recognized text covers only ${Math.round(p.coverage * 100)}% of the marks on the page; some text may be missing.`);
    }
  });
  if (!lines.length && !review.length) review.push('No text found.');

  return {
    version: 1, kind, pages, classification,
    summary: {
      pages: pages.length,
      textPages: pages.filter((p) => p.method === 'pdf-text').length,
      ocrPages: ocr.length,
      emptyPages: pages.filter((p) => p.method === 'none').length,
      meanConf,
    },
    review,
  };
}

/**
 * Whole-document suggestion, but never more confident than the pages allow: if two pages each
 * look clearly like DIFFERENT types, the document is flagged uncertain instead of averaged.
 */
export function classifyDocument(pages, allLines) {
  const whole = classify(allLines);
  const per = pages.map((p) => classify(p.normalized.lines));
  const likely = per.filter((c) => c.confidence === 'likely');
  const kinds = [...new Set(likely.map((c) => c.suggested))];
  if (kinds.length > 1) {
    return {
      ...whole,
      suggested: likely[0].suggested,
      confidence: 'uncertain',
      reasons: [`Pages look like different document types (${kinds.join(', ')}).`, ...whole.reasons],
      perPage: per.map((c) => ({ suggested: c.suggested, confidence: c.confidence })),
    };
  }
  return { ...whole, perPage: per.map((c) => ({ suggested: c.suggested, confidence: c.confidence })) };
}
