// Screenshot evidence for Batch Processing and Saved Projects -> docs/phase5/screenshots/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startApp, fixture, VIEWPORTS } from './helpers.js';

const OUT = fileURLToPath(new URL('../../docs/phase5/screenshots/', import.meta.url));
let app;
before(async () => { mkdirSync(OUT, { recursive: true }); app = await startApp(); });
after(async () => { await app.close(); });

for (const [vpName, scheme] of [['desktop', 'light'], ['desktop', 'dark'], ['laptop', 'light'], ['tablet', 'light'], ['tablet', 'dark'], ['mobile', 'light'], ['mobile', 'dark'], ['small', 'dark']]) {
  test(`capture batch + projects ${vpName} ${scheme}`, async () => {
    const { page, context, problems } = await app.newPage({ viewport: VIEWPORTS[vpName], colorScheme: scheme, reducedMotion: 'reduce' });
    await page.goto(app.base);
    await page.waitForFunction(() => document.getElementById('storage-value').textContent !== 'Checking…');
    const go = async (v) => { await page.evaluate((x) => { location.hash = `#/${x}`; }, v); await page.waitForSelector(`#view-${v}:not([hidden])`); };
    const shot = async (n, full = false) => { await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove())); await page.screenshot({ path: `${OUT}${vpName}-${scheme}-${n}.png`, fullPage: full && VIEWPORTS[vpName].width < 1024 }); };
    await go('batch');
    await shot('1-batch-empty');
    await page.setInputFiles('#file-input', [fixture('invoice-scan.png'), fixture('broken.pdf'), fixture('receipt-scan.jpg'), fixture('table-scan.png')]);
    await page.waitForFunction(() => document.querySelectorAll('#batch-table tbody tr').length === 4);
    await page.waitForSelector('#batch-table tr[data-status="extracting"], #batch-table tr[data-status="preparing"]', { timeout: 30000 }).catch(() => {});
    await page.click('#q-pause').catch(() => {});
    await shot('2-batch-running-paused', true);
    await page.click('#q-pause').catch(() => {});
    await page.waitForFunction(() => !document.querySelector('#batch-table tr[data-status="queued"], #batch-table tr[data-status="preparing"], #batch-table tr[data-status="extracting"]'), null, { timeout: 150000 });
    await page.locator('#batch-table tbody input[type=checkbox]').nth(0).check();
    await page.locator('#batch-table tbody input[type=checkbox]').nth(2).check();
    await shot('3-batch-selected', true);
    await go('convert');
    await page.click('#save-project-btn');
    await page.waitForSelector('dialog.dlg[open]');
    await page.fill('dialog.dlg input[type="text"]', 'November invoices');
    await shot('4-save-dialog');
    await page.check('dialog.dlg input[type="checkbox"]');
    await page.click('dialog.dlg button:has-text("Save in this browser")');
    await page.waitForFunction(() => /Saved \d/.test(document.getElementById('project-status').textContent), null, { timeout: 30000 });
    await go('projects');
    await page.waitForSelector('.proj-card');
    await page.waitForFunction(() => [...document.querySelectorAll('.pc-thumbs img')].every((i) => i.complete && i.naturalWidth > 0));
    await shot('5-projects', true);
    await page.click('.proj-card button:has-text("Delete")');
    await page.waitForSelector('dialog.dlg[open]');
    await shot('6-delete-confirm');
    assert.deepEqual(problems.filter((p) => !/Indexing all PDF objects/.test(p)), []);
    await context.close();
  });
}
