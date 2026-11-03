// libs.js - lazy loading of the vendored export libraries (same origin, no CDN). Each loads only when first used.
const V = (p) => new URL(`../../vendor/${p}`, import.meta.url).href;
const memo = {};
const once = (k, fn) => (memo[k] ??= fn().catch((e) => { delete memo[k]; throw e; }));

export const loadPdfLib = () => once('pdf', () => import(V('pdf-lib/pdf-lib.esm.min.js')));
export const loadDocx = () => once('docx', () => import(V('docx/index.mjs')));
export const loadFflate = () => once('zip', () => import(V('fflate/browser.js')));

/** write-excel-file ships a UMD bundle: a classic script in the browser (CSP script-src 'self'), a plain import in Node tests. */
export const loadXlsx = () => once('xlsx', async () => {
  if (typeof document === 'undefined') await import(V('write-excel-file/write-excel-file.min.js'));
  else if (!globalThis.writeXlsxFile) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = V('write-excel-file/write-excel-file.min.js');
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load the Excel writer.'));
      document.head.append(s);
    });
  }
  if (typeof globalThis.writeXlsxFile !== 'function') throw new Error('The Excel writer did not initialise.');
  return globalThis.writeXlsxFile;
});
