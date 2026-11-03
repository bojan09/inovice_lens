# Phase 5: batch conversion and optional local saved projects

Scope: a real batch screen over the recognition queue, selected-file / combined exports, and OPT-IN local projects stored in IndexedDB with autosave only after consent, portable project files, deletion, quota handling and a versioned schema. English only. Settings, the offline PWA and the release audit are Phase 6.

## Run

```bash
npm test                 # includes tests/unit/{projects,projects-flow}.test.js and the new export/session tests
npm run test:browser     # includes tests/browser/projects.e2e.js (batch, projects, storage, import, migration, a11y)
```

## What it does

### Batch Processing (`#/batch`)
- Five counters (Total, Completed, Needs review, Failed, In queue) read from the **real** recognition session. A file table with type chip, status chip, progress and actions. Progress bars exist **only while a file is actually being processed**; finished files show no bar, failed files show the real error. No estimated or fake percentages.
- Controls act on the real queue: **Pause / Resume queue**, **Retry failed**, **Cancel all**, per-file Review / Retry / Cancel / Remove, select-all and a selection bar (Export…, Retry, Cancel, Remove).
- **Exact semantics** (stated on the page): Pause stops NEW files from starting; the file being recognized finishes first, because a running OCR job cannot be suspended. Cancel terminates the OCR worker immediately (Phase 2 behaviour). Concurrency stays 1 (one wasm OCR worker; bounded to keep phones responsive).
- **Error isolation**: one damaged or password-protected file fails alone; the rest continue; "Retry failed" re-queues only failed/cancelled files.

### Exports of several files
- From Batch (selection) or Convert, the export dialog preselects the files. Choices: one file per document in a **ZIP**, or **one file**: **combined PDF** (each page labelled with its source file, optional), **consolidated workbook** (sheets Documents / Line items / Review notes, every row has a Source file column, amounts numeric, nothing summed across currencies, a warning lists mixed currencies) or **consolidated CSV**. Word cannot be combined; the reason is shown.

### Saved Projects (`#/projects`) and autosave
- **Consent first**: nothing is written to the browser until the user ticks the consent box in the Save dialog (the database is not even created before that; verified). The dialog also offers "As a file to download" (nothing stored).
- Stored (IndexedDB `invoicelens`): original file bytes, recognition result, corrected document, rotation/type choices, small thumbnails. Never uploaded. Autosave is debounced, serialised and **atomic** (one transaction): a failed write leaves the previous save intact and the UI reports the failure; "Saved HH:MM" is shown only after the commit.
- **Resume** re-opens the originals through the normal intake checks and injects the saved result and edits: **OCR does not run again** (verified by watching network requests). Files that were queued or running when the project was saved are processed again (interrupted-session recovery). Restored edits are not an undo step.
- **Rename**, **Open** (asks before replacing the current workspace), **Export** (portable file), **Delete** (confirmation dialog, cancel keeps it) and **Delete all local data** (confirmation). Deleting the open project detaches autosave. The Projects page shows what is stored and the browser's storage estimate.
- **Portable project file** (`*.invoicelens.zip`): `manifest.json` + the originals. Import treats the archive as untrusted: size limits before inflating, strict manifest validation, path-traversal rejection, size/hash-free but size-checked members, every original re-validated by intake on open. Verified: round trip into a brand-new browser profile, plus garbage ZIP, path traversal and wrong-format files refused with a readable reason.
- **Quota**: before saving, `navigator.storage.estimate()` is consulted: blocked if it cannot fit, warned above 80% full. A `QuotaExceededError` during the write rolls everything back and is shown as "no space left"; the project is not half-created. Best-effort `storage.persist()` is requested after consent and the result is reported (the browser may evict non-persistent data under pressure).
- **Schema versioning**: records carry `schemaVersion`; `DB_VERSION` upgrade hook creates stores; migrations run on read (a v0 record is upgraded in the browser test); data written by a NEWER version is listed as "Cannot open … newer version" and never reinterpreted.

## Verified results

| Check | Result |
|---|---|
| `npm test` | 226 pass / 0 fail / 1 intentional skip (corpus-empty test skips while synthetic truth exists) |
| `npm run test:browser` | 149 pass / 0 fail (125 before + 16 projects/batch + 8 captures) |
| Queue | counts match the real queue; broken file isolated; Retry failed touches only it; Pause: no new file starts while the running one completes; Resume completes all; Cancel of a running OCR file ends in `cancelled` and the next file proceeds |
| Combined exports | pdfinfo/pdftotext (page sum, source labels, unselected file absent), openpyxl (Documents rows, numeric amounts, every line item has a source), CSV BOM/headers; Word combine disabled with a reason |
| Persistence | database absent before consent; consent enforced; saved status only after commit; real thumbnail; reload + resume without any Tesseract request; edits intact; "saved edits" not shown as unsaved; deletion leaves all four stores empty |
| Large file | an ~8.8 MB original is stored and returned byte-for-byte (same size) after reload |
| Low storage | injected `QuotaExceededError`: error toast, nothing saved, no half project; estimate near full: save blocked with a message; at 85% full: warning, saving allowed |
| Import | round trip in a fresh profile (no OCR when opened); garbage, traversal and wrong-format archives refused |
| Migration | legacy v0 record opens; schema 99 record shown as unreadable, Open disabled |
| Accessibility | axe-core 0 violations on Batch (with selection), Save dialog (both modes), Projects (empty and with a card), delete dialog; light/dark; desktop, 390, 320; touch targets >= 44 px (checkbox targets enlarged after the test found 24 px) |
| Privacy | only same-origin GETs while saving/exporting/deleting; no console errors; no document data in localStorage |
| Defects found by testing and fixed | dark-theme danger button contrast; 24 px checkbox targets on mobile; failure text squeezed into a 44 px column on mobile (screenshot review); stale test expectations from earlier phases |

Screenshots: `docs/phase5/screenshots/`.

## Known limitations

- **Pause is not instant**: it takes effect after the current file. Cancel is instant but discards that file's progress. There is still **one** recognition at a time; a large batch is sequential (about 3-6 s per page on the test machine; unmeasured on phones).
- **A closed tab loses the workspace unless a project is saved.** "Autosave" only exists for a project the user created; there is no hidden saving. Without persistence granted, the browser may evict stored projects under storage pressure.
- Opening a project **replaces** the workspace (confirmed first); there is no multi-project workspace and no merge. Files already open elsewhere are not added to a project automatically except through autosave of the open project.
- The portable file is not encrypted or signed, and not integrity-hashed beyond size checks and ZIP CRC. Anyone with the file can read the documents inside; store it like the originals.
- Combined PDF stamps a small label near the bottom edge of each page (can be switched off); consolidated workbooks do not convert or add currencies; per-file option sets are not supported in a multi-file export.
- Thumbnails are generated for the first page only; imported projects without a preview show an icon until reopened.
- Tested in Chromium only. IndexedDB behaviour in Safari private mode, Firefox, and on low-storage phones was **not tested**; the UI reports an unavailable database instead of failing silently, but that path was only simulated.
- `storage.estimate()` is an estimate (browsers round and cap it); the real guard is the honest handling of a failed write.

## Handoff to Phase 6

- Settings can expose: concurrency (currently fixed 1), autosave debounce, default export options, "delete all local data" (already on the Projects page), storage/persistence status (`js/projects/space.js`).
- Offline/PWA: the app shell, vendored libraries (~12 MB) and the OCR data must be precached; IndexedDB data is independent of the service worker cache.
