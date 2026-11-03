// nav.js - hash router wiring + tablet/mobile drawer.

import { VIEWS, parseRoute } from '../router.js';

export function initNav({ onRoute } = {}) {
  const sidebar = document.getElementById('sidebar');
  const scrim = document.getElementById('scrim');
  const menuBtn = document.getElementById('menu-btn');
  const main = document.getElementById('main');
  const views = [...document.querySelectorAll('.view')];
  const links = [...document.querySelectorAll('[data-nav]')];
  const drawerMql = window.matchMedia('(max-width: 1023.98px)');
  let first = true;

  const showListeners = new Set();
  function show(id) {
    views.forEach((v) => { v.hidden = v.dataset.view !== id; });
    main.dataset.view = id;
    const active = VIEWS[id].parent ?? id; // the editor lives under Convert in the navigation
    links.forEach((a) => {
      if (a.dataset.nav === active) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    document.title = `${VIEWS[id].title} · InvoiceLens`;
    onRoute?.(id);
    showListeners.forEach((fn) => fn(id));
  }

  function route() {
    const id = parseRoute(location.hash);
    show(id);
    closeDrawer(false);
    if (!first) {
      window.scrollTo(0, 0);
      main.focus({ preventScroll: true }); // move SR/keyboard context to the new view
    }
    first = false;
  }

  // ----- drawer -----
  const focusables = () => [...sidebar.querySelectorAll('a[href], button:not([disabled])')];
  function openDrawer() {
    sidebar.classList.add('is-open');
    scrim.hidden = false;
    menuBtn.setAttribute('aria-expanded', 'true');
    menuBtn.setAttribute('aria-label', 'Close navigation');
    focusables()[0]?.focus();
  }
  function closeDrawer(returnFocus = true) {
    if (!sidebar.classList.contains('is-open')) return;
    sidebar.classList.remove('is-open');
    scrim.hidden = true;
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.setAttribute('aria-label', 'Open navigation');
    if (returnFocus) menuBtn.focus();
  }

  menuBtn.addEventListener('click', () => (sidebar.classList.contains('is-open') ? closeDrawer() : openDrawer()));
  scrim.addEventListener('click', () => closeDrawer());
  document.addEventListener('keydown', (e) => {
    if (!sidebar.classList.contains('is-open')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return; }
    if (e.key === 'Tab') { // keep focus inside the open drawer
      const f = focusables();
      const firstEl = f[0];
      const lastEl = f[f.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    }
  });
  drawerMql.addEventListener('change', () => { if (!drawerMql.matches) closeDrawer(false); });

  window.addEventListener('hashchange', route);
  route();
  return { go: (id) => { location.hash = `#/${id}`; }, onShow: (fn) => { showListeners.add(fn); fn(parseRoute(location.hash)); } };
}
