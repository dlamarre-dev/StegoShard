/**
 * Package the built extensions into store-ready zip archives.
 * Run with: npm run package  (builds both targets first, then zips them)
 * Outputs packages/imagevault-<target>-<version>.zip.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { zipSync } from 'fflate';
import { buildManifest } from '../src/manifest.config';

const ROOT = process.cwd();
const OUT = resolve(ROOT, 'packages');
const version = (buildManifest('chrome') as { version: string }).version;

function collect(dir: string): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const full = join(dir, name);
    if (name.endsWith('.map')) continue; // dev source maps: not needed in the store package
    try {
      // readdirSync(recursive) yields both dirs and files; read only files.
      const data = readFileSync(full);
      entries[name.split('\\').join('/')] = new Uint8Array(data);
    } catch {
      // Directory entry — skip.
    }
  }
  return entries;
}

function pack(target: 'chrome' | 'firefox'): void {
  const dir = resolve(ROOT, 'dist', target);
  if (!existsSync(dir)) throw new Error(`missing build: ${dir} (run the build first)`);
  const zipped = zipSync(collect(dir), { level: 9 });
  const outPath = resolve(OUT, `imagevault-${target}-${version}.zip`);
  writeFileSync(outPath, zipped);
  const kb = (zipped.length / 1024).toFixed(1);
  console.log(`${target}: ${outPath} (${kb} kB)`);
}

mkdirSync(OUT, { recursive: true });
pack('chrome');
pack('firefox');
console.log(`packaged version ${version}`);
