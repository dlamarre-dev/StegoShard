/** Guard branches + empty-blob edge for erasure.ts. */
import { describe, it, expect } from 'vitest';
import { decodeBlob, encodeShards, parityCount, splitIntoShards } from './erasure';

describe('erasure guards', () => {
  it('splitIntoShards rejects k < 1', () => {
    expect(() => splitIntoShards(new Uint8Array(10), 0)).toThrow(/k must be >= 1/);
  });

  it('handles an empty blob (shardLen floors to 1)', () => {
    const shards = splitIntoShards(new Uint8Array(0), 3);
    expect(shards).toHaveLength(3);
    expect(shards.every((s) => s.length === 1)).toBe(true);
  });

  it('round-trips an empty blob through encode/decode', () => {
    const k = 2;
    const m = parityCount(k);
    const { shards, shardLen } = encodeShards(new Uint8Array(0), k, m);
    expect(shardLen).toBe(1);
    const back = decodeBlob(shards, k, m, 0);
    expect(back.length).toBe(0);
  });

  it('reconstructs after dropping up to m shards', () => {
    const blob = Uint8Array.from({ length: 500 }, (_, i) => (i * 7) & 0xff);
    const k = 4;
    const m = parityCount(k); // 2
    const { shards } = encodeShards(blob, k, m);
    const withGaps: (Uint8Array | null)[] = shards.map((s, i) => (i < m ? null : s));
    expect([...decodeBlob(withGaps, k, m, blob.length)]).toEqual([...blob]);
  });
});
