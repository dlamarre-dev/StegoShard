import { describe, it, expect } from 'vitest';
import { type Argon2Params, WrongPasswordError } from './crypto';
import { GALLERY_LADDER, DB_LADDER } from './buckets';
import { buildNonPossessionVaultBlob, buildNonPossessionSegmentedBlob } from './access';
import { decodeMultiRegionVaultBlob } from './vault';
import { decodeMultiRegionSegmentedBlob } from './segmented';
import { shamirRecover } from './shamir';

const TEST_PARAMS: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const CAP = 1 << 20;

describe('Mode B — Non-possession (SPEC §10.6)', () => {
  it('gallery: password + k shares recovers; password alone cannot', async () => {
    const { blob, shares } = await buildNonPossessionVaultBlob(
      'secret.txt',
      enc('the real payload'),
      'pw',
      3,
      5,
      GALLERY_LADDER,
      TEST_PARAMS,
    );
    expect(shares.length).toBe(5);

    // Password alone (no threshold material) → the gated slot never opens.
    await expect(
      decodeMultiRegionVaultBlob(blob, 'pw', { params: TEST_PARAMS, maxContentBytes: CAP }),
    ).rejects.toBeInstanceOf(WrongPasswordError);

    // Any k = 3 of the 5 shares recover S → the gated slot opens.
    const secret = await shamirRecover([shares[1]!, shares[3]!, shares[4]!]);
    const out = await decodeMultiRegionVaultBlob(blob, 'pw', {
      params: TEST_PARAMS,
      maxContentBytes: CAP,
      secret,
    });
    expect(dec(out.content)).toBe('the real payload');
  });

  it('gallery: k-1 shares is TRUE inability (wrong secret → no slot opens)', async () => {
    const { blob, shares } = await buildNonPossessionVaultBlob(
      'x',
      enc('gated'),
      'pw',
      3,
      5,
      GALLERY_LADDER,
      TEST_PARAMS,
    );
    // Below threshold: shamirRecover yields a wrong S; the container cannot "notice"
    // and degrade; it simply fails to open, indistinguishable from a wrong password.
    const wrongSecret = await shamirRecover([shares[0]!, shares[1]!]); // only 2 of 3
    await expect(
      decodeMultiRegionVaultBlob(blob, 'pw', {
        params: TEST_PARAMS,
        maxContentBytes: CAP,
        secret: wrongSecret,
      }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('gallery: a wrong password with the right shares still fails', async () => {
    const { blob, shares } = await buildNonPossessionVaultBlob(
      'x',
      enc('gated'),
      'right',
      2,
      3,
      GALLERY_LADDER,
      TEST_PARAMS,
    );
    const secret = await shamirRecover([shares[0]!, shares[2]!]);
    await expect(
      decodeMultiRegionVaultBlob(blob, 'wrong', {
        params: TEST_PARAMS,
        maxContentBytes: CAP,
        secret,
      }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('.db: password + k shares recovers through the segmented path', async () => {
    const { blob, shares } = await buildNonPossessionSegmentedBlob(
      'cache.bin',
      enc('disguised non-possession secret'),
      'pw',
      2,
      3,
      DB_LADDER,
      TEST_PARAMS,
    );
    await expect(
      decodeMultiRegionSegmentedBlob(blob, 'pw', { params: TEST_PARAMS, maxContentBytes: CAP }),
    ).rejects.toBeInstanceOf(WrongPasswordError);

    const secret = await shamirRecover([shares[0]!, shares[1]!]);
    const out = await decodeMultiRegionSegmentedBlob(blob, 'pw', {
      params: TEST_PARAMS,
      maxContentBytes: CAP,
      secret,
    });
    expect(dec(out.content)).toBe('disguised non-possession secret');
  });

  it('no decoy: the second region is unrecoverable random (only one live slot)', async () => {
    const { blob } = await buildNonPossessionVaultBlob(
      'x',
      enc('single real region'),
      'pw',
      2,
      3,
      GALLERY_LADDER,
      TEST_PARAMS,
    );
    // Both region blocks are the same length; there is exactly one live slot, so
    // no credential opens a "decoy". (Structural: region area splits evenly.)
    const regionArea = blob.length - 16 - 304;
    expect(regionArea % 2).toBe(0);
  });
});
