// Test helper: lay out words like an OCR engine would (char width ~0.55*h, word gap ~0.3*h) so line
// grouping, spacing and column segmentation behave as on real pages. Content is invented.
export function layout(rows, { h = 32, conf = 95 } = {}) {
  const items = [];
  for (const row of rows) {
    // row: { y, x, text, h? } ; "|" inside text is not special: columns are separate rows entries with their own x
    const hh = row.h ?? h;
    let x = row.x;
    for (const word of row.text.split(' ')) {
      const w = word.length * 0.55 * hh;
      items.push({ text: word, x, y: row.y, w, h: hh, conf: row.conf ?? conf });
      x += w + 0.3 * hh;
    }
  }
  return items;
}

export function resultOf(items, { width = 1240, height = 1754, kind = 'png', extra = {} } = {}) {
  return {
    version: 1, kind,
    pages: [{ index: 0, method: 'ocr', rotation: 0, coordSpace: { unit: 'px', width, height }, raw: { items }, normalized: { lines: [], text: items.map((i) => i.text).join(' ') }, confidence: { mean: 90, words: items.length, lowWords: 0 }, ...extra }],
    classification: { suggested: 'invoice', confidence: 'likely', reasons: [] },
    summary: { pages: 1 }, review: [],
  };
}

/** The invoice used across the doc tests; mirrors tests/fixtures/invoice-scan.png (invented content). */
export function invoiceItems() {
  return layout([
    { y: 90, x: 90, text: 'ACME Supplies', h: 54 },
    { y: 90, x: 820, text: 'INVOICE', h: 64 },
    { y: 190, x: 820, text: 'Invoice No: INV-00482' },
    { y: 240, x: 820, text: 'Date: 03 Nov 2026' },
    { y: 290, x: 820, text: 'Due Date: 17 Nov 2026' },
    { y: 330, x: 90, text: 'Bill to:' },
    { y: 380, x: 90, text: 'Bright Tech Ltd' },
    { y: 574, x: 100, text: 'Description' }, { y: 574, x: 640, text: 'Qty' }, { y: 574, x: 780, text: 'Unit Price' }, { y: 574, x: 1000, text: 'Total' },
    { y: 650, x: 100, text: 'Product A' }, { y: 650, x: 660, text: '2' }, { y: 650, x: 800, text: '80.00' }, { y: 650, x: 1010, text: '160.00' },
    { y: 710, x: 100, text: 'Product B' }, { y: 710, x: 660, text: '1' }, { y: 710, x: 800, text: '85.00' }, { y: 710, x: 1010, text: '85.00' },
    { y: 840, x: 780, text: 'Subtotal 245.00', h: 34 },
    { y: 895, x: 780, text: 'Tax (0%) 0.00', h: 34 },
    { y: 960, x: 780, text: 'Total EUR 245.00', h: 40 },
  ]);
}
