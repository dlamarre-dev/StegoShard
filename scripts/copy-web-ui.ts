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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = process.cwd();
const SOURCE = resolve(ROOT, 'web-dist-offline');
const DEST = resolve(ROOT, 'dist-cli', 'web-ui');

/**
 * The zip's own launcher and its notes: useful in the download, pointless inside
 * the CLI, which has the `ui` command instead.
 */
const SKIP = (name: string): boolean =>
  name.startsWith('serve.') || /^README(\.[\w-]+)?\.txt$/.test(name);

if (!existsSync(join(SOURCE, 'index.html'))) {
  throw new Error(`missing ${SOURCE}/index.html (run 'npm run build:web:offline' first)`);
}

rmSync(DEST, { recursive: true, force: true });
let files = 0;
let bytes = 0;
for (const name of readdirSync(SOURCE, { recursive: true }) as string[]) {
  const rel = name.split('\\').join('/');
  // Source maps are for whoever built this, not for whoever runs it.
  if (rel.endsWith('.map') || SKIP(rel)) continue;
  let data;
  try {
    // Reading is the check: a `statSync` first would leave a window in which the
    // path could change (CodeQL js/file-system-race).
    data = readFileSync(join(SOURCE, name));
  } catch (err) {
    // Directory entries are what a recursive listing adds and all that may be
    // skipped; a real read failure must not quietly produce a partial copy.
    if ((err as NodeJS.ErrnoException).code !== 'EISDIR') throw err;
    continue;
  }
  const to = join(DEST, rel);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, data);
  files++;
  bytes += data.byteLength;
}

console.log(`web-ui: ${files} files, ${Math.round(bytes / 1024)} KiB -> dist-cli/web-ui/`);
