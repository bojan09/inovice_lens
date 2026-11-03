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
import { createExportDialog } from './ui/export/exportDialog.js';
import { createBatchView } from './ui/batch/batchView.js';
import { createProjectsView } from './ui/projects/projectsView.js';
import { createProjectsController } from './projects/controller.js';
import { createSettings, ocrPolicy } from './settings.js';
import { createSettingsView } from './ui/settings/settingsView.js';
import { createPwa } from './pwa.js';

const $ = (id) => document.getElementById(id);

const store = createStore();
const toaster = createToaster($('toasts'));

const settings = createSettings();
const theme = initThemeMenu({ button: $('theme-btn'), menu: $('theme-menu'), buttonIcon: $('theme-btn-icon') });
const applyMotion = () => { document.documentElement.dataset.motion = settings.value.appearance.motion === 'reduce' ? 'reduce' : ''; };
applyMotion();
settings.subscribe(applyMotion);

let editor = null; // created below, once the workspace exists; routes can fire during initNav()
const nav = initNav({ onRoute: (view) => { if (view === 'editor') editor?.open(parseEditorId(location.hash)); else editor?.close(); } });

// Recognition: one document at a time (a single wasm OCR worker; bounded to keep phones responsive).
const real = createRealRunner({ getPolicy: () => ocrPolicy(settings.value) });
const session = createRecognitionSession({ runner: real.runner, concurrency: 1 });

// new files are queued automatically; removed files are cancelled and forgotten
const known = new Set();
store.subscribe(({ items }) => {
  const ids = new Set(items.map((i) => i.id));
  for (const id of known) if (!ids.has(id)) { known.delete(id); session.remove(id); }
  for (const it of items) if (!known.has(it.id)) { known.add(it.id); if (!it.restoring) session.enqueue(it); }
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
const srLive = (m) => { $('sr-live').textContent = m; };
const exporter = createExportDialog({ workspace, store, session, engines: real.engines, toaster, srLive, settings });
const projects = createProjectsController({ store, session, workspace, engines: real.engines, debounceMs: () => settings.value.processing.autosaveSeconds * 1000 });
editor = createEditor({ root: $('editor-root'), workspace, session, store, engines: real.engines, toaster, srLive, onExport: (ids, from) => exporter.open(ids, from), saveInfo: () => projects.status });
projects.subscribe(() => editor.refreshSave());

const download = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
};
const batch = createBatchView({ root: $('batch-root'), store, session, workspace, toaster, srLive, onExport: (ids, from) => exporter.open(ids, from) });
const projectsUi = createProjectsView({ root: $('projects-root'), controller: projects, store, toaster, srLive, goConvert: () => nav.go('convert'), download });

// Save project (explicit consent happens inside the dialog) + autosave status in the sidebar
const saveBtn = $('save-project-btn');
saveBtn.addEventListener('click', () => projectsUi.saveFlow(saveBtn));
const pstat = $('project-status');
const renderProjectStatus = () => {
  const st = projects.status;
  saveBtn.disabled = store.getState().items.length === 0;
  saveBtn.textContent = st.project ? 'Save as new project…' : 'Save project…';
  if (!st.project) { pstat.hidden = true; pstat.replaceChildren(); return; }
  pstat.hidden = false;
  pstat.dataset.state = st.state;
  const t = st.state === 'saving' ? 'Saving…' : st.state === 'error' ? st.error : st.state === 'saved' && st.at ? `Saved ${st.at.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}` : 'Changes will be saved';
  const stop = document.createElement('button');
  stop.type = 'button'; stop.className = 'link-btn'; stop.textContent = 'Stop autosave';
  stop.addEventListener('click', () => { projects.stopAutosave(); toaster.show('Autosave stopped. The project stays saved as it was.', 'info'); });
  pstat.replaceChildren(document.createTextNode(`Project “${st.project.name}”. ${t} `), stop);
};
projects.subscribe(renderProjectStatus);
store.subscribe(renderProjectStatus);
renderProjectStatus();
nav.onShow?.((v) => { if (v === 'projects') projectsUi.refresh(); });

// Offline support (service worker) + Settings
const pwa = createPwa();
pwa.register();
const updateBar = $('update-bar');
pwa.subscribe(() => { updateBar.hidden = !pwa.updateReady; });
$('update-btn').addEventListener('click', () => {
  if (workspace.hasUnsavedEdits() && !(projects.status.project && projects.status.state === 'saved') && !confirm('Reloading to update discards edits that are not saved to a project. Reload now?')) return;
  pwa.applyUpdate();
});
createSettingsView({ root: $('settings-root'), settings, theme, projects, pwa, toaster, srLive });

// Convert page: Export is available as soon as one file has a result
const convertBtn = $('convert-btn');
const syncExportBtn = () => {
  const n = store.getState().items.filter((i) => ['recognized', 'review'].includes(session.get(i.id)?.status)).length;
  convertBtn.disabled = n === 0;
  convertBtn.textContent = n > 1 ? `Export ${n} files…` : 'Export…';
};
convertBtn.addEventListener('click', () => exporter.open(null, convertBtn));
session.subscribe(syncExportBtn);
store.subscribe(syncExportBtn);
syncExportBtn();
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
  goToConvert: () => { if (location.hash && !/^#\/?(convert|batch)/.test(location.hash)) nav.go('convert'); },
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
  const st = projects.status;
  const safe = st.project && st.state === 'saved'; // edits already committed to the saved project
  if (settings.value.general.warnUnsaved && workspace.hasUnsavedEdits() && !safe) { e.preventDefault(); e.returnValue = ''; }
});

// Release preview URLs when the page goes away.
window.addEventListener('pagehide', () => { projects.dispose(); exporter.close(); workspace.dispose(); session.clear(); real.dispose(); store.destroy(); });

const storageEls = { valueEl: $('storage-value'), meterEl: $('storage-meter'), fillEl: $('storage-fill') };
updateStorageMeter(storageEls);
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateStorageMeter(storageEls); });
