/** Validate the exact extension archives that are ready for store upload. */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { buildManifest, type Target } from '../src/manifest.config';

const root = process.cwd();
const version = (buildManifest('chrome') as { version: string }).version;
const targets: Target[] = ['chrome', 'edge', 'firefox'];
const forbidden =
  /photoslibrary\.googleapis\.com|photospicker\.googleapis\.com|response_type=token|STEGOSHARD_GOOGLE_CLIENT_ID/;

function files(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((name) => {
      try {
        readFileSync(resolve(dir, name));
        return true;
      } catch {
        return false;
      }
    })
    .map((name) => name.replaceAll('\\', '/'))
    .sort();
}

for (const target of targets) {
  const archive = resolve(root, 'packages', `stegoshard-${target}-${version}.zip`);
  const entries = unzipSync(new Uint8Array(readFileSync(archive)));
  const names = Object.keys(entries).sort();
  const expected = [
    ...files(resolve(root, 'dist', target)).filter((n) => !n.endsWith('.map')),
    'LICENSE',
    'THIRD_PARTY_NOTICES.txt',
  ].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`${target}: archive file set differs from the built release`);
  }
  const mirror = files(resolve(root, 'dist-release', target));
  if (JSON.stringify(mirror) !== JSON.stringify(expected)) {
    throw new Error(`${target}: unpacked release differs from its archive`);
  }
  for (const required of ['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'manifest.json']) {
    if (!entries[required]) throw new Error(`${target}: missing ${required}`);
  }
  if (names.some((name) => name.endsWith('.map'))) throw new Error(`${target}: source map shipped`);
  const manifest = JSON.parse(strFromU8(entries['manifest.json']!)) as Record<string, unknown>;
  if ('optional_permissions' in manifest || 'optional_host_permissions' in manifest) {
    throw new Error(`${target}: unexpected optional permissions`);
  }
  for (const [name, bytes] of Object.entries(entries)) {
    if (/\.(?:js|html|json|txt)$/i.test(name) && forbidden.test(strFromU8(bytes))) {
      throw new Error(`${target}: deferred cloud-integration code found in ${name}`);
    }
  }
  console.log(`${target}: verified ${names.length} packaged files`);
}
