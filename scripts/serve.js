// Minimal dependency-free static server for local development and browser tests.
// Usage: node scripts/serve.js [port]   (binds 127.0.0.1 only)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC = new Set(['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'assets', 'vendor']); // never serve tests/, docs/, node_modules/ or .git/

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip', // served as-is (no Content-Encoding): tesseract.js inflates eng.traineddata.gz itself
  '.icc': 'application/octet-stream',
};

export function createStaticServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      const full = normalize(join(ROOT, rel));
      if (full !== ROOT && !full.startsWith(ROOT + sep)) throw Object.assign(new Error('forbidden'), { code: 403 });
      const top = full.slice(ROOT.length + 1).split(sep)[0];
      if (!PUBLIC.has(top)) throw Object.assign(new Error('not found'), { code: 404 });
      const st = await stat(full);
      if (!st.isFile()) throw Object.assign(new Error('not found'), { code: 404 });
      const body = await readFile(full);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(full)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
        ...(full.endsWith(`${sep}sw.js`) ? { 'Service-Worker-Allowed': '/' } : {}),
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(body);
    } catch (err) {
      const code = err.code === 403 ? 403 : 404;
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(code === 403 ? 'Forbidden' : 'Not found');
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 5173);
  createStaticServer().listen(port, '127.0.0.1', () => console.log(`InvoiceLens dev server: http://127.0.0.1:${port}/`));
}
