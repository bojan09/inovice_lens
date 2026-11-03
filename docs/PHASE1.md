# Phase 1: Visual foundation + functional Convert/upload

Scope: app shell, Convert landing page, real file intake, light/dark/system theming, responsive layouts. No OCR, no conversion, no export (those are Phases 2 to 4). English only.

## Run

```bash
npm ci
npm run serve          # http://127.0.0.1:5173/  (dependency-free static server, no framework)
npm test               # unit + Phase 0 tests (node:test)
npm run test:browser   # Playwright + axe-core, Chromium (needs Playwright; see Tooling)
```

## What exists

| Area | Files |
|---|---|
| Shell, routes, drawer, bottom nav | `index.html`, `css/layout.css`, `js/router.js`, `js/ui/nav.js` |
| Convert page, files panel, coming-soon views | `css/convert.css`, `index.html` |
| Components (buttons, chips, menu, toasts) | `css/components.css`, `js/ui/toast.js`, `js/ui/themeMenu.js` |
| Tokens (unchanged except 4 file-type colours) | `css/tokens.css`, `css/base.css` |
| Intake validation (pure, no DOM) | `js/intake.js` |
| Session state + object-URL lifecycle | `js/store.js`, `js/ui/fileList.js`, `js/ui/intakeUi.js` |
| Theme preference | `js/theme.js`, `js/theme-init.js` (sync, pre-paint), `js/ui/themeMenu.js` |
| Storage meter | `js/format.js`, `js/ui/storageMeter.js` |
| Dev server | `scripts/serve.js` (serves only `index.html`, `css/`, `js/`, `assets/`) |

Module boundaries: `intake.js`, `store.js`, `theme.js`, `router.js`, `format.js` are DOM-free and unit-tested in Node. `js/ui/*` is the only code that touches the DOM. Phase 0 files (`money.js`, `validation.js`, tests, corpus) are untouched.

## Intake policy (all configurable in `DEFAULT_POLICY`, `js/intake.js`)

| Rule | Value | Why |
|---|---|---|
| Max file size | 25 MB | PDF.js and canvas decode hold file + bitmap in memory; safe on phones |
| Max files / total | 50 / 200 MB | bounds memory for the in-memory session |
| Max image pixels | 100 MP | decompression-bomb guard; read from the header, nothing is decoded to check |
| Accepted | JPG/JPEG, PNG, WebP, PDF | extension AND MIME (when present) AND magic bytes must agree |
| Truncation | PNG must end in `IEND`; WebP RIFF length must fit; header must parse | rejected as "damaged or incomplete" |
| Warnings (accepted) | JPEG without EOI marker; PDF without `%%EOF` | real files exist with trailing data, so these warn instead of reject |
| Duplicates | SHA-256 of content (falls back to name+size+mtime without `crypto.subtle`) | same content under another name is rejected with the original's name |

Every rejection shows a specific message beside the file name; "Retry" appears only for read errors, "Dismiss" always.

## Verified results (this session, Chromium 1243 via Playwright 1.63, Node 22)

| Check | Result |
|---|---|
| `npm test` | 80 pass / 0 fail (39 from Phase 0 + 41 new: intake, store, theme, format, router) |
| `npm run test:browser` | 47 pass / 0 fail, run 3 times consecutively (36 functional + 11 screenshot captures) |
| `npm run eval` | runs cleanly; corpus is empty, so accuracy metrics are **unavailable** (not 0, not 100) |
| `git diff --check` | clean |
| axe-core 4.11.0 (wcag2a/aa, 2.1, 2.2 aa, best-practice) | 0 violations: desktop 1440, tablet 768, mobile 390 x light/dark x (empty, files + errors, Batch, Projects, Settings), plus theme menu open and tablet drawer open |
| Horizontal overflow | none at 1440, 1280, 768, 390, 320 x light/dark x (empty, files + long names + errors, every view) |
| Touch targets at 390 px | all measured controls >= 44x44 (browse, camera, gallery, files, bottom nav, theme, add/clear, remove) |
| Network | only same-origin GETs; no POST; no foreign host; no console or CSP errors |
| CSP | injected inline `<script>` does not run; hostile file name `"><img onerror>` renders as text |
| Object URLs | created for images only; every one revoked on remove/clear (counted in-browser) |
| Theme | light/dark/system; survives reload; system follows live OS change; stored theme applied before first paint; no mixed surfaces (luminance of body, sidebar, header, dropzone, search sampled per theme) |
| Reduced motion | transitions disabled |

Screenshots (evidence, `docs/phase1/screenshots/`): `{desktop 1440x900, laptop 1280x800, tablet 768x1024, mobile 390x844, small 320x700} x {light, dark} x {1-empty, 2-files}` plus tablet drawer, theme menu, coming-soon view. Regenerate with `node --test tests/browser/capture.e2e.js`.

## Visual comparison with the approved image

Method: manual side-by-side of cropped reference regions (`docs/reference/approved-ui.webp`, confirmed to be the same artwork as the image attached to the session: mean absolute pixel difference 0.14/255, i.e. recompression only) against the captures above. No automated pixel diff and no similarity percentage: the reference is a low-resolution AI composite, so pixel diffs would measure artwork noise, not fidelity.

Matches: sidebar width/structure and active state, 56 px header, search field, centered bold hero with accent on "editable files", dashed accent dropzone (solid + soft fill on dragover), PDF/Word/Excel/Sheets chips right of the dropzone, four-column feature strip, bottom-pinned storage meter, deep-navy dark theme with bluer sidebar, mobile "Upload a document" screen (Browse Files, Camera/Gallery/Files tiles, 4-tab bottom bar), tablet condensed header with hamburger.

Deliberate deviations (all recorded in `docs/design-tokens.md` section 7 or by scope):
- Hero illustration is a flat SVG: the reference art has glow/gradient, which the no-glow rule forbids.
- No `EN` selector and no avatar: English-only scope; the app has no accounts.
- Theme control is a menu button (sun/moon/monitor icon, Light/Dark/System) instead of the sun/moon toggle, because a system option is required.
- Search field filters the selected files (it is the only searchable thing in Phase 1); placeholder is "Search files…", not "files, projects…".
- Input/control borders use `--color-border-strong` for 3:1 contrast (already decided in Phase 0).
- Font: Inter is not bundled (no font file in repo, no CDN). Screenshots here were taken on a machine that has Inter installed; elsewhere the system UI font is used, so glyph widths and line wraps will differ slightly.
- Reference hero has more vertical air and a taller dropzone; the build is a bit denser (200 px dropzone vs ~190 estimated). Not adjusted: the reference scale is itself an estimate.

## Known limitations (not hidden)

- Tested in Chromium only. Firefox and WebKit were not run. Real touch hardware and the real camera (`capture="environment"`) were not tested: the picker wiring is verified with Playwright's file-chooser, not a phone.
- PDF validation is header + `%%EOF` only. Encrypted, password-protected or internally corrupt PDFs pass Phase 1 and must be handled by PDF.js in Phase 2.
- JPEG truncation is a warning, not a rejection (see policy).
- Local Storage meter shows the browser's own `navigator.storage.estimate()` for this origin. Phase 1 stores nothing but the theme string, so it reads near 0 B; the quota is whatever the browser reports.
- The session file list lives in memory only. Reloading clears it (by design; persistence is Phase 5).
- "Convert" is a disabled button labelled "coming in Phase 2". Batch and Saved Projects say "Coming in Phase 5", Settings says "Coming in Phase 6". Nothing fakes progress, output or success.
- Hero copy ("extract the content automatically") is the approved wording; a one-line "Preview build" note and a notice inside the files panel state what is not built yet.

## Tooling notes

- Playwright and Chromium come from the environment (global install) and are resolved by `tests/browser/helpers.js` with a global fallback. They are **not** in `package.json`: adding a pinned `playwright` devDependency whose browser revision matches would be a decision for the user (download size, CI). `axe-core@4.11.0` was added as a devDependency (MPL-2.0, test-only, not shipped).
- Skills: `/caveman` and `/architect` were invoked as named. `/uiuxpro` does not exist in the catalog; the authentic equivalent installed is `ui-ux-pro-max:ui-ux-pro-max`, which was invoked. Its search scripts target React Native, so its checklists (contrast, touch size, nav patterns, light/dark pairing) were applied manually and verified with the tests above.

## Handoff to Phase 2 (NOT STARTED)

- CSP in `index.html` is strict (`worker-src 'self'`, no `blob:` workers, no `wasm-unsafe-eval`). PDF.js and Tesseract.js will need `worker-src`, `script-src 'wasm-unsafe-eval'` (or equivalent) and vendored assets under a path that `scripts/serve.js` allows; update both deliberately.
- `store.js` items carry `{id, file, kind, width, height, fingerprint, warnings}`: Phase 2 should attach recognition state by `id` rather than mutating intake fields.
- `intake.js` already reads whole files into memory for hashing; Phase 2 can reuse the bytes instead of reading again if memory matters.
