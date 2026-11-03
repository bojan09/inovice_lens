#!/usr/bin/env node
// Runs the REAL app (pdf.js + Tesseract + editor extraction) in Chromium over corpus/docs/* and writes
// predictions in the eval format to corpus/predictions/<id>.json (git-ignored), then prints doc-type accuracy.
// Predictions are read from what the editor shows right after opening: no user edits.
// Usage: node tests/eval/predict.mjs [--split all|tune|heldout]   then: npm run eval -- corpus/predictions --split tune
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from '../browser/helpers.js';
import { parseAmount } from '../../js/money.js';
import { splitDocs } from './metrics.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const docsDir = join(root, 'corpus', 'docs');
const truthDir = join(root, 'corpus', 'truth');
const outDir = join(root, 'corpus', 'predictions');
mkdirSync(outDir, { recursive: true });
const args = process.argv.slice(2);
const split = args.includes('--split') ? args[args.indexOf('--split') + 1] : 'all';

const ids = readdirSync(truthDir).filter((f) => f.endsWith('.json') && f !== 'schema.json').map((f) => basename(f, '.json')).sort();
const { tune, heldOut } = splitDocs(ids, { seed: 'invoice-lens', heldOutFraction: 0.3 });
const pick = split === 'tune' ? tune : split === 'heldout' ? heldOut : ids;
const files = readdirSync(docsDir);
const minor = (t) => { if (!t || !t.trim()) return null; const r = parseAmount(t); return r.ambiguous ? null : r.minor; };

const app = await startApp();
const summary = [];
for (const id of pick) {
  const file = files.find((f) => basename(f, extname(f)) === id);
  if (!file) { console.error(`no document for ${id}`); continue; }
  const { page, context } = await app.newPage({ reducedMotion: 'reduce' });
  const t0 = Date.now();
  try {
    await page.goto(app.base);
    await page.waitForFunction(() => document.getElementById('storage-value')?.textContent !== 'Checking…');
    await page.setInputFiles('#file-input', join(docsDir, file));
    await page.waitForFunction(() => ['recognized', 'review', 'failed'].includes(document.querySelector('.file-card')?.dataset.status), null, { timeout: 120000 });
    const status = await page.locator('.file-card').getAttribute('data-status');
    if (status === 'failed') { summary.push({ id, status }); continue; }
    await page.click('.file-card a:has-text("Review")');
    await page.waitForSelector('.editor:not([hidden])');
    const data = await page.evaluate(() => {
      const v = (k) => document.getElementById(`fld-${k}`)?.value ?? '';
      const rows = [...document.querySelectorAll('.ed-table tbody tr')].map((tr) => [...tr.querySelectorAll('input')].map((i) => i.value));
      return {
        type: document.getElementById('ed-type').value,
        f: Object.fromEntries(['supplier', 'customer', 'number', 'issueDate', 'dueDate', 'currency', 'taxRate', 'subtotal', 'tax', 'total'].map((k) => [k, v(k)])),
        rows,
        text: [...document.querySelectorAll('#tabpanel-text textarea')].map((t) => t.value).join('\n'),
        banner: document.querySelector('.rv-text').textContent,
      };
    });
    const e = (s) => (s === '' ? null : s);
    const pred = {
      docType: data.type, supplier: { name: e(data.f.supplier) }, customer: { name: e(data.f.customer) }, number: e(data.f.number),
      issueDate: e(data.f.issueDate), dueDate: e(data.f.dueDate), currency: e(data.f.currency) && /^[A-Z]{3}$/.test(data.f.currency) ? data.f.currency : null,
      taxRatePercent: e(data.f.taxRate), subtotalMinor: minor(data.f.subtotal), taxMinor: minor(data.f.tax), totalMinor: minor(data.f.total),
      rows: data.rows.map((r) => ({ description: e(r[0]), qty: e(r[1]), unitMinor: minor(r[2]), totalMinor: minor(r[3]) })),
      ocrText: data.text,
    };
    // receipts keep qty/unit empty by design; grid docs have a different shape and are not scored here
    writeFileSync(join(outDir, `${id}.json`), JSON.stringify(pred, null, 1));
    const truth = JSON.parse(readFileSync(join(truthDir, `${id}.json`), 'utf8'));
    summary.push({ id, status, suggested: data.type, truthType: truth.docType, flagged: data.banner, ms: Date.now() - t0 });
  } catch (err) {
    summary.push({ id, status: `error: ${err.message.split('\n')[0]}` });
  } finally {
    await context.close();
  }
}
await app.close();
writeFileSync(join(outDir, '_summary.json'), JSON.stringify(summary, null, 1));
const ok = summary.filter((s) => s.suggested);
console.log(`documents processed: ${ok.length}/${pick.length}; type suggestion correct: ${ok.filter((s) => s.suggested === s.truthType).length}/${ok.length}`);
for (const s of summary.filter((s) => !s.suggested || s.suggested !== s.truthType)) console.log('  type mismatch / failure:', JSON.stringify(s));
