import { describe, it, expect } from 'vitest';
import { type Argon2Params, WrongPasswordError, randomBytes, KEY_FACTOR_LEN } from './crypto';
import { GALLERY_LADDER, DB_LADDER } from './buckets';
import {
  CredentialsNotIndependentError,
  buildDuressVaultBlob,
  buildDuressSegmentedBlob,
  credentialsIndependent,
} from './access';
import { decodeMultiRegionVaultBlob, decodeMultiRegionVaultBlobWithDek } from './vault';
import { decodeMultiRegionSegmentedBlob } from './segmented';

const TEST_PARAMS: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const CAP = 1 << 20;

describe('credential independence (SPEC §10.5, author-time)', () => {
  it('accepts genuinely independent credentials', () => {
    expect(credentialsIndependent('correct horse battery', 'zzq-9-plum-tractor').ok).toBe(true);
  });

  it('rejects equal, case-only, prefix/suffix, reversal, and near variants', () => {
    expect(credentialsIndependent('hunter2', 'hunter2').reason).toBe('equal');
    expect(credentialsIndependent('Hunter2', 'hunter2').reason).toBe('case');
    expect(credentialsIndependent('hunter2extra', 'hunter2').reason).toBe('contains'); // prefix
    expect(credentialsIndependent('xxhunter2', 'hunter2').reason).toBe('contains'); // suffix
    expect(credentialsIndependent('hunter2', '2retnuh').reason).toBe('reverse');
    expect(credentialsIndependent('hunter2', 'hunter3').reason).toBe('near'); // one edit
  });
});

describe('Mode A — Duress (SPEC §10.5)', () => {
  const REAL = 'the real seed phrase: alpha bravo charlie';
  const DECOY = 'plausible decoy: grocery list and old notes';

  it('gallery: each credential opens its own region; the other stays hidden', async () => {
    const { blob } = await buildDuressVaultBlob(
      'real.txt',
      enc(REAL),
      'decoy.txt',
      enc(DECOY),
      'realpassword-longphrase',
      'duresspassword-different',
      GALLERY_LADDER,
      TEST_PARAMS,
    );

    const real = await decodeMultiRegionVaultBlob(blob, 'realpassword-longphrase', {
      params: TEST_PARAMS,
      maxContentBytes: CAP,
    });
    expect(dec(real.content)).toBe(REAL);

    const duress = await decodeMultiRegionVaultBlob(blob, 'duresspassword-different', {
      params: TEST_PARAMS,
      maxContentBytes: CAP,
    });
    // The duress credential yields ONLY the decoy — the real content is never
    // exposed by it (each region has an independent DEK, §10 governing decision 3).
    expect(dec(duress.content)).toBe(DECOY);
    expect(dec(duress.content)).not.toBe(REAL);
  });

  it('unlock is region-blind: both results are just (filename, content)', async () => {
    const { blob } = await buildDuressVaultBlob(
      'r',
      enc(REAL),
      'd',
      enc(DECOY),
      'realpassword-longphrase',
      'duresspassword-different',
      GALLERY_LADDER,
      TEST_PARAMS,
    );
    const real = await decodeMultiRegionVaultBlob(blob, 'realpassword-longphrase', {
      params: TEST_PARAMS,
      maxContentBytes: CAP,
    });
    // No mode / region / slot field leaks to the caller.
    expect(Object.keys(real).sort()).toEqual(['content', 'filename']);
  });

  it('a wrong (neither) password fails uniformly', async () => {
    const { blob } = await buildDuressVaultBlob(
      'r',
      enc(REAL),
      'd',
      enc(DECOY),
      'realpassword-longphrase',
      'duresspassword-different',
      GALLERY_LADDER,
      TEST_PARAMS,
    );
    await expect(
      decodeMultiRegionVaultBlob(blob, 'neither-of-them', {
        params: TEST_PARAMS,
        maxContentBytes: CAP,
      }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('verification: both regions decode with their authoring DEKs', async () => {
    const { blob, real, decoy } = await buildDuressVaultBlob(
      'r.txt',
      enc(REAL),
      'd.txt',
      enc(DECOY),
      'realpassword-longphrase',
      'duresspassword-different',
      GALLERY_LADDER,
      TEST_PARAMS,
    );
    const gotReal = await decodeMultiRegionVaultBlobWithDek(blob, real.dek, real.regionIndex, CAP);
    const gotDecoy = await decodeMultiRegionVaultBlobWithDek(
      blob,
      decoy.dek,
      decoy.regionIndex,
      CAP,
    );
    expect(dec(gotReal.content)).toBe(REAL);
    expect(dec(gotDecoy.content)).toBe(DECOY);
    expect(real.regionIndex).not.toBe(decoy.regionIndex);
  });

  it('.db: duress works through the segmented path', async () => {
    const { blob } = await buildDuressSegmentedBlob(
      'real.bin',
      enc(REAL),
      'decoy.bin',
      enc(DECOY),
      'realpassword-longphrase',
      'duresspassword-different',
      DB_LADDER,
      TEST_PARAMS,
    );
    const real = await decodeMultiRegionSegmentedBlob(blob, 'realpassword-longphrase', {
      params: TEST_PARAMS,
      maxContentBytes: CAP,
    });
    const duress = await decodeMultiRegionSegmentedBlob(blob, 'duresspassword-different', {
      params: TEST_PARAMS,
      maxContentBytes: CAP,
    });
    expect(dec(real.content)).toBe(REAL);
    expect(dec(duress.content)).toBe(DECOY);
  });

  it('refuses to author with related credentials', async () => {
    await expect(
      buildDuressVaultBlob(
        'r',
        enc(REAL),
        'd',
        enc(DECOY),
        'hunter2',
        'hunter3', // one edit away → rejected
        GALLERY_LADDER,
        TEST_PARAMS,
      ),
    ).rejects.toBeInstanceOf(CredentialsNotIndependentError);
  });

  it('composes with a key factor: the factor gates the REAL region, the decoy opens either way', async () => {
    // Regression for the "decoy unreachable when the factor is present" bug: the
    // key factor (a keyfile/stego secret) is delivered alongside the vault, so
    // restore auto-presents it for BOTH credentials. The decoy must still open.
    const factor = randomBytes(KEY_FACTOR_LEN);
    const { blob } = await buildDuressSegmentedBlob(
      'real.txt',
      enc(REAL),
      'decoy.txt',
      enc(DECOY),
      'realpassword unrelated to the other',
      'zzq plum tractor forty two',
      DB_LADDER,
      TEST_PARAMS,
      undefined,
      undefined,
      factor,
    );
    const open = (pw: string, f: Uint8Array | null) =>
      decodeMultiRegionSegmentedBlob(blob, pw, {
        params: TEST_PARAMS,
        maxContentBytes: CAP,
        keyFactor: f,
      });

    // The real region needs the real password AND the factor.
    expect(dec((await open('realpassword unrelated to the other', factor)).content)).toBe(REAL);
    await expect(open('realpassword unrelated to the other', null)).rejects.toBeInstanceOf(
      WrongPasswordError,
    );

    // The decoy opens on the duress password whether or not the factor is presented
    // (a coercer sees the .key/cover beside the vault and demands it too).
    expect(dec((await open('zzq plum tractor forty two', factor)).content)).toBe(DECOY);
    expect(dec((await open('zzq plum tractor forty two', null)).content)).toBe(DECOY);
  });
});
