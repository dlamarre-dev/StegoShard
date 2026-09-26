/**
 * The syndrome-trellis code on its own, away from any photo.
 *
 * The property that matters is the one a round trip through a photo can only
 * sample: whatever the cover parities, the message and the width, the syndrome
 * of what the embedder writes is the message. A failure one time in a thousand
 * would pass every gallery test and lose one photo in a thousand, so it is
 * checked here over tens of thousands of small instances, where it is cheap, and
 * at the edges where a trellis implementation usually breaks: the last h - 1
 * blocks, where H is truncated, and messages shorter than h.
 */

import { describe, expect, it } from 'vitest';
import {
  STC_HEIGHT,
  STC_WET,
  StcInfeasibleError,
  keyedOrder,
  stcEmbed,
  stcExtract,
  stcSubmatrix,
} from './stc';

/** A small deterministic generator, so a failing case can be replayed. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

const bits = (next: () => number, n: number) => Uint8Array.from({ length: n }, () => next() & 1);

describe('stcEmbed then stcExtract', () => {
  // Ten thousand, with room: under coverage instrumentation the trellis runs
  // several times slower, and this is the one test here that is all trellis.
  it('returns the message, over 10 000 random small instances', { timeout: 120_000 }, () => {
    const next = rng(0x5e3d);
    for (let t = 0; t < 10_000; t++) {
      const m = 1 + (next() % 40);
      const w = 1 + (next() % 12);
      const x = bits(next, m * w);
      const msg = bits(next, m);
      const { y, changes } = stcEmbed(x, null, msg, w);
      expect(stcExtract(y, m, w), `case ${t}: m=${m} w=${w}`).toEqual(msg);
      expect(changes).toBe(y.reduce((n, b, i) => n + (b !== x[i] ? 1 : 0), 0));
    }
  });

  it('returns the message on longer codes, where every block but the last h is untruncated', () => {
    const next = rng(0xbeef);
    for (const [m, w] of [
      [2000, 16],
      [500, 3],
      [STC_HEIGHT, 16],
      [STC_HEIGHT - 1, 16],
      [1, 1],
    ] as const) {
      const x = bits(next, m * w);
      const msg = bits(next, m);
      expect(stcExtract(stcEmbed(x, null, msg, w).y, m, w)).toEqual(msg);
    }
  });

  it('changes nothing when the cover already carries the message', () => {
    const next = rng(7);
    const m = 300;
    const w = 16;
    const y = bits(next, m * w);
    const msg = stcExtract(y, m, w);
    expect(stcEmbed(y, null, msg, w).changes).toBe(0);
  });

  it('is deterministic: the same inputs give the same parities', () => {
    const next = rng(99);
    const x = bits(next, 400 * 16);
    const msg = bits(next, 400);
    expect(stcEmbed(x, null, msg, 16).y).toEqual(stcEmbed(x, null, msg, 16).y);
  });

  it('never flips a wet position, and says so when it cannot avoid one', () => {
    const next = rng(3);
    const m = 200;
    const w = 8;
    const x = bits(next, m * w);
    const msg = bits(next, m);
    const costs = new Int32Array(m * w).fill(1);
    for (let i = 0; i < costs.length; i += 3) costs[i] = STC_WET;
    const { y } = stcEmbed(x, costs, msg, w);
    expect(stcExtract(y, m, w)).toEqual(msg);
    for (let i = 0; i < costs.length; i += 3) expect(y[i]).toBe(x[i]);

    // Everything wet: no parity may move, so any message but the cover's own fails.
    const allWet = new Int32Array(m * w).fill(STC_WET);
    const own = stcExtract(x, m, w);
    const other = own.map((b, i) => (i === 0 ? b ^ 1 : b));
    expect(() => stcEmbed(x, allWet, other, w)).toThrow(StcInfeasibleError);
  });

  // The int32 trellis is exact only inside these bounds; outside them it must
  // refuse rather than overflow into a wrong but plausible answer.
  it('refuses a cost or a width outside the range its arithmetic is exact in', () => {
    const x = new Uint8Array(8);
    const msg = new Uint8Array(4);
    expect(() => stcEmbed(x, Int32Array.of(1, 1, 1, 1, 1, 1, 1, 4096), msg, 2)).toThrow(RangeError);
    expect(() => stcEmbed(x, Int32Array.of(1, 1, 1, 1, 1, 1, 1, -1), msg, 2)).toThrow(RangeError);
    expect(() => stcEmbed(new Uint8Array(65), null, new Uint8Array(1), 65)).toThrow(RangeError);
  });

  it('prefers cheap positions over expensive ones', () => {
    const next = rng(11);
    const m = 400;
    const w = 16;
    const x = bits(next, m * w);
    const msg = bits(next, m);
    // Odd positions cost a hundred times the even ones.
    const costs = Int32Array.from({ length: m * w }, (_, i) => (i % 2 ? 100 : 1));
    const { y } = stcEmbed(x, costs, msg, w);
    let odd = 0;
    let even = 0;
    y.forEach((b, i) => {
      if (b === x[i]) return;
      if (i % 2) odd++;
      else even++;
    });
    expect(odd).toBeLessThan(even / 10);
  });

  it('needs about a fifth of the changes one bit per carrier would, at the gallery width', () => {
    const next = rng(0x16);
    const m = 4000;
    const w = 16;
    const { changes } = stcEmbed(bits(next, m * w), null, bits(next, m), w);
    // One bit per carrier changes m/2; the bound at w = 16 is m/8.5 and this code
    // reaches about 85 % of it. The window is wide enough not to be flaky.
    expect(changes).toBeGreaterThan(m / 8.5);
    expect(changes).toBeLessThan(m / 6.5);
  });
});

describe('stcSubmatrix', () => {
  it('forces the first and last bit of every column, and nothing past h', () => {
    for (const c of stcSubmatrix(64)) {
      expect(c & 1).toBe(1);
      expect(c >>> (STC_HEIGHT - 1)).toBe(1);
    }
  });

  it('gives each width a prefix of the next', () => {
    expect([...stcSubmatrix(16)]).toEqual([...stcSubmatrix(32)].slice(0, 16));
  });
});

describe('keyedOrder', () => {
  it('draws distinct positions within range, deterministically', () => {
    const stream = Uint8Array.from({ length: 40_000 }, (_, i) => (i * 131 + 7) & 0xff);
    const a = keyedOrder(stream, 5000, 3000);
    expect(new Set(a).size).toBe(3000);
    expect(Math.max(...a)).toBeLessThan(5000);
    expect([...keyedOrder(stream, 5000, 3000)]).toEqual([...a]);
  });

  it('refuses to return a short order when the stream runs out', () => {
    expect(() => keyedOrder(new Uint8Array(8), 100, 50)).toThrow(/exhausted/);
  });
});
