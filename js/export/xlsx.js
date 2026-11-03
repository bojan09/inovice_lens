// xlsx.js - real .xlsx: numeric cells for amounts/quantities, real date cells, one sheet per table.
import { loadXlsx } from './libs.js';
import { tablesOf } from './data.js';
import { currencyExponent } from '../money.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Excel rejects a workbook ("found unreadable content") for these: sheet names over 31 chars or with []:*?/\\, and a
// cell with more than 32,767 characters. Enforce them instead of trusting the writer.
export const EXCEL_CELL_LIMIT = 32767;
export const sheetName = (n) => String(n).replace(/[\[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
const clip = (v, counter) => {
  if (typeof v === 'string' && v.length > EXCEL_CELL_LIMIT) { counter.n += 1; return v.slice(0, EXCEL_CELL_LIMIT); }
  return v;
};

const widthOf = (rows, col) => Math.min(60, Math.max(8, ...rows.slice(0, 200).map((r) => String(r[col] ?? '').length + 2)));

export async function buildXlsx(data, { signal } = {}) {
  const write = await loadXlsx();
  if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
  const exp = currencyExponent(data.currency);
  const moneyFmt = exp ? `#,##0.${'0'.repeat(exp)}` : '#,##0';
  const bold = (v) => ({ value: v, fontWeight: 'bold' });
  const cut = { n: 0 };

  const sheets = tablesOf(data).map((t) => {
    const cols = Math.max(...t.rows.map((r) => r.length));
    let rows;
    if (t.id === 'summary') {
      rows = t.rows.map((r, i) => {
        if (i === 0) return r.map(bold);
        const f = data.fields.find((x) => x.label === r[0]);
        const cell = typeof r[1] === 'number' ? { value: r[1], type: Number, format: f?.kind === 'percent' ? '0.####' : moneyFmt } : r[1] === '' ? null : { value: String(r[1]), type: String };
        if (f?.kind === 'date' && f.iso) { const [y, m, d] = f.iso.split('-').map(Number); return [r[0], { value: new Date(Date.UTC(y, m - 1, d)), type: Date, format: 'yyyy-mm-dd' }]; }
        return [r[0], cell];
      });
    } else if (t.id === 'items') {
      rows = t.rows.map((r, i) => (i === 0 ? r.map(bold) : [
        { value: r[0], type: Number },
        r[1] === '' ? null : { value: String(r[1]), type: String },
        typeof r[2] === 'number' ? { value: r[2], type: Number, format: '0.####' } : r[2] === '' ? null : { value: String(r[2]), type: String },
        typeof r[3] === 'number' ? { value: r[3], type: Number, format: moneyFmt } : r[3] === '' ? null : { value: String(r[3]), type: String },
        typeof r[4] === 'number' ? { value: r[4], type: Number, format: moneyFmt } : r[4] === '' ? null : { value: String(r[4]), type: String },
      ]));
    } else {
      rows = t.rows.map((r, i) => r.map((c) => {
        if (c === null || c === '') return null;
        const head = t.header && i === 0;
        if (typeof c === 'number') return { value: c, type: Number };
        return head ? bold(c) : { value: String(c), type: String };
      }));
    }
    for (const r of rows) for (const c of r) if (c && typeof c.value === 'string') c.value = clip(c.value, cut);
    return { sheet: sheetName(t.name), data: rows, columns: Array.from({ length: cols }, (_, c) => ({ width: widthOf(t.rows, c) })), stickyRowsCount: t.header ? 1 : 0 };
  });
  if (!sheets.length) sheets.push({ sheet: 'Document', data: [[{ value: 'No data', type: String }]] });
  const blob = await write(sheets).toBlob();
  return { blob, mime: XLSX_MIME, ext: 'xlsx', warnings: cut.n ? [`${cut.n} cell${cut.n === 1 ? ' was' : 's were'} longer than Excel's ${EXCEL_CELL_LIMIT.toLocaleString('en-US')}-character limit and ${cut.n === 1 ? 'was' : 'were'} shortened.`] : [] };
}
