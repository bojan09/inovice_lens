#!/usr/bin/env node
// Dev tool: CPU-profiles the main thread during the core journey (4x CPU slowdown) and prints the heaviest functions
// and the longest tasks. Usage: node scripts/profile-journey.mjs [--no-throttle]
import { startApp, fixture, VIEWPORTS } from '../tests/browser/helpers.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const throttle = !process.argv.includes('--no-throttle');
const app = await startApp();
const { page, context } = await app.newPage({ viewport: VIEWPORTS.mobile, hasTouch: true, isMobile: true, reducedMotion: 'reduce', acceptDownloads: true });
await page.goto(app.base);
await page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…');
const cdp = await context.newCDPSession(page);
await page.evaluate(() => { window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push({ d: Math.round(e.duration), at: Math.round(e.startTime), label: window.__phase }); }).observe({ entryTypes: ['longtask'] }); });
if (throttle) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
await cdp.send('Profiler.start');
const phase = (p) => page.evaluate((x) => { window.__phase = x; }, p);
const img = (n) => ({ name: n, mimeType: n.endsWith('.png') ? 'image/png' : 'image/jpeg', buffer: readFileSync(`${ROOT}corpus/docs/${n}`) });

await phase('recognize');
await page.setInputFiles('#file-input', [img('syn-inv-03-c-photo.jpg'), img('syn-rec-26-b-photo.jpg')]);
await page.waitForFunction(() => document.querySelectorAll('.file-card').length === 2 && [...document.querySelectorAll('.file-card')].every((c) => ['recognized', 'review'].includes(c.dataset.status)), null, { timeout: 240000 });
await phase('open-editor');
await page.evaluate(() => { location.hash = '#/editor/f1'; });
await page.waitForSelector('.editor:not([hidden])'); await page.waitForSelector('.vw-busy[hidden]', { state: 'attached' });
await phase('edit');
await page.click('#pane-tab-edit');
for (let i = 0; i < 6; i += 1) await page.fill('#fld-supplier', `Name ${i}`);
await page.click('#tab-table'); await page.click('#tab-text'); await page.click('#tab-fields');
await phase('export');
await page.click('#ed-export'); await page.waitForSelector('.exp[open]');
await page.waitForFunction(() => /^Ready:/.test(document.querySelector('.exp-status').textContent), null, { timeout: 120000 });
await phase('done');
const { profile } = await cdp.send('Profiler.stop');
const long = await page.evaluate(() => window.__long);
await context.close(); await app.close();

// self time per function
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = profile.timeDeltas;
profile.samples.forEach((id, i) => {
  const n = byId.get(id); const f = n.callFrame;
  if (['(idle)', '(program)', '(garbage collector)'].includes(f.functionName) && f.functionName !== '(garbage collector)') return;
  const key = `${f.functionName || '(anonymous)'} ${f.url.replace(/^.*\/\/[^/]+/, '')}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
});
const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${Math.round(v).toString().padStart(6)} ms  ${k}`);
console.log(`throttle=${throttle}\nlong tasks (>50 ms): ${long.length}; >200 ms: ${long.filter((l) => l.d > 200).length}; longest ${Math.max(0, ...long.map((l) => l.d))} ms`);
console.log(long.filter((l) => l.d > 150).map((l) => `  ${l.d} ms in "${l.label}"`).join('\n'));
console.log('self time, heaviest first:\n' + top.join('\n'));
