import { describe, it, expect } from 'vitest';
import {
  type Argon2Params,
  DEK_LEN,
  SLOT_ARRAY_LEN,
  SLOT_COUNT,
  SLOT_PLAINTEXT_LEN,
  SLOT_SIZE,
  aeadSeal,
  IV_LEN,
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
        if (await tryOpenSlot(kek, arr.subarray(i * SLOT_SIZE, (i + 1) * SLOT_SIZE)))
          positions.add(i);
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
    expect(new TextDecoder().decode(await decryptBytes(viaBytes, iv, ciphertext))).toBe(
      'same key?',
    );
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

/**
 * The slot layer's own argument guards, and two that cannot be reached at all.
 *
 * All five mutants below were reported as no coverage on the forced mutation run:
 * the lines never ran. Three are real guards on values a caller controls. The
 * other two are dead, each made unreachable by a check a few lines above it, and
 * proving that is more useful than a test that pretends to cover them.
 */
describe('slot layer argument guards', () => {
  const EMPTY_AAD = new Uint8Array(0);

  /**
   * A slot array of the wrong size is a malformed container, and it fails the
   * same way a wrong password does. That uniformity is the point: §10.3.1 spends
   * its whole design on making "no slot matched" indistinguishable from anything
   * else, and a distinct error here would hand back exactly the signal the
   * constant-work loop below it refuses to leak.
   */
  it('reports a wrong-length slot array as a wrong password, not as malformed', async () => {
    const kek = await deriveKEK('pw', randomBytes(16), TEST_PARAMS);
    for (const len of [0, SLOT_ARRAY_LEN - 1, SLOT_ARRAY_LEN + 1]) {
      await expect(
        openSlotArray(new Uint8Array(len), [kek]),
        `length ${len}`,
      ).rejects.toBeInstanceOf(WrongPasswordError);
    }
  });

  /**
   * Trailing bytes are refused, and this is the assertion that makes the guard
   * above load-bearing rather than decorative.
   *
   * Deleting the length check does not change the answer for a *short* array: the
   * loop finds no match and the function throws the same WrongPasswordError at
   * the bottom, so a test on short input alone cannot tell whether the guard is
   * there. Mutation testing said exactly that, by leaving the mutant alive after
   * the test above was written.
   *
   * A *longer* array separates them. The loop reads only the first SLOT_COUNT
   * slots, so a valid array with bytes appended would open normally without the
   * guard. That is the canonical-encoding property the format relies on
   * elsewhere: exactly one byte sequence parses to a given container.
   */
  it('refuses a valid slot array with bytes appended', async () => {
    const salt = randomBytes(16);
    const kek = await deriveKEK('pw', salt, TEST_PARAMS);
    const dek = randomBytes(DEK_LEN);
    const arr = await buildSlotArray([{ kek, dek, regionIndex: 0 }]);

    // The control: unmodified, it opens.
    const ok = await openSlotArray(arr, [kek]);
    expect([...ok.dek]).toEqual([...dek]);

    const padded = new Uint8Array(arr.length + 1);
    padded.set(arr);
    await expect(openSlotArray(padded, [kek])).rejects.toBeInstanceOf(WrongPasswordError);
  });

  // Same reasoning one layer up: whatever goes wrong while turning the password
  // into a KEK, the caller learns only that the password did not work.
  it('reports a failed key derivation as a wrong password', async () => {
    for (const params of [
      { iterations: 0, memoryKiB: 8, parallelism: 1 },
      { iterations: 1, memoryKiB: 0, parallelism: 1 },
    ]) {
      await expect(
        unlockSlotArray(new Uint8Array(SLOT_ARRAY_LEN), randomBytes(16), 'pw', params),
        JSON.stringify(params),
      ).rejects.toBeInstanceOf(WrongPasswordError);
    }
  });

  /**
   * `tryOpenSlot` checks the recovered plaintext length, and cannot ever fail
   * that check.
   *
   * AES-GCM is length-preserving plus a 16-byte tag, and the function has already
   * refused anything that is not exactly `SLOT_SIZE` bytes. So the sealed part is
   * always `SLOT_SIZE - IV_LEN` bytes, which always opens to exactly
   * `SLOT_PLAINTEXT_LEN`. The only plaintext length that can produce a slot of
   * the accepted size is the one the guard is looking for.
   *
   * Swept rather than argued: every plaintext length from 0 to 96 either builds a
   * slot of the wrong size, rejected earlier, or builds a 48-byte one.
   */
  it('cannot reach its plaintext-length guard, by construction', async () => {
    const kek = await deriveKEK('pw', randomBytes(16), TEST_PARAMS);
    const acceptedSizes = new Set<number>();

    for (let ptLen = 0; ptLen <= 96; ptLen++) {
      const nonce = randomBytes(IV_LEN);
      const sealed = await aeadSeal(kek, nonce, randomBytes(ptLen), EMPTY_AAD);
      const slot = new Uint8Array(IV_LEN + sealed.length);
      slot.set(nonce);
      slot.set(sealed, IV_LEN);
      if (slot.length === SLOT_SIZE) acceptedSizes.add(ptLen);
    }

    // Exactly one plaintext length survives the size check, and it is the one the
    // guard tests for, so the guard's body is unreachable.
    expect([...acceptedSizes]).toEqual([SLOT_PLAINTEXT_LEN]);
  });

  /**
   * `randomIntBelow` refuses a non-positive bound, and nothing can ask it for
   * one. Its only caller is `secureShuffle`, whose loop runs while `i > 0` and
   * passes `i + 1`, so the smallest bound it can ever see is 2. Both the
   * non-positive guard and the `n === 1` shortcut below it are dead.
   *
   * Kept because they make `randomIntBelow` correct on its own terms rather than
   * only in the one place it happens to be used, which is the right shape for a
   * sampling primitive. Recorded because a permanently uncovered mutant should be
   * explained once instead of investigated every time.
   */
  it('never asks randomIntBelow for a non-positive bound', () => {
    for (const len of [0, 1, 2, 5, 50]) {
      const arr = Array.from({ length: len }, (_, i) => i);
      expect(() => secureShuffle(arr)).not.toThrow();
      expect([...arr].sort((a, b) => a - b)).toEqual(Array.from({ length: len }, (_, i) => i));
    }
  });
});
