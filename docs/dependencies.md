# InvoiceLens - Vendored dependency evaluation

Date of evaluation: 2026-11-03. Scope: **English only** (scope change received mid-task: only the
`eng` Tesseract model is needed; Macedonian/Serbian/Bulgarian data, Cyrillic fonts and Cyrillic
CMaps are dropped; Latin standard-font notes are kept).

Method: `npm view` (versions, dates, licences, maintainers), `npm pack` + `tar` extraction into a
scratch directory (nothing executed), `gzip -9` for transfer sizes, the npm bulk advisory endpoint
(`/-/npm/v1/security/advisories/bulk`, same data source as `npm audit`) for CVEs, GitHub API
listing for tessdata_fast / tessdata_best sizes, direct download of the SheetJS CDN tarball.
Policy: latest stable release that is at least 14 days old on 2026-11-03 (i.e. published on or
before 2026-10-20) unless stated.

"measured" = taken from an unpacked tarball or file on disk. "estimated" = derived. "UNVERIFIED" =
not checked, or no way to check without running code / a browser.

## 1. Summary table

| Area | Pick (exact) | SPDX | Min+gz transfer | Raw (= what the SW cache stores) | Advisories (on pinned version) | Notes |
|---|---|---|---|---|---|---|
| OCR wrapper | tesseract.js **7.0.0** | Apache-2.0 | 10.6 KB (esm) + 33.6 KB (worker) | 63.2 KB + 111.3 KB | none | released 2025-12-15, no release in ~11 months |
| OCR core (wasm) | tesseract.js-core **7.0.0** (use `tesseract-core-simd-lstm.wasm.js`) | Apache-2.0 | 1.46 MB | 3.90 MB | none | wasm is base64-embedded in the .js; npm `latest` dist-tag still says 6.1.2, 7.0.0 is what tesseract.js 7.0.0 depends on |
| OCR language data | @tesseract.js-data/eng **1.0.0**, folder `4.0.0_best_int` (`eng.traineddata.gz`) | MIT wrapper; traineddata Apache-2.0 (tessdata_best LICENSE) | 2.95 MB (already gzip) | 2.95 MB | n/a | alt: tessdata_fast eng, 1.98 MB gz (see 2.1) |
| PDF read/render | pdfjs-dist **6.4.299** | Apache-2.0 | 131 KB + 375 KB worker | 459 KB + 1.26 MB | none | 6.5.438 (2026-11-01) is too new; 6.4.299 dated 2026-10-03 |
| PDF write | pdf-lib **1.17.1** | MIT | 206 KB | 523 KB | none | last release 2022-05; stable, unmaintained |
| DOCX | docx **9.13.0** | MIT | 276 KB (unminified file gz) | 1.28 MB unminified | none | published 2026-10-19 (15 days); very frequent releases, pin exactly |
| XLSX | write-excel-file **4.1.1** (UMD bundle) | MIT | 19 KB | 70.8 KB | none | write-only; fflate inlined |
| ZIP | fflate **0.8.3** | MIT | 22 KB (esm) / 12.6 KB (umd) | 90.9 KB / 33.0 KB | none | |
| Preprocessing | **No OpenCV.js**; plain canvas code | n/a | n/a | n/a | n/a | opencv.js is 13.3 MB raw / 3.75 MB gz |

Pinned set is pure client-side, no runtime CDN, no `eval`/`new Function` on any hot path (see 4).

## 2. Per-library notes

### 2.1 OCR: tesseract.js 7.0.0 + tesseract.js-core 7.0.0 + eng data

- Browser entry for no-bundler use: `dist/tesseract.esm.min.js` (ES module, default export is the
  Tesseract object; use `Tesseract.createWorker(...)`). Checked: tail of the file is
  `export { tesseract_min as default }`. Worker script: `dist/worker.min.js` (classic script,
  loaded with `new Worker` or a blob `importScripts`). Inside the worker the core is loaded with
  `importScripts()`.
- API (v7, from `src/createWorker.js`): `createWorker(langs='eng', oem=1 /*LSTM_ONLY*/, options, config)`.
- **Pointing at local files** (read from `src/worker-script/browser/getCore.js`,
  `src/worker-script/index.js`, `src/worker/browser/spawnWorker.js`):
  - `workerPath`: URL of the worker script. Default is a jsDelivr URL, so it MUST be overridden.
  - `corePath`: if the string ends in `js` it is `importScripts`'d verbatim, otherwise it is treated
    as a directory and the file is chosen by feature detection (relaxedsimd > simd > plain). To
    avoid precaching three 3.9 MB variants, **pass the full file URL**
    `.../tesseract-core-simd-lstm.wasm.js`. WASM SIMD is baseline in current evergreen browsers
    (the non-SIMD fallback is deliberately dropped; browser-support claim not tested here).
  - `langPath`: directory URL; the worker fetches `${langPath}/eng.traineddata.gz` (gzip defaults
    to true; it checks the 1F 8B magic bytes so a server that transparently decodes also works).
    Without `langPath` it fetches from jsDelivr (`@tesseract.js-data/eng/4.0.0_best_int`).
  - `workerBlobURL`: default `true` wraps the worker as `importScripts("<workerPath>")` inside a blob
    worker, so paths MUST be absolute (use `new URL('vendor/tesseract/worker.min.js', location.href).href`).
    Setting `workerBlobURL: false` creates `new Worker(workerPath)` directly and is the safer choice
    when relying on the service worker to answer the request (no `blob:` in `worker-src` needed).
  - `cacheMethod: 'none'` stops tesseract.js from also copying the traineddata into IndexedDB
    (otherwise ~5 MB is stored twice: SW cache plus IndexedDB). Valid values seen in source:
    'write' (default), 'refresh', 'none'.
  - `gzip: true` (default). Keep the file as `.gz`.
  - Recommended call (untested in a browser, derived from source):
    `Tesseract.createWorker('eng', 1, { workerPath, corePath, langPath, workerBlobURL:false, cacheMethod:'none', gzip:true, logger })`
- Service-worker cache: all of the above are plain GET requests to same-origin static files, so
  precaching them under the same scope works. Dedicated workers created from a same-origin URL are
  controlled by the page's SW; `importScripts` and `fetch` from inside them go through it
  (standard behaviour; UNVERIFIED by me in a browser). Cache API stores the **decoded** body, so
  the budget uses raw sizes for `.js` files and the `.gz` size for traineddata (the file is stored as-is).
- Core variants in 7.0.0 (measured raw): `lstm` 3.896 MB, `simd-lstm` 3.899 MB, `relaxedsimd-lstm`
  3.906 MB; non-lstm (legacy engine) variants are 4.69-4.70 MB. Only `simd-lstm` is needed.
  The separate `.wasm` files (2.86 MB) are NOT needed: the `.wasm.js` embeds the binary (no
  `.wasm` fetch or `locateFile` reference found in the file).
- **tessdata_fast vs best, English only** (sizes measured):

  | Variant | Raw | gzip -9 | Source |
  |---|---|---|---|
  | tessdata_fast `eng.traineddata` | 4,113,088 B | 1,976,309 B (my own gzip) | GitHub tessdata_fast |
  | `@tesseract.js-data/eng` `4.0.0_best_int` | 5,199,098 B | 2,952,873 B (shipped) | npm |
  | tessdata_best `eng.traineddata` (float) | 15,400,601 B | not measured | GitHub tessdata_best |
  | `@tesseract.js-data/eng` `4.0.0` (legacy+LSTM) | 23,466,654 B | 10,923,060 B | npm; not needed |

  Practical trade-off: `best` (float) is the most accurate and slowest; `fast` is integer-quantised,
  smaller and faster with slightly lower accuracy; `best_int` is the best model converted to integer
  weights, which is what tesseract.js itself downloads for LSTM-only mode (so it is the
  combination the library is tested with). The accuracy and speed deltas on invoices are
  **UNVERIFIED** - I did not benchmark. Recommendation: ship `best_int` (2.95 MB cost, +1 MB over
  fast), and A/B it against fast on `corpus/` in the repo before release; switching is a file swap
  because both are LSTM-only traineddata. Do not ship the 15 MB float `best`.
  If you pick fast, produce `eng.traineddata.gz` yourself (`gzip -9`, 1.98 MB) and keep the name.
- Not needed in English-only scope: `osd.traineddata` (10.5 MB in tessdata_fast), mkd, srp, srp_latn, bul.
- Licence: tesseract.js and core Apache-2.0 (package.json); tessdata_fast/best LICENSE files are Apache 2.0
  (fetched); npm wrapper `@tesseract.js-data/eng` declares MIT.
- Advisories: none for tesseract.js 7.0.0, tesseract.js-core 7.0.0, nor its deps idb-keyval 6.2.0,
  wasm-feature-detect 1.8.0, bmp-js 0.1.0, zlibjs 0.3.1 (bulk advisory API). The dist bundle
  `worker.min.js` is the self-contained build (zlib, regenerator-runtime inlined).
- Maintenance: 4 npm maintainers; 55 releases since 2015; last release 2025-12-15 (11 months). Moderate.
- Code-eval scan: `worker.min.js` contains guarded fallbacks `new Function("return this")` (only if
  `globalThis` is missing) and `Function("r","regeneratorRuntime = r")` (only if `globalThis` missing);
  the core `.wasm.js` has none. CSP needs `'wasm-unsafe-eval'` for WebAssembly compile.

### 2.2 PDF read/render: pdfjs-dist 6.4.299

- ES module build only in `build/`: `pdf.min.mjs` (459 KB raw, 131 KB gz) and `pdf.worker.min.mjs`
  (1.264 MB raw, 375 KB gz). A `legacy/build/` copy exists (pdf.min.mjs 524 KB, worker 1.32 MB) for
  older browsers; engines field is Node >=22.13 only (Node, not browser). Browser minimums for the
  non-legacy build: UNVERIFIED.
- Wiring: `import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs'`; `pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', location.href).href`.
- `getDocument({ data, wasmUrl:'vendor/pdfjs/wasm/', standardFontDataUrl:'vendor/pdfjs/standard_fonts/', iccUrl:'vendor/pdfjs/iccs/', cMapUrl: undefined, enableScripting:false })`
  (option names seen in `build/pdf.mjs`: `wasmUrl`, `cMapUrl`, `standardFontDataUrl`, `iccUrl`, `useWorkerFetch`,
  `enableScripting`). Use absolute URLs ending in `/`. With all URLs valid, pdf.js sets `useWorkerFetch`
  so the worker itself fetches wasm/fonts (goes through the SW).
- **Security flags**: `isEvalSupported` no longer exists in v6 (0 occurrences in `pdf.mjs` and
  `pdf.worker.mjs`); no `eval(`/`new Function` in the worker. `enableScripting` defaults off; keep it
  false (then `quickjs-eval.wasm`/`.js`, 469 KB + 6 KB, are not needed). Older pdf.js had CVE-2024-4367
  (font eval); the bulk advisory API reports nothing for 6.4.299.
- Needed assets (measured): `wasm/openjpeg.wasm` 251 KB (JPEG2000), `wasm/jbig2.wasm` 104 KB,
  `wasm/qcms_bg.wasm` 97 KB (colour), `standard_fonts/` 774 KB of fonts (Liberation Sans x4 TTF = 574 KB,
  Foxit .pfb x10 = 201 KB; used when a PDF references non-embedded base-14 Latin fonts), `iccs/CGATS001Compat-v2-micro.icc` 8.5 KB.
  Copy the LICENSE files that sit beside them (LICENSE_LIBERATION, LICENSE_FOXIT, wasm/LICENSE_*).
- **Not shipped** (English-only): `cmaps/` (169 files, 1.7 MB; only needed for non-embedded CJK/predefined
  CID fonts - rare PDFs with such fonts will render with fallback glyphs; accepted risk),
  `wasm/*_nowasm_fallback.js` (152 KB + 446 KB), `image_decoders/`, `*.map` (2-5 MB each),
  `pdf.sandbox*`, `web/` viewer.
- Rendering to canvas for OCR is the main use; text extraction via `page.getTextContent()`.
- Maintenance: Mozilla, extremely active (1568 npm releases). New release roughly monthly; pin and bump deliberately.
- Licence: Apache-2.0.

### 2.3 PDF generation: pdf-lib 1.17.1 vs jsPDF 4.2.1

| Criterion | pdf-lib 1.17.1 | jsPDF 4.2.1 |
|---|---|---|
| (a) embed page images | `embedJpg` (JPEG kept as-is) / `embedPng`; arbitrary page sizes | `addImage`; recompresses through its own pipeline (fast-png + fflate) |
| (b) invisible OCR text | `pushOperators(setTextRenderingMode(TextRenderingMode.Invisible))` (enum value 3 present in `operators.d.ts`) plus `setTextMatrix` for per-word placement/scale; slightly low-level | `doc.text(..., {renderingMode:'invisible'})` present in source - simpler |
| (c) fonts | Standard 14 fonts are WinAnsi only and throw on unencodable characters (sanitise OCR text). Custom TTF would need `@pdf-lib/fontkit` (+341 KB gz). For English not needed | Standard 14 built in; TTF via addFont/base64 if required |
| (d) size | `dist/pdf-lib.esm.min.js` 523 KB raw / 206 KB gz, **self-contained ES module** (no imports) | `jspdf.es.min.js` 344 KB/109 KB gz but has **bare imports** (`@babel/runtime`, `fflate`, `fast-png`) - not usable without a bundler/import map; self-contained build is `jspdf.umd.min.js` 420 KB raw / 132 KB gz, which still contains lazy `require("canvg")`, `dompurify`, `html2canvas` (only hit by `.html()`/SVG helpers) |
| Licence | MIT | MIT |
| Maintenance | last release 2022-05-12; no advisories on 1.17.1; effectively unmaintained | 4.2.1 on 2026-03-17 (8 months ago); no advisories on 4.2.1 (older 3.x/2.x had several; stay on 4.x) |
| Extras | `copyPages` / load existing PDFs (merge, rotate, reorder) | none comparable |

**Pick: pdf-lib 1.17.1.** Reasons: true ES module with zero dependencies (fits no-bundler), JPEG
passthrough keeps scanned-page PDFs small, and it can import/merge existing PDFs. Cost: 74 KB gz more
than jsPDF UMD, and invisible text requires raw operators. Mitigations: wrap in one small helper;
sanitise text to WinAnsi. Alternative if the unmaintained status becomes a concern: jsPDF 4.2.1 UMD.
Behaviour claims for JPEG passthrough are from the documented API, not a test run (UNVERIFIED).

### 2.4 DOCX: docx 9.13.0

- `dist/index.mjs` is a self-contained ES module (no bare imports; it inlines jszip, hash.js, nanoid)
  - 1,283,711 B raw, **unminified**, 276 KB gz. A minified copy is not shipped, so a build step
  (esbuild/terser at vendoring time) could cut the raw size; size after minify is UNVERIFIED (est. 0.5-0.7 MB).
  Alternatives in the same dir: `index.iife.js` (global `docx`, 1.33 MB, 279 KB gz).
  Sub-entries (`charts`, `html`, `layout`, ...) exist as separate files; the main `index` is enough.
- Browser use: `Packer.toBlob(doc)` then `URL.createObjectURL`; supports `Table`, `ImageRun`, headings.
  (API knowledge; not executed here.)
- Dependencies bundled: jszip (MIT OR GPL-3.0; use under MIT), hash.js, nanoid. No advisories for
  docx 9.13.0, hash.js 1.1.7, nanoid 6.0.1, jszip 3.10.2.
- Eval scan: a guarded `new Function("return this")` global-detection fallback in the bundled code.
- Maintenance: single maintainer (dolanmiy), 104 releases, 9.12 -> 9.15.1 in the last 4 weeks. Very
  active but churny; pin 9.13.0 (published 2026-10-19, 15 days old; 9.12.0 on 2026-10-16 is the fallback).
  9.15.1 (2026-10-31) is too new under the 14-day rule.
- Licence MIT.

### 2.5 XLSX: write-excel-file 4.1.1 vs SheetJS CE vs ExcelJS

| | write-excel-file 4.1.1 | SheetJS CE 0.20.3 | ExcelJS 4.4.0 |
|---|---|---|---|
| Licence | MIT | Apache-2.0 | MIT |
| Distribution | npm, current (2026-06-08) | **npm `xlsx` is stale at 0.18.5 (2022-03-24, last npm publish)**; real releases only via `cdn.sheetjs.com` tarball (0.20.3 listed as latest in `xlsx.lst`) | npm, last release 2024-12-20 |
| Advisories | none | npm 0.18.5: **GHSA-4r6h-8v6p-xvw6** (prototype pollution, <0.19.3, high) and **GHSA-5pgg-2g8v-p4x9** (ReDoS, <0.20.2, high). 0.20.3 not listed | none on 4.4.0 |
| Browser no-bundler | `bundle/write-excel-file.min.js` UMD, global `writeXlsxFile`; ESM entry `browser/index.js` has a bare `fflate` import | `xlsx.mjs` ESM (1.0 MB raw / 253 KB gz) or `dist/xlsx.mini.min.js` (280 KB / 86 KB gz) | `dist/exceljs.min.js` 948 KB / 256 KB gz |
| Size (min / gz) | **70.8 KB / 19.1 KB** | 280 KB / 86 KB (mini), 952 KB / 334 KB (full) | 948 KB / 256 KB |
| Reads xlsx | no (write only) | yes | yes |
| Cell styling (bold, widths, borders) | yes (`fontWeight`, `columns:[{width}]`, README checked) | column widths yes; cell styles are Pro-only | yes |
| Integrity/provenance | npm sha512 | tarball from a non-registry CDN; I recorded sha256 `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8` for `xlsx-0.20.3.tgz` (2,409,319 B) | npm sha512 |

**Pick: write-excel-file 4.1.1**, vendored as the UMD bundle (use a classic `<script>` or wrap it in a
tiny module shim). Justification: InvoiceLens only exports; smallest by 4-14x; MIT; on the normal
registry with integrity hashes; no advisories; styled headers/column widths. Risks: one maintainer
(GitLab-hosted); no xlsx reading (not required); the UMD bundle is the version-matching build
by assumption (UNVERIFIED - its header carries no version string). CSV is trivial to hand-write (RFC 4180,
prepend a UTF-8 BOM for Excel), no library needed. If reading xlsx is ever required, use SheetJS
0.20.3 from the CDN tarball, never npm `xlsx`.

### 2.6 ZIP: fflate 0.8.3 vs JSZip 3.10.2

- fflate 0.8.3 (2026-05-16, MIT, no dependencies): `esm/browser.js` self-contained ES module, 90.9 KB raw /
  22 KB gz; `umd/index.js` minified, 33 KB raw / 12.6 KB gz. Use the **sync API** (`zipSync`, `strToU8`) to avoid
  its blob-worker async path (keeps CSP simple).
- JSZip 3.10.2 (2026-09-08, `(MIT OR GPL-3.0-or-later)`): 97.8 KB raw / 28 KB gz; promise API; the
  dual licence needs an explicit MIT election in notices. Its code is already inside docx's bundle,
  so a standalone copy would duplicate.
- **Pick fflate 0.8.3.** No advisories for either pinned version. (write-excel-file's UMD embeds its own deflate copy; fine.)

### 2.7 Optional preprocessing: OpenCV.js

- `@techstark/opencv-js@5.0.0-release.1` (Apache-2.0, 2026-06-24; the `opencv-js` name on npm is unpublished):
  `dist/opencv.js` single file is **13,298,869 B raw / 3,749,551 B gz**; a custom build with only imgproc
  is possible but needs the Emscripten toolchain (not evaluated).
- **Recommendation: do not ship OpenCV.js.** +13.3 MB in the SW cache would more than double the budget.
  Plain canvas gives: grayscale, contrast stretch, Otsu / Sauvola adaptive threshold, downscale/upscale to
  ~300 DPI equivalent, and projection-profile deskew (rotate by candidate angles in +-5 degrees and maximise row-variance) in
  roughly 3-6 KB of JS. Tesseract/Leptonica also performs its own Otsu binarisation internally.
  Perspective (phone-photo) correction is the one thing OpenCV does better; defer.

## 3. Proposed `vendor/` layout

```
vendor/
  tesseract/
    tesseract.esm.min.js                 (from tesseract.js@7.0.0 dist/)
    worker.min.js                        (dist/)
    tesseract-core-simd-lstm.wasm.js     (tesseract.js-core@7.0.0)
    eng.traineddata.gz                   (@tesseract.js-data/eng@1.0.0, 4.0.0_best_int/)
    LICENSE-tesseract.js, LICENSE-tesseract.js-core (Apache-2.0), tessdata LICENSE (Apache-2.0)
  pdfjs/
    pdf.min.mjs
    pdf.worker.min.mjs                   (pdfjs-dist@6.4.299 build/)
    wasm/openjpeg.wasm  wasm/jbig2.wasm  wasm/qcms_bg.wasm  wasm/LICENSE_*
    standard_fonts/*.pfb  standard_fonts/*.ttf  standard_fonts/LICENSE_*
    iccs/CGATS001Compat-v2-micro.icc  iccs/LICENSE
    LICENSE
  pdf-lib/pdf-lib.esm.min.js  + LICENSE.md        (pdf-lib@1.17.1 dist/)
  docx/index.mjs              + LICENSE           (docx@9.13.0 dist/; minify at vendoring if a build step exists)
  write-excel-file/write-excel-file.min.js + LICENSE   (bundle/)
  fflate/browser.js           + LICENSE           (fflate@0.8.3 esm/browser.js)
  VENDOR.md   (package, version, npm sha512 integrity, file sha256 list)
```

npm sha512 integrity of the pinned tarballs (from `npm view dist.integrity`):
tesseract.js `sha512-exPBkd+z+wM1BuMkx/Bjv43OeLBxhL5kKWsz/9JY+DXcXdiBjiAch0V49QR3oAJqCaL5qURE0vx9Eo+G5YE7mA==`;
tesseract.js-core `sha512-WnNH518NzmbSq9zgTPeoF8c+xmilS8rFIl1YKbk/ptuuc7p6cLNELNuPAzcmsYw450ca6bLa8j3t0VAtq435Vw==`;
pdfjs-dist `sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==`;
pdf-lib `sha512-V/mpyJAoTsN4cnP31vc0wfNA1+p20evqqnap0KLoRUN0Yk/p3wN52DOEsL4oBFcLdb76hlpKPtzJIgo67j/XLw==`;
docx `sha512-MofrvX7rzwCe1xUFXnwneQHzv2p1lIUIDPD01DueOnKGw+TSKxAAcK5Beo69bTyqKUYsX8d49Co03Bcntc60WQ==`;
write-excel-file `sha512-MUnCnNtQrcZek832ZcU24uU0rSphFmKPD1DvIjXOlygVb93CV7Tme6H3jUTkxsMmjB2W7HIzERzjqTi5kui71A==`;
fflate `sha512-tbZNuJrLwGUp3zshBtdy4W+ORxZuIh8a5ilyIEQDC5rY1f3U20JMry0Ll3WBzU58EZKsEuJFXhb5gwv8CsPvgA==`.
Vendoring should fetch with `npm pack <pkg>@<ver>` and verify against these hashes (npm does so for installs).
Do not vendor `.map` files (several MB, see below).

## 4. Offline precache budget (English only)

Cache Storage holds the decoded response body, so the "Cache" column is the raw size of each file as
served (or the `.gz` file size for traineddata). "Transfer" is `gzip -9` size for first install over a server
that compresses (assets already compressed are counted at their own size).

| Group | Files | Cache (bytes) | Transfer gz (bytes) | Basis |
|---|---|---|---|---|
| Tesseract JS | tesseract.esm.min.js, worker.min.js | 174,527 | 44,164 | measured |
| Tesseract core | tesseract-core-simd-lstm.wasm.js | 3,899,472 | 1,462,450 | measured |
| eng data (best_int) | eng.traineddata.gz | 2,952,873 | 2,952,873 | measured |
| **OCR subtotal** | | **7,026,872** | **4,459,487** | |
| pdf.js code | pdf.min.mjs, pdf.worker.min.mjs | 1,723,246 | 506,085 | measured |
| pdf.js assets | 3 wasm, standard fonts, icc | 1,234,194 | 702,707 | measured (fonts 774,339 + wasm 451,391 + icc 8,464) |
| **PDF.js subtotal** | | **2,957,440** | **1,208,792** | |
| pdf-lib | pdf-lib.esm.min.js | 523,417 | 205,996 | measured |
| docx | index.mjs (unminified) | 1,283,711 | 276,093 | measured (minified size would be smaller; UNVERIFIED) |
| write-excel-file | UMD bundle | 70,844 | 19,149 | measured |
| fflate | esm/browser.js | 90,922 | 22,064 | measured |
| **Library subtotal** | | **1,968,894** | **523,302** | |
| **Vendored total** | | **11,953,206 B (about 11.4 MiB)** | **about 6.19 MB** | measured sum |
| App code (js/, css/, html, icons, manifest) | | about 0.3 MB | about 0.1 MB | **estimated, UNVERIFIED** (repo not inspected) |
| **Precache total** | | **about 12.3 MB** | about 6.3 MB | |

Variants: tessdata_fast instead of best_int saves 976,564 B of cache (1,976,309 B gz file) -> about 11.3 MB total.
Tesseract core non-SIMD or relaxedsimd variants would add 3.9 MB each; not included.
Avoided (not shipped): float tessdata_best eng 15.4 MB, `osd.traineddata` 10.5 MB, OpenCV.js 13.3 MB,
pdf.js cmaps 1.7 MB, source maps (pdf.worker.mjs.map alone 5.3 MB), non-lstm tesseract cores (4.7 MB each).

Storage context: 12 MB is well under typical origin quotas on desktop; on iOS Safari the cache is
evictable after about 7 days of non-use for non-installed sites (installed PWAs are exempt - platform
behaviour not tested here). Recommended SW strategy: two cache buckets - `shell-vN` (app code + small libs) installed
eagerly, `ocr-vN` (core, traineddata, pdf.js wasm/fonts) installed in the same `install` step but
versioned independently so that an app-only update does not re-download 10 MB; use `cache.addAll` with
hashed or versioned URLs; wait for `navigator.storage.persist()` to be requested on first successful install.

## 5. Risks

1. **Cache size and install failure**: a 12 MB single-install precache can fail on flaky mobile links
   (one failed request aborts `cache.addAll`). Split the buckets, retry per-file, and let the app run
   with a lazy "download OCR engine" step (OCR assets 7.0 MB) instead of blocking SW activation.
2. **Worker and path plumbing with the service worker (UNVERIFIED in a browser)**: tesseract.js default
   options point at jsDelivr; if any of `workerPath`/`corePath`/`langPath` is omitted, it silently fetches from
   the CDN online and fails offline. The blob-worker wrapper needs absolute URLs; relative paths break.
   Add an offline test (DevTools offline + empty IndexedDB) to CI/checklist; consider `workerBlobURL:false`.
3. **tesseract.js / core version skew**: npm `latest` for `tesseract.js-core` is 6.1.2 but tesseract.js 7.0.0
   requires `^7.0.0`; always take core 7.0.0 explicitly. Mixing 6.x core with 7.x wrapper is untested.
4. **pdf-lib is unmaintained (last release May 2022)**: no known advisories on 1.17.1, but bugs will not be
   fixed upstream. Isolate behind an `export/pdf.js` adapter so jsPDF 4.2.1 UMD can replace it.
5. **WinAnsi-only standard fonts**: OCR output with characters outside WinAnsi (some symbols, ligatures, smart punctuation
   variants) makes pdf-lib throw; sanitise/transliterate before `drawText`.
6. **docx churn and size**: 12 releases in 4 weeks; unminified 1.28 MB. Pin exactly, add a minify step, and
   do not auto-bump.
7. **pdf.js minor releases**: monthly; v6 removed `isEvalSupported` and changed option names (`wasmUrl`) - re-test
   on every bump. Without cmaps, PDFs relying on predefined CJK CMaps render poorly (accepted for English scope).
8. **write-excel-file single maintainer and UMD provenance**: version of the bundled UMD is assumed to match 4.1.1.
   Verify by hashing against a rebuild from the tarball, or vendor the ESM sources plus fflate instead.
9. **CSP requirements**: `script-src 'self' 'wasm-unsafe-eval'`; `worker-src 'self'` (add `blob:` if
   `workerBlobURL` stays true); no `unsafe-eval` needed (all `new Function` occurrences are `globalThis`-guarded fallbacks).
10. **Accuracy/performance numbers for best_int vs fast are UNVERIFIED** (no benchmark was run); decide with the repo corpus.
11. **Browser support for the non-legacy pdf.js 6.x build and WASM SIMD baseline is UNVERIFIED**; legacy build
    (+65 KB raw for pdf.min.mjs, +57 KB for the worker) is the fallback.
12. **Supply chain**: all files were obtained by `npm pack` (and one CDN tarball for evaluation) and only
    inspected, not executed. Re-fetch and verify hashes from section 3 when vendoring; do not copy
    files from the scratch directory.

## 6. Verification record (what was and was not checked)

- Measured: all tarball file sizes, gzip sizes, licences from package.json, advisory lookups, presence
  of bare imports, `isEvalSupported` absence in pdf.js 6.4.299, `Invisible = 3` operator in pdf-lib typings,
  `renderingMode` handling in jsPDF source, tesseract.js option handling by reading source.
- From GitHub API listings (not downloaded, except fast eng): tessdata_best eng 15,400,601 B.
- NOT verified: any runtime behaviour in a browser (SW interception of worker fetches, wasm SIMD
  availability, pdf.js rendering, docx/xlsx output opening in Word/Excel), OCR accuracy/speed, minified
  size of docx, repo app-code size, `write-excel-file` UMD version match, the 15-day-old docx 9.13.0 stability.
- Advisories: npm bulk advisory API reports only `xlsx` (0.18.5) among all checked packages; GitHub
  advisory pages for non-npm routes (SheetJS CDN builds) were not checked individually.
