#!/usr/bin/env node
// Usage: node tests/eval/run.js <predictionsDir> [--split all|tune|heldout] [--seed S] [--held-out-fraction F]
// Reads corpus/truth/*.json (excluding schema.json) and <predictionsDir>/<id>.json, prints markdown.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fieldScores, splitDocs, characterErrorRate, wordErrorRate } from './metrics.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const truthDir = join(root, 'corpus', 'truth');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

const truthFiles = existsSync(truthDir)
  ? readdirSync(truthDir).filter((f) => f.endsWith('.json') && f !== 'schema.json' && !f.startsWith('_')).sort()
  : [];
if (truthFiles.length === 0) {
  console.log('No documents: corpus/truth/ has no truth files (the corpus is optional). Nothing to evaluate.');
  process.exit(0);
}
const predDir = positional[0];
if (!predDir) { console.error('Usage: node tests/eval/run.js <predictionsDir> [--split all|tune|heldout]'); process.exit(2); }
if (!existsSync(predDir)) { console.error(`Predictions directory not found: ${predDir}`); process.exit(2); }

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const truthAll = {}, preds = {};
for (const f of truthFiles) {
  const id = basename(f, '.json');
  try { truthAll[id] = readJson(join(truthDir, f)); } catch (e) { console.error(`Bad truth file ${f}: ${e.message}`); process.exit(2); }
  const pf = join(predDir, f);
  if (existsSync(pf)) { try { preds[id] = readJson(pf); } catch (e) { console.error(`Bad prediction ${f}: ${e.message}`); process.exit(2); } }
}
const split = opt('--split', 'all');
const { tune, heldOut } = splitDocs(Object.keys(truthAll), { seed: opt('--seed', 'invoice-lens'), heldOutFraction: Number(opt('--held-out-fraction', '0.3')) });
const ids = split === 'tune' ? tune : split === 'heldout' ? heldOut : Object.keys(truthAll);
if (ids.length === 0) { console.log(`No documents in split "${split}" (${Object.keys(truthAll).length} total).`); process.exit(0); }
const truth = Object.fromEntries(ids.map((id) => [id, truthAll[id]]));

const s = fieldScores(preds, truth);
const pct = (v) => (v === null ? 'n/a' : (v * 100).toFixed(1) + '%');
const missing = ids.filter((id) => !preds[id]).length;
console.log(`# InvoiceLens evaluation\n`);
console.log(`Split: ${split} | documents: ${s.docs} | without prediction: ${missing} | exact-match rate: ${pct(s.exactMatchRate)}\n`);
console.log('| Field | Truth | Predicted | Correct | Precision | Recall | F1 |\n|---|---|---|---|---|---|---|');
const row = (n, m) => console.log(`| ${n} | ${m.truth} | ${m.predicted} | ${m.tp} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} |`);
for (const [f, m] of Object.entries(s.perField)) row(f, m);
row('**micro-average**', s.micro);

const both = ids.filter((id) => typeof truth[id].transcript === 'string' && typeof preds[id]?.ocrText === 'string');
if (both.length) {
  const avg = (fn) => both.reduce((a, id) => a + fn(truth[id].transcript, preds[id].ocrText), 0) / both.length;
  console.log(`\nOCR text (${both.length} docs): CER ${pct(avg(characterErrorRate))}, WER ${pct(avg(wordErrorRate))}`);
}
