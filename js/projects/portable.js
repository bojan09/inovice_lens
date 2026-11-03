// portable.js - export / import a project as one ZIP: manifest.json + the original files. The archive is UNTRUSTED on
// import: sizes are checked before inflating, paths are matched against the manifest only (never used to write files),
// the manifest is validated strictly, and each original still goes through the normal intake checks when opened.
import { loadFflate } from '../export/libs.js';
import { validateManifest, PORTABLE_FORMAT, SCHEMA_VERSION, LIMITS, cleanProjectName, SchemaError } from './schema.js';
import { safeStem } from '../export/util.js';

export const PORTABLE_MIME = 'application/zip';
export const portableName = (name, now = new Date()) => `${safeStem(name, 'project')}_${now.toISOString().slice(0, 10)}.invoicelens.zip`;

/** @param {{project:{name:string}, files:{id:string,name:string,kind:string,size:number,status:string,rotation:number,override:string|null,result:object|null,doc:object|null,blob:Blob}[]}} p */
export async function packProject(p, { now = new Date() } = {}) {
  const { zipSync, strToU8 } = await loadFflate();
  const members = {};
  const files = [];
  let n = 0;
  for (const f of p.files) {
    n += 1;
    const path = `files/${n}-${safeStem(f.name, 'file')}${/\.[A-Za-z0-9]{1,5}$/.exec(f.name)?.[0] ?? ''}`;
    members[path] = [new Uint8Array(await f.blob.arrayBuffer()), { level: 0 }]; // originals are already compressed formats
    files.push({ name: f.name, path, kind: f.kind, mime: f.mime ?? '', size: f.blob.size, status: f.status, rotation: f.rotation ?? 0, override: f.override ?? null, width: f.width ?? null, height: f.height ?? null, fingerprint: typeof f.fingerprint === 'string' ? f.fingerprint : null, result: f.result ?? null, doc: f.doc ?? null });
  }
  const manifest = { format: PORTABLE_FORMAT, version: SCHEMA_VERSION, createdAt: now.toISOString(), app: 'InvoiceLens', project: { name: cleanProjectName(p.project.name) }, files };
  members['manifest.json'] = [strToU8(JSON.stringify(manifest)), { level: 6 }];
  const bytes = zipSync(members, { mtime: now });
  return { blob: new Blob([bytes], { type: PORTABLE_MIME }), bytes: bytes.length };
}

/**
 * @returns {Promise<{project:{name:string}, files:object[]}>} files carry `blob`; throws SchemaError with a readable message.
 */
export async function unpackProject(input, { limits = LIMITS } = {}) {
  const { unzipSync, strFromU8 } = await loadFflate();
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(await input.arrayBuffer());
  if (bytes.length > limits.maxImportBytes) throw new SchemaError('too-big', `This file is larger than the ${Math.round(limits.maxImportBytes / 1048576)} MB import limit.`);
  let total = 0;
  let tooBig = null;
  let entries;
  try {
    entries = unzipSync(bytes, {
      filter: (f) => {
        total += f.originalSize;
        if (f.originalSize > limits.maxMemberBytes) tooBig = tooBig ?? `"${f.name.slice(0, 60)}" is larger than ${Math.round(limits.maxMemberBytes / 1048576)} MB`;
        if (total > limits.maxInflatedBytes) tooBig = tooBig ?? 'the archive expands to more than the import limit';
        return !tooBig; // stop inflating as soon as a limit is crossed
      },
    });
  } catch {
    throw new SchemaError('not-zip', 'This is not a readable InvoiceLens project file (the ZIP is damaged).');
  }
  if (tooBig) throw new SchemaError('too-big', `Import refused: ${tooBig}.`);
  const raw = entries['manifest.json'];
  if (!raw) throw new SchemaError('no-manifest', 'This ZIP has no manifest.json, so it is not an InvoiceLens project.');
  let manifest;
  try { manifest = JSON.parse(strFromU8(raw)); } catch { throw new SchemaError('bad-manifest', 'The project manifest is not valid JSON.'); }
  const errors = validateManifest(manifest);
  if (errors.length) throw new SchemaError('invalid', `The project file is not valid: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? ` (+${errors.length - 3} more)` : ''}.`);
  const files = manifest.files.map((f) => {
    const data = entries[f.path];
    if (!data) throw new SchemaError('missing-member', `The project lists "${f.name}" but its file is missing from the ZIP.`);
    if (data.length !== f.size) throw new SchemaError('size-mismatch', `"${f.name}" does not match its recorded size (damaged or altered).`);
    return { ...f, blob: new Blob([data], { type: f.mime || '' }) };
  });
  return { project: { name: cleanProjectName(manifest.project.name) }, files, version: manifest.version };
}
