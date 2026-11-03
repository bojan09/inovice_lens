import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_POLICY, sniffKind, imageSize, extensionOf, kindFromExtension,
  checkMetadata, inspectContent, processFiles,
} from '../../js/intake.js';

const fx = (n) => new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url))));
const file = (bytes, name, type = '') => new File([bytes], name, { type });
const empty = () => ({ count: 0, totalBytes: 0, fingerprints: new Map() });

test('extensionOf / kindFromExtension', () => {
  assert.equal(extensionOf('a.b.JPG'), 'jpg');
  assert.equal(extensionOf('noext'), '');
  assert.equal(kindFromExtension('x.jpeg'), 'jpeg');
  assert.equal(kindFromExtension('x.gif'), null);
  assert.equal(kindFromExtension('x.pdf.exe'), null);
});

test('sniffKind identifies all four real fixtures', () => {
  assert.equal(sniffKind(fx('sample.png')), 'png');
  assert.equal(sniffKind(fx('sample.jpg')), 'jpeg');
  assert.equal(sniffKind(fx('sample.webp')), 'webp');
  assert.equal(sniffKind(fx('sample.pdf')), 'pdf');
  assert.equal(sniffKind(new Uint8Array([1, 2, 3, 4])), null);
  assert.equal(sniffKind(new Uint8Array(0)), null);
});

test('sniffKind accepts PDF header after leading junk (<1024 bytes) only', () => {
  const junk = new Uint8Array(100).fill(0x20);
  const pdf = new Uint8Array([...junk, ...new TextEncoder().encode('%PDF-1.7\n')]);
  assert.equal(sniffKind(pdf), 'pdf');
  const far = new Uint8Array([...new Uint8Array(2000).fill(0x20), ...new TextEncoder().encode('%PDF-1.7')]);
  assert.equal(sniffKind(far), null);
});

test('imageSize reads real PNG / JPEG / WebP headers', () => {
  assert.deepEqual(imageSize('png', fx('sample.png')), { width: 480, height: 640 });
  assert.deepEqual(imageSize('jpeg', fx('sample.jpg')), { width: 480, height: 640 });
  assert.deepEqual(imageSize('webp', fx('sample.webp')), { width: 480, height: 640 });
});

test('imageSize returns null for truncated headers', () => {
  assert.equal(imageSize('png', fx('sample.png').slice(0, 20)), null);
  assert.equal(imageSize('jpeg', fx('sample.jpg').slice(0, 10)), null);
  assert.equal(imageSize('webp', fx('sample.webp').slice(0, 20)), null);
});

test('imageSize rejects PNG with zero dimensions', () => {
  const b = fx('sample.png').slice();
  b.fill(0, 16, 20); // width = 0
  assert.equal(imageSize('png', b), null);
});

test('checkMetadata: empty, oversize, unsupported extension, unsupported MIME', () => {
  assert.equal(checkMetadata({ name: 'a.png', size: 0 }).code, 'empty');
  assert.equal(checkMetadata({ name: 'a.png', size: DEFAULT_POLICY.maxFileBytes + 1 }).code, 'too-large');
  assert.equal(checkMetadata({ name: 'a.gif', size: 10 }).code, 'unsupported-type');
  assert.equal(checkMetadata({ name: 'a.png', size: 10, type: 'text/html' }).code, 'unsupported-type');
  assert.equal(checkMetadata({ name: 'a.png', size: 10, type: 'image/png' }), null);
  assert.equal(checkMetadata({ name: 'a.png', size: 10, type: '' }), null);
  assert.equal(checkMetadata({ name: 'a.png', size: DEFAULT_POLICY.maxFileBytes }), null);
});

test('inspectContent: extension / content mismatch is rejected with both names', () => {
  const r = inspectContent('photo.jpg', fx('sample.png'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'content-mismatch');
  assert.match(r.message, /JPG.*PNG/);
});

test('inspectContent: non-image garbage with image extension is unsupported-type', () => {
  const r = inspectContent('a.png', new TextEncoder().encode('<html>not an image</html>'));
  assert.equal(r.code, 'unsupported-type');
});

test('inspectContent: truncated PNG/JPEG/WebP are corrupt', () => {
  assert.equal(inspectContent('a.png', fx('sample.png').slice(0, 20)).code, 'corrupt');
  assert.equal(inspectContent('a.jpg', fx('sample.jpg').slice(0, 8)).code, 'corrupt');
  assert.equal(inspectContent('a.webp', fx('sample.webp').slice(0, 24)).code, 'corrupt');
});

test('inspectContent: header-valid but cut-off files are corrupt (PNG no IEND, WebP short RIFF)', () => {
  assert.equal(inspectContent('a.png', fx('sample.png').slice(0, 200)).code, 'corrupt');
  assert.equal(inspectContent('a.webp', fx('sample.webp').slice(0, 200)).code, 'corrupt');
});

test('inspectContent: JPEG without EOI is accepted with a warning', () => {
  const b = fx('sample.jpg');
  const r = inspectContent('a.jpg', b.slice(0, b.length - 2));
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
  assert.deepEqual(inspectContent('a.jpg', b).warnings, []);
});

test('inspectContent: pixel limit', () => {
  const r = inspectContent('a.png', fx('sample.png'), { ...DEFAULT_POLICY, maxImagePixels: 1000 });
  assert.equal(r.code, 'too-many-pixels');
  assert.match(r.message, /480 × 640/);
});

test('inspectContent: valid files return kind and dimensions', () => {
  assert.deepEqual(
    { ...inspectContent('a.png', fx('sample.png')), warnings: undefined },
    { ok: true, kind: 'png', width: 480, height: 640, warnings: undefined },
  );
  assert.equal(inspectContent('a.pdf', fx('sample.pdf')).kind, 'pdf');
  assert.deepEqual(inspectContent('a.pdf', fx('sample.pdf')).warnings, []);
});

test('inspectContent: PDF without %%EOF is accepted with a warning', () => {
  const b = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
  const r = inspectContent('a.pdf', b);
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
});

test('processFiles: accepts the four real fixtures, in order', async () => {
  const files = [
    file(fx('sample.jpg'), 'a.jpg', 'image/jpeg'),
    file(fx('sample.png'), 'b.png', 'image/png'),
    file(fx('sample.webp'), 'c.webp', 'image/webp'),
    file(fx('sample.pdf'), 'd.pdf', 'application/pdf'),
  ];
  const { accepted, rejected } = await processFiles(files, empty());
  assert.deepEqual(accepted.map((a) => a.kind), ['jpeg', 'png', 'webp', 'pdf']);
  assert.equal(rejected.length, 0);
});

test('processFiles: mixed good and bad produce one result per file', async () => {
  const files = [
    file(fx('sample.png'), 'ok.png'),
    file(new Uint8Array(0), 'empty.png'),
    file(fx('sample.png'), 'renamed.jpg'),
    file(new TextEncoder().encode('hello'), 'notes.txt'),
    file(fx('sample.png').slice(0, 30), 'cut.png'),
  ];
  const { accepted, rejected } = await processFiles(files, empty());
  assert.equal(accepted.length, 1);
  assert.deepEqual(rejected.map((r) => r.code), ['empty', 'content-mismatch', 'unsupported-type', 'corrupt']);
  assert.ok(rejected.every((r) => r.message.length > 10));
});

test('processFiles: duplicate content is rejected even with different name', async () => {
  const { accepted, rejected } = await processFiles(
    [file(fx('sample.png'), 'one.png'), file(fx('sample.png'), 'two.png')], empty());
  assert.equal(accepted.length, 1);
  assert.equal(rejected[0].code, 'duplicate');
  assert.match(rejected[0].message, /one\.png/);
});

test('processFiles: duplicate against already-accepted files', async () => {
  const first = await processFiles([file(fx('sample.png'), 'one.png')], empty());
  const existing = {
    count: 1,
    totalBytes: first.accepted[0].size,
    fingerprints: new Map([[first.accepted[0].fingerprint, 'one.png']]),
  };
  const second = await processFiles([file(fx('sample.png'), 'again.png')], existing);
  assert.equal(second.rejected[0].code, 'duplicate');
});

test('processFiles: file-count and total-size limits', async () => {
  const policy = { ...DEFAULT_POLICY, maxFiles: 1 };
  const r1 = await processFiles([file(fx('sample.png'), 'a.png'), file(fx('sample.jpg'), 'b.jpg')], empty(), policy);
  assert.equal(r1.accepted.length, 1);
  assert.equal(r1.rejected[0].code, 'limit-files');

  const tiny = { ...DEFAULT_POLICY, maxTotalBytes: fx('sample.png').length + 5 };
  const r2 = await processFiles([file(fx('sample.png'), 'a.png'), file(fx('sample.jpg'), 'b.jpg')], empty(), tiny);
  assert.equal(r2.accepted.length, 1);
  assert.equal(r2.rejected[0].code, 'limit-total');
});

test('processFiles: read failure is reported as retryable read-error', async () => {
  const boom = async () => { throw new Error('NotReadableError'); };
  const { accepted, rejected } = await processFiles([file(fx('sample.png'), 'a.png')], empty(), DEFAULT_POLICY, boom);
  assert.equal(accepted.length, 0);
  assert.equal(rejected[0].code, 'read-error');
});

test('processFiles: oversize file is rejected without reading it', async () => {
  let read = false;
  const spy = async () => { read = true; return new ArrayBuffer(0); };
  const policy = { ...DEFAULT_POLICY, maxFileBytes: 10 };
  const { rejected } = await processFiles([file(fx('sample.png'), 'a.png')], empty(), policy, spy);
  assert.equal(rejected[0].code, 'too-large');
  assert.equal(read, false);
});
