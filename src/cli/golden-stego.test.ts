/**
 * The committed stego covers still give up their key block.
 *
 * `tests/golden/stego` and `tests/golden/stego-jpeg` hold real key images built
 * by an earlier version of this code, and `scripts/check-golden.ts` already
 * verifies them in CI. That script is not a vitest test, though, and mutation
 * testing only runs vitest, so as far as Stryker was concerned nothing pinned
 * the cover fingerprint's *value* at all.
 *
 * The report showed exactly that: after the property tests in
 * src/core/stego.binding.test.ts landed, 15 mutants still survived inside the
 * two fingerprint functions, and every one of them is of the same kind. They
 * change which cover bytes feed the hash, or their order, while leaving the
 * result deterministic, cover-dependent and invariant under embedding. Those are
 * the three properties the binding tests assert, so the binding tests cannot see
 * them. `pixels / 3`, `p / 4`, `o--`, `base - 1`, big-endian turned little.
 *
 * They are not harmless. The fingerprint is a cross-implementation contract:
 * python/stegoshard/stego.py computes the same hash, so a cover hidden by one
 * implementation is only readable by the other while both agree byte for byte.
 * Nothing about that is visible from inside a single implementation's
 * round-trip, which is why a committed artifact is the only honest way to hold
 * it still.
 *
 * So this reads the real files. Any change to what the fingerprint hashes
 * derives a different key, picks different carriers, and returns null here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEY_BLOCK_LEN, isSerializedKeyBlock } from '../core/index';
import { extractKeyImage } from './node-image-io';

const ROOT = join(import.meta.dirname, '..', '..', 'tests', 'golden');

function manifest(dir: string): { password: string } {
  return JSON.parse(readFileSync(join(ROOT, dir, 'manifest.json'), 'utf-8')) as {
    password: string;
  };
}

describe('golden stego covers', () => {
  // Production Argon2 (t=4, m=256 MiB), because that is what produced the files
  // and the whole point is to read them as they are. It costs about a second a
  // call, which is why there are two cases here and not a sweep.
  it.each([
    ['stego', 'key.png'],
    ['stego-jpeg', 'key.jpg'],
  ])('recovers the key block from tests/golden/%s/%s', async (dir, file) => {
    const bytes = new Uint8Array(readFileSync(join(ROOT, dir, file)));
    const out = await extractKeyImage(bytes, file, manifest(dir).password);

    expect(out, `no key block came out of ${dir}/${file}`).not.toBeNull();
    expect(out!.length).toBe(KEY_BLOCK_LEN);
    expect(isSerializedKeyBlock(out!)).toBe(true);
  });

  it('finds nothing in the same covers under a wrong password', async () => {
    // Without this the test above would still pass against an extractor that
    // returned a key block for anything, which is the failure it guards.
    const bytes = new Uint8Array(readFileSync(join(ROOT, 'stego', 'key.png')));
    expect(await extractKeyImage(bytes, 'key.png', 'not the password')).toBeNull();
  });
});
