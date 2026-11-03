# InvoiceLens design tokens: rationale and measurements

Source of truth: `docs/reference/approved-ui.webp` (1536x1024). Tokens live in `css/tokens.css`. The reference is an AI-rendered showcase at low resolution: every number below is an estimate unless it is a computed contrast ratio.

## 1. Scale assumption
Showcase panels are shrunk. The Convert panel is ~750 px wide in the image; nav labels have ~10 px x-height-ish text that maps to 13-14 px UI text. Working assumption: **image px / 0.78 = CSS px** (so the Convert panel is ~960 px wide, sidebar ~200 px, nav row ~40 px). If the real build looks too big or small side by side, change `--sidebar-w`, `--header-h`, `--fs-*` only; do not rescale individual components.

## 2. Style rationale
Restrained productivity UI: white surfaces on a pale blue-grey canvas, hairline borders, one blue accent, small radii (6-8 px controls, 12 px dropzone), very light shadows, dark mode as deep navy (not black, not inverted light). No gradients, glows or glass in the app chrome. (The reference hero art, floating invoice with arrow, has glow/gradient: treat as illustration only, implement as a flat SVG or omit.)

**Font.** Reference glyphs match Inter. The app is English-only (scope change), so only Latin coverage is required. Stack: `Inter` (if installed or later self-hosted, OFL) then `system-ui`, Segoe UI, Roboto, Helvetica Neue, Arial; nothing loads from a CDN. Not bundled in this task because no font file is in the repo.

## 3. Measured layout (image px, then estimated CSS px)
| Item | Image | CSS est |
|---|---|---|
| Sidebar width, desktop expanded | ~157 | 200 (`--sidebar-w`) |
| Compact sidebar | not shown | 64 (`--sidebar-w-compact`, proposal) |
| Header / top bar height | ~44-54 | 56 |
| Nav row height / gap | ~33 / ~32 pitch | 40 |
| Nav icon | ~14 | 20 |
| Brand tile | ~22 sq, radius ~6 | 28-32 |
| Search field | ~260 x 26 in header | max 360 x 36, radius 8 |
| Header controls right | EN selector, theme toggle, avatar | theme toggle only (see section 7) |
| Buttons (Export, Add Files, Browse) | 22-26 high | 32 |
| Inputs / selects (Editor, Settings) | ~28-30 high | 40 |

**Convert.** Centered column: H1 (bold, ~32), two-line muted subtitle (~13), dashed dropzone ~275 x 150 img (~350 x 190 css) with cloud-upload icon, "Drag & drop files here", "or", primary "Browse Files", muted formats line. Hero illustration with format chips (PDF, Word, Excel, Sheets) to the right of the dropzone. Four feature columns below (icon, bold title, muted caption). Local Storage meter bottom of sidebar: label, "312 MB of 2 GB", 4 px progress bar.

**Editor.** Top bar: brand, "< Back to Workspace", info icon, Export (split button). Three columns: Pages rail (~100 img, thumbnails with blue selected border, "Add Page" tile), viewer (zoom toolbar, white invoice page with shadow on grey-blue canvas), right panel ~215 img (~280-340 css) with tabs Extracted Data / Table / Text, collapsible "Document Details" with type chip, label-left/field-right rows, "Items (2)" row, warning banner with Review button.

**Batch.** Page title + subtitle + "Add Files" split button right. Four stat tiles (Total Files 12, Completed 9, Needs Review 2, Processing 1), each ~65 x 45 img with 8 px radius icon left, number bold, caption muted. Table: checkbox, File Name, Type chip, Status chip, Progress (bar + %), eye and kebab actions. Bottom action bar: "3 selected", Export (primary split), Pause, Retry, Remove (outlined).

**Saved Projects.** Header with title, subtitle, "New Project" button, grid-view and search icon buttons. 2-column card grid (~250 x 80 img): blue folder icon, name bold, "n documents" muted, size, kebab, date bottom-right, strip of 4-5 page thumbnails.

**Settings.** Two inner columns: sub-nav (General, Recognition (OCR), Export Defaults, Storage & Projects, Appearance; the reference's Language entry is dropped) ~ 205 img wide in 2x crop (~160 css), then form: section title, selects (full width), three label + toggle rows with info icons. Toggle ~28 x 16 img (~36 x 20 css), on = accent.

**Tablet portrait (editor).** No sidebar. Top bar with hamburger, brand, icons; tab strip Original / Edit / Table; document fills width; bottom tab bar Files, Edit, Export (Edit active, accent).

**Mobile home.** Top bar with brand and theme icon, bold "Upload a document", muted "Photo, image or PDF", full-width Browse Files, three tiles Camera / Gallery / Files, bottom tab bar Home, Batch, Projects, Settings (4 tabs).

## 4. Icons
Single outline family, ~1.75 px stroke, rounded caps and joins, 20 px nav / 16 px inline, monochrome currentColor (accent when active). Brand mark: blue rounded square with white scan-bracket glyph. Colored file-type glyphs (PDF red, Word blue, Excel green, Sheets green) are small filled tiles, used only for file type. Use inline SVG, no emoji, no icon font.

## 5. Light vs dark mapping
| Token | Light | Dark |
|---|---|---|
| bg | #f5f9fc | #0d151e |
| surface | #ffffff | #131a28 |
| surface-2 | #eef3f9 | #1a2231 |
| sidebar | #fafcfe | #131d2e |
| border | #dfe6ef | #2a3446 |
| text / muted | #0f172a / #5b6578 | #e8edf5 / #98a3b8 |
| accent / hover | #1e68fc / #1558e0 | #1f6bff / #3a7fff |
| accent text | #1558e0 | #6aa3ff |
| accent-soft (selected nav) | #e6eefe | #16295a |
Dark uses lighter tonal chip text on dark tinted bg (not inverted). Dropzone border stays dashed accent in both. Shadows are nearly invisible in dark; separation comes from borders and surface steps.

## 6. Contrast (computed, WCAG 2.x relative luminance)
Text pairs:
| Pair | Ratio | AA |
|---|---|---|
| Light text on bg / surface | 16.87 / 17.85 | pass |
| Light muted on surface / bg / surface-2 | 5.87 / 5.55 / 5.26 | pass |
| Light white on accent #1e68fc | 4.73 | pass (barely) |
| Light white on accent-hover | 5.99 | pass |
| Light accent-text #1558e0 on accent-soft | 5.14 | pass |
| Light raw #1e68fc on accent-soft | 4.06 | **fail** (do not use for nav text; use accent-text) |
| Light raw #1e68fc on bg | 4.47 | **fail** for small text (use accent-text) |
| Light chips success / warning / info / danger / neutral | 5.71 / 5.25 / 6.11 / 5.44 / 6.38 | pass |
| Light placeholder candidate #6b7587 on #f2f6fa | 4.28 | **fail**: use text-muted for placeholders |
| Dark text on bg / surface | 15.63 / 14.81 | pass |
| Dark muted on bg / surface / surface-2 | 7.23 / 6.85 / 6.28 | pass |
| Dark white on accent #1f6bff | 4.56 | pass (barely) |
| Dark white on accent-hover | 5.81 | pass |
| Dark accent-text #6aa3ff on surface / bg | 6.88 / 7.26 | pass |
| Dark accent-text on accent-soft | 6.93 | pass |
| Dark chips success / warning / info / danger / neutral | 6.83 / 6.45 / 5.54 / 6.93 / 5.92 | pass |
| Dark raw accent #1f6bff as text on bg | 4.03 | **fail** (use accent-text) |

Non-text (3:1 needed, WCAG 1.4.11):
| Pair | Ratio | Result |
|---|---|---|
| Light hairline border #dfe6ef on white | 1.26 | fails; fine for decorative card edges only |
| Light control border (reference style) #c3ccda on white | 1.62 | **fails**: reference inputs are too faint |
| Light `--color-border-strong` #8793a6 on white / bg | 3.11 / 2.94 | passes on surface, marginal on bg |
| Dark hairline #2a3446 on surface | 1.39 | fails; decorative only |
| Dark control border #3a4558 on surface | 1.80 | **fails** |
| Dark `--color-border-strong` #5f6e86 on surface / bg | 3.37 / 3.55 | pass |
Decision: card edges use `--color-border` (as in reference); input, select and checkbox outlines use `--color-border-strong`, a small deliberate deviation for accessibility. Status is never colour-only: chips carry text.

## 7. Impossible or inconsistent mockup items
- Nav label typos: "Invoicert" (dark Batch sidebar, first item), "Invoicpce" (Settings sidebar) and "Invoivert" lookalikes: both should read **Convert**. Saved Projects sidebar shows "Invoicert" too.
- Batch and Saved/Settings screens use "Invoicert" with a home icon where Convert screens show "Convert" with the same icon: treat as one item.
- Sidebar order is Convert, Batch Processing, Saved Projects, Settings. The Settings screen adds a "Language" entry in the main sidebar and in the settings sub-nav. The app is English-only: **drop Language everywhere** (sidebar and sub-nav).
- Chip text garbled ("Invoice", "Docuent", "Receipt" tiny illegible): use real labels Invoice, Receipt, Table, Document.
- Editor page-thumbnail numbers are cropped ("2", "2"); page numbers 1, 2 to be rendered cleanly.
- Dark editor omits some toolbar glyphs shown in light; use one toolbar for both.
- Hero "document with arrow" art is raster with blur/glow; not reproducible, and violates no-glow rule. Use flat SVG.
- Sidebar background differs from main in dark (navy vs near-black) but is nearly identical in light; kept as tokens.
- Info icons next to toggles have no defined behaviour; implement as tooltips or drop.
- Export dialog is not shown anywhere (Export is only a split button). Dialog design must be derived from tokens (see checklist).
- Theme toggle in header appears as sun (light) and moon in a filled blue circle (dark); an "EN" language selector with chevron (non-functional visual reference only: the app is English-only, do not build or style a language switcher); avatar circle. The app has no accounts: avatar must be omitted or become a settings shortcut.
- Settings screen shows only the General pane; other panes are undefined.
- Mobile phone and tablet frames show device bezels: not part of the UI.
- Colours were sampled from a compressed, blurred image; exact hex values are approximate (+/- ~6 per channel).
