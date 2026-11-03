# InvoiceLens — Execution Plan

Source of truth for scope: `docs/MASTER_PROMPT.md`. UI baseline: `docs/reference/approved-ui.webp`.
This plan **reorders** the master prompt: **measurement first, UI second**, and every phase ends with independent evidence.

## Rewritten prompt (governing rules)

Implement **InvoiceLens** (browser-only, vanilla JS, local-first; constraints unchanged from the master prompt, EXCEPT: **English only**. No Macedonian, no Cyrillic, no language switcher, `eng` OCR data only. This overrides the master prompt). Use the approved image as the UI baseline.

### Phase 0 additions (before any UI)
1. `corpus/` is OPTIONAL. The user will test with sample documents once the app is built. The eval harness must run cleanly with an empty corpus and only score documents that have a hand-keyed answer file.
2. `corpus/truth/*.json`: hand-keyed answer keys (supplier, number, dates, currency, rows, totals), only if/when the user provides documents. Never auto-generate truth from OCR output.
3. `tests/eval/`: character and word error rate, per-field precision and recall, held-out split. Output a table.

### Engineering rules
- Money = integer minor units + currency. Parse numbers by detected locale (`1.234,56` vs `1,234.56`); flag ambiguity, never guess.
- Needs-review triggers: measured OCR confidence below threshold, or a broken arithmetic invariant (rows = subtotal, subtotal + tax = total). Never auto-correct amounts.
- Keep raw Tesseract TSV and PDF.js text items separate from the user-corrected model.
- Pick each preprocessing step and OCR model (`best` vs `fast`) only from measured error rates on the corpus.
- Strict CSP. Treat all input files as hostile.

### Independent verification (a phase is not done without these)
- Field-level scores on held-out documents.
- Each export reopened by LibreOffice headless, `pdftotext`, `qpdf --check`, and an independent XLSX reader; values compared to the model.
- Playwright (Chromium, Firefox, WebKit) with a network log showing no document data leaves the device, plus an offline-reload test.
- pixelmatch against crops of the approved image, both themes, desktop, tablet, phone, with stated tolerances.
- axe-core and Lighthouse (accessibility, PWA, performance) on a throttled mobile profile.
- Report actual numbers. Where something is unverified, say so. Do not claim accuracy.

Then proceed with Phases 1–6 as in the master prompt, each ending with its evidence.

## Phase 0 parallel work (independent, disjoint files)

| Agent | Scope | Writes only |
|---|---|---|
| A. Design capture | Run `ui-ux-pro-max`, analyse the reference, define tokens + acceptance checklist | `docs/design-tokens.md`, `docs/visual-checklist.md`, `css/tokens.css` |
| B. Eval + money core | Eval harness, locale-aware money parser, validators, property tests | `tests/eval/**`, `corpus/README.md`, `corpus/truth/schema.json`, `js/money.js`, `js/validation.js`, `tests/unit/**` |
| C. Dependency vetting | Pick and pin libs, licence and size check, vendor/offline plan | `docs/dependencies.md` |

## Open decisions (need user)
- Git: DECIDED. Own repo in `invoice_lens`, branch `main`, remote `https://github.com/bojan09/inovice_lens.git`. User authorised commit and push.
- Scope: English only (user decision, overrides master prompt).
- Corpus: optional; user tests with sample documents after build.
