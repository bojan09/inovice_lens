// saveDialog.js - the consent step. Nothing is stored in the browser until the user ticks the box here.
import { el } from '../dom.js';
import { formatBytes } from '../../format.js';

/**
 * @returns {Promise<{where:'browser'|'file', name:string}|null>}
 */
export function askSave({ defaultName, files, bytes, space, opener }) {
  const id = `sv-${Math.random().toString(36).slice(2, 8)}`;
  const name = el('input', { id: `${id}-n`, class: 'input', type: 'text', value: defaultName, maxlength: '120', autocomplete: 'off' });
  const where = { browser: el('input', { type: 'radio', name: `${id}-w`, id: `${id}-wb`, value: 'browser', checked: true }), file: el('input', { type: 'radio', name: `${id}-w`, id: `${id}-wf`, value: 'file' }) };
  const consent = el('input', { type: 'checkbox', id: `${id}-c`, 'aria-describedby': `${id}-cd` });
  const err = el('p', { class: 'dlg-error', role: 'alert' });
  const spaceLine = el('p', { class: `dlg-space space-${space?.level ?? 'unknown'}` }, space?.message ?? '');
  const save = el('button', { type: 'submit', value: 'ok', class: 'btn btn-primary' }, 'Save project');
  const consentRow = el('div', { class: 'opt' }, consent, el('label', { for: `${id}-c` }, 'Store these files and my edits in this browser, and keep them updated automatically.'),
    el('p', { class: 'opt-help', id: `${id}-cd` }, 'Saved on this device only (IndexedDB). Nothing is uploaded. You can delete it any time on the Saved Projects page; clearing your browser data also removes it.'));
  const sync = () => {
    const browser = where.browser.checked;
    consentRow.hidden = !browser;
    save.textContent = browser ? 'Save in this browser' : 'Download project file';
    save.disabled = browser && (space?.level === 'block');
  };
  where.browser.addEventListener('change', sync); where.file.addEventListener('change', sync);
  const dlg = el('dialog', { class: 'dlg dlg-wide', 'aria-labelledby': `${id}-t` },
    el('form', { method: 'dialog', class: 'dlg-form' },
      el('h2', { id: `${id}-t`, class: 'dlg-title' }, 'Save project'),
      el('p', { class: 'dlg-text' }, `${files} ${files === 1 ? 'file' : 'files'}, ${formatBytes(bytes)} of originals, plus recognized text and your edits.`),
      el('label', { for: `${id}-n`, class: 'dlg-label' }, 'Project name'), name,
      el('fieldset', { class: 'exp-set' }, el('legend', {}, 'Where'),
        el('div', { class: 'opt' }, where.browser, el('label', { for: `${id}-wb` }, 'In this browser (autosaved)'), el('p', { class: 'opt-help' }, 'Resume later from Saved Projects, even after closing the tab.')),
        el('div', { class: 'opt' }, where.file, el('label', { for: `${id}-wf` }, 'As a file to download'), el('p', { class: 'opt-help' }, 'A portable .invoicelens.zip you keep yourself. Nothing is stored in the browser.'))),
      consentRow, spaceLine, err,
      el('div', { class: 'dlg-actions' }, el('button', { type: 'submit', value: 'cancel', class: 'btn btn-secondary', formnovalidate: true }, 'Cancel'), save)));
  sync();
  return new Promise((resolve) => {
    let result = null;
    dlg.querySelector('form').addEventListener('submit', (e) => {
      if (e.submitter?.value !== 'ok') return;
      if (where.browser.checked && !consent.checked) { e.preventDefault(); err.textContent = 'Tick the box to allow saving in this browser, or choose "As a file".'; consent.focus(); return; }
      if (!name.value.trim()) { e.preventDefault(); err.textContent = 'Give the project a name.'; name.focus(); return; }
      result = { where: where.browser.checked ? 'browser' : 'file', name: name.value.trim() };
    });
    dlg.addEventListener('close', () => { dlg.remove(); opener?.focus?.(); resolve(result); });
    document.body.append(dlg);
    dlg.showModal();
    name.select();
  });
}
