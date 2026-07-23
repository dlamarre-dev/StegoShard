/** Guard branches for reed-solomon.ts. */
import { describe, it, expect } from 'vitest';
import {
  buildCauchyMatrix,
  invertMatrix,
  rsEncode,
  rsReconstructData,
} from './reed-solomon';

describe('reed-solomon guards', () => {
  it('buildCauchyMatrix rejects bad k/m', () => {
    expect(() => buildCauchyMatrix(0, 2)).toThrow(/k must be >=1/);
    expect(() => buildCauchyMatrix(200, 100)).toThrow(/<= 256/);
  });

  it('rsEncode rejects no data shards and mismatched lengths', () => {
    expect(() => rsEncode([], 2)).toThrow(/at least one data shard/);
    expect(() => rsEncode([new Uint8Array(4), new Uint8Array(5)], 2)).toThrow(/differ in length/);
  });

  it('invertMatrix rejects a singular matrix', () => {
    // Two identical rows → singular.
    const singular = [Uint8Array.of(1, 2), Uint8Array.of(1, 2)];
    expect(() => invertMatrix(singular)).toThrow(/singular/);
  });

  it('rsReconstructData rejects wrong slot count, mismatched lengths, too few present', () => {
    const k = 2;
    const m = 2;
    expect(() => rsReconstructData([null, null, null], k, m)).toThrow(/expected .* shard slots/);
    const badLen: (Uint8Array | null)[] = [new Uint8Array(4), new Uint8Array(5), null, null];
    expect(() => rsReconstructData(badLen, k, m)).toThrow(/differ in length/);
    const tooFew: (Uint8Array | null)[] = [new Uint8Array(4), null, null, null];
    expect(() => rsReconstructData(tooFew, k, m)).toThrow();
  });
});
