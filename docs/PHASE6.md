# Phase 6: settings, offline PWA, quality audit and release readiness

The measured audit is in **`docs/FINAL_QA.md`** (tests executed, tools not available, numbers, deviations, residual risks). This file describes what was built.

## Settings (`#/settings/<section>`)

Six sections, every control real and stated: **General** (warn before leaving with unsaved edits; privacy facts; reset), **Recognition (OCR)** (enhanced-pass automatic/never; pages per PDF 10/25/50; page image size 4/8/12 MP), **Export defaults** (format, PDF mode, review notes, page text, text layer, combined-PDF labels), **Storage & offline** (saved-project usage, persistent-storage request, delete all local data, offline files status/download/remove, install), **Appearance** (theme, motion), **Processing** (fixed one-at-a-time queue stated as such; project autosave delay).

- Only preferences are stored (`localStorage` key `invoicelens.settings`, versioned, allow-list validated on every load; junk, partial or newer-version data falls back to defaults; the key is removed when everything is default; blocked storage still applies the choice for the session and says it was not saved). No file names or document content.
- English only; there is no language switcher (asserted).
- Effects are tested end to end: the PDF page limit refuses a 12-page PDF at 10 and accepts it at 25; "Never" skips the enhanced OCR pass on the low-contrast fixture; export defaults pre-set the dialog; motion/theme change the page; the unsaved-edits prompt can be switched off; the autosave delay is honoured.

## PWA

- `manifest.webmanifest`, icons (192, 512, maskable 512, apple-touch 180), theme colours, `sw.js`.
- `scripts/build-pwa.js` generates `sw.js` (from `scripts/sw.template.js`) and `js/pwa-manifest.js` from the files that exist, with content-hash versions: `npm run build:pwa` after changing any app file; `npm run check:pwa` (and a unit test) fail when stale.
- **Two caches:** a shell cache (app files, version changes with every app change) and a vendor cache (OCR/PDF/export libraries, version changes only when `vendor/` changes), so an app update does not re-download 11.5 MB.
- The worker answers only same-origin GET requests for an allow-list; user documents never pass through it (verified: no document name in any cache; no `blob:`/IndexedDB/FileReader in the worker code).
- **Updates wait for the user**: no automatic `skipWaiting`; the page shows "Reload to update"; the old cache is deleted on activation; IndexedDB projects are unaffected (tested).
- Offline conditions, install and limits: see `docs/FINAL_QA.md` section 8.

## Release-readiness cleanup

Removed placeholder views and "Phase N" wording from the UI, the dead `phase-note`, `.spinner`/`.soon` CSS and stale comments; the hero text now says "Google Sheets (CSV)" because that is what is offered (no Sheets API, no OAuth).

## Handoff

The project is feature-complete for the supported scope. Not done and not started: deployment and hosting headers, a bundling/compression step, Firefox/WebKit verification, real-device testing, real-document accuracy measurement, non-English OCR. See "Not verified" in `docs/FINAL_QA.md`.
