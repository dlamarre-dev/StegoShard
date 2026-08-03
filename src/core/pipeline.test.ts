import { describe, it, expect } from 'vitest';
import { type Argon2Params, createKeyBlock, serializeKeyBlock } from './crypto';
import { getCodec } from './codec';
import { CODEC_QR_GRID, PROFILE_DISK, decodeHeader } from './header';
import { type VaultKey, exportVault, importVault } from './vault';

const TEST_PARAMS: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };

async function makeKey(password: string): Promise<VaultKey> {
  const { dek, block } = await createKeyBlock(password, TEST_PARAMS);
  return { dek, keyBlock: serializeKeyBlock(block) };
}

function pseudoRandom(len: number, seed: number): Uint8Array {
  let s = seed >>> 0;
  return Uint8Array.from({ length: len }, () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 24) & 0xff;
  });
}

/**
 * The Phase 1 acceptance test: a file makes the full round-trip through a set of
 * real images (bytes → QR pixels → bytes), tolerating missing images. The disk
 * profile is lossless, so rendering and decoding is a faithful identity.
 */
// Rendering and decoding a whole image set is real work, and it runs alongside
// the rest of the suite under coverage instrumentation.
const SLOW = { timeout: 60_000 };

describe('end-to-end pipeline through rendered images', () => {
  it('restores a file after rendering every payload to a QR image', SLOW, async () => {
    const codec = getCodec(CODEC_QR_GRID);
    const key = await makeKey('hunter2');
    const content = pseudoRandom(2500, 123);

    const { imagePayloads } = await exportVault('wallet.dat', content, key, {
      profile: PROFILE_DISK,
    });

    // Render each payload to pixels, then decode straight back (lossless).
    const images = imagePayloads.map((p) => codec.encode(p, PROFILE_DISK));
    const recoveredPayloads = images.map((img) => codec.decode(img));

    // Every header must survive intact (self-describing property).
    for (const p of recoveredPayloads) {
      expect(decodeHeader(p).codecId).toBe(CODEC_QR_GRID);
    }

    const out = await importVault(recoveredPayloads, 'hunter2');
    expect(out.filename).toBe('wallet.dat');
    expect([...out.content]).toEqual([...content]);
  });

  it('restores from images even when some are missing', SLOW, async () => {
    const codec = getCodec(CODEC_QR_GRID);
    const key = await makeKey('pw');
    const content = pseudoRandom(2500, 456);

    const { imagePayloads, m } = await exportVault('keys.txt', content, key, {
      profile: PROFILE_DISK,
    });

    // Simulate losing m images (e.g. torn pages / deleted album photos).
    const survivors = imagePayloads.slice(m);
    const decoded = survivors.map((p) => codec.decode(codec.encode(p, PROFILE_DISK)));

    const out = await importVault(decoded, 'pw');
    expect([...out.content]).toEqual([...content]);
  });
});
