// settingsView.js - Settings: general, OCR, export defaults, storage & offline, appearance, processing.
// Every control writes through js/settings.js and has a real effect (stated in its help text). Nothing here is decorative.
import { el, icon } from '../dom.js';
import { SETTINGS_SECTIONS, parseSettingsSection } from '../../router.js';
import { CHOICES } from '../../settings.js';
import { formatBytes } from '../../format.js';
import { confirmDialog } from '../dialogs.js';

const SECTIONS = {
  general: 'General',
  ocr: 'Recognition (OCR)',
  export: 'Export defaults',
  storage: 'Storage & offline',
  appearance: 'Appearance',
  processing: 'Processing',
};

export function createSettingsView({ root, settings, theme, projects, pwa, toaster, srLive }) {
  const nav = el('nav', { class: 'set-nav', 'aria-label': 'Settings sections' }, el('ul', {}, ...SETTINGS_SECTIONS.map((id) => el('li', {}, el('a', { href: `#/settings/${id}`, 'data-section': id }, SECTIONS[id])))));
  const panel = el('div', { class: 'set-panel' });
  const head = el('div', { class: 'page-head' }, el('h1', { class: 'page-title', id: 'settings-title' }, 'Settings'), el('p', { class: 'page-sub' }, 'Customize InvoiceLens to fit your workflow. Preferences are stored on this device only.'));
  root.replaceChildren(head, el('div', { class: 'set-layout' }, nav, panel));
  let section = 'general';

  // ------------------------------------------------------------------ control builders
  let uid = 0;
  const row = (label, control, help, id) => el('div', { class: 'set-row' }, el('div', { class: 'set-text' }, el('label', { for: id }, label), help ? el('p', { class: 'opt-help', id: `${id}-h` }, help) : null), el('div', { class: 'set-ctl' }, control));
  const toggle = (path, label, help) => {
    const id = `set-${(uid += 1)}`;
    const [a, b] = path.split('.');
    const input = el('input', { type: 'checkbox', role: 'switch', id, class: 'switch', checked: settings.value[a][b], 'aria-describedby': help ? `${id}-h` : null });
    input.addEventListener('change', () => { settings.set(path, input.checked); srLive(`${label}: ${input.checked ? 'on' : 'off'}.`); });
    return row(label, input, help, id);
  };
  const select = (path, label, options, help) => {
    const id = `set-${(uid += 1)}`;
    const [a, b] = path.split('.');
    const sel = el('select', { id, class: 'select', 'aria-describedby': help ? `${id}-h` : null }, ...options.map(([v, t]) => el('option', { value: String(v) }, t)));
    sel.value = String(settings.value[a][b]);
    sel.addEventListener('change', () => {
      const allowed = CHOICES[path];
      const v = allowed.find((x) => String(x) === sel.value);
      settings.set(path, v);
      srLive(`${label}: ${sel.selectedOptions[0].textContent}.`);
    });
    return row(label, sel, help, id);
  };
  const info = (label, text) => el('div', { class: 'set-row' }, el('div', { class: 'set-text' }, el('p', { class: 'set-label' }, label), el('p', { class: 'opt-help' }, text)));
  const section_ = (title, intro, ...rows) => el('section', { class: 'set-section', 'aria-labelledby': 'set-sec-title' }, el('h2', { class: 'set-title', id: 'set-sec-title' }, title), intro ? el('p', { class: 'opt-help set-intro' }, intro) : null, ...rows);

  // ------------------------------------------------------------------ sections
  const build = {
    general: () => section_('General', null,
      toggle('general.warnUnsaved', 'Warn before leaving with unsaved edits', 'Shows the browser\'s "leave site?" prompt if you close or reload the tab while edits are not saved to a project.'),
      info('Language', 'English only. There is no language switcher in this version.'),
      info('Privacy', 'Everything runs on this device. Files are never uploaded, and there is no account, analytics or telemetry. Settings store preferences only (no file names or content).'),
      el('div', { class: 'set-row' }, el('div', { class: 'set-text' }, el('p', { class: 'set-label' }, 'Reset'), el('p', { class: 'opt-help' }, 'Restore every setting on this page to its default. Saved projects are not touched.')),
        el('div', { class: 'set-ctl' }, el('button', { type: 'button', class: 'btn btn-secondary', id: 'reset-settings', onclick: () => { settings.reset(); theme.setPref('system'); toaster.show('Settings reset to defaults.', 'success'); render(); } }, 'Reset settings')))),

    ocr: () => section_('Recognition (OCR)', 'These apply to the next file that is recognized. Files already recognized keep their result (use Retry to run them again).',
      select('ocr.enhance', 'Enhanced image pass', [['auto', 'Automatic (recommended)'], ['never', 'Never']], 'Automatic: pages that look weak are retried on a cleaned-up copy (lighting flattened, straightened) and the better result is kept. Never: one plain pass only (faster).'),
      select('ocr.maxPages', 'Pages per PDF', CHOICES['ocr.maxPages'].map((n) => [n, `Up to ${n} pages`]), 'PDFs with more pages are refused with a clear message instead of freezing the browser.'),
      select('ocr.maxMegapixels', 'Page image size', CHOICES['ocr.maxMegapixels'].map((n) => [n, `Up to ${n} megapixels`]), 'Larger images are scaled down before recognition. Lower values use less memory (useful on phones) but can lose small print.'),
      info('Language', 'English recognition only.')),

    export: () => section_('Export defaults', 'The Export dialog opens with these choices (you can still change them each time).',
      select('export.format', 'Default format', [['pdf', 'PDF'], ['docx', 'Word (.docx)'], ['xlsx', 'Excel (.xlsx)'], ['csv', 'Google Sheets (CSV)']]),
      select('export.pdfMode', 'PDF content', [['structured', 'Structured (editable text and tables)'], ['original', 'Original appearance (page images)']]),
      toggle('export.includeNotes', 'Include review notes', 'Lists the checks that are still open when the file is made.'),
      toggle('export.includeText', 'Include recognized page text'),
      toggle('export.textLayer', 'Searchable text layer in original-appearance PDFs', 'Invisible words as recognized (not your edits), for search and copy.'),
      toggle('export.labelPages', 'Label pages in combined PDFs with their source file')),

    storage: () => {
      const usage = el('p', { class: 'opt-help', id: 'set-usage', role: 'status' }, 'Checking…');
      const persist = el('p', { class: 'opt-help', id: 'set-persist' });
      const refresh = async () => {
        try {
          const u = await projects.usage();
          const est = await navigator.storage?.estimate?.();
          usage.textContent = `${u.projects} saved ${u.projects === 1 ? 'project' : 'projects'} (${u.files} ${u.files === 1 ? 'file' : 'files'}, ${formatBytes(u.bytes)} of originals)${est?.quota ? ` · this site uses ${formatBytes(est.usage ?? 0)} of about ${formatBytes(est.quota)}` : ''}.`;
        } catch { usage.textContent = projects.unavailable ?? 'Saved projects are not available in this browser.'; }
        try { persist.textContent = (await navigator.storage?.persisted?.()) ? 'Persistent storage: granted. The browser will not clear saved projects automatically.' : 'Persistent storage: not granted. The browser may clear saved projects if it runs low on space.'; } catch { persist.textContent = ''; }
      };
      refresh();
      const askPersist = el('button', { type: 'button', class: 'btn btn-secondary', id: 'ask-persist', onclick: async () => { const ok = await navigator.storage?.persist?.().catch(() => false); toaster.show(ok ? 'Persistent storage granted.' : 'The browser declined. Saved projects may be cleared if space runs low.', ok ? 'success' : 'info'); refresh(); } }, 'Request persistent storage');
      const del = el('button', { type: 'button', class: 'btn btn-danger', id: 'set-delete-all', onclick: async (e) => {
        const ok = await confirmDialog({ title: 'Delete all local data?', message: 'This permanently removes every saved project, original file, edit and thumbnail stored in this browser. Settings and offline files are kept.', confirmLabel: 'Delete everything', danger: true, opener: e.currentTarget });
        if (!ok) return;
        try { await projects.removeAll(); toaster.show('All saved projects were deleted from this browser.', 'success'); srLive('All local data deleted.'); refresh(); } catch (err) { toaster.show(`Could not delete: ${err.message}`, 'error'); }
      } }, icon('trash', 'icon-sm'), 'Delete all local data');
      return section_('Storage & offline', 'Where InvoiceLens keeps things on this device.',
        el('div', { class: 'set-row' }, el('div', { class: 'set-text' }, el('p', { class: 'set-label' }, 'Saved projects'), usage, persist, el('p', { class: 'opt-help' }, 'Nothing is saved unless you create a project. ', el('a', { href: '#/projects' }, 'Manage saved projects'))), el('div', { class: 'set-ctl set-ctl-col' }, askPersist, del)),
        offlineRow());
    },

    appearance: () => {
      const id = 'set-theme';
      const pref = theme.getPref();
      const group = el('div', { role: 'radiogroup', 'aria-labelledby': `${id}-l`, class: 'set-radios' },
        ...[['light', 'Light'], ['dark', 'Dark'], ['system', 'System']].map(([v, t]) => {
          const input = el('input', { type: 'radio', name: id, id: `${id}-${v}`, value: v, checked: pref === v });
          input.addEventListener('change', () => { theme.setPref(v); srLive(`Theme: ${t}.`); });
          return el('label', { class: 'set-radio', for: `${id}-${v}` }, input, t);
        }));
      return section_('Appearance', null,
        el('div', { class: 'set-row' }, el('div', { class: 'set-text' }, el('p', { class: 'set-label', id: `${id}-l` }, 'Theme'), el('p', { class: 'opt-help' }, 'System follows your device. The top bar theme button changes the same setting.')), el('div', { class: 'set-ctl' }, group)),
        select('appearance.motion', 'Motion', [['system', 'Follow my device'], ['reduce', 'Always reduce motion']], 'Reduced motion removes transitions and animations. Your device\'s "reduce motion" setting is always respected.'));
    },

    processing: () => section_('Processing', null,
      info('Recognition queue', 'Files are recognized one at a time (one OCR worker) to keep the browser responsive. This is not adjustable: a second worker would double memory use. Pause and Cancel are on the Batch page.'),
      select('processing.autosaveSeconds', 'Project autosave delay', CHOICES['processing.autosaveSeconds'].map((n) => [n, `${n} seconds after the last change`]), 'Only applies to a project you saved in this browser. Longer delays write less often; a failed save is always reported.'),
      info('Everything stays local', 'Recognition, editing and export run in your browser. No file leaves this device.')),
  };

  function offlineRow() {
    if (!pwa) return null;
    const status = el('p', { class: 'opt-help', id: 'offline-status', role: 'status' }, 'Checking…');
    const groups = el('ul', { class: 'offline-list', id: 'offline-groups' });
    const dl = el('button', { type: 'button', class: 'btn btn-secondary', id: 'offline-download' }, icon('download', 'icon-sm'), 'Download for offline use');
    const rm = el('button', { type: 'button', class: 'btn btn-secondary', id: 'offline-remove' }, 'Remove offline files');
    const inst = el('button', { type: 'button', class: 'btn btn-secondary', id: 'pwa-install', hidden: true }, 'Install app');
    const meter = el('div', { class: 'meter', role: 'progressbar', 'aria-label': 'Offline download progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', hidden: true }, el('span'));
    const render = async () => {
      const s = await pwa.status();
      status.textContent = s.message;
      groups.replaceChildren(...s.groups.map((g) => el('li', {}, `${g.label}: `, el('strong', {}, g.complete ? 'available offline' : g.cached ? `partly downloaded (${g.cached}/${g.total} files)` : 'not downloaded'), ` · ${formatBytes(g.bytes)}`)));
      dl.disabled = !s.supported || s.groups.every((g) => g.complete) || s.downloading;
      rm.disabled = !s.supported || !s.groups.some((g) => g.cached);
      inst.hidden = !s.canInstall;
    };
    dl.addEventListener('click', async () => {
      meter.hidden = false; dl.disabled = true;
      try { await pwa.download((done, total) => { const v = Math.round((done / total) * 100); meter.firstElementChild.style.width = `${v}%`; meter.setAttribute('aria-valuenow', String(v)); status.textContent = `Downloading ${done} of ${total} files…`; }); toaster.show('Everything needed for offline use is now stored on this device.', 'success'); srLive('Offline files downloaded.'); }
      catch (e) { toaster.show(`Offline download failed: ${e.message}`, 'error'); } finally { meter.hidden = true; render(); }
    });
    rm.addEventListener('click', async () => { await pwa.clear(); toaster.show('Offline files removed. Saved projects and settings are untouched.', 'info'); render(); });
    inst.addEventListener('click', async () => { const r = await pwa.install(); toaster.show(r === 'accepted' ? 'Installing InvoiceLens…' : 'Install dismissed.', 'info'); render(); });
    pwa.subscribe(render);
    render();
    return el('div', { class: 'set-row' }, el('div', { class: 'set-text' }, el('p', { class: 'set-label' }, 'Offline use & install'), status, groups,
      el('p', { class: 'opt-help' }, 'Recognition needs about 12 MB of program files. They are fetched once from this site and kept in a cache; your documents are never cached. First use while offline is not possible.'), meter),
      el('div', { class: 'set-ctl set-ctl-col' }, dl, rm, inst));
  }

  function render() {
    section = parseSettingsSection(location.hash);
    for (const a of nav.querySelectorAll('a')) { if (a.dataset.section === section) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    uid = 0;
    panel.replaceChildren(build[section]());
  }

  window.addEventListener('hashchange', () => { if (/^#\/?settings/.test(location.hash)) render(); });
  settings.subscribe(() => {}); // values are written by the controls themselves; the panel is not rebuilt (keeps focus)
  render();
  return { render };
}
