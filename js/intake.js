// intake.js - file intake validation. Pure (no DOM); works on File/Blob + bytes.
//
// Every file is treated as hostile input. A file is accepted only when ALL hold:
//   1. non-empty, within size policy, extension and (if present) MIME type are supported;
//   2. magic bytes identify a supported format AND agree with the extension;
//   3. images: the header parses and the declared pixel count is within policy
//      (rejects truncated files and decompression-bomb style dimensions);
//   4. not an exact duplicate (SHA-256 of content) of a file already accepted.
// Nothing here reads file contents into the DOM or sends them anywhere.

export const DEFAULT_POLICY = Object.freeze({
  maxFileBytes: 25 * 1024 * 1024, // PDF.js / canvas decode keep whole file + bitmap in memory
  maxFiles: 50,
  maxTotalBytes: 200 * 1024 * 1024,
  maxImagePixels: 100_000_000, // 100 MP, ~400 MB decoded RGBA: upper bound for a phone browser tab
});

export const KINDS = Object.freeze({
  jpeg: { label: 'JPG', ext: ['jpg', 'jpeg'], mime: ['image/jpeg', 'image/jpg', 'image/pjpeg'], image: true },
  png: { label: 'PNG', ext: ['png'], mime: ['image/png', 'image/x-png'], image: true },
  webp: { label: 'WebP', ext: ['webp'], mime: ['image/webp'], image: true },
  pdf: { label: 'PDF', ext: ['pdf'], mime: ['application/pdf', 'application/x-pdf'], image: false },
});

export const ACCEPT_ATTR = '.jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf';

const ALL_MIMES = new Set(Object.values(KINDS).flatMap((k) => k.mime));
const RETRYABLE = new Set(['read-error']);
export const isRetryable = (code) => RETRYABLE.has(code);

export function extensionOf(name) {
  const m = /\.([^.\\/]+)$/.exec(String(name));
  return m ? m[1].toLowerCase() : '';
}

export function kindFromExtension(name) {
  const ext = extensionOf(name);
  return Object.keys(KINDS).find((k) => KINDS[k].ext.includes(ext)) ?? null;
}

/** Identify format by magic bytes. Returns a KINDS key or null. */
export function sniffKind(bytes) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  // PDF spec: header may be preceded by up to 1024 bytes of junk.
  const head = ascii(b, 0, Math.min(b.length, 1024));
  if (head.includes('%PDF-')) return 'pdf';
  return null;
}

function ascii(b, from, to) {
  let s = '';
  for (let i = from; i < to && i < b.length; i += 1) s += String.fromCharCode(b[i]);
  return s;
}

const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

/** Parse pixel dimensions from the header. Returns {width,height} or null if unreadable. */
export function imageSize(kind, b) {
  try {
    if (kind === 'png') {
      if (b.length < 24 || ascii(b, 12, 16) !== 'IHDR') return null;
      return dims(u32be(b, 16), u32be(b, 20));
    }
    if (kind === 'webp') return webpSize(b);
    if (kind === 'jpeg') return jpegSize(b);
  } catch {
    return null;
  }
  return null;
}

function dims(width, height) {
  return width > 0 && height > 0 ? { width, height } : null;
}

function webpSize(b) {
  if (b.length < 30) return null;
  const fourcc = ascii(b, 12, 16);
  if (fourcc === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return dims(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (fourcc === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const width = 1 + (((b[22] & 0x3f) << 8) | b[21]);
    const height = 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6));
    return { width, height };
  }
  if (fourcc === 'VP8X') {
    const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return { width, height };
  }
  return null;
}

function jpegSize(b) {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null; // lost sync: corrupt
    while (b[i] === 0xff && i < b.length) i += 1; // fill bytes
    const marker = b[i];
    i += 1;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS reached before any SOF
    if (i + 1 >= b.length) return null;
    const len = u16be(b, i);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 6 >= b.length) return null;
      return dims(u16be(b, i + 5), u16be(b, i + 3));
    }
    i += len;
  }
  return null;
}

export const MESSAGES = {
  empty: () => 'The file is empty (0 bytes).',
  'too-large': (_n, p, size) => `The file is ${mb(size)} which is over the ${mb(p.maxFileBytes)} per-file limit.`,
  'unsupported-type': () => 'Unsupported file type. Use JPG, PNG, WebP or PDF.',
  'content-mismatch': (_n, _p, _s, extra) => `The file extension says ${extra.claimed} but the content is ${extra.actual}. Rename it or re-export it.`,
  corrupt: () => 'The file could not be read as a valid image or PDF. It may be damaged or incomplete.',
  'too-many-pixels': (_n, p, _s, extra) => `The image is ${extra.width} × ${extra.height} px (${Math.round((extra.width * extra.height) / 1e6)} MP), over the ${Math.round(p.maxImagePixels / 1e6)} MP limit.`,
  duplicate: (_n, _p, _s, extra) => `Already added (identical content to ${extra.of}).`,
  'limit-files': (_n, p) => `Limit of ${p.maxFiles} files reached.`,
  'limit-total': (_n, p) => `Adding this file would exceed the ${mb(p.maxTotalBytes)} total limit.`,
  'read-error': () => 'The browser could not read this file. Try again.',
};

function mb(n) {
  return `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function reject(code, policy, size, extra) {
  return { ok: false, code, message: MESSAGES[code](null, policy, size, extra) };
}

/** Checks that need no file contents. Returns a rejection or null. */
export function checkMetadata({ name, size, type }, policy = DEFAULT_POLICY) {
  if (size === 0) return reject('empty', policy, size);
  if (size > policy.maxFileBytes) return reject('too-large', policy, size);
  if (!kindFromExtension(name)) return reject('unsupported-type', policy, size);
  if (type && !ALL_MIMES.has(type.toLowerCase())) return reject('unsupported-type', policy, size);
  return null;
}

/** Checks on file bytes. Returns {ok:true, kind, width?, height?, warnings[]} or a rejection. */
export function inspectContent(name, bytes, policy = DEFAULT_POLICY) {
  const claimed = kindFromExtension(name);
  const actual = sniffKind(bytes);
  if (!actual) return reject('unsupported-type', policy, bytes.length);
  if (actual !== claimed) {
    return reject('content-mismatch', policy, bytes.length, { claimed: KINDS[claimed].label, actual: KINDS[actual].label });
  }
  const warnings = [];
  if (KINDS[actual].image) {
    const size = imageSize(actual, bytes);
    if (!size) return reject('corrupt', policy, bytes.length);
    if (size.width * size.height > policy.maxImagePixels) return reject('too-many-pixels', policy, bytes.length, size);
    if (!isComplete(actual, bytes)) return reject('corrupt', policy, bytes.length);
    if (actual === 'jpeg' && !(bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9)) {
      warnings.push('JPEG end marker not found; the image data may be incomplete.');
    }
    return { ok: true, kind: actual, width: size.width, height: size.height, warnings };
  }
  const tail = ascii(bytes, Math.max(0, bytes.length - 4096), bytes.length);
  if (!tail.includes('%%EOF')) warnings.push('PDF end marker not found; the file may be incomplete.');
  return { ok: true, kind: actual, warnings };
}

/** Truncation checks that are strict enough to be safe: PNG must end with IEND, WebP RIFF length must fit. */
function isComplete(kind, b) {
  if (kind === 'png') return b.length >= 20 && ascii(b, b.length - 8, b.length - 4) === 'IEND';
  if (kind === 'webp') return u32le(b, 4) + 8 <= b.length;
  return true;
}

async function fingerprint(bytes, file) {
  try {
    if (globalThis.crypto?.subtle) {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      return 'sha256:' + [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    /* fall through */
  }
  return `weak:${file.size}:${file.name}:${file.lastModified ?? 0}`;
}

/**
 * Validate files sequentially.
 * @param {File[]} files
 * @param {{count:number,totalBytes:number,fingerprints:Map<string,string>}} existing  already-accepted state (fingerprint -> display name)
 * @returns {Promise<{accepted: object[], rejected: object[]}>}
 */
export async function processFiles(files, existing, policy = DEFAULT_POLICY, readBytes = defaultRead) {
  const accepted = [];
  const rejected = [];
  let count = existing.count;
  let total = existing.totalBytes;
  const seen = new Map(existing.fingerprints);

  for (const file of files) {
    const base = { file, name: file.name, size: file.size };
    const meta = checkMetadata(file, policy);
    if (meta) {
      rejected.push({ ...base, code: meta.code, message: meta.message });
      continue;
    }
    if (count >= policy.maxFiles) {
      const r = reject('limit-files', policy, file.size);
      rejected.push({ ...base, code: r.code, message: r.message });
      continue;
    }
    if (total + file.size > policy.maxTotalBytes) {
      const r = reject('limit-total', policy, file.size);
      rejected.push({ ...base, code: r.code, message: r.message });
      continue;
    }
    let bytes;
    try {
      bytes = new Uint8Array(await readBytes(file));
    } catch {
      const r = reject('read-error', policy, file.size);
      rejected.push({ ...base, code: r.code, message: r.message });
      continue;
    }
    const result = inspectContent(file.name, bytes, policy);
    if (!result.ok) {
      rejected.push({ ...base, code: result.code, message: result.message });
      continue;
    }
    const fp = await fingerprint(bytes, file);
    if (seen.has(fp)) {
      const r = reject('duplicate', policy, file.size, { of: seen.get(fp) });
      rejected.push({ ...base, code: r.code, message: r.message });
      continue;
    }
    seen.set(fp, file.name);
    count += 1;
    total += file.size;
    accepted.push({ ...base, kind: result.kind, width: result.width, height: result.height, warnings: result.warnings, fingerprint: fp });
  }
  return { accepted, rejected };
}

function defaultRead(file) {
  return file.arrayBuffer();
}
