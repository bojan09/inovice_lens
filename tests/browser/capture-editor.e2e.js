// Writes screenshot evidence to docs/phase3/screenshots/ (viewport x theme x state). Evidence for eyeballing
// against the approved reference, not a pixel diff (the reference is an AI-rendered composite).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startApp, fixture, VIEWPORTS } from './helpers.js';

const OUT = fileURLToPath(new URL('../../docs/phase3/screenshots/', import.meta.url));
let app;
before(async () => { mkdirSync(OUT, { recursive: true }); app = await startApp(); });
after(async () => { await app.close(); });

for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  for (const scheme of ['light', 'dark']) {
    test(`capture editor ${vpName} ${scheme}`, async () => {
      const { page, context, problems } = await app.newPage({ viewport: vp, colorScheme: scheme, reducedMotion: 'reduce' });
      await page.goto(app.base);
      await page.waitForFunction(() => document.getElementById('storage-value').textContent !== 'Checking…');
      await page.setInputFiles('#file-input', fixture('invoice-scan.png'));
      await page.waitForSelector('.file-card[data-status="recognized"]', { timeout: 90000 });
      const clean = () => page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
      await clean();
      await page.click('.file-card a:has-text("Review")');
      await page.waitForSelector('.editor:not([hidden])');
      await page.waitForSelector('.vw-busy[hidden]', { state: 'attached' });
      const small = vp.width < 1024;
      const shot = (n, full = false) => page.screenshot({ path: `${OUT}${vpName}-${scheme}-${n}.png`, fullPage: full && small });
      if (small) await page.click('#pane-tab-edit'); // locating a value then switches back to the Original pane
      await page.locator('#fld-number').locator('xpath=ancestor::div[contains(@class,"fld-input")]').locator('.loc-btn').click();
      await page.waitForSelector('.hl-active');
      await clean();
      await shot('1-original-highlight');
      if (small) await page.click('#pane-tab-edit');
      await page.fill('#fld-total', 'EUR 250.00');
      await page.click('.rv-toggle');
      await clean();
      await shot('2-extracted-warning', true);
      await page.click('#tab-table');
      await shot('3-table', true);
      await page.click('#tab-text');
      await shot('4-text', true);
      if (small) { await page.click('#pane-tab-preview'); await shot('5-preview', true); }
      assert.deepEqual(problems, []);
      await context.close();
    });
  }
}
