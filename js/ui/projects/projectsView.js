// projectsView.js - Saved Projects: cards with thumbnails, resume, rename, portable export, delete (with confirmation),
// import, storage context and an explicit "delete all local data". Everything shown comes from what is really stored.
import { el, icon } from '../dom.js';
import { formatBytes } from '../../format.js';
import { confirmDialog, promptDialog } from '../dialogs.js';
import { askSave } from './saveDialog.js';
import { portableName } from '../../projects/portable.js';

const when = (t) => new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(t));

export function createProjectsView({ root, controller, store, toaster, srLive, goConvert, download }) {
  const urls = [];
  const revokeAll = () => { while (urls.length) URL.revokeObjectURL(urls.pop()); };
  let busy = false;

  const head = el('div', { class: 'page-head proj-head' },
    el('div', {}, el('h1', { class: 'page-title', id: 'projects-title' }, 'Saved Projects'), el('p', { class: 'page-sub' }, 'Your locally saved workspaces. Files and edits stay on this device.')),
    el('div', { class: 'proj-actions' }));
  const actions = head.querySelector('.proj-actions');
  const newBtn = el('button', { type: 'button', class: 'btn btn-primary', id: 'new-project' }, icon('plus', 'icon-sm'), 'New project');
  const importBtn = el('button', { type: 'button', class: 'btn btn-secondary', id: 'import-project' }, 'Import file…');
  const importInput = el('input', { type: 'file', class: 'visually-hidden', accept: '.zip,application/zip', tabindex: '-1', 'aria-hidden': 'true', id: 'import-input' });
  actions.append(newBtn, importBtn, importInput);

  const privacy = el('p', { class: 'notice', id: 'proj-privacy' }, icon('lock'), el('span', {}, 'Projects are stored only in this browser (IndexedDB) and only after you save one. Nothing is uploaded, synced or sent to analytics. Deleting a project removes its files, text and edits from this device. Clearing your browser data also removes projects.'));
  const storage = el('p', { class: 'proj-storage', id: 'proj-storage', role: 'status' });
  const notice = el('p', { class: 'notice notice-warn', id: 'proj-unavailable', hidden: true, role: 'alert' });
  const grid = el('ul', { class: 'proj-grid', 'aria-label': 'Saved projects' });
  const empty = el('div', { class: 'coming proj-empty', hidden: true }, icon('folder', 'coming-icon'), el('h2', {}, 'No saved projects yet'),
    el('p', {}, 'Add files on Convert, then choose "Save project…". Nothing is saved until you do.'), el('a', { class: 'btn btn-secondary', href: '#/convert' }, 'Go to Convert'));
  const danger = el('div', { class: 'proj-danger' }, el('h2', { class: 'ed-h3' }, 'Local data'),
    el('p', { class: 'opt-help' }, 'Removes every saved project, original file, edit and thumbnail InvoiceLens stored in this browser.'),
    el('button', { type: 'button', class: 'btn btn-danger', id: 'delete-all' }, icon('trash', 'icon-sm'), 'Delete all local data'));
  root.replaceChildren(head, privacy, storage, notice, grid, empty, danger);

  const setBusy = (b) => { busy = b; [newBtn, importBtn].forEach((x) => { x.disabled = b; }); root.setAttribute('aria-busy', String(b)); };
  const fail = (e, what) => { toaster.show(`${what}: ${e.message || 'unknown error'}`, 'error'); srLive(`${what} failed.`); };

  async function refresh() {
    revokeAll();
    notice.hidden = true;
    let list;
    try { list = await controller.list(); } catch (e) {
      notice.hidden = false;
      notice.replaceChildren(icon('alert'), el('span', {}, controller.unavailable ?? `Saved projects are not available: ${e.message}`));
      grid.replaceChildren(); empty.hidden = true; danger.hidden = true; newBtn.disabled = true; importBtn.disabled = true;
      storage.textContent = '';
      return;
    }
    danger.hidden = false; importBtn.disabled = busy; newBtn.disabled = busy;
    empty.hidden = list.length > 0;
    const cur = controller.status.project?.id;
    grid.replaceChildren(...list.map((p) => card(p, p.id === cur)));
    try {
      const u = await controller.usage();
      const est = await navigator.storage?.estimate?.();
      storage.textContent = `${u.projects} ${u.projects === 1 ? 'project' : 'projects'}, ${u.files} ${u.files === 1 ? 'file' : 'files'}, ${formatBytes(u.bytes)} of originals${est?.quota ? ` · this site uses ${formatBytes(est.usage ?? 0)} of about ${formatBytes(est.quota)}` : ''}.`;
    } catch { storage.textContent = ''; }
  }

  function card(p, current) {
    const thumbs = el('div', { class: 'pc-thumbs', 'aria-hidden': 'true' }, ...p.thumbs.map((b) => { const u = URL.createObjectURL(b); urls.push(u); return el('img', { src: u, alt: '', width: 44, height: 56 }); }));
    if (!p.thumbs.length) thumbs.append(icon('file', 'pc-fileicon'));
    const name = el('h2', { class: 'pc-name' }, p.name);
    const meta = p.unreadable
      ? el('p', { class: 'pc-meta pc-bad' }, `Cannot open: ${p.unreadable}`)
      : el('p', { class: 'pc-meta' }, `${p.fileCount} ${p.fileCount === 1 ? 'document' : 'documents'} · ${formatBytes(p.bytes)}`);
    const when_ = el('p', { class: 'pc-when' }, `Updated ${when(p.updatedAt)}`);
    const btn = (label, cls, fn, extra = {}) => { const b = el('button', { type: 'button', class: `btn btn-sm ${cls}`, 'aria-label': `${label} ${p.name}`, ...extra }, label); b.addEventListener('click', () => fn(b)); return b; };
    const open = btn('Open', 'btn-primary', (b) => onOpen(p, b), { disabled: !!p.unreadable });
    const bar = el('div', { class: 'pc-actions' }, open, btn('Rename', 'btn-secondary', (b) => onRename(p, b)), btn('Export', 'btn-secondary', () => onExport(p), { disabled: !!p.unreadable }), btn('Delete', 'btn-secondary btn-danger-outline', (b) => onDelete(p, b)));
    return el('li', { class: 'proj-card', 'data-id': p.id }, el('div', { class: 'pc-top' }, el('span', { class: 'pc-icon' }, icon('folder')), el('div', { class: 'pc-title' }, name, meta), current ? el('span', { class: 'chip chip-info' }, 'Open · autosaving') : null), thumbs, when_, bar);
  }

  async function onOpen(p, opener) {
    if (store.getState().items.length) {
      const ok = await confirmDialog({ title: `Open "${p.name}"?`, message: 'Opening replaces the files currently in your workspace. Anything not saved in a project is lost.', details: [`${store.getState().items.length} file(s) in the workspace now will be closed.`], confirmLabel: 'Replace workspace and open', opener });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await controller.open(p.id);
      const notes = [r.skipped.length ? `${r.skipped.length} file(s) skipped (${r.skipped.map((s) => s.name).slice(0, 3).join(', ')})` : '', r.requeued ? `${r.requeued} unfinished file(s) are being recognized again` : '', r.docsDropped ? `${r.docsDropped} saved edit set(s) could not be matched and were reset` : ''].filter(Boolean);
      toaster.show(`Opened "${r.name}": ${r.opened} file(s).${notes.length ? ` ${notes.join('; ')}.` : ''}`, notes.length ? 'info' : 'success');
      srLive(`Opened project ${r.name}.`);
      goConvert();
    } catch (e) { fail(e, 'Could not open the project'); } finally { setBusy(false); }
  }
  async function onRename(p, opener) {
    const name = await promptDialog({ title: 'Rename project', label: 'Project name', value: p.name, opener });
    if (!name) return;
    try { await controller.rename(p.id, name); await refresh(); srLive(`Renamed to ${name}.`); } catch (e) { fail(e, 'Could not rename'); }
  }
  async function onDelete(p, opener) {
    const ok = await confirmDialog({ title: `Delete "${p.name}"?`, message: 'This permanently removes the project from this browser: its original files, recognized text and edits. It cannot be undone.', details: [`${p.fileCount} document(s), ${formatBytes(p.bytes)}`, 'Files currently open in your workspace are not affected.'], confirmLabel: 'Delete project', danger: true, opener });
    if (!ok) return;
    try { await controller.remove(p.id); await refresh(); toaster.show(`Deleted "${p.name}".`, 'success'); srLive(`Deleted ${p.name}.`); } catch (e) { fail(e, 'Could not delete'); }
  }
  async function onExport(p) {
    try { const { blob, filename } = await controller.exportSaved(p.id); download(blob, filename); } catch (e) { fail(e, 'Could not export the project'); }
  }

  newBtn.addEventListener('click', async () => {
    if (!store.getState().items.length) { toaster.show('Add files on Convert first, then save them as a project.', 'info'); goConvert(); return; }
    await saveFlow(newBtn);
  });
  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const f = importInput.files?.[0];
    importInput.value = '';
    if (!f) return;
    setBusy(true);
    try { const r = await controller.importFile(f); await refresh(); toaster.show(`Imported "${r.name}" (${r.files} file${r.files === 1 ? '' : 's'}). Open it from the list.`, 'success'); srLive(`Imported ${r.name}.`); }
    catch (e) { fail(e, 'Import refused'); } finally { setBusy(false); }
  });
  danger.querySelector('#delete-all').addEventListener('click', async (e) => {
    const ok = await confirmDialog({ title: 'Delete all local data?', message: 'This permanently removes every saved project, original file, edit and thumbnail InvoiceLens stored in this browser. Files in your current workspace stay open until you close the tab.', confirmLabel: 'Delete everything', danger: true, opener: e.currentTarget });
    if (!ok) return;
    try { await controller.removeAll(); await refresh(); toaster.show('All saved projects were deleted from this browser.', 'success'); srLive('All local data deleted.'); } catch (err) { fail(err, 'Could not delete'); }
  });

  /** Shared with the Convert page: ask consent, then save in the browser or hand back a file. */
  async function saveFlow(opener) {
    const count = store.getState().items.length;
    const bytes = controller.workspaceBytes();
    let space = null;
    try { space = await controller.space(bytes); } catch { space = null; }
    const choice = await askSave({ defaultName: controller.status.project?.name ?? `Workspace ${new Date().toISOString().slice(0, 10)}`, files: count, bytes, space, opener });
    if (!choice) return false;
    setBusy(true);
    try {
      if (choice.where === 'file') {
        const { blob, filename } = await controller.exportWorkspace(choice.name);
        download(blob, filename);
        toaster.show(`Downloaded ${filename}.`, 'success');
      } else {
        const r = await controller.saveWorkspace(choice.name);
        toaster.show(`Saved "${choice.name}" in this browser. Changes are saved automatically.${r.persistent ? '' : ' The browser may clear it if storage runs low.'}`, 'success');
        srLive(`Project ${choice.name} saved.`);
      }
      await refresh();
      return true;
    } catch (e) { fail(e, 'Could not save'); return false; } finally { setBusy(false); }
  }

  controller.subscribe(() => { if (!root.closest('[hidden]')) refresh(); });
  return { refresh, saveFlow, dispose: revokeAll, portableName };
}
