// storageMeter.js - shows the browser's own storage estimate (navigator.storage.estimate()).
// Phase 1 persists nothing but the theme preference, so usage is whatever the browser reports
// for this origin. If the API is unavailable the meter says so instead of showing a number.

import { formatBytes, usageFraction } from '../format.js';

export async function updateStorageMeter({ valueEl, meterEl, fillEl }) {
  try {
    const est = await navigator.storage?.estimate?.();
    const frac = est ? usageFraction(est.usage, est.quota) : null;
    if (!est || frac === null) throw new Error('unavailable');
    valueEl.textContent = `${formatBytes(est.usage)} of ${formatBytes(est.quota)}`;
    fillEl.style.width = `${(frac * 100).toFixed(2)}%`;
    meterEl.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
    meterEl.setAttribute('aria-valuetext', `${formatBytes(est.usage)} of ${formatBytes(est.quota)} used`);
    meterEl.hidden = false;
  } catch {
    valueEl.textContent = 'Not available in this browser';
    meterEl.hidden = true;
  }
}
