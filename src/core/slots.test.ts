import { describe, it, expect } from 'vitest';
import {
  type Argon2Params,
  DEK_LEN,
  SLOT_ARRAY_LEN,
  SLOT_COUNT,
  SLOT_SIZE,
  buildSlotArray,
  decryptBytes,
  deriveKEK,
  deriveKekBytes,
  deriveRegionKey,
  encryptBytes,
  importAesGcmKey,
  openSlotArray,
  randomBytes,
  secureShuffle,
  tryOpenSlot,
  unlockSlotArray,
  WrongPasswordError,
} from './crypto';
import { BucketTooLargeError, DB_LADDER, GALLERY_LADDER, pickBucket } from './buckets';
import { padRegionPlaintext, parseRegionPlaintext } from './regions';

const TEST_PARAMS: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };
const enc = (s: string) => new TextEncoder().encode(s);

describe('buckets (SPEC §10.4)', () => {
  it('picks the smallest rung ≥ the larger region', () => {
    expect(pickBucket(1, 1, GALLERY_LADDER)).toBe(4096);
    expect(pickBucket(4096, 1, GALLERY_LADDER)).toBe(4096);
    expect(pickBucket(4097, 1, GALLERY_LADDER)).toBe(16384);
    // A dead region contributes 0, so it never bumps the bucket.
    expect(pickBucket(5000, 0, GALLERY_LADDER)).toBe(16384);
    expect(pickBucket(0, 5000, GALLERY_LADDER)).toBe(16384);
  });

  it('throws when the larger region exceeds the top rung', () => {
    expect(() => pickBucket(64 * 1024 + 1, 0, GALLERY_LADDER)).toThrow(BucketTooLargeError);
    expect(() => pickBucket(64 * 1024 * 1024 + 1, 0, DB_LADDER)).toThrow(BucketTooLargeError);
  });
});

describe('region plaintext framing (SPEC §10.4)', () => {
  it('round-trips an envelope, hiding true length in padding', () => {
    const env = enc('hello world');
    const padded = padRegionPlaintext(env, 4096);
    expect(padded.length).toBe(4096);
    expect([...parseRegionPlaintext(padded, 1 << 20)]).toEqual([...env]);
  });

  it('rejects a declared length beyond the bucket or the cap', () => {
    const padded = padRegionPlaintext(enc('x'), 4096);
    // A hostile REGION_LEN can never drive an over-large read.
    padded[0] = 0xff;
    padded[1] = 0xff;
    expect(() => parseRegionPlaintext(padded, 1 << 20)).toThrow();
    // Under cap in the field but over the caller's maxContentBytes.
    const ok = padRegionPlaintext(enc('abcdef'), 4096);
    expect(() => parseRegionPlaintext(ok, 3)).toThrow();
  });
});

describe('key-slot array (SPEC §10.3)', () => {
  it('is always the fixed size with all slots present', async () => {
    const kek = await deriveKEK('pw', randomBytes(16), TEST_PARAMS);
    const arr = await buildSlotArray([{ kek, dek: randomBytes(DEK_LEN), regionIndex: 0 }]);
    expect(arr.length).toBe(SLOT_ARRAY_LEN);
    expect(SLOT_ARRAY_LEN).toBe(SLOT_COUNT * SLOT_SIZE);
  });

  it('opens exactly one slot with the right KEK, recovering dek + region', async () => {
    const salt = randomBytes(16);
    const kek = await deriveKEK('pw', salt, TEST_PARAMS);
    const dek = randomBytes(DEK_LEN);
    const arr = await buildSlotArray([{ kek, dek, regionIndex: 1 }]);
    const got = await unlockSlotArray(arr, salt, 'pw', TEST_PARAMS);
    expect(got.regionIndex).toBe(1);
    expect([...got.dek]).toEqual([...dek]);
  });

  it('rejects a wrong password with the uniform WrongPasswordError', async () => {
    const salt = randomBytes(16);
    const kek = await deriveKEK('right', salt, TEST_PARAMS);
    const arr = await buildSlotArray([{ kek, dek: randomBytes(DEK_LEN), regionIndex: 0 }]);
    await expect(unlockSlotArray(arr, salt, 'wrong', TEST_PARAMS)).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it('flipping region_index breaks GCM open rather than redirecting', async () => {
    const salt = randomBytes(16);
    const kek = await deriveKEK('pw', salt, TEST_PARAMS);
    const dek = randomBytes(DEK_LEN);
    const arr = await buildSlotArray([{ kek, dek, regionIndex: 0 }]);
    // Find the live slot and corrupt every byte of its sealed region until one flips;
    // any single-byte edit inside the authenticated region must fail the tag.
    let opened = -1;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const slot = arr.subarray(i * SLOT_SIZE, (i + 1) * SLOT_SIZE);
      if (await tryOpenSlot(kek, slot)) opened = i;
    }
    expect(opened).toBeGreaterThanOrEqual(0);
    const tampered = arr.slice();
    tampered[opened * SLOT_SIZE + 12]! ^= 0xff; // first ciphertext byte (dek/region region)
    await expect(unlockSlotArray(tampered, salt, 'pw', TEST_PARAMS)).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it('dead slots never open', async () => {
    const kek = await deriveKEK('pw', randomBytes(16), TEST_PARAMS);
    // A slot array with a single live entry has 3 dead (random) slots.
    const arr = await buildSlotArray([{ kek, dek: randomBytes(DEK_LEN), regionIndex: 0 }]);
    let matches = 0;
    for (let i = 0; i < SLOT_COUNT; i++) {
      if (await tryOpenSlot(kek, arr.subarray(i * SLOT_SIZE, (i + 1) * SLOT_SIZE))) matches++;
    }
    expect(matches).toBe(1);
  });

  it('fails closed (no match) via openSlotArray with an unrelated KEK', async () => {
    const kek = await deriveKEK('pw', randomBytes(16), TEST_PARAMS);
    const arr = await buildSlotArray([{ kek, dek: randomBytes(DEK_LEN), regionIndex: 0 }]);
    const other = await importAesGcmKey(randomBytes(32));
    await expect(openSlotArray(arr, [other])).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('spreads the live slot across positions over many authorings', async () => {
    const kek = await deriveKEK('pw', randomBytes(16), TEST_PARAMS);
    const positions = new Set<number>();
    for (let n = 0; n < 40; n++) {
      const arr = await buildSlotArray([{ kek, dek: randomBytes(DEK_LEN), regionIndex: 0 }]);
      for (let i = 0; i < SLOT_COUNT; i++) {
        if (await tryOpenSlot(kek, arr.subarray(i * SLOT_SIZE, (i + 1) * SLOT_SIZE))) positions.add(i);
      }
    }
    // Over 40 shuffles all four positions should appear (biased shuffle would not).
    expect(positions.size).toBe(SLOT_COUNT);
  });
});

describe('per-region key (independent DEK)', () => {
  it('derives distinct keys per region index and round-trips content', async () => {
    const dek = randomBytes(DEK_LEN);
    const salt = randomBytes(16);
    const k0 = await deriveRegionKey(dek, salt, 0);
    const { iv, ciphertext } = await encryptBytes(k0, enc('region zero'));
    const again = await deriveRegionKey(dek, salt, 0);
    expect(new TextDecoder().decode(await decryptBytes(again, iv, ciphertext))).toBe('region zero');
    // A different region index yields a key that cannot open region 0's ciphertext.
    const k1 = await deriveRegionKey(dek, salt, 1);
    await expect(decryptBytes(k1, iv, ciphertext)).rejects.toBeTruthy();
  });
});

describe('deriveKekBytes + secureShuffle helpers', () => {
  it('deriveKekBytes matches deriveKEK for the same inputs', async () => {
    const salt = randomBytes(16);
    const raw = await deriveKekBytes('pw', salt, TEST_PARAMS);
    expect(raw.length).toBe(32);
    const viaBytes = await importAesGcmKey(raw);
    const direct = await deriveKEK('pw', salt, TEST_PARAMS);
    const { iv, ciphertext } = await encryptBytes(direct, enc('same key?'));
    expect(new TextDecoder().decode(await decryptBytes(viaBytes, iv, ciphertext))).toBe('same key?');
  });

  it('secureShuffle keeps the multiset and covers all positions', () => {
    const counts = new Array(5).fill(0);
    for (let n = 0; n < 200; n++) {
      const a = [0, 1, 2, 3, 4];
      secureShuffle(a);
      expect([...a].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4]);
      counts[a[0]!]++;
    }
    // Every value lands in position 0 at least once (uniform-ish).
    expect(counts.every((c) => c > 0)).toBe(true);
  });
});
