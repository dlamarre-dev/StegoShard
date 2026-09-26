/**
 * UERD costs (`uerd.ts`) and their fixed-point form (`stcCosts`).
 *
 * The cost function itself is the paper's; what these tests hold is what this
 * codebase depends on: the costs line up one for one with the S1 carriers, they
 * rank busy blocks and coarse modes cheaper, they reach the trellis as integers
 * in range, and with them the S1 writer moves its flips into the texture, which
 * is the step's whole point (it replaces, for S1, the uniform-placement argument
 * of `stego.concentration.test.ts`).
 */

import { describe, expect, it } from 'vitest';
import jpeg from 'jpeg-js';
import { decode, eligibleCoefficients } from '../jpeg-coeff';
import { STC_MAX_COST } from '../stc';
import { embedBytesStcJpeg, extractBytesStcJpeg } from '../stego';
import { componentQuantTables, stcCosts, uerdCosts } from './uerd';

/**
 * A q85 baseline JPEG, `width` × `height`, of noise whose amplitude is `left`
 * on the left half and `right` on the right half, around mid-grey.
 */
function twoTextures(width: number, height: number, left: number, right: number): Uint8Array {
  const data = Buffer.alloc(width * height * 4);
  let s = 12345;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const amp = x < width / 2 ? left : right;
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        s = (s * 1664525 + 1013904223) >>> 0;
        data[i + c] = Math.round(128 + ((s >>> 24) / 255 - 0.5) * amp);
      }
      data[i + 3] = 255;
    }
  }
  return new Uint8Array(jpeg.encode({ data, width, height }, 85).data);
}

describe('uerdCosts', () => {
  const model = decode(twoTextures(256, 128, 255, 255));

  it('reads one 64-step table per component, from the tables the frame names', () => {
    const q = componentQuantTables(model);
    expect(q).toHaveLength(3);
    // jpeg-js at q85 shares the chroma table between Cb and Cr, not with luma.
    expect(q[1]).toEqual(q[2]);
    expect(q[0]).not.toEqual(q[1]);
    for (const t of q) for (const step of t) expect(step).toBeGreaterThan(0);
  });

  it('prices every S1 carrier, in carrier order, with a positive finite cost', () => {
    const costs = uerdCosts(model);
    expect(costs.length).toBe(eligibleCoefficients(model).count);
    for (const c of costs) expect(Number.isFinite(c) && c > 0).toBe(true);
  });

  it('prices a change in a quiet block above the same mode in a busy one', () => {
    const m = decode(twoTextures(256, 128, 255, 40));
    const costs = uerdCosts(m);
    // Mean luma cost per half of the image, from the carriers' block columns.
    const y = m.components[0]!;
    const cols = m.mcusPerLine * y.h;
    const per = y.h * y.v;
    const sums = [0, 0];
    const counts = [0, 0];
    let i = 0;
    y.blocks.forEach((blk, b) => {
      const mcu = (b / per) | 0;
      const col = (mcu % m.mcusPerLine) * y.h + ((b % per) % y.h);
      const half = col < cols / 2 ? 0 : 1;
      for (let k = 1; k < 64; k++) {
        if (Math.abs(blk[k]!) < 2) continue;
        sums[half]! += costs[i++]!;
        counts[half]!++;
      }
    });
    expect(counts[1]).toBeGreaterThan(100); // the quiet half still has carriers
    expect(sums[1]! / counts[1]!).toBeGreaterThan((3 * sums[0]!) / counts[0]!);
  });
});

describe('stcCosts', () => {
  it('scales the median of the carriers it is given to 64 and clamps to 1 .. STC_MAX_COST', () => {
    const raw = Float64Array.from([1e-9, 0.5, 1, 1, 2, 1000, 3]);
    const order = Uint32Array.from([6, 5, 4, 3, 2, 1, 0]);
    const out = stcCosts(raw, order);
    expect(Array.from(out)).toEqual([192, STC_MAX_COST, 128, 64, 64, 32, 1]);
  });

  it('only looks at the carriers in the order, in its sequence', () => {
    const raw = Float64Array.from([5, 1, 99, 2]);
    expect(Array.from(stcCosts(raw, Uint32Array.from([3, 1])))).toEqual([64, 32]);
  });
});

describe('S1 under UERD costs', () => {
  // 896 × 512: the busy half alone holds far more carriers than a slot needs,
  // and the quiet half enough that a uniform embed would put a third of its
  // changes there.
  const cover = twoTextures(896, 512, 255, 48);
  const data = Uint8Array.from({ length: 2109 }, (_, i) => (i * 97) & 0xff);
  const key = Uint8Array.from({ length: 32 }, (_, i) => i ^ 0x5a);

  /** Changes per carrier on the quiet half over changes per carrier on the busy half. */
  async function quietToBusy(costs: 'uerd' | 'uniform'): Promise<number> {
    const stego = await embedBytesStcJpeg(cover, data, key, 16, costs);
    expect(await extractBytesStcJpeg(stego, key, data.length)).toEqual(data);
    const a = decode(cover);
    const b = decode(stego);
    const changed = [0, 0];
    const carriers = [0, 0];
    a.components.forEach((comp, ci) => {
      const cols = a.mcusPerLine * comp.h;
      const per = comp.h * comp.v;
      comp.blocks.forEach((blk, bi) => {
        const mcu = (bi / per) | 0;
        const col = (mcu % a.mcusPerLine) * comp.h + ((bi % per) % comp.h);
        const half = col < cols / 2 ? 0 : 1;
        const other = b.components[ci]!.blocks[bi]!;
        for (let k = 1; k < 64; k++) {
          if (Math.abs(blk[k]!) < 2) continue;
          carriers[half]!++;
          if (other[k] !== blk[k]) changed[half]!++;
        }
      });
    });
    return changed[1]! / carriers[1]! / (changed[0]! / carriers[0]!);
  }

  it('moves its changes out of the quiet half, which a uniform embed does not', async () => {
    const uniform = await quietToBusy('uniform');
    const uerd = await quietToBusy('uerd');
    // Uniform placement: the same rate everywhere, up to sampling noise.
    expect(uniform).toBeGreaterThan(0.8);
    expect(uniform).toBeLessThan(1.25);
    expect(uerd).toBeLessThan(0.5);
  }, 60000);
});
