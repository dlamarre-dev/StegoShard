/**
 * Embedding scheme S1 on real JPEG coefficients (SPEC §9.3.1).
 *
 * What changes against S0 is which carriers are written, never how: every
 * change is still the LSB of a `|v| ≥ 2` magnitude, so the carrier set is the
 * same after the embed as before, and that invariance is what lets the reader
 * find the code again. These tests hold that, the round trip, and the reason S1
 * exists, a quarter of S0's changes for the same slot.
 */

import { describe, expect, it } from 'vitest';
import jpeg from 'jpeg-js';
import { decode, eligibleCoefficients } from './jpeg-coeff';
import {
  StegoCapacityError,
  embedBytesStcJpeg,
  embedBytesStegoJpeg,
  extractBytesStcJpeg,
  extractBytesStegoJpeg,
} from './stego';
import { uerdCosts } from './costs/uerd';

/** Textured q85 baseline JPEG; 448² of noise gives about 285 000 carriers. */
function noisyJpeg(side: number, seed: number): Uint8Array {
  const data = Buffer.alloc(side * side * 4);
  let s = seed >>> 0;
  for (let i = 0; i < side * side; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i * 4] = (s >>> 24) & 0xff;
    data[i * 4 + 1] = (s >>> 16) & 0xff;
    data[i * 4 + 2] = (s >>> 8) & 0xff;
    data[i * 4 + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data, width: side, height: side }, 85).data);
}

const SLOT = 2109; // a gallery slot
const bytes = (n: number, seed: number) =>
  Uint8Array.from({ length: n }, (_, i) => (i * 131 + seed * 7) & 0xff);
const key = (seed: number) => Uint8Array.from({ length: 32 }, (_, i) => (i + seed) & 0xff);

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

/** Total UERD cost, priced on the cover, of every carrier the embed changed. */
function priceOf(coverJpeg: Uint8Array, stegoJpeg: Uint8Array): number {
  const x = decode(coverJpeg);
  const y = decode(stegoJpeg);
  const raw = uerdCosts(x);
  let i = 0;
  let total = 0;
  x.components.forEach((c, ci) =>
    c.blocks.forEach((blk, bi) => {
      const other = y.components[ci]!.blocks[bi]!;
      for (let k = 1; k < 64; k++) {
        if (Math.abs(blk[k]!) < 2) continue;
        if (blk[k] !== other[k]) total += raw[i]!;
        i++;
      }
    }),
  );
  return total;
}

describe('embedding scheme S1', () => {
  const cover = noisyJpeg(448, 1);
  const data = bytes(SLOT, 1);

  it('reads back what it wrote', async () => {
    const stego = await embedBytesStcJpeg(cover, data, key(1));
    expect(await extractBytesStcJpeg(stego, key(1), SLOT)).toEqual(data);
  });

  it('writes only the LSB of |v| ≥ 2 magnitudes, so the carrier set does not move', async () => {
    const stego = await embedBytesStcJpeg(cover, data, key(2));
    for (const [a, b] of changes(cover, stego)) {
      expect(Math.abs(a)).toBeGreaterThanOrEqual(2);
      expect(Math.abs(b)).toBeGreaterThanOrEqual(2);
      expect(Math.sign(a)).toBe(Math.sign(b));
      expect(Math.abs(Math.abs(a) - Math.abs(b))).toBe(1);
      expect(Math.abs(a) >> 1).toBe(Math.abs(b) >> 1); // the pair {2i, 2i+1}
    }
    expect(eligibleCoefficients(decode(stego)).count).toBe(
      eligibleCoefficients(decode(cover)).count,
    );
  });

  it('changes about a quarter of what S0 changes for the same slot', async () => {
    const s0 = changes(cover, await embedBytesStegoJpeg(cover, data, key(3), 16)).length;
    const s1 = changes(cover, await embedBytesStcJpeg(cover, data, key(3), 16, 'uniform')).length;
    // S0 flips half its 16 872 bits; S1 at uniform cost about one in 7.1 (see STC_WIDTH).
    expect(s0).toBeGreaterThan(8000);
    expect(s1).toBeGreaterThan(2000);
    expect(s1).toBeLessThan(2700);
  });

  /**
   * What the UERD costs buy, and what they cost. The trellis now minimizes the
   * total cost rather than the count, so it takes more flips than at uniform
   * cost, each cheaper: the total UERD price of the flips falls well below
   * uniform's, for a count that rises by a bounded amount.
   */
  it('trades a bounded rise in changes for a lower total cost under UERD', async () => {
    const uniform = changes(cover, await embedBytesStcJpeg(cover, data, key(3), 16, 'uniform'));
    const uerd = changes(cover, await embedBytesStcJpeg(cover, data, key(3)));
    expect(uerd.length).toBeGreaterThan(uniform.length);
    expect(uerd.length).toBeLessThan(uniform.length * 1.6);
    const price = (stego: Uint8Array) => priceOf(cover, stego);
    const pu = price(await embedBytesStcJpeg(cover, data, key(3), 16, 'uniform'));
    const pe = price(await embedBytesStcJpeg(cover, data, key(3)));
    expect(pe).toBeLessThan(pu * 0.8);
    expect(
      await extractBytesStcJpeg(await embedBytesStcJpeg(cover, data, key(3)), key(3), SLOT),
    ).toEqual(data);
  }, 120000); // five embeds, each several times slower under coverage

  it('is deterministic for a cover, a payload and a key', async () => {
    expect(await embedBytesStcJpeg(cover, data, key(4))).toEqual(
      await embedBytesStcJpeg(cover, data, key(4)),
    );
  });

  it('gives nothing meaningful under another key or the other scheme', async () => {
    const stego = await embedBytesStcJpeg(cover, data, key(5));
    expect(await extractBytesStcJpeg(stego, key(6), SLOT)).not.toEqual(data);
    expect(await extractBytesStegoJpeg(stego, key(5), SLOT, 4)).not.toEqual(data);
  });

  it('refuses a cover with fewer than 16 carriers per bit, and reads nothing from one', async () => {
    const small = noisyJpeg(160, 9);
    await expect(embedBytesStcJpeg(small, data, key(7))).rejects.toBeInstanceOf(StegoCapacityError);
    expect(await extractBytesStcJpeg(small, key(7), SLOT)).toBeNull();
  });
});
