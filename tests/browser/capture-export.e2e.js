// Screenshot evidence for the Export sheet -> docs/phase4/screenshots/ (viewport x theme x format).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startApp, fixture, VIEWPORTS } from './helpers.js';

const OUT = fileURLToPath(new URL('../../docs/phase4/screenshots/', import.meta.url));
let app;
before(async () => { mkdirSync(OUT, { recursive: true }); app = await startApp(); });
after(async () => { await app.close(); });

for (const [vpName, scheme] of [['desktop', 'light'], ['desktop', 'dark'], ['tablet', 'light'], ['mobile', 'light'], ['mobile', 'dark'], ['small', 'dark']]) {
  test(`capture export ${vpName} ${scheme}`, async () => {
    const { page, context, problems } = await app.newPage({ viewport: VIEWPORTS[vpName], colorScheme: scheme, reducedMotion: 'reduce' });
    await page.goto(app.base);
    await page.waitForFunction(() => document.getElementById('storage-value').textContent !== 'Checking…');
    await page.setInputFiles('#file-input', fixture('invoice-scan.png'));
    await page.waitForSelector('.file-card[data-status="recognized"]', { timeout: 90000 });
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await page.click('#convert-btn');
    await page.waitForSelector('.exp[open]');
    const ready = () => page.waitForFunction(() => /^Ready:/.test(document.querySelector('.exp-status').textContent), null, { timeout: 60000 });
    await ready();
    const shot = (n) => page.screenshot({ path: `${OUT}${vpName}-${scheme}-${n}.png` });
    await page.waitForFunction(() => document.querySelector('.exp-pv-canvas')?.width > 100);
    await shot('1-pdf-structured');
    await page.check('#exp-mode-original'); await ready(); await page.waitForTimeout(500);
    await shot('2-pdf-original');
    await page.check('#exp-format-xlsx'); await ready(); await shot('3-excel');
    await page.check('#exp-format-csv'); await ready(); await shot('4-sheets-csv');
    assert.deepEqual(problems, []);
    await context.close();
  });
}
