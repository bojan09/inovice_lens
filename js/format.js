// format.js - small display helpers. Pure, no DOM.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Binary (1024) units, e.g. 1536 -> "1.5 KB". Invalid input -> "0 B". */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = i === 0 || v >= 100 ? 0 : v >= 10 ? 1 : 2;
  // trim trailing zeros: "1.50" -> "1.5", "2.00" -> "2"
  const s = v.toFixed(digits).replace(/\.?0+$/, '');
  return `${s} ${UNITS[i]}`;
}

/** Fraction 0..1 used/quota, clamped. Returns null when quota is unknown. */
export function usageFraction(usage, quota) {
  if (!Number.isFinite(usage) || !Number.isFinite(quota) || quota <= 0) return null;
  return Math.min(1, Math.max(0, usage / quota));
}
