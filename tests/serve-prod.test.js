import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStaticServer } from '../scripts/serve.js';

async function withServer(opts, fn) {
  const server = createStaticServer(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

test('prod mode: brotli/gzip, ETag + 304, revalidating shell, cached vendor; dev mode stays no-store', async () => {
  await withServer({ prod: true }, async (base) => {
    const br = await fetch(`${base}/js/main.js`, { headers: { 'accept-encoding': 'br' } });
    assert.equal(br.headers.get('content-encoding'), 'br');
    assert.equal(br.headers.get('cache-control'), 'no-cache');
    const etag = br.headers.get('etag');
    assert.ok(etag);
    assert.equal((await fetch(`${base}/js/main.js`, { headers: { 'if-none-match': etag } })).status, 304);
    const gz = await fetch(`${base}/index.html`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(gz.headers.get('content-encoding'), 'gzip');
    assert.match(await gz.text(), /<title>/);
    const plain = await fetch(`${base}/css/base.css`, { headers: { 'accept-encoding': 'identity' } });
    assert.equal(plain.headers.get('content-encoding'), null);
    const png = await fetch(`${base}/assets/icon-192.png`, { headers: { 'accept-encoding': 'br' } });
    assert.equal(png.headers.get('content-encoding'), null, 'already-compressed formats are not recompressed');
    assert.equal(png.headers.get('cache-control'), 'public, max-age=86400');
    assert.equal((await fetch(`${base}/tests/serve-prod.test.js`)).status, 404, 'non-public paths stay hidden');
  });
  await withServer({}, async (base) => {
    const r = await fetch(`${base}/js/main.js`, { headers: { 'accept-encoding': 'br' } });
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('content-encoding'), null);
  });
});
