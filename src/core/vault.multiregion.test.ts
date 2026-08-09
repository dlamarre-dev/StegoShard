import { describe, it, expect } from 'vitest';
import { type Argon2Params, WrongPasswordError } from './crypto';
import { GALLERY_LADDER } from './buckets';
import {
  buildPlainVaultBlobMulti,
  decodeMultiRegionVaultBlob,
  decodeMultiRegionVaultBlobWithDek,
  multiRegionBlobLen,
} from './vault';
import { buildPayload } from './payload';

const TEST_PARAMS: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('multi-region vault blob (SPEC §10.4)', () => {
  it('round-trips a plain single-payload blob by password', async () => {
    const { blob } = await buildPlainVaultBlobMulti(
      'note.txt',
      enc('the real secret'),
      'pw',
      GALLERY_LADDER,
      TEST_PARAMS,
    );
    const got = await decodeMultiRegionVaultBlob(blob, 'pw', {
      params: TEST_PARAMS,
      maxContentBytes: 1 << 20,
    });
    expect(got.filename).toBe('note.txt');
    expect(dec(got.content)).toBe('the real secret');
  });

  it('decodes the live region directly with the authoring DEK (verification path)', async () => {
    const { blob, regionIndex, dek } = await buildPlainVaultBlobMulti(
      'a.bin',
      enc('verify me'),
      'pw',
      GALLERY_LADDER,
      TEST_PARAMS,
    );
    const got = await decodeMultiRegionVaultBlobWithDek(blob, dek, regionIndex, 1 << 20);
    expect(dec(got.content)).toBe('verify me');
  });

  it('rejects a wrong password uniformly', async () => {
    const { blob } = await buildPlainVaultBlobMulti(
      'x',
      enc('s'),
      'right',
      GALLERY_LADDER,
      TEST_PARAMS,
    );
    await expect(
      decodeMultiRegionVaultBlob(blob, 'wrong', { params: TEST_PARAMS, maxContentBytes: 1 << 20 }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('the two regions are equal length: which is real is invisible', async () => {
    const { blob } = await buildPlainVaultBlobMulti(
      'x',
      enc('hi'),
      'pw',
      GALLERY_LADDER,
      TEST_PARAMS,
    );
    // Region area (after vault_salt 16 + slot_array 304) splits into two equal halves.
    const regionArea = blob.length - 16 - 304;
    expect(regionArea % 2).toBe(0);
    expect(blob.length).toBe(
      multiRegionBlobLen((await buildPayload('x', enc('hi'))).length, 0, GALLERY_LADDER),
    );
  });

  it('two different payloads in the same bucket yield identical blob length', async () => {
    const a = await buildPlainVaultBlobMulti('a', enc('short'), 'pw', GALLERY_LADDER, TEST_PARAMS);
    const b = await buildPlainVaultBlobMulti(
      'bbbbb',
      enc('a somewhat longer secret but still under 4 KiB'),
      'pw2',
      GALLERY_LADDER,
      TEST_PARAMS,
    );
    expect(a.blob.length).toBe(b.blob.length); // same bucket → same length (§10.2)
  });
});
