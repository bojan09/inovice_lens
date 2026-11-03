// pwa.js - page side of the offline support: registers the service worker, reports what is really cached, downloads /
// removes the vendored libraries on request, handles "install" and "update available". The worker itself (sw.js) is generated
// by scripts/build-pwa.js. Only static program files are ever cached; user documents never are.
import { PWA } from './pwa-manifest.js';

export function createPwa({ nav = globalThis.navigator, win = globalThis.window, caches_ = globalThis.caches } = {}) {
  const listeners = new Set();
  let reg = null;
  let updateReady = false;
  let installEvent = null;
  let downloading = false;
  let reloading = false;
  const emit = () => listeners.forEach((fn) => fn());
  const supported = !!(nav?.serviceWorker && caches_ && win?.isSecureContext);

  async function register(url = 'sw.js') {
    if (!supported) return null;
    try {
      reg = await nav.serviceWorker.register(url, { scope: './' });
    } catch { return null; }
    const watch = (w) => w?.addEventListener('statechange', () => { if (w.state === 'installed' && nav.serviceWorker.controller) { updateReady = true; emit(); } });
    if (reg.waiting && nav.serviceWorker.controller) { updateReady = true; emit(); }
    reg.addEventListener('updatefound', () => watch(reg.installing));
    nav.serviceWorker.addEventListener('controllerchange', () => { if (reloading) win.location.reload(); emit(); });
    reg.update().catch(() => {}); // check for a new version now (the browser also checks on navigation)
    return reg;
  }

  const origin = (p) => new URL(p, win.location.href).href;

  async function status() {
    const groups = [];
    let cacheNames = [];
    if (supported) { try { cacheNames = await caches_.keys(); } catch { cacheNames = []; } }
    const vendorCache = supported && cacheNames.includes(PWA.vendorCache) ? await caches_.open(PWA.vendorCache) : null;
    const have = new Set(vendorCache ? (await vendorCache.keys()).map((r) => new URL(r.url).pathname) : []);
    for (const g of PWA.groups) {
      const cached = g.files.filter((f) => have.has(new URL(f.path, win?.location?.href ?? 'http://x/').pathname)).length;
      groups.push({ id: g.id, label: g.label, total: g.files.length, cached, complete: cached === g.files.length && g.files.length > 0, bytes: g.files.reduce((n, f) => n + f.bytes, 0) });
    }
    const controlled = !!nav?.serviceWorker?.controller;
    const allReady = groups.every((g) => g.complete);
    let message;
    if (!supported) message = 'Offline use is not available here: it needs a secure (https or localhost) page and a browser with service workers.';
    else if (!controlled) message = 'Setting up offline support… reload the page once if this does not change.';
    else if (updateReady) message = 'A new version of InvoiceLens is ready. Reload to use it.';
    else if (allReady) message = 'Ready for offline use: the app and everything it needs are stored on this device.';
    else message = 'The app itself opens offline. Recognition and export also need the files below: download them once while you are online.';
    return { supported, controlled, updateReady, downloading, canInstall: !!installEvent, groups, message };
  }

  /** Fetch every vendored file not yet cached. onProgress(done, total). Throws if any file cannot be fetched. */
  async function download(onProgress = () => {}) {
    if (!supported) throw new Error('Offline use is not available in this browser.');
    downloading = true; emit();
    try {
      const cache = await caches_.open(PWA.vendorCache);
      const have = new Set((await cache.keys()).map((r) => new URL(r.url).pathname));
      const todo = PWA.groups.flatMap((g) => g.files).filter((f) => !have.has(new URL(f.path, win.location.href).pathname));
      let done = 0;
      onProgress(0, todo.length);
      const queue = [...todo];
      const worker = async () => {
        for (let f = queue.shift(); f; f = queue.shift()) {
          const res = await fetch(origin(f.path), { cache: 'no-cache' });
          if (!res.ok) throw new Error(`${f.path} could not be downloaded (${res.status}).`);
          await cache.put(origin(f.path), res);
          done += 1; onProgress(done, todo.length);
        }
      };
      await Promise.all([worker(), worker(), worker()]);
    } finally { downloading = false; emit(); }
  }

  async function clear() {
    if (!supported) return;
    await caches_.delete(PWA.vendorCache);
    emit();
  }

  async function install() {
    if (!installEvent) return 'unavailable';
    installEvent.prompt();
    const r = await installEvent.userChoice.catch(() => ({ outcome: 'dismissed' }));
    installEvent = null; emit();
    return r.outcome;
  }

  /** Activate the waiting worker and reload once it has taken control. */
  function applyUpdate() {
    if (!reg?.waiting) return false;
    reloading = true;
    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    return true;
  }

  win?.addEventListener?.('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; emit(); });
  win?.addEventListener?.('appinstalled', () => { installEvent = null; emit(); });

  return { supported, register, status, download, clear, install, applyUpdate, get updateReady() { return updateReady; }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
}
