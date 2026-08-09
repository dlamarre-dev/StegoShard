import { describe, it, expect } from 'vitest';
import { MIN_PARITY, decodeBlob, encodeShards, parityCount, splitIntoShards } from './erasure';

describe('parityCount', () => {
  it('applies +30% above the floor', () => {
    expect(parityCount(10)).toBe(3); // ceil(3.0) => 3
    expect(parityCount(20)).toBe(6);
  });

  it('never drops below MIN_PARITY', () => {
    expect(parityCount(1)).toBe(MIN_PARITY);
    expect(parityCount(2)).toBe(MIN_PARITY);
  });
});

describe('splitIntoShards', () => {
  it('produces k equal-length shards, zero-padding the tail', () => {
    const blob = Uint8Array.from([1, 2, 3, 4, 5]);
    const shards = splitIntoShards(blob, 2);
    expect(shards.length).toBe(2);
    expect(shards[0]!.length).toBe(3);
    expect([...shards[0]!]).toEqual([1, 2, 3]);
    expect([...shards[1]!]).toEqual([4, 5, 0]); // padded
  });
});

describe('encode/decode blob with erasure', () => {
  const blob = Uint8Array.from({ length: 250 }, (_, i) => (i * 37) & 0xff);
  const k = 4;
  const m = parityCount(k); // 2

  it('reconstructs from the full set', () => {
    const { shards } = encodeShards(blob, k, m);
    expect([...decodeBlob([...shards], k, m, blob.length)]).toEqual([...blob]);
  });

  it('reconstructs after dropping m shards', () => {
    const { shards } = encodeShards(blob, k, m);
    const slots: (Uint8Array | null)[] = [...shards];
    slots[1] = null;
    slots[k] = null; // one data + one parity dropped
    expect([...decodeBlob(slots, k, m, blob.length)]).toEqual([...blob]);
  });

  it('fails when more than m shards are lost', () => {
    const { shards } = encodeShards(blob, k, m);
    const slots: (Uint8Array | null)[] = [...shards];
    slots[0] = slots[1] = slots[2] = null; // 3 > m
    expect(() => decodeBlob(slots, k, m, blob.length)).toThrow();
  });
});
