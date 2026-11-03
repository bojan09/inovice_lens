// Reproducible vendoring of browser libraries into vendor/. Fetches pinned npm tarballs,
// verifies each against its pinned sha512 integrity, extracts into a temp dir (nothing is
// executed), copies an explicit allow-list of files, and writes vendor/VENDOR.md with sha256s.
// Usage: node scripts/vendor.js
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'vendor');

// [npm spec, sha512 integrity, [[path inside package, destination under vendor/], ...]]
const PACKAGES = [
  ['tesseract.js@7.0.0', 'sha512-exPBkd+z+wM1BuMkx/Bjv43OeLBxhL5kKWsz/9JY+DXcXdiBjiAch0V49QR3oAJqCaL5qURE0vx9Eo+G5YE7mA==', [
    ['dist/tesseract.esm.min.js', 'tesseract/tesseract.esm.min.js'],
    ['dist/worker.min.js', 'tesseract/worker.min.js'],
    ['LICENSE.md', 'tesseract/LICENSE-tesseract.js.md'],
  ]],
  ['tesseract.js-core@7.0.0', 'sha512-WnNH518NzmbSq9zgTPeoF8c+xmilS8rFIl1YKbk/ptuuc7p6cLNELNuPAzcmsYw450ca6bLa8j3t0VAtq435Vw==', [
    ['tesseract-core-simd-lstm.wasm.js', 'tesseract/tesseract-core-simd-lstm.wasm.js'],
    ['LICENSE', 'tesseract/LICENSE-tesseract.js-core'],
  ]],
  ['@tesseract.js-data/eng@1.0.0', 'sha512-mbTumm6KQPUHyzTPQaF3ObXYnx0SqqfV2nabqFVQBwD6Kl7PhGSLSzOlfFTWy0P3BjghaSKA2W9GB19Jk+ZcTg==', [
    ['4.0.0_best_int/eng.traineddata.gz', 'tesseract/eng.traineddata.gz'],
  ]],
  ['pdfjs-dist@6.4.299', 'sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==', [
    ['build/pdf.min.mjs', 'pdfjs/pdf.min.mjs'],
    ['build/pdf.worker.min.mjs', 'pdfjs/pdf.worker.min.mjs'],
    ['LICENSE', 'pdfjs/LICENSE'],
    ['wasm/openjpeg.wasm', 'pdfjs/wasm/openjpeg.wasm'],
    ['wasm/jbig2.wasm', 'pdfjs/wasm/jbig2.wasm'],
    ['wasm/qcms_bg.wasm', 'pdfjs/wasm/qcms_bg.wasm'],
    ['wasm/LICENSE_JBIG2', 'pdfjs/wasm/LICENSE_JBIG2'],
    ['wasm/LICENSE_OPENJPEG', 'pdfjs/wasm/LICENSE_OPENJPEG'],
    ['wasm/LICENSE_PDFJS_JBIG2', 'pdfjs/wasm/LICENSE_PDFJS_JBIG2'],
    ['wasm/LICENSE_PDFJS_OPENJPEG', 'pdfjs/wasm/LICENSE_PDFJS_OPENJPEG'],
    ['wasm/LICENSE_PDFJS_QCMS', 'pdfjs/wasm/LICENSE_PDFJS_QCMS'],
    ['wasm/LICENSE_QCMS', 'pdfjs/wasm/LICENSE_QCMS'],
    ['standard_fonts', 'pdfjs/standard_fonts'],
    ['iccs', 'pdfjs/iccs'],
  ]],
  ['pdf-lib@1.17.1', 'sha512-V/mpyJAoTsN4cnP31vc0wfNA1+p20evqqnap0KLoRUN0Yk/p3wN52DOEsL4oBFcLdb76hlpKPtzJIgo67j/XLw==', [
    ['dist/pdf-lib.esm.min.js', 'pdf-lib/pdf-lib.esm.min.js'],
    ['LICENSE.md', 'pdf-lib/LICENSE.md'],
  ]],
  ['docx@9.13.0', 'sha512-MofrvX7rzwCe1xUFXnwneQHzv2p1lIUIDPD01DueOnKGw+TSKxAAcK5Beo69bTyqKUYsX8d49Co03Bcntc60WQ==', [
    ['dist/index.mjs', 'docx/index.mjs'],
    ['LICENSE', 'docx/LICENSE'],
  ]],
  ['write-excel-file@4.1.1', 'sha512-MUnCnNtQrcZek832ZcU24uU0rSphFmKPD1DvIjXOlygVb93CV7Tme6H3jUTkxsMmjB2W7HIzERzjqTi5kui71A==', [
    ['bundle/write-excel-file.min.js', 'write-excel-file/write-excel-file.min.js'],
    ['LICENSE', 'write-excel-file/LICENSE'],
  ]],
  ['fflate@0.8.3', 'sha512-tbZNuJrLwGUp3zshBtdy4W+ORxZuIh8a5ilyIEQDC5rY1f3U20JMry0Ll3WBzU58EZKsEuJFXhb5gwv8CsPvgA==', [
    ['esm/browser.js', 'fflate/browser.js'],
    ['LICENSE', 'fflate/LICENSE'],
  ]],
];

const sha = (buf, algo, enc) => createHash(algo).update(buf).digest(enc);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

const work = mkdtempSync(join(tmpdir(), 'invoicelens-vendor-'));
const rows = [];
try {
  rmSync(OUT, { recursive: true, force: true });
  for (const [spec, integrity, files] of PACKAGES) {
    const tgzName = execFileSync('npm', ['pack', spec, '--silent', '--pack-destination', work], { encoding: 'utf8' }).trim().split('\n').pop();
    const tgz = join(work, tgzName);
    const got = 'sha512-' + sha(readFileSync(tgz), 'sha512', 'base64');
    if (got !== integrity) throw new Error(`Integrity mismatch for ${spec}\n expected ${integrity}\n got      ${got}`);
    const dir = join(work, tgzName.replace(/\.tgz$/, ''));
    mkdirSync(dir);
    execFileSync('tar', ['xzf', tgz, '-C', dir, '--strip-components=1']);
    for (const [from, to] of files) {
      const src = join(dir, from);
      const dst = join(OUT, to);
      mkdirSync(join(dst, '..'), { recursive: true });
      cpSync(src, dst, { recursive: true });
      const list = statSync(dst).isDirectory() ? walk(dst) : [dst];
      for (const f of list) rows.push({ spec, file: relative(OUT, f), bytes: statSync(f).size, sha256: sha(readFileSync(f), 'sha256', 'hex') });
    }
    console.log(`ok ${spec}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

rows.sort((a, b) => a.file.localeCompare(b.file));
const total = rows.reduce((s, r) => s + r.bytes, 0);
const md = [
  '# Vendored libraries',
  '',
  'Generated by `node scripts/vendor.js`. Each npm tarball is verified against a pinned sha512 integrity before extraction;',
  'only the files below are copied (no source maps, no cmaps, no scripting sandbox, no non-SIMD fallbacks).',
  'See `docs/dependencies.md` for selection rationale, licences and risks.',
  '',
  '| Package | Pinned integrity (sha512) |', '|---|---|',
  ...PACKAGES.map(([s, i]) => `| ${s} | \`${i}\` |`),
  '',
  `Total: ${rows.length} files, ${total.toLocaleString('en-US')} bytes.`,
  '',
  '| File | Package | Bytes | sha256 |', '|---|---|---|---|',
  ...rows.map((r) => `| ${r.file} | ${r.spec} | ${r.bytes} | \`${r.sha256}\` |`),
  '',
].join('\n');
writeFileSync(join(OUT, 'VENDOR.md'), md);
console.log(`vendored ${rows.length} files, ${total} bytes -> vendor/`);
