// space.js - is there room to save? Uses the browser's storage estimate (an ESTIMATE: it can be rounded, capped, or
// unavailable). The result is advice shown before saving; the real guard is that a failed write is reported honestly.
import { formatBytes } from '../format.js';

export const WARN_RATIO = 0.8;

/** @param {number} needed bytes about to be written (originals); @returns {Promise<{level:'ok'|'warn'|'block'|'unknown', usage:number|null, quota:number|null, free:number|null, message:string}>} */
export async function checkSpace(needed, { storage = globalThis.navigator?.storage } = {}) {
  let est = null;
  try { est = await storage?.estimate?.(); } catch { est = null; }
  if (!est || !Number.isFinite(est.quota) || est.quota <= 0) {
    return { level: 'unknown', usage: null, quota: null, free: null, message: `The browser did not report how much space is free. Saving needs about ${formatBytes(needed)}; if it does not fit, the save fails and nothing is lost.` };
  }
  const usage = est.usage ?? 0;
  const free = est.quota - usage;
  const need = Math.ceil(needed * 1.1) + 1024 * 1024; // a little headroom for results, edits and indexes
  if (need > free) return { level: 'block', usage, quota: est.quota, free, message: `Not enough space: saving needs about ${formatBytes(need)} but only about ${formatBytes(Math.max(0, free))} is free for this site. Delete a saved project or remove large files first.` };
  if ((usage + need) / est.quota > WARN_RATIO) return { level: 'warn', usage, quota: est.quota, free, message: `Storage will be ${Math.round(((usage + need) / est.quota) * 100)}% full after saving (about ${formatBytes(free - need)} left).` };
  return { level: 'ok', usage, quota: est.quota, free, message: `About ${formatBytes(free)} is free for this site.` };
}

/** Ask the browser not to evict our data under pressure. Best effort; returns whether it is persistent now. */
export async function requestPersistence({ storage = globalThis.navigator?.storage } = {}) {
  try {
    if (await storage?.persisted?.()) return true;
    return !!(await storage?.persist?.());
  } catch { return false; }
}
