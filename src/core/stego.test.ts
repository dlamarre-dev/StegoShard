/**
 * Deniable stego key block: embed/extract round-trips, wrong-password and
 * wrong-image rejection, capacity guard, and the deniability properties
 * (sparse changes, only LSBs touched, alpha untouched, whitened carrier).
 */

import { describe, it, expect } from 'vitest';
import {
  type Argon2Params,
  StegoCapacityError,
  createKeyBlock,
  embedKeyBlockStego,
  extractKeyBlockStego,
  isSerializedKeyBlock,
  serializeKeyBlock,
  KEY_BLOCK_LEN,
} from './index';

// Cheap Argon2 keeps the suite fast; production uses DEFAULT_ARGON2.
const FAST: Argon2Params = { iterations: 1, memoryKiB: 64, parallelism: 1 };

/** A deterministic "photo": smooth gradient so LSB changes are meaningful. */
function makeCover(width: number, height: number, seed = 1): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  let s = seed >>> 0;
  for (let p = 0; p < width * height; p++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    rgba[p * 4] = (p * 7) & 0xff;
    rgba[p * 4 + 1] = (p * 13) & 0xff;
    rgba[p * 4 + 2] = (s >>> 24) & 0xff;
    rgba[p * 4 + 3] = 255;
  }
  return rgba;
}

async function makeKeyBlockBytes(password: string): Promise<Uint8Array> {
  const { block } = await createKeyBlock(password, FAST);
  return serializeKeyBlock(block);
}

const W = 128;
const H = 128; // 128*128*3 = 49152 LSBs, well above the minimum

describe('stego round-trip', () => {
  it('embeds and extracts the exact key block with the right password', async () => {
    const kb = await makeKeyBlockBytes('correct horse');
    const rgba = makeCover(W, H);
    await embedKeyBlockStego(rgba, W, H, kb, 'correct horse', FAST);

    const out = await extractKeyBlockStego(rgba, W, H, 'correct horse', FAST);
    expect(out).not.toBeNull();
    expect([...out!]).toEqual([...kb]);
    expect(isSerializedKeyBlock(out!)).toBe(true);
  });

  it('extracts across Unicode normalization forms (NFC/NFD password)', async () => {
    const nfc = 'passwörd'; // precomposed
    const nfd = 'passwörd'; // decomposed o + combining diaeresis
    expect(nfc).not.toBe(nfd);
    const kb = await makeKeyBlockBytes(nfc);
    const rgba = makeCover(W, H);
    await embedKeyBlockStego(rgba, W, H, kb, nfc, FAST);
    const out = await extractKeyBlockStego(rgba, W, H, nfd, FAST);
    expect(out).not.toBeNull();
    expect([...out!]).toEqual([...kb]);
  });
});

describe('stego rejection (deniability of failure)', () => {
  it('returns null for a wrong password (indistinguishable from no key)', async () => {
    const kb = await makeKeyBlockBytes('right');
    const rgba = makeCover(W, H);
    await embedKeyBlockStego(rgba, W, H, kb, 'right', FAST);
    expect(await extractKeyBlockStego(rgba, W, H, 'wrong', FAST)).toBeNull();
  });

  it('returns null for an untouched cover image', async () => {
    const rgba = makeCover(W, H, 99);
    expect(await extractKeyBlockStego(rgba, W, H, 'anything', FAST)).toBeNull();
  });

  it('does not leak across two covers keyed by different passwords', async () => {
    const a = makeCover(W, H, 1);
    const b = makeCover(W, H, 2);
    await embedKeyBlockStego(a, W, H, await makeKeyBlockBytes('alpha'), 'alpha', FAST);
    await embedKeyBlockStego(b, W, H, await makeKeyBlockBytes('bravo'), 'bravo', FAST);
    expect(await extractKeyBlockStego(a, W, H, 'bravo', FAST)).toBeNull();
    expect(await extractKeyBlockStego(b, W, H, 'alpha', FAST)).toBeNull();
  });
});

describe('stego deniability properties', () => {
  it('touches only LSBs, never alpha, and changes few pixels', async () => {
    const kb = await makeKeyBlockBytes('pw');
    const before = makeCover(W, H);
    const after = before.slice();
    await embedKeyBlockStego(after, W, H, kb, 'pw', FAST);

    let changed = 0;
    for (let i = 0; i < before.length; i++) {
      if (before[i] === after[i]) continue;
      changed++;
      // Only the LSB may differ.
      expect((before[i]! ^ after[i]!) & 0xfe).toBe(0);
      // Never an alpha byte (index % 4 === 3).
      expect(i % 4).not.toBe(3);
    }
    // At most 736 carrier bits, ~half already match → well under 736 changes.
    expect(changed).toBeGreaterThan(0);
    expect(changed).toBeLessThanOrEqual(KEY_BLOCK_LEN * 8);
  });

  it('the carried bits are ~uniformly distributed (whitened)', async () => {
    // Embed into an all-zero cover so the written LSB equals the whitened bit.
    const rgba = new Uint8Array(W * H * 4);
    for (let p = 0; p < W * H; p++) rgba[p * 4 + 3] = 255;
    const kb = await makeKeyBlockBytes('pw');
    await embedKeyBlockStego(rgba, W, H, kb, 'pw', FAST);
    let ones = 0;
    for (let p = 0; p < W * H; p++) {
      ones += (rgba[p * 4]! & 1) + (rgba[p * 4 + 1]! & 1) + (rgba[p * 4 + 2]! & 1);
    }
    // ~368 ones expected out of 736 carrier bits; allow a generous band.
    expect(ones).toBeGreaterThan(736 * 0.3);
    expect(ones).toBeLessThan(736 * 0.7);
  });
});

describe('stego capacity', () => {
  it('throws a typed error when the cover is too small', async () => {
    const kb = await makeKeyBlockBytes('pw');
    const rgba = makeCover(32, 32); // 32*32*3 = 3072 < minimum
    await expect(embedKeyBlockStego(rgba, 32, 32, kb, 'pw', FAST)).rejects.toBeInstanceOf(
      StegoCapacityError,
    );
  });

  it('extraction returns null (not throw) for an undersized image', async () => {
    const rgba = makeCover(32, 32);
    expect(await extractKeyBlockStego(rgba, 32, 32, 'pw', FAST)).toBeNull();
  });

  it('rejects a wrong-length payload', async () => {
    const rgba = makeCover(W, H);
    await expect(
      embedKeyBlockStego(rgba, W, H, new Uint8Array(10), 'pw', FAST),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
