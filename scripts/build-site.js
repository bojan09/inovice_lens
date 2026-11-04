// build-site.js - copy exactly the files the app serves into dist/ (what a static host publishes).
// No bundling or minifying: the app is plain ES modules, hosts compress on the fly. tests/, docs/, corpus/ and scripts/ are never published.
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'dist');
const PUBLIC = ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'assets', 'vendor']; // keep in sync with scripts/serve.js

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const name of PUBLIC) {
    const from = join(ROOT, name);
    if (!existsSync(from)) throw new Error(`missing ${name}: run \`npm run build:pwa\` and \`node scripts/vendor.js\` first`);
    cpSync(from, join(OUT, name), { recursive: true });
  }
  console.log(`dist/ ready: ${PUBLIC.join(', ')}`);
}
