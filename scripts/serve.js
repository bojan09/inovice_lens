// Minimal dependency-free static server for local development and browser tests.
// Usage: node scripts/serve.js [port]   (binds 127.0.0.1 only)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync, constants as zc } from 'node:zlib';
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

const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.webmanifest', '.svg', '.wasm']);
const prodCache = new Map(); // path -> { etag, raw, br, gz } built once per process in prod mode

function prodEntry(full, body, ext) {
  const hit = prodCache.get(full);
  if (hit && hit.size === body.length) return hit;
  const e = {
    size: body.length,
    etag: `"${createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`,
    br: COMPRESSIBLE.has(ext) ? brotliCompressSync(body, { params: { [zc.BROTLI_PARAM_QUALITY]: 9 } }) : null,
    gz: COMPRESSIBLE.has(ext) ? gzipSync(body, { level: 9 }) : null,
  };
  prodCache.set(full, e);
  return e;
}

/** @param {{prod?: boolean}} [opts] prod: ETag/304, brotli+gzip, long-lived caching of vendored libs and icons (mirrors the hosting configs). */
export function createStaticServer({ prod = false } = {}) {
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
      const ext = extname(full);
      let payload = body;
      const extra = {};
      let cache = 'no-store';
      if (prod) {
        const e = prodEntry(full, body, ext);
        const accept = String(req.headers['accept-encoding'] ?? '');
        if (e.br && /\bbr\b/.test(accept)) { payload = e.br; extra['Content-Encoding'] = 'br'; } else if (e.gz && /\bgzip\b/.test(accept)) { payload = e.gz; extra['Content-Encoding'] = 'gzip'; }
        extra.Vary = 'Accept-Encoding';
        extra.ETag = e.etag;
        const immutableish = top === 'vendor' || top === 'assets';
        cache = immutableish ? 'public, max-age=86400' : 'no-cache'; // shell files revalidate (cheap 304); the service worker keeps the app available offline
        if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, { ETag: e.etag, 'Cache-Control': cache, Vary: 'Accept-Encoding' }); res.end(); return; }
      }
      res.writeHead(200, {
        ...extra,
        'Content-Length': payload.length,
        'Content-Type': TYPES[ext] ?? 'application/octet-stream',
        'Cache-Control': cache,
        ...(full.endsWith(`${sep}sw.js`) ? { 'Service-Worker-Allowed': '/' } : {}),
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(payload);
    } catch (err) {
      const code = err.code === 403 ? 403 : 404;
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(code === 403 ? 'Forbidden' : 'Not found');
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const prod = args.includes('--prod');
  const port = Number(args.find((a) => /^\d+$/.test(a)) ?? process.env.PORT ?? 5173);
  createStaticServer({ prod }).listen(port, '127.0.0.1', () => console.log(`InvoiceLens ${prod ? 'production-mode' : 'dev'} server: http://127.0.0.1:${port}/`));
}
