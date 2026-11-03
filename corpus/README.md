# Corpus (optional)

The corpus is **optional**. Tests (`npm test`) and the eval CLI (`npm run eval`) run fine with it empty; the CLI then prints "No documents".

If you want accuracy numbers, supply English-language invoices/receipts:

- `corpus/docs/<id>.<pdf|png|jpg>` - the anonymised document (remove names, addresses, tax/bank IDs, emails).
- `corpus/truth/<id>.json` - hand-keyed ground truth matching `corpus/truth/schema.json`. Same `<id>` as the document, lowercase, no spaces. Never generate it from OCR output.
- Run: `npm run eval -- <predictionsDir> --split heldout` (predictions are `<predictionsDir>/<id>.json`).

Held-out rule: ~30% of ids are assigned to a held-out set by a stable hash (`splitDocs`). Never tune extraction rules on held-out documents; report held-out numbers only.

Public stand-ins (SROIE, CORD) may be used, clearly labelled with `"source": "public-sroie"` / `"public-cord"` in the truth file. Real documents use `"source": "real"`.

## Synthetic corpus (generated)

`python3 -I corpus/make_corpus.py` builds 34 invented documents into `corpus/docs/` (git-ignored) and writes `corpus/truth/syn-*.json` with `"source": "synthetic"`. Then `node tests/eval/predict.mjs` runs the real app over them and `npm run eval -- corpus/predictions --split tune|heldout` scores. Synthetic numbers measure robustness to one generator, not real-world accuracy. Note: `tests/eval/metrics.test.js` skips its empty-corpus test while truth files exist.
