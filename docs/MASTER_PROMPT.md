# InvoiceLens — Claude Code Implementation Master Prompt

You are implementing **InvoiceLens**, a free, privacy-first, browser-based document-to-editable-file converter. This is an **implementation task**, not an invitation to redesign the app from scratch.

## 0. Approved visual reference — mandatory

**The user approved IMAGE 1: the FIRST light-and-dark UI showcase in the preceding ChatGPT design discussion.** The user will attach that specific image to your Claude Code conversation or place it in the repository as a design reference. **Inspect the actual approved image before writing UI code.** If you cannot access it, do not invent its appearance or claim visual fidelity; ask for that one missing reference before implementing visual components.

Use the approved image as the **visual source of truth** for light mode, dark mode, the overall workspace, navigation, upload, editor, batch processing, saved projects, settings, and responsive layouts. The reference shows a restrained modern productivity application with compact left navigation on desktop, crisp typography, minimal surfaces, rounded but not bulbous controls, orderly spacing, subtle borders/shadows, restrained blue accent, and serious document-centric styling.

**Follow the reference closely rather than generating a generic SaaS dashboard.** Match, as closely as practical:
- navigation position, hierarchy, widths, and selected states;
- header, toolbars, breadcrumbs, actions, and control density;
- panel arrangement, white space, proportions, borders, radii, and shadows;
- fonts, weights, visual rhythm, icon style, document preview treatment;
- status colors, upload dropzone, cards, forms, queues, and tables;
- both full **light and dark themes**, each designed intentionally;
- tablet portrait and phone layouts shown in the reference.

Do **not** add oversized buttons, large empty decorative areas, dramatic gradients, glassmorphism, neon/glows, heavy animations, giant sidebars, random icons, or mismatched screens. Do not bolt new CSS on top of an old design: audit and remove obsolete/conflicting styles as you go. A screenshot is a direction, not a guaranteed pixel-perfect functional specification; preserve necessary accessibility and usable responsiveness.

## 1. Mandatory Claude Code skills, in this order

Before touching the implementation:
1. Invoke **`/caveman`** to establish a token-efficient, disciplined working strategy; use it throughout the project.
2. Invoke **`/architect`** to review requirements, module boundaries, browser-only limitations, dependencies, performance, privacy, and incremental phase plan.
3. Invoke **`/uiuxpro`** to analyze the attached approved reference and establish design tokens, responsive layout rules, interactions, and a visual acceptance checklist.

If a skill command is unavailable, inspect the project's configured skills and determine the actual matching command or skill path. State plainly what was found and what was not available; **do not pretend to have run a skill**. Do not silently substitute unrelated skills. Keep skill analysis concise and immediately actionable.

## 2. Non-negotiable tech and product constraints

- Develop **locally first**. Do not move work to cloud coding environments or deploy without explicit instruction.
- **HTML5 + CSS3 + vanilla modern JavaScript only** for app code. Modular ES modules are encouraged. No React, Vue, Angular, Svelte, Next.js, TypeScript, Tailwind, or heavy SPA frameworks.
- No backend, hosted OCR APIs, server uploads, account system, user registration, authentication, or cloud database.
- Local browser **IndexedDB** is allowed and encouraged for optional saved projects. This is device-local storage, not a hosted database. Preferences can use localStorage. No sensitive document contents in localStorage.
- Offline-first installable PWA using a service worker and locally cached required assets/language data, after initial setup. Clearly handle first-time offline unavailability.
- No paid services, payment features, advertisements, artificial conversion quotas, or subscriptions.
- Interface languages: **English and Macedonian** (including correct Cyrillic UI rendering). Support OCR Latin and Cyrillic language packs where available.
- Inputs: JPEG/JPG, PNG, WebP, PDF (text-native and scanned; multi-page where feasible).
- Document categories: invoices, receipts, tables, general printed documents.
- Outputs: **PDF, DOCX, XLSX**, and **Google Sheets-compatible** XLSX/CSV or copy/paste table. **Do not claim direct saving to Google Sheets** without OAuth, which is out of scope.
- Preserve two meaningful export modes: **original appearance** (faithful archival visual output, especially PDF) and **structured editable** (reconstructed content with realistic limitations). Do not promise pixel-perfect editable DOCX or XLSX from arbitrary scans.
- All conversion and recognition runs client-side. Never transmit document contents to telemetry, third parties, or remote services.

Lightweight, browser-compatible libraries are permitted for specialized tasks, such as Tesseract.js for OCR, PDF.js for PDF parsing/rendering, a reputable PDF generator, docx for Word, and SheetJS or another well-maintained XLSX solution. Select and pin versions deliberately, check licensing and browser compatibility, and use local vendor assets where needed. No CDN required during normal offline operation.

## 3. Primary user flows

### A. Fast single-file conversion
1. Open app and immediately see the **Convert** upload workspace — no onboarding or login.
2. Drop a file, choose a file, or paste an image where supported.
3. Validate format/size and show thumbnail, page count, and clear errors.
4. For text PDFs, prefer direct text extraction; for scanned pages/images, preprocess and run OCR in Web Workers.
5. Automatically infer document type with an **editable classification** and show any uncertainty.
6. Open an editor showing **source document** alongside **extracted/structured content**.
7. Let user fix text, metadata, tables, values, and page order; highlight recognition uncertainties and arithmetic mismatches without guessing.
8. Show an export preview and allow one or more output formats and export modes.
9. Download client-generated files with sensible filenames, truthful success/error status, and no remote upload.

### B. Document editor
- Desktop: collapsible file/page rail, large page canvas, right editing inspector; make proportions and density follow IMAGE 1 closely.
- Support zoom, fit page, rotate, page navigation, selected OCR region highlight when coordinates exist, undo/redo, keyboard shortcuts, and inline editing.
- Structured invoice fields: supplier, customer, invoice number, dates, currency, rows, quantities, amounts, tax, totals, notes. Other document types use appropriate generic text/table models.
- Preserve raw OCR output + confidence/coordinates separately from the corrected user document model.
- Validate amounts without silently changing financial values; ambiguous values remain unconfirmed.
- Keep export action accessible and contextual.

### C. Batch processing
- Add multiple files to a queue, show statuses: queued, processing, needs review, completed, failed, cancelled.
- Use bounded concurrency so mobile devices don't freeze. Provide pause, resume, retry, remove, multi-select, and meaningful progress stages. Never invent percentage precision.
- Export selected files individually, as a ZIP, combined PDF when appropriate, or consolidated XLSX summary with source-file tracking.
- Preserve partially completed items and corrections when saved locally; interrupted OCR may need to restart.

### D. Saved projects (optional, local)
- Explicit **Save locally** / **Resume** workflows with descriptive project names and timestamps.
- Store Blob inputs, thumbnails where practical, extracted data, edits, and safe metadata in IndexedDB.
- Show storage use estimates, quota errors, delete confirmation, and an explicit **Delete all local data** action.
- Offer portable project backup/restore (versioned schema, safe import validation, no executable data).
- Explain that browser storage can be cleared and is not a secure encrypted archive. Do not quietly save sensitive documents forever.

### E. Settings
- Light / Dark / System theme selector with accessible contrast; both modes must closely match approved visual reference.
- English / Macedonian, OCR languages, conversion mode defaults, export defaults, processing preferences, local storage management, and reduced-motion preference.
- Working, persisted controls; no decorative settings switches.

## 4. Screens that must be implemented and visually verified

1. **Convert / Upload** — primary landing screen and states: empty, drag-over, validation error, uploaded, processing.
2. **Editor** — source preview + extracted fields/table/text, selected/warning states, original appearance vs structured content.
3. **Batch Processing** — actionable compact file table/list with status, progress, review and export controls.
4. **Saved Projects** — local project cards or rows with resume, rename, export backup, delete, storage context.
5. **Export dialog / sheet** — clear format and mode selection, sensible compatibility notes, estimated scope, real export states.
6. **Settings** — coherent sections with fully functional preferences and privacy controls.
7. **Responsive views** — desktop, laptop, **portrait tablet**, and mobile; preserve design identity and functionality. On tablet/mobile use compact navigation and appropriate tabs rather than a permanently occupying desktop sidebar.

No dead buttons, fake data masquerading as live OCR, or static screens that look finished but lack behavior. Clearly mark any demonstrative placeholders during development and remove/replace before release.

## 5. Suggested local architecture

Use well-separated ES modules, for example:

```text
invoicelens/
  index.html
  manifest.webmanifest
  service-worker.js
  css/
    tokens.css
    base.css
    layout.css
    components.css
    responsive.css
  js/
    app.js
    routing.js
    state.js
    upload.js
    preview.js
    image-processing.js
    ocr.js
    pdf-reader.js
    classify.js
    document-model.js
    editor.js
    validation.js
    batch.js
    persistence.js
    settings.js
    i18n.js
    exporters/
      pdf.js
      docx.js
      xlsx.js
      sheets-compatible.js
  locales/en.json
  locales/mk.json
  assets/
  vendor/
  tests/
```

Adjust based on `/architect` findings. Prefer simple modules and explicit state transitions; avoid one monolithic JS file or CSS specificity wars. Use semantic HTML, robust focus states, screen-reader support, reduced motion, and graceful errors. Prevent PDF and import content from executing scripts; treat all recognized text and project data as untrusted.

## 6. Phased development — small, verifiable increments

**Rule: each phase must produce a working increment, be tested, visually checked against IMAGE 1 in both themes, and documented before proceeding.** Do not write all screens in one massive pass.

### Phase 0 — Repository inspection and design capture
- Inspect local project files, Git status, and existing implementation before changes. Do not overwrite user work.
- Load and analyze the approved IMAGE 1, identify design tokens, panel measurements and responsive rules as precisely as the image permits.
- Run required skills and write a short execution checklist, risks, and acceptance criteria.
- If project is empty, establish clean vanilla JS structure and local dev workflow.

### Phase 1 — Visual foundation + Convert upload screen
- Build responsive shell, icons, typography, theme tokens, toggle, top header/sidebar/mobile navigation.
- Implement real file drag/drop, picker and validation, thumbnails, file metadata, errors, keyboard accessibility.
- Match approved light/dark upload screens visually. Deliver screenshots at desktop/tablet/mobile widths.

### Phase 2 — Image/PDF intake + OCR
- Real PDF text extraction and scanned PDF rendering, image preprocessing, OCR workers and language packs.
- Recognize input text, with honest progress/error UI and automatic type suggestions.
- Test actual sample input, including Macedonian Cyrillic and multi-page PDF.

### Phase 3 — Editor workspace
- Document model, field/table/text editor, source preview, OCR coordinates/highlights, warnings, validation, undo/redo.
- Build editor UI to follow approved IMAGE 1, with responsive tablet/mobile behavior.

### Phase 4 — Export workflows
- Functional PDF/DOCX/XLSX generation, Sheets-compatible export, original-image PDF mode and structured content mode.
- Design export modal/sheet precisely in the approved design language.
- Test opened file contents and values, not just download initiation.

### Phase 5 — Batch + local projects
- Queue with bounded processing, bulk controls, ZIP/combined export where practical.
- IndexedDB saved projects, optional autosave only when explicitly enabled, import/export project backups, storage controls.
- Complete batch and saved-project screens in both themes.

### Phase 6 — Settings, localization, offline PWA, final QA
- All settings functional, EN/MK UI, reliable persistence.
- Cache versioned application/OCR assets for offline use; provide install flow and fallbacks.
- Accessibility, performance, visual regression, error-state, browser and responsive QA.
- Resolve problems discovered; remove debug placeholders and unused code.

**Source control:** If the project is already a Git repository, make focused commits at completed checkpoints; follow existing branch and remote rules. **Do not assume a branch name, force-push, or push/deploy without user authorization.** If no repository exists, work locally and report setup needed.

## 7. Visual fidelity requirements — acceptance gate

For every visible screen:
- Compare implementation with IMAGE 1 side by side at matching viewport dimensions.
- Check BOTH light and dark variants, including selected navigation, toolbars, button scale, spacing, font hierarchy, borders, corners, cards, tables, document previews, icons and progress indicators.
- Verify tablet portrait and mobile explicitly; avoid horizontal overflow and oversized desktop controls.
- Use a shared token system so UI doesn't drift between screens.
- If reference art contains impossible/nonfunctional UI, adapt responsibly while preserving the same aesthetic.
- Prefer **small, intentional refinements** over visual invention. No redesigns without approval.

## 8. Completion and reporting rules

- Start by stating which mandatory skills were actually loaded, what reference image was inspected, and the concise phase plan.
- Implement working code, not just propose code.
- At the end of each phase: list files changed, summarize working behavior, run tests, report visual differences remaining, and specify any limitations honestly.
- Do not claim OCR accuracy, export fidelity, offline readiness, passing tests, commits, pushes, or completed phases without evidence.
- Keep discussions short and token-efficient, but preserve essential decisions in project documentation so work can be resumed.
- Do not publish or send customer invoices externally.

**Start with Phase 0, then Phase 1.** Continue incrementally only after each phase's functional and visual checks. The approved IMAGE 1 is the design baseline for the full app.
