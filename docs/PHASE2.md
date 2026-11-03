# Phase 2: PDF and image intake, client-side OCR, classification

Scope: real text extraction from PDFs, real OCR for images and scanned PDFs, an honest per-file state machine with genuine cancel/retry, document-type suggestions with user override. English only. Read-only results: editing is Phase 3, export is Phase 4.

## Run

```bash
npm ci
node scripts/vendor.js   # only to re-create vendor/ (already committed); verifies pinned sha512 of each tarball
npm run serve            # http://127.0.0.1:5173/
npm test                 # 127 unit tests
npm run test:browser     # 69 Playwright tests (real pdf.js + real Tesseract in Chromium)
python3 -I tests/fixtures/make_fixtures.py   # regenerates the synthetic fixtures (needs Pillow, pypdf)
```

## What was built

| Area | Files |
|---|---|
| State machine (illegal transitions throw) | `js/recognition/states.js` |
| One-document pipeline, engines injected (unit-testable) | `js/recognition/pipeline.js` |
| Queue: bounded concurrency, cancel, retry, rotate, override | `js/recognition/session.js` |
| pdf.js adapter (text items + coordinates, page render, password/invalid errors) | `js/recognition/pdfEngine.js` |
| Tesseract adapter (lazy worker, terminate-on-cancel) | `js/recognition/ocrEngine.js` |
| Image decode to OCR-sized canvas | `js/recognition/imageEngine.js` |
| Pure image maths: contrast, Otsu, skew, background flattening, ink coverage | `js/recognition/preprocess.js` (+ `canvasOps.js` glue) |
| Raw items -> normalized lines (raw never mutated) | `js/recognition/text.js` |
| Heuristic type suggestion | `js/recognition/classify.js` |
| UI: in-place updating cards, progress, type select, text preview | `js/ui/fileList.js`, `css/convert.css` |
| Vendored libraries + integrity manifest | `vendor/` (36 files, 10,066,432 B), `vendor/VENDOR.md`, `scripts/vendor.js` |

### Behaviour

- **States:** `queued -> preparing -> extracting -> recognized | review | failed`, plus `cancelled`. Terminal states can re-queue (Retry, Rotate).
- **Text-native PDF pages** (>= 25 letters/digits of embedded text) skip OCR entirely. Scanned pages in the same file are rendered (~300 DPI, capped at 12 MP) and OCRed. Verified: opening a text PDF makes no request under `/vendor/tesseract/`.
- **OCR:** Tesseract.js 7.0.0, `eng` best_int model, LSTM only, single worker, served from `/vendor` (no CDN). Strict CSP: `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self'`.
- **Preprocessing is measured, not assumed.** The raw image is OCRed first. An enhanced variant (grayscale, illumination flattening, contrast stretch, deskew only if confident) is tried only when the raw pass is weak (mean confidence < 75, no words, or low coverage). The attempt that recognised more confident text (sum of confidence over words >= 60, with 5% hysteresis) is kept. Every attempt (mean, words, coverage) is stored in the result.
- **Coverage check.** Mean confidence alone is misleading: on the low-contrast fixture the raw pass reported 91.9% confidence while finding only 14 of ~63 words. Coverage = share of the page's dark marks that lie inside recognized word boxes. Below 0.6 the page is flagged "some text may be missing" and the enhanced pass is tried.
- **Review triggers:** page with no text, page mean confidence < 70, coverage < 0.6.
- **Failures are specific:** password-protected PDF, damaged PDF, > 50 pages, decode failure, OCR engine failure.
- **Cancel is real:** an aborted OCR job terminates the Tesseract worker (the only way to stop a running wasm call); a fresh worker is created for the next job. Late results from a cancelled or superseded run are discarded (a bug in exactly this path was found by a unit test and fixed).
- **Concurrency:** 1 document at a time (one wasm worker, bounded memory). Configurable in `createRecognitionSession`.
- **Data model:** per page `raw.items` (text, x, y, w, h, conf; unit `pt` for PDF text, `px` for OCR, with page size) is never modified; `normalized` is derived from it. User edits (Phase 3) must live elsewhere. The UI shows one block per page with its method and confidence, so text is traceable to a source page. Word-level highlighting on the page is Phase 3.
- **Classification:** English keyword/shape heuristics -> invoice, receipt, table, general document, labelled `likely` / `uncertain` / none. Per-page classification; if two pages each look clearly like different types the file is `uncertain`. User override persists across re-runs, navigation and list re-renders, is labelled "Changed by you", and can be reset.

## Verified results (this session; Chromium via Playwright 1.63, Node 22)

| Check | Result |
|---|---|
| `npm test` | 127 pass / 0 fail (80 from Phase 0-1 + 47 new: state machine, text, classifier, skew, flatten, coverage, pipeline with fakes, session scheduling/cancel races) |
| `npm run test:browser` | 69 pass / 0 fail (47 Phase 1 + 22 Phase 2), plus 11 screenshot captures |
| `git diff --check` | clean |
| Independent check of fixtures | `pdftotext` (poppler): text PDF yields its text, scanned PDF yields none, encrypted PDF asks for a password |
| Paths exercised with real engines | text PDF (2 pages), scanned 2-page PDF, PNG, JPG, rotated, skewed, low-contrast, noise, blank, encrypted PDF, broken PDF |
| Bounded concurrency | polled every 40 ms across 4 queued files: never more than 1 active |
| Cancel | running OCR job -> `cancelled` in < 3 s, `Worker.terminate` observed, next file recognized, no late result after 6 s; Retry afterwards works; Cancel all; remove while running |
| Privacy | full run (text PDF + scanned PDF + image): only same-origin GETs, no POST, no foreign host, no console or CSP errors |
| Accessibility | axe-core 4.11.0: 0 violations in recognized / needs-review / failed card states, details open, desktop + 390 + 320, light + dark |
| Layout | no horizontal overflow; text column stays >= 180 px at 320 px (a screenshot review found it squeezed to ~20 px before the fix; now asserted) |
| Touch targets (390 px) | Cancel, Rotate, Remove, type select, "Recognized text" summary >= 44 px |
| Responsiveness | longest main-thread task during OCR of a scanned PDF: 209 ms (theme change during OCR took 158 ms). Single run on this machine, not a mobile figure |

### Recognition quality on synthetic fixtures (NOT an accuracy metric)

`corpus/` is empty, so real-document accuracy is **unavailable**, not 0 and not 100. For the controlled, invented fixtures in `tests/fixtures/` the tests print the share of known tokens found in the recognized text:

| Fixture | Token recall | Mean conf. | Notes |
|---|---|---|---|
| invoice-scan.png (12 tokens) | 100% | 95.6% | coverage 0.91 |
| invoice-skewed.png (3 degrees) | 100% | 94.7% | enhanced pass not needed |
| invoice-lowcontrast.png | 92% | 93.3% (enhanced) | raw pass: 14 words at 91.9%, coverage 0.18; enhanced: 63 words, coverage 0.87 |
| receipt-scan.jpg, table-scan.png | >= 85% asserted | 91.3%, 95.9% | |
| invoice-rotated90.png | flagged `review` (42.8%) | | readable after 3 clockwise Rotate presses |
| noise.png | flagged `review` (18.8%) | | garbage words are not presented as good |
| blank.png | flagged `review` | | "no text found" |

These are clean, synthetic, English, Liberation Sans renders. They show the pipeline works and that failures are flagged; they say little about real phone photos, stamps, handwriting or other fonts.

Honest finding on preprocessing: before the flattening step was added, the "enhanced" variant (stretch + deskew only) recovered **nothing** on any fixture (14 vs 14 words on the low-contrast photo; no gain on skewed/rotated/noise). It was kept only after illumination flattening made it recover 63 vs 14 words. On the 3-degree skew fixture the raw pass was already 94.7%, so deskew has no measured benefit here; it stays because it only runs on weak pages and only rotates when the estimate is confident, but its value on real skewed scans is unproven.

Timings (this machine, headless Chromium, includes first-use wasm/model load where noted): text PDF 0.4 s; invoice PNG 2.5 s cold / ~1 s warm; 2-page scanned PDF 5.4 s cold; noise page 6.5 s (two attempts). Phone timings unknown.

## Known limitations

- **No automatic orientation detection** (Tesseract OSD data is not shipped). A page rotated 90/180/270 is flagged for review; the user presses Rotate (clockwise, re-runs OCR). Phone photos with EXIF orientation are handled by the browser decode.
- **Coverage threshold (0.6) is calibrated on 7 synthetic images only.** Clean pages measured 0.80 to 1.00; the bad one 0.18. Real pages with large logos, photos, stamps or handwriting may be falsely flagged; pages with a lot of non-text ink that happens to sit under word boxes could be missed.
- **Classifier is a heuristic** over English keywords and number-heavy lines, tested on invented text. Accuracy on real documents is unmeasured; it always shows `likely` / `uncertain` and is overridable.
- **Embedded PDF text is trusted** when >= 25 letters/digits are present. A PDF with a broken text layer (garbage ToUnicode) would be accepted as text and not OCRed. Multi-column reading order is geometric (rows by baseline), not layout analysis; tables become lines.
- **pdf.js asset paths not exercised:** fixtures contain only a JPEG (DCT) image and a non-embedded Helvetica text layer, so JPEG2000/JBIG2 wasm, ICC and standard-font fetching are configured but **unverified**. No cmaps (CJK) shipped.
- **Whole-file limits:** 50 pages per PDF (otherwise the file fails with a clear message), 12 MP render cap, 25 MB per file (Phase 1 policy). Memory behaviour on low-end phones is untested.
- **Offline:** there is no service worker until Phase 6. Vendor files (~9.6 MiB total; Tesseract ~7 MiB only on first OCR, pdf.js ~1.7 MiB only on first PDF) are fetched from the app's own origin on demand and then rely on normal HTTP caching. Offline use after first load is not guaranteed yet.
- **Browsers:** Chromium only. WASM-SIMD is required by the shipped Tesseract core variant (no non-SIMD fallback). Firefox/WebKit, real devices and real camera input were not tested.
- Results live in memory only; nothing is persisted. The Phase 1 screenshots' mid-page "Skip to main content" / header / bottom-nav artifacts in full-page captures come from fixed elements being stitched, not from the app.

## Tooling notes

- Vendored: tesseract.js 7.0.0, tesseract.js-core 7.0.0 (`simd-lstm` only), `@tesseract.js-data/eng` 1.0.0 (`4.0.0_best_int`), pdfjs-dist 6.4.299. Tarball sha512 integrity is checked by `scripts/vendor.js` (the first three match the values recorded in `docs/dependencies.md`; the `eng` data package hash was taken from the npm registry at vendoring time). Licences (Apache-2.0, plus pdf.js wasm/font licence files) are copied next to the files. No source maps, no scripting sandbox.
- pdf-lib, docx, write-excel-file and fflate from the dependency plan are **not** vendored yet (Phase 4).
- Fixture generation uses Pillow and pypdf (not project dependencies).

## Handoff to Phase 3 (NOT STARTED)

- Result shape is `result.pages[i].raw.items` (immutable) + `normalized`; session entries are keyed by file-store item id and expose `{status, progress, result, error, rotation, override}`. Phase 3 should store corrected values in a separate versioned document model and reference raw items by page index + item index.
- OCR coordinates are in canvas pixels of the (possibly rotated, upscaled) recognized bitmap (`coordSpace`); to highlight on the original image Phase 3 needs the rotation and scale used (rotation is stored; scale is derivable from `coordSpace` vs the source size).
- `js/validation.js` / `js/money.js` are still unused by the UI.
