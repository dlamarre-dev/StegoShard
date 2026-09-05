import { describe, it, expect } from 'vitest';
import {
  type Argon2Params,
  WrongPasswordError,
  REGION_COUNT,
  SLOT_ARRAY_LEN,
  VAULT_SALT_LEN,
} from './crypto';
import { DB_LADDER, GALLERY_LADDER } from './buckets';
import {
  buildMultiRegionVaultBlob,
  buildPlainVaultBlobMulti,
  decodeMultiRegionVaultBlob,
  decodeMultiRegionVaultBlobWithDek,
  multiRegionBlobLen,
} from './vault';
import { buildPayload } from './payload';

const TEST_PARAMS: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** Section geometry, from the exported constants rather than restated by hand. */
const HEAD = VAULT_SALT_LEN + SLOT_ARRAY_LEN; // 320
/** CONTENT_SALT_LEN + IV_LEN + GCM_TAG_LEN, which vault.ts keeps private. */
const REGION_OVERHEAD = 44;

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

/**
 * The geometry guards on an untrusted blob.
 *
 * `splitMultiRegionBlob` is the first thing a restore runs on bytes it was handed,
 * before any key derivation, so its three checks are parsing attacker-controlled
 * input. Mutation testing reported every one of them as **no coverage**: not
 * "a test failed to notice", but "nothing ever ran these lines".
 */
describe('multi-region blob geometry is validated before anything is derived', () => {
  const OPTS = { maxContentBytes: 1 << 20 };
  /** Shortest blob that clears the length check: 320 + 2 * (44 + 1). */
  const MIN_OK = HEAD + REGION_COUNT * (REGION_OVERHEAD + 1);

  it('refuses a blob too short to hold two regions', async () => {
    await expect(
      decodeMultiRegionVaultBlob(new Uint8Array(MIN_OK - 1), 'pw', OPTS),
    ).rejects.toThrow(/too short/);
    // One byte more is past this guard, so the message above is really this
    // check speaking and not a later one.
    await expect(
      decodeMultiRegionVaultBlob(new Uint8Array(MIN_OK), 'pw', OPTS),
    ).rejects.not.toThrow(/too short/);
  });

  // Two regions of equal length is the property that makes which one is real
  // invisible, so an area that cannot be halved is not a vault.
  it('refuses a region area that does not divide in two', async () => {
    await expect(
      decodeMultiRegionVaultBlob(new Uint8Array(MIN_OK + 1), 'pw', OPTS),
    ).rejects.toThrow(/odd region area/);
  });

  /**
   * The third guard, `R < REGION_OVERHEAD + 1`, is **unreachable**, and no test
   * can cover it. It is implied by the two above: clearing the length check
   * means `blob.length >= 320 + 2 * 45`, so the region area is at least 90, so
   * `R >= 45`, which is exactly the bound. Confirmed by sweeping every length
   * from 0 to 600: only "too short" and "odd region area" ever fire.
   *
   * Left in place rather than deleted. It states the invariant the other two
   * only imply, and it becomes live again the moment someone loosens the length
   * check. The cost is one permanently uncovered mutant, recorded here so the
   * next person reading the mutation report does not chase it, in the same
   * spirit as the equivalent mutants noted in stryker.config.mjs.
   */
  it('cannot reach the region-too-small guard, by construction', { timeout: 60_000 }, async () => {
    const reasons = new Set<string>();
    // Cheap KDF parameters: every length that clears the split goes on to derive
    // slot candidates, and at production cost this sweep would take minutes to
    // prove something about the twenty lines before the derivation.
    const sweep = { maxContentBytes: 1 << 20, params: TEST_PARAMS };
    for (let len = 0; len <= 600; len++) {
      await decodeMultiRegionVaultBlob(new Uint8Array(len), 'pw', sweep).catch((e: Error) => {
        if (e.message.startsWith('multi-region blob')) reasons.add(e.message);
      });
    }
    expect([...reasons].sort()).toEqual([
      'multi-region blob: odd region area',
      'multi-region blob: too short',
    ]);
  });

  it('refuses to build with a vault salt of the wrong length', async () => {
    await expect(
      buildMultiRegionVaultBlob(new Uint8Array(VAULT_SALT_LEN - 1), [], [], DB_LADDER),
    ).rejects.toThrow(/bad vault salt/);
  });

  /**
   * Any failure while deriving the slot candidates is reported as a wrong
   * password, never as the underlying error. That is not politeness: a caller
   * able to tell "your password is wrong" from "the KDF rejected these
   * parameters" gets an oracle, and §10 spends a lot of effort making unlock
   * failures indistinguishable.
   */
  it('reports a failed candidate derivation as a wrong password', async () => {
    const blob = new Uint8Array(HEAD + REGION_COUNT * 200);
    for (const params of [
      { iterations: 0, memoryKiB: 8, parallelism: 1 },
      { iterations: 1, memoryKiB: 0, parallelism: 1 },
      { iterations: 1, memoryKiB: 8, parallelism: 0 },
    ]) {
      await expect(
        decodeMultiRegionVaultBlob(blob, 'pw', { maxContentBytes: 1 << 20, params }),
        JSON.stringify(params),
      ).rejects.toThrow(WrongPasswordError);
    }
  });
});

/**
 * `multiRegionBlobLen` predicts the blob size before anything is built, so the
 * caller can refuse an oversized secret without paying for the encryption first.
 * Only the region-0 arm was exercised; the region-1 arm never was.
 */
describe('multiRegionBlobLen accounts for both regions', () => {
  const expected = (bucket: number) => HEAD + REGION_COUNT * (REGION_OVERHEAD + bucket);

  it('sizes from whichever region is larger, not only the first', () => {
    const [smallest] = DB_LADDER as readonly number[];
    // Both envelopes tiny: the smallest bucket covers them.
    expect(multiRegionBlobLen(0, 0, DB_LADDER)).toBe(expected(smallest!));
    expect(multiRegionBlobLen(100, 0, DB_LADDER)).toBe(expected(smallest!));

    // A region-1 envelope past the first bucket has to push the whole blob up,
    // exactly as a region-0 one does: the two regions are always equal length.
    const big = smallest! + 1;
    expect(multiRegionBlobLen(0, big, DB_LADDER)).toBe(multiRegionBlobLen(big, 0, DB_LADDER));
    expect(multiRegionBlobLen(0, big, DB_LADDER)).toBeGreaterThan(expected(smallest!));
  });
});
