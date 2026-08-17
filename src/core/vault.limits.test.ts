/**
 * The refusals on the export paths, none of which any test reached.
 *
 * The vault.ts mutation run reported 31 mutants with no coverage at all, and a
 * cluster of them sit on guards that decide whether a save is allowed to happen:
 * the image-count ceiling, the two file-size ceilings, the branded-only check on
 * `exportVaultBinary`, and the refusal to import a set with nothing readable in
 * it. Every one is a message a user can meet, and every one could have been
 * deleted with the suite still green.
 *
 * `TooManyImagesError`'s own constructor was uncovered too, so the numbers it
 * carries into that message were never read by anything.
 */

import { describe, it, expect } from 'vitest';
import { type Argon2Params, createKeyBlock, serializeKeyBlock } from './crypto';
import { CODEC_QR_GRID, PROFILE_PAPER } from './header';
import {
  type VaultKey,
  FileTooLargeError,
  MAX_FILE_BYTES,
  MAX_IMAGES,
  TooManyImagesError,
  exportVault,
  exportVaultBinary,
  exportVaultBinaryDisguised,
  importVault,
} from './vault';

const FAST: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };
const NAME = 'secret.txt';

async function makeKey(): Promise<VaultKey> {
  const { dek, block } = await createKeyBlock('pw', FAST);
  return { dek, keyBlock: serializeKeyBlock(block) };
}

function filler(n: number): Uint8Array {
  return new Uint8Array(n).map((_, i) => (i * 131 + 7) & 0xff);
}

/**
 * Incompressible bytes, which the image-count tests need and the size tests do
 * not.
 *
 * The envelope is compressed before it is encrypted, so a buffer of zeros, or
 * the repeating pattern `filler` produces, collapses to almost nothing and comes
 * out as a single shard however large it started. A first version of these tests
 * asked for 90 KiB and got k = 1, which would have made the ceiling untestable
 * while looking like a passing test of it.
 */
function noise(n: number): Uint8Array {
  const a = new Uint8Array(n);
  let s = 99;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    a[i] = (s >>> 24) & 0xff;
  }
  return a;
}

describe('image count ceiling', () => {
  it('refuses a vault that would need more than MAX_IMAGES images', async () => {
    // Measured, not derived: 90 KiB of incompressible content on the paper
    // profile crosses 150 images, while 30 KiB comes to 54. Both stay well under
    // the 1 MiB file limit, so it is the profile and not the file size that
    // trips this guard, which is what separates it from FileTooLargeError.
    const key = await makeKey();
    const content = noise(90 * 1024);

    await expect(
      exportVault(NAME, content, key, { codecId: CODEC_QR_GRID, profile: PROFILE_PAPER }),
    ).rejects.toBeInstanceOf(TooManyImagesError);
  });

  it('carries the count and the limit into the message', async () => {
    // The constructor had no coverage, so nothing read the two numbers it
    // formats. They are the whole content of the advice: a user who is told
    // "too many images" and not how many can only guess how much to remove.
    const key = await makeKey();
    const content = noise(90 * 1024);

    const err = await exportVault(NAME, content, key, {
      codecId: CODEC_QR_GRID,
      profile: PROFILE_PAPER,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TooManyImagesError);
    const typed = err as TooManyImagesError & { count: number; limit: number };
    expect(typed.limit).toBe(MAX_IMAGES);
    expect(typed.count).toBeGreaterThan(MAX_IMAGES);
    expect(typed.message).toContain(String(typed.count));
    expect(typed.message).toContain(String(MAX_IMAGES));
  });

  it('still accepts a vault just under the ceiling', async () => {
    // Without this the guard could be widened until it rejected everything and
    // the test above would not notice.
    const key = await makeKey();
    const { imagePayloads } = await exportVault(NAME, noise(30 * 1024), key, {
      codecId: CODEC_QR_GRID,
      profile: PROFILE_PAPER,
    });
    expect(imagePayloads.length).toBeGreaterThan(1);
    expect(imagePayloads.length).toBeLessThanOrEqual(MAX_IMAGES);
  });
});

describe('file size ceilings', () => {
  it('refuses a file past MAX_FILE_BYTES on the image path', async () => {
    const key = await makeKey();
    await expect(exportVault(NAME, filler(MAX_FILE_BYTES + 1), key)).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
  });

  it('refuses a file past the caller-supplied cap on the branded path', async () => {
    // `maxBytes` exists so the UI can impose a lower ceiling than the CLI's, so
    // the guard has to honour the argument rather than the constant.
    const key = await makeKey();
    const content = filler(4096);

    await expect(
      exportVaultBinary(NAME, content, key, { variant: 'branded', maxBytes: 1024 }),
    ).rejects.toMatchObject({ name: 'FileTooLargeError' });

    // And the same content passes when the cap allows it, so the test is about
    // the cap and not about the content.
    await expect(
      exportVaultBinary(NAME, content, key, { variant: 'branded', maxBytes: 8192 }),
    ).resolves.toBeDefined();
  });

  it('refuses a file past the caller-supplied cap on the disguised path', async () => {
    await expect(
      exportVaultBinaryDisguised(NAME, filler(4096), 'pw', { maxBytes: 1024 }),
    ).rejects.toMatchObject({ name: 'FileTooLargeError' });
  });

  // The remaining size guard is deliberately left uncovered: translating
  // BucketTooLargeError into FileTooLargeError needs content larger than the top
  // DB_LADDER bucket, which is 64 MiB. Allocating and encrypting that once is
  // affordable; doing it for every mutant that touches the file is not, and the
  // nightly is already the thing being kept in budget. Noted rather than faked.
});

describe('branded-only guard on exportVaultBinary', () => {
  it('refuses the disguised variant and says where to go instead', async () => {
    // A wrong-API call rather than bad user input, but it is the guard that
    // stops a disguised container being built by the single-region path, which
    // would produce a file that looks right and carries no decoy regions.
    const key = await makeKey();
    await expect(
      exportVaultBinary(NAME, filler(1024), key, { variant: 'disguised' }),
    ).rejects.toThrow(/branded/);
  });
});

describe('import with nothing readable', () => {
  it('refuses a set where no payload is a StegoShard image', async () => {
    // Distinct from the empty-input case, which is guarded separately: here
    // images were supplied and every one of them was foreign.
    const junk = [filler(500), filler(500).reverse(), new Uint8Array(500).fill(0xaa)];
    await expect(importVault(junk, 'pw')).rejects.toThrow(/no valid StegoShard images/);
  });
});
