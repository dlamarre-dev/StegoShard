import { describe, it, expect } from 'vitest';
import {
  buildCauchyMatrix,
  buildEncodingMatrix,
  invertMatrix,
  rsEncode,
  rsReconstructData,
} from './reed-solomon';

function randomShards(k: number, len: number, seed: number): Uint8Array[] {
  // Deterministic pseudo-random data (no Math.random, which keeps tests reproducible).
  let s = seed >>> 0;
  const next = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 24) & 0xff;
  };
  return Array.from({ length: k }, () => Uint8Array.from({ length: len }, () => next()));
}

describe('Cauchy / encoding matrix', () => {
  it('produces a systematic matrix (identity on top)', () => {
    const g = buildEncodingMatrix(4, 2);
    expect(g.length).toBe(6);
    for (let i = 0; i < 4; i++) {
      expect([...g[i]!]).toEqual([0, 1, 2, 3].map((j) => (i === j ? 1 : 0)));
    }
  });

  it('every k×k submatrix is invertible (MDS property)', () => {
    const k = 4;
    const m = 3;
    const g = buildEncodingMatrix(k, m);
    // Try all combinations of k rows out of k+m.
    const idx = [...Array(k + m).keys()];
    const combos: number[][] = [];
    const choose = (start: number, acc: number[]) => {
      if (acc.length === k) return combos.push([...acc]);
      for (let i = start; i < idx.length; i++) choose(i + 1, [...acc, idx[i]!]);
    };
    choose(0, []);
    for (const combo of combos) {
      const sub = combo.map((i) => g[i]!);
      expect(() => invertMatrix(sub)).not.toThrow();
    }
  });

  it('rejects k + m > 256', () => {
    expect(() => buildCauchyMatrix(200, 100)).toThrow(RangeError);
  });
});

describe('Reed-Solomon erasure round-trip', () => {
  it('reconstructs with no loss', () => {
    const data = randomShards(4, 32, 1);
    const parity = rsEncode(data, 2);
    const all = [...data, ...parity];
    const recovered = rsReconstructData(all, 4, 2);
    recovered.forEach((r, i) => expect([...r]).toEqual([...data[i]!]));
  });

  it('reconstructs after losing up to m shards, in every position', () => {
    const k = 5;
    const m = 3;
    const data = randomShards(k, 24, 7);
    const parity = rsEncode(data, m);
    const all: (Uint8Array | null)[] = [...data, ...parity];

    // Drop m shards at a few representative index sets.
    const dropSets = [
      [0, 1, 2], // three data shards
      [0, k, k + 1], // mix of data + parity
      [k, k + 1, k + 2], // all parity
      [2, 4, k + 1],
    ];
    for (const drop of dropSets) {
      const shards = [...all];
      for (const d of drop) shards[d] = null;
      const recovered = rsReconstructData(shards, k, m);
      recovered.forEach((r, i) => expect([...r]).toEqual([...data[i]!]));
    }
  });

  it('handles the MIN_PARITY small-vault case (k=1, m=2)', () => {
    const data = randomShards(1, 16, 3);
    const parity = rsEncode(data, 2);
    // Lose the single data shard; rebuild from the two parity shards.
    const shards: (Uint8Array | null)[] = [null, parity[0]!, parity[1]!];
    const recovered = rsReconstructData(shards, 1, 2);
    expect([...recovered[0]!]).toEqual([...data[0]!]);
  });

  it('throws when fewer than k shards survive', () => {
    const data = randomShards(3, 8, 9);
    const parity = rsEncode(data, 2);
    const shards: (Uint8Array | null)[] = [...data, ...parity];
    shards[0] = null;
    shards[1] = null;
    shards[2] = null; // only 2 of 3 required remain
    expect(() => rsReconstructData(shards, 3, 2)).toThrow(/required shards/);
  });
});
