// Writes screenshot evidence to docs/phase2/screenshots/ (viewport x theme x state).
// This is evidence, not a pixel-diff: the approved reference is an AI-rendered composite, so
// geometry/typography/colour are compared by eye (see docs/PHASE1.md), never by a fake percentage.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startApp, fixture, VIEWPORTS } from './helpers.js';

const OUT = fileURLToPath(new URL('../../docs/phase2/screenshots/', import.meta.url));
let app;
before(async () => { mkdirSync(OUT, { recursive: true }); app = await startApp(); });
after(async () => { await app.close(); });

const NAMES = ['invoice-scan.png', 'receipt-scan.jpg', 'invoice-text.pdf', 'blank.png', 'encrypted.pdf'];
const TERMINAL = ['recognized', 'review', 'failed', 'cancelled'];

for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  for (const scheme of ['light', 'dark']) {
    test(`capture ${vpName} ${scheme}`, async () => {
      const { page, context, problems } = await app.newPage({ viewport: vp, colorScheme: scheme, reducedMotion: 'reduce' });
      await page.goto(app.base);
      await page.waitForFunction(() => document.getElementById('storage-value').textContent !== 'Checking…');
      await page.screenshot({ path: `${OUT}${vpName}-${scheme}-1-empty.png` });

      await page.setInputFiles('#file-input', NAMES.map(fixture));
      await page.waitForSelector('.file-card[data-status="extracting"]');
      await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
      await page.screenshot({ path: `${OUT}${vpName}-${scheme}-2-recognizing.png`, fullPage: true });
      await page.waitForFunction((term) => {
        const cs = [...document.querySelectorAll('.file-card')];
        return cs.length === 5 && cs.every((c) => term.includes(c.dataset.status));
      }, TERMINAL, { timeout: 120000 });
      await page.locator('.file-card:has(.file-name[title="invoice-scan.png"]) details > summary').click();
      await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
      await page.screenshot({ path: `${OUT}${vpName}-${scheme}-3-results.png`, fullPage: true });
      assert.deepEqual(problems, []);
      await context.close();
    });
  }
}

test('capture tablet drawer + theme menu + coming-soon', async () => {
  let c = await app.newPage({ viewport: VIEWPORTS.tablet, colorScheme: 'light', reducedMotion: 'reduce' });
  await c.page.goto(app.base);
  await c.page.click('#menu-btn');
  await c.page.waitForTimeout(100);
  await c.page.screenshot({ path: `${OUT}tablet-light-4-drawer.png` });
  await c.context.close();

  c = await app.newPage({ viewport: VIEWPORTS.desktop, colorScheme: 'dark', reducedMotion: 'reduce' });
  await c.page.goto(app.base);
  await c.page.click('#theme-btn');
  await c.page.screenshot({ path: `${OUT}desktop-dark-5-theme-menu.png`, clip: { x: 1040, y: 0, width: 400, height: 220 } });
  await c.page.keyboard.press('Escape');
  await c.page.goto(`${app.base}#/batch`);
  await c.page.screenshot({ path: `${OUT}desktop-dark-6-coming-soon.png` });
  await c.context.close();
});
