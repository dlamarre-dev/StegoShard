/**
 * Branch coverage for the §10 primitives' guard/edge paths: the error branches
 * that the end-to-end round-trips don't naturally exercise. All fast (pure funcs
 * or a raw-imported AES key; no Argon2).
 */

import { describe, it, expect } from 'vitest';
import {
  DEK_LEN,
  KEY_FACTOR_LEN,
  KEY_FACTOR_BLOCK_LEN,
  SLOT_SIZE,
  buildSlotArray,
  importAesGcmKey,
  parseKeyFactorBlock,
  randomBytes,
  secureShuffle,
  serializeKeyFactorBlock,
  serializeSlot,
  tryOpenSlot,
} from './crypto';
import { padRegionPlaintext, parseRegionPlaintext, REGION_LEN_FIELD } from './regions';
import { BucketTooLargeError, GALLERY_LADDER, pickBucket } from './buckets';
import {
  SECRET_LEN,
  SHARE_LEN,
  ShareChecksumError,
  serializeShare,
  parseShare,
  shamirSplit,
  shareFileText,
  encodeShareText,
  decodeShareText,
} from './shamir';
import { credentialsIndependent } from './access';

const key = () => importAesGcmKey(randomBytes(DEK_LEN));

describe('SSKF key-factor envelope guards (§10.3)', () => {
  it('serialize rejects a factor of the wrong length', () => {
    expect(() => serializeKeyFactorBlock(randomBytes(KEY_FACTOR_LEN - 1))).toThrow(RangeError);
  });

  it('parse returns null for wrong length, wrong magic, and wrong version', () => {
    const good = serializeKeyFactorBlock(randomBytes(KEY_FACTOR_LEN));
    expect(parseKeyFactorBlock(good)).not.toBeNull();
    // wrong length
    expect(parseKeyFactorBlock(good.subarray(0, KEY_FACTOR_BLOCK_LEN - 1))).toBeNull();
    // right length, wrong magic
    const badMagic = good.slice();
    badMagic[0] = badMagic[0]! ^ 0xff;
    expect(parseKeyFactorBlock(badMagic)).toBeNull();
    // right magic, wrong version
    const badVer = good.slice();
    badVer[4] = 0x02;
    expect(parseKeyFactorBlock(badVer)).toBeNull();
  });
});

describe('slot primitives guards (§10)', () => {
  it('serializeSlot rejects a bad nonce or dek length', async () => {
    const k = await key();
    await expect(serializeSlot(k, randomBytes(11), randomBytes(DEK_LEN), 0)).rejects.toThrow(
      RangeError,
    );
    await expect(serializeSlot(k, randomBytes(12), randomBytes(DEK_LEN - 1), 0)).rejects.toThrow(
      RangeError,
    );
  });

  it('buildSlotArray rejects an empty, oversized, or out-of-range entry set', async () => {
    const k = await key();
    await expect(buildSlotArray([])).rejects.toThrow(RangeError);
    const entry = { kek: k, dek: randomBytes(DEK_LEN), regionIndex: 0 };
    await expect(buildSlotArray(Array.from({ length: 5 }, () => entry))).rejects.toThrow(
      RangeError,
    );
    await expect(
      buildSlotArray([{ kek: k, dek: randomBytes(DEK_LEN), regionIndex: 2 }]),
    ).rejects.toThrow(RangeError);
  });

  it('tryOpenSlot returns null for a wrong-size slot and a random (dead) slot', async () => {
    const k = await key();
    expect(await tryOpenSlot(k, randomBytes(SLOT_SIZE - 1))).toBeNull();
    expect(await tryOpenSlot(k, randomBytes(SLOT_SIZE))).toBeNull(); // GCM auth fails
  });

  it('tryOpenSlot rejects a slot whose authenticated region index is out of range', async () => {
    const k = await key();
    // serializeSlot doesn't bound the index (buildSlotArray does); a slot that
    // decrypts cleanly but names region 2 ∉ {0,1} must still be rejected.
    const slot = await serializeSlot(k, randomBytes(12), randomBytes(DEK_LEN), 2);
    expect(await tryOpenSlot(k, slot)).toBeNull();
  });
});

describe('secureShuffle edges', () => {
  it('is a no-op on 0- and 1-element arrays and preserves the multiset otherwise', () => {
    const empty: number[] = [];
    secureShuffle(empty);
    expect(empty).toEqual([]);
    const one = [42];
    secureShuffle(one);
    expect(one).toEqual([42]);
    const many = [1, 2, 3, 4, 5, 6, 7, 8];
    secureShuffle(many);
    expect([...many].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('region plaintext framing guards (§10.5)', () => {
  it('padRegionPlaintext rejects a bucket smaller than the framed envelope', () => {
    expect(() => padRegionPlaintext(randomBytes(100), 50)).toThrow(RangeError);
  });

  it('parseRegionPlaintext bounds the declared length before slicing', () => {
    const env = randomBytes(20);
    const region = padRegionPlaintext(env, 64);
    expect([...parseRegionPlaintext(region, 1 << 20)]).toEqual([...env]);
    // too short to even hold the length field
    expect(() => parseRegionPlaintext(randomBytes(REGION_LEN_FIELD - 1), 1 << 20)).toThrow();
    // declared length exceeds the bucket
    const overBucket = region.slice();
    overBucket[0] = 0xff;
    overBucket[1] = 0xff;
    expect(() => parseRegionPlaintext(overBucket, 1 << 20)).toThrow();
    // declared length exceeds the caller's max-content cap
    expect(() => parseRegionPlaintext(region, 5)).toThrow();
  });
});

describe('bucket ladder', () => {
  it('picks the smallest entry ≥ the larger length', () => {
    expect(pickBucket(10, 100, GALLERY_LADDER)).toBe(GALLERY_LADDER[0]);
    expect(pickBucket(5000, 10, GALLERY_LADDER)).toBe(GALLERY_LADDER[1]);
  });

  it('throws BucketTooLargeError when neither length fits', () => {
    const top = GALLERY_LADDER[GALLERY_LADDER.length - 1]!;
    expect(() => pickBucket(top + 1, 0, GALLERY_LADDER)).toThrow(BucketTooLargeError);
  });
});

describe('Shamir share (de)serialization guards (§10.6.1)', () => {
  it('serializeShare rejects an out-of-range index or bad value length', async () => {
    await expect(serializeShare(0, randomBytes(SECRET_LEN))).rejects.toThrow(RangeError);
    await expect(serializeShare(256, randomBytes(SECRET_LEN))).rejects.toThrow(RangeError);
    await expect(serializeShare(1, randomBytes(SECRET_LEN - 1))).rejects.toThrow(RangeError);
  });

  it('parseShare rejects a bad length, version, and checksum', async () => {
    const share = (await shamirSplit(randomBytes(SECRET_LEN), 2, 3))[0]!;
    await expect(parseShare(share.subarray(0, SHARE_LEN - 1))).rejects.toThrow(RangeError);
    const badVer = share.slice();
    badVer[0] = 0x02;
    await expect(parseShare(badVer)).rejects.toThrow();
    const badChecksum = share.slice();
    badChecksum[SHARE_LEN - 1] = badChecksum[SHARE_LEN - 1]! ^ 0xff;
    await expect(parseShare(badChecksum)).rejects.toBeInstanceOf(ShareChecksumError);
  });

  it('shamirSplit rejects a bad secret length or k/n', async () => {
    await expect(shamirSplit(randomBytes(SECRET_LEN - 1), 2, 3)).rejects.toThrow(RangeError);
    await expect(shamirSplit(randomBytes(SECRET_LEN), 0, 3)).rejects.toThrow(RangeError); // k<1
    await expect(shamirSplit(randomBytes(SECRET_LEN), 4, 3)).rejects.toThrow(RangeError); // n<k
    await expect(shamirSplit(randomBytes(SECRET_LEN), 2, 256)).rejects.toThrow(RangeError); // n>255
  });

  it('share text round-trips (ignoring dashes/whitespace and stray chars)', async () => {
    const share = (await shamirSplit(randomBytes(SECRET_LEN), 2, 3))[0]!;
    const text = encodeShareText(share);
    expect(text).toContain('-');
    // 'I' survives the [^0-9A-Z] filter but isn't in Crockford base32 → skipped.
    expect([...decodeShareText(`  ${text}  I!? `)]).toEqual([...share]);
  });

  it('shareFileText embeds the encoded share + the surface-specific load hint', async () => {
    const share = (await shamirSplit(randomBytes(SECRET_LEN), 2, 3))[0]!;
    const body = shareFileText(share, 1, 3, 2, 'and load them at unlock.');
    expect(body).toContain('share 1 of 3');
    expect(body).toContain(encodeShareText(share));
    expect(body).toContain('and load them at unlock.');
  });
});

describe('credential independence extra branches (§10.9)', () => {
  it('flags containment in both directions and case-insensitive reversal', () => {
    expect(credentialsIndependent('hunter2tail', 'hunter2').reason).toBe('contains'); // b prefix of a
    expect(credentialsIndependent('hunter2', 'hunter2tail').reason).toBe('contains'); // a prefix of b
    expect(credentialsIndependent('prefixhunter2', 'hunter2').reason).toBe('contains'); // b suffix of a
    expect(credentialsIndependent('Hunter2', '2Retnuh').reason).toBe('reverse'); // case-insensitive reverse
  });
});
