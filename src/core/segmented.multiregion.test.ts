import { describe, it, expect } from 'vitest';
import { type Argon2Params, WrongPasswordError } from './crypto';
import { DB_LADDER } from './buckets';
import {
  buildPlainSegmentedBlobMulti,
  decodeMultiRegionSegmentedBlob,
  decodeMultiRegionSegmentedBlobWithDek,
} from './segmented';

const TEST_PARAMS: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const CAP = 1 << 20;

describe('multi-region segmented blob (SPEC §10.4, .db path)', () => {
  it('round-trips a plain payload by password', async () => {
    const { blob } = await buildPlainSegmentedBlobMulti(
      'cache.bin',
      enc('disguised secret'),
      'pw',
      DB_LADDER,
      TEST_PARAMS,
    );
    const got = await decodeMultiRegionSegmentedBlob(blob, 'pw', {
      params: TEST_PARAMS,
      maxContentBytes: CAP,
    });
    expect(got.filename).toBe('cache.bin');
    expect(dec(got.content)).toBe('disguised secret');
  });

  it('decodes the live region with the authoring DEK (verification)', async () => {
    const { blob, regionIndex, dek } = await buildPlainSegmentedBlobMulti(
      'x',
      enc('verify me'),
      'pw',
      DB_LADDER,
      TEST_PARAMS,
    );
    const got = await decodeMultiRegionSegmentedBlobWithDek(blob, dek, regionIndex, CAP);
    expect(dec(got.content)).toBe('verify me');
  });

  it('rejects a wrong password uniformly', async () => {
    const { blob } = await buildPlainSegmentedBlobMulti('x', enc('s'), 'right', DB_LADDER, TEST_PARAMS);
    await expect(
      decodeMultiRegionSegmentedBlob(blob, 'wrong', { params: TEST_PARAMS, maxContentBytes: CAP }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('the two region streams are equal length (dead region invisible)', async () => {
    const { blob } = await buildPlainSegmentedBlobMulti('x', enc('hi'), 'pw', DB_LADDER, TEST_PARAMS);
    // head = 334 bytes; the remainder is two equal region streams.
    const regionArea = blob.length - 334;
    expect(regionArea % 2).toBe(0);
  });

  it('same bucket ⇒ identical blob length regardless of payload', async () => {
    const a = await buildPlainSegmentedBlobMulti('a', enc('short'), 'pw', DB_LADDER, TEST_PARAMS);
    const b = await buildPlainSegmentedBlobMulti(
      'bbbb',
      enc('a different secret under 64 KiB'),
      'pw2',
      DB_LADDER,
      TEST_PARAMS,
    );
    expect(a.blob.length).toBe(b.blob.length);
  });

  it('rejects a truncated container (length cross-check)', async () => {
    const { blob } = await buildPlainSegmentedBlobMulti('x', enc('s'), 'pw', DB_LADDER, TEST_PARAMS);
    await expect(
      decodeMultiRegionSegmentedBlob(blob.subarray(0, blob.length - 1), 'pw', {
        params: TEST_PARAMS,
        maxContentBytes: CAP,
      }),
    ).rejects.toBeTruthy();
  });
});
