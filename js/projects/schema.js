// schema.js - versioned storage schema, migrations and validation of portable project files.
// A record carries `schemaVersion`; `migrate*` upgrade older shapes to the current one and refuse NEWER ones
// (data written by a future version is never silently reinterpreted).

export const DB_NAME = 'invoicelens';
export const DB_VERSION = 1; // IndexedDB structure version (object stores); bump + add an upgrade step in db.js
export const SCHEMA_VERSION = 1; // shape of the records themselves
export const PORTABLE_FORMAT = 'invoicelens-project';
export const STORES = Object.freeze({ projects: 'projects', files: 'files', blobs: 'blobs', thumbs: 'thumbs' });

export const LIMITS = Object.freeze({
  maxFiles: 100,
  maxImportBytes: 400 * 1024 * 1024, // compressed archive
  maxInflatedBytes: 600 * 1024 * 1024, // sum of declared member sizes
  maxMemberBytes: 60 * 1024 * 1024, // per member (originals are <= 25 MB by intake policy; results/docs are small)
  maxNameLength: 120,
});

export class SchemaError extends Error {
  constructor(code, message) { super(message); this.name = 'SchemaError'; this.code = code; }
}

// ---------------------------------------------------------------- migrations
const MIGRATIONS = {
  // v0 was the pre-release shape: files embedded inside the project record, `docs` instead of `doc`, no schemaVersion.
  0: (rec, kind) => {
    if (kind === 'project') {
      const { files: _drop, ...rest } = rec;
      return { ...rest, schemaVersion: 1, autosave: rest.autosave ?? false, order: rest.order ?? [] };
    }
    const { docs, ...rest } = rec;
    return { ...rest, doc: rest.doc ?? docs ?? null, schemaVersion: 1 };
  },
};

function migrate(rec, kind) {
  if (!rec || typeof rec !== 'object') throw new SchemaError('corrupt', `Stored ${kind} record is not an object.`);
  let r = { ...rec };
  let v = Number.isInteger(r.schemaVersion) ? r.schemaVersion : 0;
  if (v > SCHEMA_VERSION) throw new SchemaError('too-new', `This ${kind} was saved by a newer version of InvoiceLens (schema ${v}). Update the app to open it.`);
  while (v < SCHEMA_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) throw new SchemaError('no-migration', `No migration from schema ${v}.`);
    r = step(r, kind);
    v = r.schemaVersion;
  }
  return r;
}
export const migrateProject = (rec) => migrate(rec, 'project');
export const migrateFile = (rec) => migrate(rec, 'file');

// ---------------------------------------------------------------- names
export function cleanProjectName(name, fallback = 'Untitled project') {
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.maxNameLength);
  return s || fallback;
}

// ---------------------------------------------------------------- portable manifest validation
const isStr = (v, max = 500) => typeof v === 'string' && v.length <= max;
const isInt = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(v) && v >= min && v <= max;
const STATUSES = ['recognized', 'review', 'failed', 'cancelled', 'queued'];
const KINDS = ['pdf', 'jpeg', 'png', 'webp'];

/** Strict structural validation of a manifest read from an untrusted archive. Returns [] when valid. */
export function validateManifest(m) {
  const errors = [];
  const bad = (msg) => errors.push(msg);
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['manifest is not an object'];
  if (m.format !== PORTABLE_FORMAT) bad(`not an InvoiceLens project file (format "${String(m.format).slice(0, 40)}")`);
  if (!isInt(m.version, 1)) bad('missing manifest version');
  else if (m.version > SCHEMA_VERSION) bad(`saved by a newer version (${m.version}); update InvoiceLens`);
  if (!m.project || typeof m.project !== 'object') bad('missing project');
  else if (!isStr(m.project.name, LIMITS.maxNameLength * 2)) bad('bad project name');
  if (!Array.isArray(m.files)) return [...errors, 'missing files list'];
  if (m.files.length > LIMITS.maxFiles) bad(`too many files (${m.files.length} > ${LIMITS.maxFiles})`);
  const paths = new Set();
  m.files.forEach((f, i) => {
    const w = `file ${i + 1}`;
    if (!f || typeof f !== 'object') return bad(`${w}: not an object`);
    if (!isStr(f.name, 300) || !f.name) bad(`${w}: bad name`);
    if (!isStr(f.path, 200) || !/^files\/[A-Za-z0-9._-]+$/.test(f.path) || f.path.includes('..')) bad(`${w}: unsafe path`);
    else if (paths.has(f.path)) bad(`${w}: duplicate path`);
    else paths.add(f.path);
    if (!KINDS.includes(f.kind)) bad(`${w}: unknown kind`);
    if (!isInt(f.size, 1, LIMITS.maxMemberBytes)) bad(`${w}: bad size`);
    if (!STATUSES.includes(f.status)) bad(`${w}: bad status`);
    if (!isInt(f.rotation ?? 0, 0, 270) || (f.rotation ?? 0) % 90) bad(`${w}: bad rotation`);
    if (f.override != null && !['invoice', 'receipt', 'table', 'general'].includes(f.override)) bad(`${w}: bad type override`);
    if (f.result != null && (typeof f.result !== 'object' || !Array.isArray(f.result.pages))) bad(`${w}: bad recognition result`);
    if (f.doc != null && (typeof f.doc !== 'object' || f.doc.schema !== 'invoicelens.document')) bad(`${w}: bad document`);
  });
  return errors;
}
