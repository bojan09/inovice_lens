// themeMenu.js - accessible light/dark/system picker (menu button pattern).

import { PREFS, readPref, writePref, applyPref, resolveTheme } from '../theme.js';

const ICON = { light: 'sun', dark: 'moon', system: 'monitor' };
const LABEL = { light: 'Light', dark: 'Dark', system: 'System' };

export function initThemeMenu({ button, menu, buttonIcon, root = document.documentElement, storage = localStorage, onChange }) {
  const items = [...menu.querySelectorAll('[role="menuitemradio"]')];
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  let pref = readPref(storage);

  function render() {
    applyPref(root, pref);
    const shown = resolveTheme(pref, mql.matches);
    buttonIcon.setAttribute('href', `#i-${ICON[pref]}`);
    button.setAttribute('aria-label', `Theme: ${LABEL[pref]}${pref === 'system' ? ` (${shown})` : ''}. Change theme`);
    items.forEach((it) => it.setAttribute('aria-checked', String(it.dataset.themePref === pref)));
    onChange?.({ pref, shown });
  }

  function open() {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    (items.find((i) => i.getAttribute('aria-checked') === 'true') ?? items[0]).focus();
  }
  function close(returnFocus = true) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (returnFocus) button.focus();
  }
  function choose(next) {
    if (!PREFS.includes(next)) return;
    pref = next;
    writePref(storage, pref);
    render();
    close();
  }

  button.addEventListener('click', () => (menu.hidden ? open() : close()));
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
  });
  items.forEach((it, i) => {
    it.addEventListener('click', () => choose(it.dataset.themePref));
    it.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Tab') close(false);
    });
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !button.contains(e.target)) close(false);
  });
  mql.addEventListener('change', () => { if (pref === 'system') render(); });

  render();
  return { getPref: () => pref };
}
