// toast.js - transient notifications. The container is role="status" aria-live="polite" so
// messages are announced without stealing focus. Dismiss on timer, close button, or Escape-free
// (focus is never moved).

import { el, icon } from './dom.js';

const ICONS = { success: 'check-circle', error: 'alert', info: 'info' };

export function createToaster(container, { timeout = 6000 } = {}) {
  function show(message, kind = 'info') {
    const node = el('div', { class: `toast toast-${kind}` });
    const dismiss = () => node.remove();
    node.append(
      icon(ICONS[kind] ?? ICONS.info),
      el('p', {}, message),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Dismiss notification', onclick: dismiss }, icon('x')),
    );
    container.append(node);
    while (container.children.length > 3) container.firstElementChild.remove();
    if (timeout > 0) {
      let timer = setTimeout(dismiss, timeout);
      node.addEventListener('mouseenter', () => clearTimeout(timer));
      node.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, timeout); });
      node.addEventListener('focusin', () => clearTimeout(timer));
    }
    return node;
  }
  return { show };
}
