// messages.js - small helpers shared by the field / table editors: show the validation messages for one
// target, mark the input invalid, and keep aria-describedby in sync.
import { el, icon } from '../dom.js';
import { issuesFor } from '../../doc/validate.js';
import { isEdited } from '../../doc/model.js';

const ICON = { error: 'alert', warning: 'alert', info: 'info' };

/** Messages for one field/cell: validation issues, else the extractor's helper note while unedited. */
export function messagesFor(issues, target, field) {
  const list = issuesFor(issues, target).map((i) => ({ severity: i.severity, text: i.message, id: i.id }));
  if (field && field.note && field.noteLevel === 'info' && !isEdited(field)) list.push({ severity: 'info', text: field.note, id: 'note' });
  return list;
}

export function renderMessages(container, input, list, baseId) {
  const sig = list.map((m) => `${m.severity}:${m.text}`).join('|');
  if (container.dataset.sig !== sig) {
    container.dataset.sig = sig;
    container.replaceChildren(...list.map((m, i) => el('span', { class: `msg msg-${m.severity}`, id: `${baseId}-${i}` }, icon(ICON[m.severity], 'icon-xs'), el('span', {}, `${m.severity === 'error' ? 'Error: ' : m.severity === 'warning' ? 'Check: ' : ''}${m.text}`))));
  }
  const bad = list.some((m) => m.severity === 'error');
  if (bad) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  input.dataset.state = bad ? 'error' : list.some((m) => m.severity === 'warning') ? 'warning' : '';
  if (list.length) input.setAttribute('aria-describedby', list.map((_, i) => `${baseId}-${i}`).join(' ')); else input.removeAttribute('aria-describedby');
}
