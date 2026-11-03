// Writes screenshot evidence to docs/phase1/screenshots/ (viewport x theme x state).
// This is evidence, not a pixel-diff: the approved reference is an AI-rendered composite, so
// geometry/typography/colour are compared by eye (see docs/PHASE1.md), never by a fake percentage.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startApp, readFixture, VIEWPORTS } from './helpers.js';

const OUT = fileURLToPath(new URL('../../docs/phase1/screenshots/', import.meta.url));
let app;
before(async () => { mkdirSync(OUT, { recursive: true }); app = await startApp(); });
after(async () => { await app.close(); });

const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };
const FILES = ['sample.png', 'sample.jpg', 'sample.pdf'].map((name) => ({ name, mimeType: MIME[name.split('.')[1]], buffer: readFixture(name) }));
const BAD = { name: 'scan-0042.png', mimeType: 'image/png', buffer: readFixture('sample.png').subarray(0, 200) };

for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  for (const scheme of ['light', 'dark']) {
    test(`capture ${vpName} ${scheme}`, async () => {
      const { page, context, problems } = await app.newPage({ viewport: vp, colorScheme: scheme, reducedMotion: 'reduce' });
      await page.goto(app.base);
      await page.waitForFunction(() => document.getElementById('storage-value').textContent !== 'Checking…');
      await page.screenshot({ path: `${OUT}${vpName}-${scheme}-1-empty.png` });

      await page.setInputFiles('#file-input', [...FILES, BAD]);
      await page.waitForSelector('.reject-card');
      await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
      await page.screenshot({ path: `${OUT}${vpName}-${scheme}-2-files.png`, fullPage: true });
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
  await c.page.screenshot({ path: `${OUT}tablet-light-3-drawer.png` });
  await c.context.close();

  c = await app.newPage({ viewport: VIEWPORTS.desktop, colorScheme: 'dark', reducedMotion: 'reduce' });
  await c.page.goto(app.base);
  await c.page.click('#theme-btn');
  await c.page.screenshot({ path: `${OUT}desktop-dark-3-theme-menu.png`, clip: { x: 1040, y: 0, width: 400, height: 220 } });
  await c.page.keyboard.press('Escape');
  await c.page.goto(`${app.base}#/batch`);
  await c.page.screenshot({ path: `${OUT}desktop-dark-4-coming-soon.png` });
  await c.context.close();
});
