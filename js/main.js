// main.js - bootstrap. Everything runs client-side; no network requests are made.

import { createStore } from './store.js';
import { initNav } from './ui/nav.js';
import { initThemeMenu } from './ui/themeMenu.js';
import { createToaster } from './ui/toast.js';
import { createFileList } from './ui/fileList.js';
import { initIntake } from './ui/intakeUi.js';
import { updateStorageMeter } from './ui/storageMeter.js';

const $ = (id) => document.getElementById(id);

const store = createStore();
const toaster = createToaster($('toasts'));

initThemeMenu({ button: $('theme-btn'), menu: $('theme-menu'), buttonIcon: $('theme-btn-icon') });

const nav = initNav();

const fileList = createFileList({
  store,
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

// Release preview URLs when the page goes away.
window.addEventListener('pagehide', () => store.destroy());

const storageEls = { valueEl: $('storage-value'), meterEl: $('storage-meter'), fillEl: $('storage-fill') };
updateStorageMeter(storageEls);
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateStorageMeter(storageEls); });
