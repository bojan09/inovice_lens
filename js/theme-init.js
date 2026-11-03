// Classic (non-module) script loaded synchronously in <head> to set data-theme before first
// paint and avoid a flash of the wrong theme. Keep in sync with js/theme.js (THEME_KEY).
(function () {
  try {
    var v = localStorage.getItem('invoicelens.theme');
    if (v === 'light' || v === 'dark') document.documentElement.setAttribute('data-theme', v);
  } catch (e) {
    /* storage blocked: follow system */
  }
})();
