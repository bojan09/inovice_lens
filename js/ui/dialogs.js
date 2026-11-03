// dialogs.js - small promise-based modal dialogs on the native <dialog> element (focus trap, Esc, inert page behind).
import { el } from './dom.js';

function open(dlg, opener) {
  document.body.append(dlg);
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => { dlg.remove(); (opener ?? null)?.focus?.(); resolve(dlg.returnValue); });
    dlg.showModal();
  });
}

/** @returns {Promise<boolean>} true when confirmed. Cancel is the default focus so Enter never confirms by accident. */
export async function confirmDialog({ title, message, details = null, confirmLabel = 'Confirm', danger = false, opener = null }) {
  const id = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  const cancel = el('button', { type: 'submit', value: 'cancel', class: 'btn btn-secondary', autofocus: true }, 'Cancel');
  const ok = el('button', { type: 'submit', value: 'ok', class: `btn ${danger ? 'btn-danger' : 'btn-primary'}` }, confirmLabel);
  const dlg = el('dialog', { class: 'dlg', 'aria-labelledby': `${id}-t`, 'aria-describedby': `${id}-d` },
    el('form', { method: 'dialog', class: 'dlg-form' },
      el('h2', { id: `${id}-t`, class: 'dlg-title' }, title),
      el('p', { id: `${id}-d`, class: 'dlg-text' }, message),
      details ? el('ul', { class: 'dlg-list' }, ...details.map((d) => el('li', {}, d))) : null,
      el('div', { class: 'dlg-actions' }, cancel, ok)));
  dlg.addEventListener('cancel', () => { dlg.returnValue = 'cancel'; });
  return (await open(dlg, opener)) === 'ok';
}

/** @returns {Promise<string|null>} the entered text, or null when cancelled. */
export async function promptDialog({ title, label, value = '', confirmLabel = 'Save', maxLength = 120, opener = null }) {
  const id = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  const input = el('input', { id: `${id}-i`, class: 'input', type: 'text', value, maxlength: String(maxLength), autocomplete: 'off', required: true });
  const dlg = el('dialog', { class: 'dlg', 'aria-labelledby': `${id}-t` },
    el('form', { method: 'dialog', class: 'dlg-form' },
      el('h2', { id: `${id}-t`, class: 'dlg-title' }, title),
      el('label', { for: `${id}-i`, class: 'dlg-label' }, label), input,
      el('div', { class: 'dlg-actions' },
        el('button', { type: 'submit', value: 'cancel', class: 'btn btn-secondary', formnovalidate: true }, 'Cancel'),
        el('button', { type: 'submit', value: 'ok', class: 'btn btn-primary' }, confirmLabel))));
  dlg.addEventListener('close', () => {}, { once: true });
  const p = open(dlg, opener);
  input.select();
  const r = await p;
  return r === 'ok' && input.value.trim() ? input.value.trim() : null;
}

export { open as openDialog };
