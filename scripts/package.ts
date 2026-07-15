/**
 * Package the built extensions into store-ready zip archives, and mirror the
 * exact same file set (unzipped) into dist-release/<target>/ for loading
 * unpacked and testing precisely what will be uploaded.
 *
 * Run with: npm run package  (builds all targets in store mode first, then this)
 * Outputs:
 *   packages/imagevault-<target>-<version>.zip
 *   dist-release/<target>/            (identical contents, source maps excluded)
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { zipSync } from 'fflate';
import { buildManifest, type Target } from '../src/manifest.config';

const ROOT = process.cwd();
const OUT = resolve(ROOT, 'packages');
const RELEASE = resolve(ROOT, 'dist-release');
const TARGETS: Target[] = ['chrome', 'edge', 'firefox'];
const version = (buildManifest('chrome') as { version: string }).version;

/** Read a built dir into a { relPath: bytes } map, excluding dev source maps. */
function collect(dir: string): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    if (name.endsWith('.map')) continue; // dev source maps: not needed in the package
    try {
      // readdirSync(recursive) yields both dirs and files; read only files.
      const data = readFileSync(join(dir, name));
      entries[name.split('\\').join('/')] = new Uint8Array(data);
    } catch {
      // Directory entry — skip.
    }
  }
  return entries;
}

function pack(target: Target): void {
  const dir = resolve(ROOT, 'dist', target);
  if (!existsSync(dir)) throw new Error(`missing build: ${dir} (run the build first)`);
  const entries = collect(dir);

  // 1) Zip for store upload.
  const zipped = zipSync(entries, { level: 9 });
  writeFileSync(resolve(OUT, `imagevault-${target}-${version}.zip`), zipped);

  // 2) Unzipped mirror for local testing (identical to the zip's contents).
  const releaseDir = resolve(RELEASE, target);
  rmSync(releaseDir, { recursive: true, force: true });
  for (const [rel, bytes] of Object.entries(entries)) {
    const dest = join(releaseDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
  }

  console.log(`${target}: packages/imagevault-${target}-${version}.zip + dist-release/${target}/`);
}

mkdirSync(OUT, { recursive: true });
mkdirSync(RELEASE, { recursive: true });
for (const target of TARGETS) pack(target);
console.log(`packaged version ${version} (${TARGETS.join(', ')})`);
