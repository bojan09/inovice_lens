# Phase 3: editable document workspace and validation

Scope: open a recognized file in an editor (page rail, original viewer, inspector with Extracted Data / Table / Text), edit values with undo/redo, validate with the existing money/validation core, show where each value came from on the page. English only. Export is Phase 4 and is visible but disabled. Edits live in memory for the browser session only (persistence is Phase 5).

## Run

```bash
npm test                 # unit tests (pure model, history, extraction, validation, workspace)
npm run test:browser     # Playwright: real pdf.js + Tesseract feeding the editor, Chromium
```

Open a file on Convert, wait for "Recognized" / "Needs review", press **Review & edit** (route `#/editor/<fileId>`).

## Architecture

| Layer | Files | Notes |
|---|---|---|
| Document model v1 (`invoicelens.document`) | `js/doc/model.js` | Pure, immutable updaters. Every value is a field `{value, extracted, ref, note, noteLevel}`; `edited == value !== extracted`. Money stays **text** until validation. |
| Source separation | frozen `result` (Phase 2) | Raw OCR / PDF items are deep-frozen when the editor opens and referenced by `ref = {page, items[]}`. The serialised document (`toPlain`) contains no raw items. |
| Extraction (heuristic, English) | `js/doc/extract.js`, `js/doc/dates.js`, `js/recognition/text.js` (`itemsToLineObjects`) | Labels -> values with refs to the raw words. Unclear values stay empty or carry a note. Never recomputes anything. |
| Validation | `js/doc/validate.js` on `js/validation.js` + `js/money.js` | Integer minor units, exact rational maths, 1-minor-unit rounding tolerance = warning. No auto-fix. Adds unreadable/ambiguous amounts, currency mismatches, extraction notes, low OCR confidence, recognition review reasons. |
| History | `js/doc/history.js` | Snapshots of immutable docs; typing in one field within 1 s is one step; limit 200. |
| Session store | `js/doc/workspace.js` | One document per recognized file for the page session; re-recognition rules below. |
| Geometry | `js/doc/geometry.js` | Normalized rects, rotation maths for highlights. |
| UI | `js/ui/editor/*`, `css/editor.css`, `#view-editor` | rail, viewer, fields, table, text, review panel, preview, panes. |

### Behaviour worth knowing

- **Source regions**: "Show on page" (target icon) highlights the raw words a value came from, at any zoom/rotation. Typed values or values without a recorded region say so (status line; toast on small screens). A toggle draws every recognized word box.
- **Validation is truthful**: a total that disagrees with subtotal + tax is an error on the total field, with both numbers. The typed value is never replaced. Ambiguous amounts ("1,234") and unreadable ones are reported, not guessed. Ambiguous dates ("03/04/2026") keep the printed text and ask for YYYY-MM-DD. "$" alone is read as USD **with a warning**.
- **Receipts** do not require an invoice number or customer. A missing currency/date is still an error because it is genuinely unknown.
- **Document type** can change in the editor or on Convert; structured parts are re-extracted as one undoable step (page text and page order are kept).
- **Re-recognition** (Rotate/Retry on Convert): an unedited document is rebuilt silently; with edits, the new result is held back and the editor asks (use new = discards edits, or keep mine).
- **Page order / rotation** are model state (undoable) for later export; "Add file" links back to Convert (no in-editor page import yet).
- **Unsaved indicator**: "No changes yet" / "Edited. Kept for this session only, not saved to disk"; `beforeunload` warns only when real edits exist; the file card shows an "Edited" chip.
- **Layout**: desktop = rail 104 px + viewer + inspector 340 px (matches the reference). Below 1024 px one pane at a time: Original / Edit / Preview (Preview is a read-only summary of the corrected values). Table rows become cards in narrow containers. The review banner stays visible while scrolling on small screens.
- **Keyboard**: tabs use arrows/Home/End; table cells: Up/Down/Enter move between rows, Ctrl+Enter adds a row; Ctrl/Cmd+Z, Ctrl+Shift+Z / Ctrl+Y replace the browser's field-level undo.

## Verified results

| Check | Result |
|---|---|
| `npm test` | 174 pass / 0 fail (127 before + 47 new: lines/offsets, dates, geometry, model, history, extraction, validation, workspace, router) |
| `npm run test:browser` | 106 pass / 0 fail (69 before + 27 editor + 10 screenshot captures) |
| Real data path | real Tesseract + pdf.js: invoice PNG, receipt JPG, table PNG, text PDF (2 pp), scanned 2-page PDF all open with extracted fields/rows/cells |
| Source integrity | recognized text on the Convert card is identical before/after edits; source result is frozen; serialised doc has no raw items |
| Highlights | position checked at two zooms and after a 90 degree view rotation; on the text PDF the box covers printed ink (>20 dark px) |
| Accessibility | axe-core: 0 violations on Extracted Data / Table / Text (+ Original / Preview on small screens), light+dark, desktop/390/320, with an error and an ambiguity showing. Two real defects found by axe/tests and fixed: heading order, review bar hidden under the mobile bottom nav |
| Layout | rail 104 px, inspector 340 px at 1440; no horizontal overflow at 1280/768/390/320; touch controls >= 44 px at 390 |
| Privacy | editing and page rendering make only same-origin GETs; no console/CSP errors |
| Other bug found by testing | the Table panel was visible on first open (fixed, asserted) |

Screenshots: `docs/phase3/screenshots/` (5 viewports x light/dark x original+highlight, warning state, table, text, preview).

## Measured on a SYNTHETIC corpus (follow-up to Phase 3)

No real documents were available, so `corpus/make_corpus.py` generates 34 invented documents (24 invoices in 4 layouts/fonts, 10 receipts; clean renders and phone-photo simulations with tilt, shadow, blur, noise, JPEG; varied labels, date formats, currencies, thousands separators, 1-6 rows, fractional quantities). Truth is written from the generator data, never from OCR; where a page prints no currency, truth currency is `null`. The documents are git-ignored (regenerate with `python3 -I corpus/make_corpus.py`); truth files are committed (`corpus/truth/syn-*.json`, `"source": "synthetic"`).

Run: `python3 -I corpus/make_corpus.py && node tests/eval/predict.mjs && npm run eval -- corpus/predictions --split tune` (use `--split heldout` for the held-out set). `predict.mjs` drives the real app (pdf.js, Tesseract, editor extraction) and reads the values the editor shows, with no edits.

| | tune (24 docs) before | tune after | held-out (10 docs) before | held-out after |
|---|---|---|---|---|
| micro precision | 98.5% | 98.9% | 97.9% | 98.7% |
| micro recall | 76.2% | 98.6% | 81.5% | 95.2% |
| micro F1 | 85.9% | 98.7% | 89.0% | 96.9% |
| exact-match docs | 25% | 75% | 20% | 70% |
| document type suggestion | 34/34 correct (whole corpus) | | | |
| OCR text CER / WER | 11.5% / 8.7% | 9.6% / 6.4% | 9.3% / 7.8% | 7.9% / 6.3% |

What was wrong and fixed (found ONLY on the tune split; the held-out split was looked at as aggregate numbers, never per document):
- **Tilted photos split lines** (a 1.8 degree tilt moves a baseline by more than a text height across the page): line grouping now estimates the tilt from neighbouring words and groups along it. Raw coordinates are untouched. This also changes the normalized text shown on Convert (for tilted pages only).
- **"13.48 USD" / "USD 13.48"** line-item amounts were not recognised as amounts: a bare currency code now joins its neighbouring decimal number.
- **"No. 2025/071"** and **"#69621"** invoice numbers were missed (the "#" is kept, it is part of the printed number).
- **The corpus itself was wrong** for pages that print no currency at all (truth said EUR); truth is now `null` there. Without this, the first round overstated the currency error.

What the numbers do NOT say:
- This is one generator, written by the same author as the extractor. 34 documents; one run each (OCR is deterministic here, but there is no variance estimate). The held-out split is 10 documents and was seen in aggregate before tuning. Treat 96.9% held-out F1 as "robust to this generator's variations", **not** as real-world accuracy. Real invoices (stamps, logos, multi-column layouts, other fonts, non-English text, crumpled paper) will score lower. Real-world accuracy remains UNAVAILABLE.
- Remaining misses are mostly OCR errors (a bold "Due" read as "DUsJR" hides a total; a trailing "." after a supplier name; quantity "1.5" read oddly). They surface as empty fields or review warnings, not silently wrong amounts: precision stays above 98%.
- Receipts are scored without qty/unit price (not extracted by design).

## Known limitations (read before relying on it)

- Extraction is **heuristic and tuned on synthetic fixtures** (invented invoice, receipt, table). `corpus/` is still empty, so real-document accuracy is **unavailable**. Expect misses on multi-line descriptions, amounts split across lines, tax tables with several rates, non-English labels, right-to-left layouts.
- Supplier and customer are guesses (first block on the page, text under "Bill to") and are labelled as such.
- A single currency per document; one tax rate; no discounts/shipping lines; the "table" type is a column-clustering approximation (cells are plain text).
- Editing the Text tab does **not** update fields or the table, and vice versa (stated in the UI).
- Highlights only exist where the engine gave coordinates; PDF text coordinates follow pdf.js (verified on one text PDF); OCR coordinates follow the recognized bitmap (rotation handled). Large zoom (>150%) is magnified from a 4 MP render, so it softens.
- No date picker (a text field with `YYYY-MM-DD` hint) and no drag-and-drop page reorder (buttons instead).
- Edits are lost on reload. No autosave, no export (Phases 4 and 5). Chromium only; no real device test.
- Tablet/mobile deviate from the reference: panes are Original / Edit / Preview (reference tablet shows Original / Edit / Table).

## Handoff to Phase 4

- Export should read `toPlain(doc)` plus `validateDocument` output; page order = `doc.pages`, text = `doc.text[source].value`, rows = `doc.items` / `doc.grid`.
- Money is text: parse with `readAmount` (`js/doc/validate.js`) / `parseAmount`; never export floats.
- The disabled Export button (`.ed-bar .btn-primary`) and the Convert "Export — coming in Phase 4" button are the two entry points to wire.
