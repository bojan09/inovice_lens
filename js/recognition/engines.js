// engines.js - wires the real engines + runner used by the app.
import { createPdfEngine } from './pdfEngine.js';
import { createOcrEngine } from './ocrEngine.js';
import { createImageEngine } from './imageEngine.js';
import { enhanceCanvas, releaseCanvas, computeCoverage } from './canvasOps.js';
import { recognizeDocument } from './pipeline.js';

export function createRealRunner() {
  const ocr = createOcrEngine();
  const engines = {
    pdf: createPdfEngine(),
    image: createImageEngine(),
    ocr,
    enhance: async (canvas) => enhanceCanvas(canvas),
    coverage: async (canvas, words) => computeCoverage(canvas, words),
    release: releaseCanvas,
  };
  const runner = (item, { rotation, signal, onProgress }) => recognizeDocument({
    file: item.file,
    kind: item.kind,
    hint: { width: item.width, height: item.height },
    rotation,
    engines,
    signal,
    onProgress,
  });
  return { runner, engines, dispose: () => ocr.dispose() };
}
