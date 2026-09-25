import { describe, it, expect } from 'vitest';
import { randomBytes } from './crypto';
import {
  SECRET_LEN,
  SHARE_LEN,
  ShareChecksumError,
  ShareSetError,
  decodeShareText,
  encodeShareText,
  parseShare,
  serializeShare,
  shamirRecover,
  shamirSplit,
} from './shamir';

const secret = () => randomBytes(SECRET_LEN);

/** Every k-subset of `arr` (small n only). */
function kSubsets<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (k > arr.length) return [];
  const [head, ...rest] = arr;
  return [...kSubsets(rest, k - 1).map((s) => [head!, ...s]), ...kSubsets(rest, k)];
}

describe('Shamir secret sharing (SPEC §10.6.1)', () => {
  it('produces n fixed-size shares', async () => {
    const shares = await shamirSplit(secret(), 3, 5);
    expect(shares.length).toBe(5);
    for (const s of shares) expect(s.length).toBe(SHARE_LEN);
  });

  it('ANY k of n shares recover the exact secret', async () => {
    const S = secret();
    const shares = await shamirSplit(S, 3, 5);
    for (const subset of kSubsets(shares, 3)) {
      expect([...(await shamirRecover(subset))]).toEqual([...S]);
    }
  });

  it('extra shares (> k) still recover correctly', async () => {
    const S = secret();
    const shares = await shamirSplit(S, 2, 5);
    expect([...(await shamirRecover(shares))]).toEqual([...S]); // all 5
  });

  it('k-1 shares reveal ZERO information (wrong value, never the secret)', async () => {
    const S = secret();
    const shares = await shamirSplit(S, 3, 5);
    // Every 2-subset (below the 3 threshold) must NOT reconstruct S.
    for (const subset of kSubsets(shares, 2)) {
      expect([...(await shamirRecover(subset))]).not.toEqual([...S]);
    }
  });

  it('k=1 is a trivial share of the secret (all shares equal S)', async () => {
    const S = secret();
    const shares = await shamirSplit(S, 1, 3);
    for (const s of shares) expect([...(await shamirRecover([s]))]).toEqual([...S]);
  });

  it('rejects duplicate shares with a clean error (not a raw division-by-zero)', async () => {
    const shares = await shamirSplit(secret(), 2, 3);
    // The same share loaded twice, a natural UX/transcription mistake.
    await expect(shamirRecover([shares[0]!, shares[0]!])).rejects.toBeInstanceOf(ShareSetError);
    // A distinct pair still recovers, so the guard is specific to duplicates.
    await expect(shamirRecover([shares[0]!, shares[1]!])).resolves.toHaveLength(SECRET_LEN);
  });

  // Found in review: the checksum is unkeyed, so a share at x=0 is easy to forge,
  // and Lagrange at 0 then returns its value whatever the genuine shares say.
  it('refuses a share at index 0, which SPEC §10.6.1 excludes', async () => {
    const body = Uint8Array.of(1, 0, ...new Uint8Array(SECRET_LEN).fill(0x42));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
    const forged = Uint8Array.of(...body, ...digest.subarray(0, 4));
    await expect(parseShare(forged)).rejects.toThrow(/index 0/);
    const [genuine] = await shamirSplit(secret(), 2, 3);
    await expect(shamirRecover([forged, genuine!])).rejects.toThrow(/index 0/);
  });

  it('reads O as 0 and I or L as 1 in a typed share, as Crockford base32 does', async () => {
    const shares = await shamirSplit(secret(), 2, 3);
    for (const share of shares) {
      const text = encodeShareText(share);
      const misread = text.replace(/0/g, 'O').replace(/1/g, (_, i: number) => (i % 2 ? 'l' : 'I'));
      expect(decodeShareText(misread)).toEqual(share);
    }
  });

  it('checksum detects a transcription error but is not vault-bound', async () => {
    const shares = await shamirSplit(secret(), 2, 3);
    const good = shares[0]!;
    await expect(parseShare(good)).resolves.toBeTruthy();
    // Flip a value byte → checksum fails on parse.
    const bad = good.slice();
    bad[5] = bad[5]! ^ 0xff;
    await expect(parseShare(bad)).rejects.toBeInstanceOf(ShareChecksumError);
  });

  it('rejects bad k/n and bad secret length', async () => {
    await expect(shamirSplit(new Uint8Array(31), 2, 3)).rejects.toThrow();
    await expect(shamirSplit(secret(), 0, 3)).rejects.toThrow();
    await expect(shamirSplit(secret(), 4, 3)).rejects.toThrow(); // k > n
    await expect(shamirSplit(secret(), 2, 256)).rejects.toThrow(); // n > 255
  });

  it('serializeShare round-trips through parseShare', async () => {
    const value = randomBytes(SECRET_LEN);
    const share = await serializeShare(7, value);
    const { index, value: back } = await parseShare(share);
    expect(index).toBe(7);
    expect([...back]).toEqual([...value]);
  });

  it('share text (base32) round-trips, ignoring dashes/spacing', async () => {
    const shares = await shamirSplit(secret(), 2, 3);
    for (const s of shares) {
      const text = encodeShareText(s);
      expect(text).toMatch(/^[0-9A-HJKMNP-TV-Z-]+$/); // Crockford + dashes
      expect([...decodeShareText(text)]).toEqual([...s]);
      // Reformatting (extra spaces / lowercase) still decodes.
      expect([...decodeShareText(text.toLowerCase().replace(/-/g, ' '))]).toEqual([...s]);
    }
  });
});
