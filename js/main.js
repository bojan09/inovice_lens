// main.js - bootstrap. Everything runs client-side; no network requests are made.

import { createStore } from './store.js';
import { initNav } from './ui/nav.js';
import { initThemeMenu } from './ui/themeMenu.js';
import { createToaster } from './ui/toast.js';
import { createFileList } from './ui/fileList.js';
import { initIntake } from './ui/intakeUi.js';
import { updateStorageMeter } from './ui/storageMeter.js';
import { createRecognitionSession } from './recognition/session.js';
import { createRealRunner } from './recognition/engines.js';
import { STATUS, isTerminal } from './recognition/states.js';
import { CATEGORY_LABELS } from './recognition/classify.js';
import { createWorkspace } from './doc/workspace.js';
import { createEditor } from './ui/editor/editor.js';
import { parseEditorId } from './router.js';

const $ = (id) => document.getElementById(id);

const store = createStore();
const toaster = createToaster($('toasts'));

initThemeMenu({ button: $('theme-btn'), menu: $('theme-menu'), buttonIcon: $('theme-btn-icon') });

let editor = null; // created below, once the workspace exists; routes can fire during initNav()
const nav = initNav({ onRoute: (view) => { if (view === 'editor') editor?.open(parseEditorId(location.hash)); else editor?.close(); } });

// Recognition: one document at a time (a single wasm OCR worker; bounded to keep phones responsive).
const real = createRealRunner();
const session = createRecognitionSession({ runner: real.runner, concurrency: 1 });

// new files are queued automatically; removed files are cancelled and forgotten
const known = new Set();
store.subscribe(({ items }) => {
  const ids = new Set(items.map((i) => i.id));
  for (const id of known) if (!ids.has(id)) { known.delete(id); session.remove(id); }
  for (const it of items) if (!known.has(it.id)) { known.add(it.id); session.enqueue(it); }
});

// screen-reader announcements for finished files (visual state lives on the cards)
const lastStatus = new Map();
session.subscribe((snap) => {
  for (const [id, e] of snap) {
    const prev = lastStatus.get(id);
    lastStatus.set(id, e.status);
    if (prev === e.status || !isTerminal(e.status)) continue;
    const name = store.getState().items.find((i) => i.id === id)?.name ?? 'File';
    const msg = {
      [STATUS.RECOGNIZED]: `${name}: recognized${e.result ? `, suggested type ${CATEGORY_LABELS[e.result.classification.suggested]}` : ''}.`,
      [STATUS.REVIEW]: `${name}: needs review. ${e.result?.review?.[0] ?? ''}`,
      [STATUS.FAILED]: `${name}: failed. ${e.error?.message ?? ''}`,
      [STATUS.CANCELLED]: `${name}: cancelled.`,
    }[e.status];
    if (msg) $('sr-live').textContent = msg;
  }
});

// Editable documents live for the whole page session, so edits survive moving between views.
const workspace = createWorkspace({ store, session });
editor = createEditor({ root: $('editor-root'), workspace, session, store, engines: real.engines, toaster, srLive: (m) => { $('sr-live').textContent = m; } });
if (location.hash.startsWith('#/editor')) editor.open(parseEditorId(location.hash));

const fileList = createFileList({
  store,
  session,
  workspace,
  cancelAllBtn: $('cancel-all'),
  panel: $('files-panel'),
  listEl: $('file-list'),
  rejectEl: $('reject-list'),
  countEl: $('files-count'),
  noMatchEl: $('no-match'),
});

initIntake({
  store,
  dropzone: $('dropzone'),
  fileInput: $('file-input'),
  galleryInput: $('gallery-input'),
  cameraInput: $('camera-input'),
  browseButtons: [...document.querySelectorAll('[data-browse]')],
  cameraBtn: $('camera-btn'),
  galleryBtn: $('gallery-btn'),
  toaster,
  goToConvert: () => { if (location.hash && !/^#\/?convert/.test(location.hash)) nav.go('convert'); },
});

$('cancel-all').addEventListener('click', () => session.cancelAll());

$('clear-all').addEventListener('click', () => {
  const n = store.getState().items.length + store.getState().rejected.length;
  store.clear();
  $('search').value = '';
  fileList.setQuery('');
  toaster.show(`Cleared ${n} ${n === 1 ? 'entry' : 'entries'}.`, 'info');
  $('browse-btn').focus();
});

// Search filters the selected files; files live on Convert, so jump there when typing elsewhere.
$('search').addEventListener('input', (e) => {
  if (e.target.value && !/^#\/?convert/.test(location.hash) && location.hash) nav.go('convert');
  fileList.setQuery(e.target.value);
});

// Edits are not persisted until a later phase: warn before the tab is closed or reloaded with unsaved edits.
window.addEventListener('beforeunload', (e) => {
  if (workspace.hasUnsavedEdits()) { e.preventDefault(); e.returnValue = ''; }
});

// Release preview URLs when the page goes away.
window.addEventListener('pagehide', () => { workspace.dispose(); session.clear(); real.dispose(); store.destroy(); });

const storageEls = { valueEl: $('storage-value'), meterEl: $('storage-meter'), fillEl: $('storage-fill') };
updateStorageMeter(storageEls);
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateStorageMeter(storageEls); });
