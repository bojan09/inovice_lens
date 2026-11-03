# Visual acceptance checklist

Compare side by side with `docs/reference/approved-ui.webp` at matching viewport widths (desktop 1280-1440, tablet 768x1024, mobile 390x844). Tick each item for **Light** and **Dark**. Mark deviations with a note. Tokens come from `css/tokens.css`; no raw hex in component CSS.

Legend: [ ] Light  [ ] Dark. Each row below has two boxes.

## 0. Global (every screen)
- [ ] Font is Inter or system UI font (English/Latin only; no Cyrillic or language switcher anywhere)
- [ ] [ ] Body 14 px, nav and controls 13 px, no text below 11 px
- [ ] [ ] No gradients, glow, glassmorphism or blur in chrome; shadows barely visible
- [ ] [ ] Radii: controls 6, cards 8, dropzone/panels 12
- [ ] [ ] Buttons 32 px tall, inputs 40 px tall (44 px on touch layouts)
- [ ] [ ] Icons one outline family, same stroke, 20 px nav / 16 px inline
- [ ] [ ] Visible focus ring on every interactive element
- [ ] [ ] Nav label reads "Convert" (not "Invoicert"/"Invoicpce")
- [ ] [ ] No horizontal page overflow at 320 px
- [ ] [ ] Theme switch changes every surface; no leftover light panels in dark

## 1. Convert
- [ ] [ ] Sidebar ~200 px: brand tile + "InvoiceLens", 4 nav items, Local Storage meter pinned at bottom
- [ ] [ ] Active nav item: soft accent bg, accent text, accent icon, radius 6
- [ ] [ ] Header ~56 px: search field left (rounded, surface-2), theme toggle on right (reference shows an EN selector: non-functional, omit)
- [ ] [ ] H1 bold ~32 px, centered; subtitle two lines muted
- [ ] [ ] Dashed accent dropzone, cloud-upload icon, "Drag & drop files here", "or", Browse Files primary, formats line muted
- [ ] [ ] Format chips (PDF, Word, Excel, Sheets) stacked at right of dropzone
- [ ] [ ] Four feature columns: icon in accent, bold title, muted caption, evenly spaced
- [ ] [ ] Storage bar 4 px, accent fill over progress track, "312 MB of 2 GB"
- [ ] [ ] Dragover state: dropzone bg accent-soft, solid border
- [ ] [ ] Dark: bg deep navy, sidebar slightly bluer, active item accent-soft #16295a

## 2. Editor
- [ ] [ ] Top bar: brand, "< Back to Workspace", info icon, Export split button (accent)
- [ ] [ ] Pages rail ~104 px, selected thumbnail has 2 px accent border, "Add Page" tile dashed/soft
- [ ] [ ] Viewer toolbar: zoom -, 100%, +, pan (active = accent-soft), tool icons grouped in white pill
- [ ] [ ] Document page white with soft shadow on surface-2 canvas (page stays white in dark)
- [ ] [ ] Right panel ~340 px: tabs Extracted Data / Table / Text, active tab has accent text + 2 px underline
- [ ] [ ] "Document Details" collapsible with type chip (green Invoice)
- [ ] [ ] Label-left, field-right rows, 40 px inputs, date fields with calendar icon
- [ ] [ ] "Items (2)" collapsible row with chevron
- [ ] [ ] Warning banner with amber icon, "1 item to review", outlined Review button
- [ ] [ ] Dark: panels #131a28 / #1a2231, inputs have visible borders

## 3. Batch Processing
- [ ] [ ] Title 20 px semibold, subtitle muted, Add Files split button top right
- [ ] [ ] Four stat tiles: icon, bold number, muted caption; success/warning/info icon colors
- [ ] [ ] Table header muted, rows ~48 px, hairline separators
- [ ] [ ] Type chip + status chip (Completed green, Needs Review amber, Processing blue, Queued neutral)
- [ ] [ ] Progress bar 4 px with percent label; eye and kebab icons at right
- [ ] [ ] Checkboxes accent when checked
- [ ] [ ] Bottom action bar: "3 selected", Export primary split, Pause, Retry, Remove outlined
- [ ] [ ] Dark reference is the primary; light variant derived from tokens

## 4. Saved Projects
- [ ] [ ] Title, subtitle, New Project primary button, grid-view and search icon buttons
- [ ] [ ] 2-column card grid (1 column on mobile), 8 px radius, hairline border
- [ ] [ ] Card: blue folder icon, bold name, muted counts, size, kebab, date bottom right, 4-5 page thumbnails
- [ ] [ ] Active nav item "Saved Projects" highlighted
- [ ] [ ] Empty state present (not in reference): icon, text, New Project button
- [ ] [ ] Dark variant derived from tokens (not in reference)

## 5. Export dialog (not in reference)
- [ ] [ ] Modal, radius 12-16, shadow-lg, scrim 50% (light) / 60% (dark)
- [ ] [ ] Title, close button, format choices (PDF, Word, Excel, Google Sheets-compatible), primary Export, secondary Cancel
- [ ] [ ] Focus trapped, Esc closes, focus returns to Export button
- [ ] [ ] Uses only existing tokens and component styles; no new colors
- [ ] [ ] Progress and error states use chip/status tokens

## 6. Settings
- [ ] [ ] Settings sub-nav (General, Recognition (OCR), Export Defaults, Storage & Projects, Appearance), active = accent-soft; no Language entry
- [ ] [ ] Section title bold, selects full width 40 px with chevron
- [ ] [ ] Toggle rows with label, info icon, toggle ~36 x 20 (on = accent, white knob)
- [ ] [ ] No "Language" item in main sidebar or sub-nav
- [ ] [ ] Appearance pane includes light/dark/system choice
- [ ] [ ] Dark variant derived from tokens (not in reference)

## 7. Tablet portrait (768x1024)
- [ ] [ ] No persistent sidebar; top bar with hamburger, brand, icons
- [ ] [ ] Tab strip Original / Edit / Table, active accent with underline
- [ ] [ ] Document fills width, page white with shadow, readable text
- [ ] [ ] Bottom bar: Files, Edit (active accent), Export; targets >= 44 px
- [ ] [ ] No horizontal overflow
- [ ] [ ] Dark: shown with dark frame in reference; verify surfaces

## 8. Mobile (390x844)
- [ ] [ ] Top bar: brand left, theme icon right
- [ ] [ ] "Upload a document" bold, "Photo, image or PDF" muted
- [ ] [ ] Full-width Browse Files primary (>= 44 px)
- [ ] [ ] Three tiles Camera / Gallery / Files, equal width, icon + label
- [ ] [ ] Bottom tab bar: Home (active), Batch, Projects, Settings; safe-area padding
- [ ] [ ] Dark variant derived from tokens (not in reference)
- [ ] [ ] Verified at 320 px: no overflow, no clipped labels
