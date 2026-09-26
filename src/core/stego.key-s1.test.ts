/**
 * Key-photo scheme S1-key (SPEC §5.4.1).
 *
 * What these hold: S1-key changes a small fraction of what S0 did for the same
 * key block, with the same write (the LSB of a `|v| ≥ 2` magnitude, so the cover
 * fingerprint and the carrier set do not move); a small photo still works, with a
 * narrower code, down to the ×2 floor S0 always had; and reading one Argon2 seed
 * serves both schemes, so an S0 key photo delivered before S1-key costs no second
 * derivation. The S0 reader itself is pinned by the frozen golden
 * `tests/golden/stego-jpeg/` (src/api/node/golden-stego.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import jpeg from 'jpeg-js';

const argon2Calls = { n: 0 };

// Delegates to the real implementation and counts, as access.trace.test.ts does.
vi.mock('hash-wasm', async (importOriginal) => {
  const real = await importOriginal<typeof import('hash-wasm')>();
  return {
    ...real,
    argon2id: (...args: Parameters<typeof real.argon2id>) => {
      argon2Calls.n++;
      return real.argon2id(...args);
    },
  };
});

const {
  KEY_BLOCK_LEN,
  StegoCapacityError,
  createKeyBlock,
  decode,
  eligibleCoefficients,
  embedKeyBlockStegoJpeg,
  embedKeyFactorStegoJpeg,
  extractKeyBlockStegoJpeg,
  extractKeyFactorStegoJpeg,
  resetStegoCoverGuard,
  serializeKeyBlock,
} = await import('./index');

beforeEach(() => resetStegoCoverGuard());

const FAST = { iterations: 1, memoryKiB: 64, parallelism: 1 };

/** A textured q85 baseline JPEG, so it has plenty of |coef| ≥ 2 carriers. */
function noisyJpeg(side: number, seed = 1, amplitude = 255): Uint8Array {
  const data = Buffer.alloc(side * side * 4);
  let s = seed >>> 0;
  for (let i = 0; i < side * side; i++) {
    for (let c = 0; c < 3; c++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      data[i * 4 + c] = Math.round(128 + ((s >>> 24) / 255 - 0.5) * amplitude);
    }
    data[i * 4 + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data, width: side, height: side }, 85).data);
}

/** Every changed coefficient, as [before, after]. */
function changes(a: Uint8Array, b: Uint8Array): [number, number][] {
  const x = decode(a);
  const y = decode(b);
  const out: [number, number][] = [];
  x.components.forEach((c, ci) =>
    c.blocks.forEach((blk, bi) => {
      const other = y.components[ci]!.blocks[bi]!;
      for (let k = 0; k < 64; k++) if (blk[k] !== other[k]) out.push([blk[k]!, other[k]!]);
    }),
  );
  return out;
}

async function keyBlock(password: string): Promise<Uint8Array> {
  return serializeKeyBlock((await createKeyBlock(password, FAST)).block);
}

describe('key-photo scheme S1-key', () => {
  it('changes about a quarter of what S0 did, by LSB replacement only', async () => {
    // 256² of noise: over 47 104 carriers, so the code is at its full width of 64.
    const cover = noisyJpeg(256);
    expect(eligibleCoefficients(decode(cover)).count).toBeGreaterThan(KEY_BLOCK_LEN * 8 * 64);
    const kb = await keyBlock('pw');
    const stego = await embedKeyBlockStegoJpeg(cover, kb, 'pw', FAST);
    expect(await extractKeyBlockStegoJpeg(stego, 'pw', FAST)).toEqual(kb);

    const moved = changes(cover, stego);
    // S0 flips half of its 736 bits, about 368; STC at w = 64 about 88 at uniform
    // cost, and UERD trades a few more for placement.
    expect(moved.length).toBeGreaterThan(40);
    expect(moved.length).toBeLessThan(160);
    for (const [a, b] of moved) {
      expect(Math.abs(a)).toBeGreaterThanOrEqual(2);
      expect(Math.sign(a)).toBe(Math.sign(b));
      expect(Math.abs(a) >> 1).toBe(Math.abs(b) >> 1); // the pair {2i, 2i+1}: LSB replacement
    }
  });

  it('works on a small photo with a narrower code, and refuses one below the floor', async () => {
    // Low-amplitude noise at 96²: between 2 and 64 carriers per key-block bit.
    const small = noisyJpeg(96, 7, 90);
    const n = eligibleCoefficients(decode(small)).count;
    expect(n).toBeGreaterThanOrEqual(KEY_BLOCK_LEN * 8 * 2);
    expect(n).toBeLessThan(KEY_BLOCK_LEN * 8 * 64);
    const kb = await keyBlock('pw');
    const stego = await embedKeyBlockStegoJpeg(small, kb, 'pw', FAST);
    expect(await extractKeyBlockStegoJpeg(stego, 'pw', FAST)).toEqual(kb);

    const tiny = noisyJpeg(32, 7, 90);
    expect(eligibleCoefficients(decode(tiny)).count).toBeLessThan(KEY_BLOCK_LEN * 8 * 2);
    await expect(embedKeyBlockStegoJpeg(tiny, kb, 'pw', FAST)).rejects.toBeInstanceOf(
      StegoCapacityError,
    );
    expect(await extractKeyBlockStegoJpeg(tiny, 'pw', FAST)).toBeNull();
  });

  it('carries the key factor too, and nothing under another password', async () => {
    const factor = Uint8Array.from({ length: 32 }, (_, i) => (i * 29 + 3) & 0xff);
    const stego = await embedKeyFactorStegoJpeg(noisyJpeg(160, 3), factor, 'pw', FAST);
    expect(await extractKeyFactorStegoJpeg(stego, 'pw', FAST)).toEqual(factor);
    expect(await extractKeyFactorStegoJpeg(stego, 'other', FAST)).toBeNull();
  });

  it('keeps the cover fingerprint, so the carrier set and the S0 key are unchanged', async () => {
    const cover = noisyJpeg(160, 5);
    const stego = await embedKeyBlockStegoJpeg(cover, await keyBlock('pw'), 'pw', FAST);
    const masked = (b: Uint8Array) => {
      const out: number[] = [];
      for (const c of decode(b).components)
        for (const blk of c.blocks)
          for (let k = 1; k < 64; k++) {
            const v = blk[k]!;
            if (Math.abs(v) >= 2) out.push(Math.sign(v) * (Math.abs(v) & ~1)); // as coverFingerprintJpeg
          }
      return out;
    };
    expect(masked(stego)).toEqual(masked(cover));
  });

  it('runs Argon2 once to read an S0 key photo, the S1-key attempt included', async () => {
    // The frozen S0 golden, at the production cost that wrote it.
    const dir = join(import.meta.dirname, '../../tests/golden/stego-jpeg');
    const bytes = new Uint8Array(readFileSync(join(dir, 'key.jpg')));
    const { password } = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8')) as {
      password: string;
    };
    argon2Calls.n = 0;
    const out = await extractKeyBlockStegoJpeg(bytes, password);
    expect(out).not.toBeNull();
    expect(argon2Calls.n).toBe(1);

    argon2Calls.n = 0;
    expect(await extractKeyBlockStegoJpeg(bytes, 'not the password')).toBeNull();
    expect(argon2Calls.n).toBe(1);
  }, 60000);
});
