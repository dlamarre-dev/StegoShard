/**
 * Copy the offline web build next to the CLI bundle, as `dist-cli/web-ui/`.
 *
 * That is what `stegoshard ui` serves and what the npm package ships:
 * `package.json`'s `files: ["dist-cli"]` already covers it, so publishing needs no
 * other change. The `deno compile` binaries embed only `stegoshard.js`, so they
 * get none of this, which is deliberate: they are compiled without network access
 * and could not serve it anyway.
 *
 * Run with: npm run build:cli  (after the offline web build)
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = process.cwd();
const SOURCE = resolve(ROOT, 'web-dist-offline');
const DEST = resolve(ROOT, 'dist-cli', 'web-ui');

/**
 * The zip's own launcher and its notes: useful in the download, pointless inside
 * the CLI, which has the `ui` command instead.
 */
const SKIP = new Set(['serve.mjs', 'serve.cmd', 'serve.sh', 'README.txt']);

if (!existsSync(join(SOURCE, 'index.html'))) {
  throw new Error(`missing ${SOURCE}/index.html (run 'npm run build:web:offline' first)`);
}

rmSync(DEST, { recursive: true, force: true });
let files = 0;
let bytes = 0;
for (const name of readdirSync(SOURCE, { recursive: true }) as string[]) {
  const rel = name.split('\\').join('/');
  // Source maps are for whoever built this, not for whoever runs it.
  if (rel.endsWith('.map') || SKIP.has(rel)) continue;
  const from = join(SOURCE, name);
  if (!statSync(from).isFile()) continue;
  const to = join(DEST, rel);
  mkdirSync(dirname(to), { recursive: true });
  const data = readFileSync(from);
  writeFileSync(to, data);
  files++;
  bytes += data.byteLength;
}

console.log(`web-ui: ${files} files, ${Math.round(bytes / 1024)} KiB -> dist-cli/web-ui/`);
