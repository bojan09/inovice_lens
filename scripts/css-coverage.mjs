#!/usr/bin/env node
// Dev tool: runs a scripted tour of every screen/dialog/state in Chromium with CSS coverage on, and lists rules that were never
// used. Rules are only reported, never deleted automatically. Usage: node scripts/css-coverage.mjs
import { startApp, fixture, VIEWPORTS } from '../tests/browser/helpers.js';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const app = await startApp();
const used = new Map(); // url -> Set of used [start,end]
const total = new Map(); // url -> text

for (const vpName of ['desktop', 'mobile']) {
  const { page, context } = await app.newPage({ viewport: VIEWPORTS[vpName], reducedMotion: 'reduce', acceptDownloads: true });
  await page.coverage.startCSSCoverage();
  const go = async (h) => { await page.evaluate((x) => { location.hash = x; }, h); await page.waitForTimeout(150); };
  await page.goto(app.base);
  await page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…');
  await go('#/batch'); await go('#/projects'); for (const s of ['general', 'ocr', 'export', 'storage', 'appearance', 'processing']) await go(`#/settings/${s}`);
  await go('#/convert');
  const buf = (n, t) => ({ name: n, mimeType: t, buffer: readFileSync(fixture(n)) });
  await page.setInputFiles('#file-input', [buf('invoice-scan.png', 'image/png'), buf('receipt-scan.jpg', 'image/jpeg'), buf('broken.pdf', 'application/pdf'), { name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('nope') }]);
  await page.waitForFunction(() => [...document.querySelectorAll('.file-card')].every((c) => ['recognized', 'review', 'failed'].includes(c.dataset.status)) && document.querySelectorAll('.file-card').length === 3, null, { timeout: 120000 });
  await page.click('.file-card details > summary').catch(() => {});
  await page.click('#theme-btn').catch(() => {}); await page.keyboard.press('Escape');
  await go('#/batch'); await page.locator('#batch-table tbody input[type=checkbox]').first().check().catch(() => {}); await page.click('#q-pause').catch(() => {}); await page.click('#q-pause').catch(() => {});
  await go('#/convert');
  await page.click('#save-project-btn'); await page.waitForSelector('dialog.dlg[open]'); await page.check('dialog.dlg input[value="file"]').catch(() => {}); await page.click('dialog.dlg button:has-text("Cancel")');
  await page.locator('.file-card a:has-text("Review")').first().click();
  await page.waitForSelector('.editor:not([hidden])'); await page.waitForTimeout(800);
  if (vpName === 'mobile') await page.click('#pane-tab-edit');
  await page.fill('#fld-total', 'EUR 250.00'); await page.click('.rv-toggle').catch(() => {});
  if (vpName === 'mobile') { for (const id of ['preview', 'original', 'edit']) await page.click(`#pane-tab-${id}`); } else await page.click('[aria-label="Show all recognized text regions"]').catch(() => {});
  for (const t of ['table', 'text', 'fields']) await page.click(`#tab-${t}`);
  await page.click('#ed-export'); await page.waitForSelector('.exp[open]');
  const ready = () => page.waitForFunction(() => /^Ready:/.test(document.querySelector('.exp-status').textContent) || document.querySelector('.exp-error').textContent, null, { timeout: 60000 });
  await ready();
  for (const f of ['pdf', 'docx', 'xlsx', 'csv']) { await page.check(`#exp-format-${f}`); await ready(); }
  await page.check('#exp-format-pdf'); await page.check('#exp-mode-original'); await ready();
  await page.keyboard.press('Escape');
  await go('#/convert'); await page.setInputFiles('#file-input', buf('invoice-text.pdf', 'application/pdf')); await page.waitForTimeout(1500);
  await go('#/projects');
  const entries = await page.coverage.stopCSSCoverage();
  for (const e of entries) {
    if (!e.url.includes('/css/')) continue;
    total.set(e.url, e.text);
    const set = used.get(e.url) ?? new Set();
    for (const r of e.ranges) set.add(`${r.start}:${r.end}`);
    used.set(e.url, set);
  }
  await context.close();
}
await app.close();

const report = {};
let allBytes = 0; let allUsed = 0;
for (const [url, text] of total) {
  const mask = new Uint8Array(text.length);
  for (const k of used.get(url)) { const [s, e] = k.split(':').map(Number); mask.fill(1, s, e); }
  const name = new URL(url).pathname.replace(/^\//, '');
  const usedBytes = mask.reduce((a, b) => a + b, 0);
  allBytes += text.length; allUsed += usedBytes;
  // unused top-level rules (selector text) for review
  const unusedRules = [];
  const re = /([^{}]+)\{[^{}]*\}/g; let m;
  while ((m = re.exec(text))) { const slice = mask.subarray(m.index, m.index + m[0].length); if (!slice.some((b) => b === 1)) unusedRules.push(m[1].trim().replace(/\s+/g, ' ').slice(0, 90)); }
  report[name] = { bytes: text.length, usedPct: Math.round((usedBytes / text.length) * 1000) / 10, unusedRules };
}
report.TOTAL = { bytes: allBytes, usedPct: Math.round((allUsed / allBytes) * 1000) / 10 };
mkdirSync(join(ROOT, 'docs/qa'), { recursive: true });
writeFileSync(join(ROOT, 'docs/qa/css-coverage.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(report).map(([k, v]) => [k, `${v.usedPct}% of ${v.bytes} B, ${v.unusedRules?.length ?? ''} unused rules`])), null, 1));
