// csv.js - Google Sheets-compatible CSV (UTF-8 with BOM, CRLF, RFC 4180 quoting) and tab-separated text for pasting.
import { tablesOf, csvRows } from './data.js';
import { toCsv, toTsv } from './util.js';

export const CSV_MIME = 'text/csv;charset=utf-8';

export function csvTables(data) { return tablesOf(data); }

export function buildCsv(data, tableId) {
  const tables = tablesOf(data);
  const t = tables.find((x) => x.id === tableId) ?? tables[0];
  if (!t) throw new Error('There is nothing to export.');
  const rows = csvRows(t, data);
  const text = '﻿' + toCsv(rows); // BOM so Excel reads UTF-8; Google Sheets ignores it
  return { blob: new Blob([text], { type: CSV_MIME }), mime: CSV_MIME, ext: 'csv', warnings: [], table: t.name, text, rows };
}

export function buildPasteText(data, tableId) {
  const tables = tablesOf(data);
  const t = tables.find((x) => x.id === tableId) ?? tables[0];
  if (!t) throw new Error('There is nothing to copy.');
  return toTsv(csvRows(t, data));
}
