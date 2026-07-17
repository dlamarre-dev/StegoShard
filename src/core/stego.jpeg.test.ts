/**
 * JPEG-domain stego (SPEC §5.4): the key block hidden in a baseline JPEG's DCT
 * coefficients round-trips, the output stays a valid JPEG of ~the same size,
 * only eligible coefficients move by ±1, and wrong password / undersized / wrong
 * format all fail safely.
 */

import { describe, it, expect } from 'vitest';
import jpeg from 'jpeg-js';
import {
  type Argon2Params,
  StegoCapacityError,
  createKeyBlock,
  decode as decodeJpeg,
  embedKeyBlockStegoJpeg,
  extractKeyBlockStegoJpeg,
  isSerializedKeyBlock,
  serializeKeyBlock,
} from './index';

const FAST: Argon2Params = { iterations: 1, memoryKiB: 64, parallelism: 1 };

/** A textured (high-AC-energy) baseline JPEG so it has plenty of |coef|≥2 carriers. */
function noisyJpeg(width: number, height: number, quality = 85, seed = 1): Uint8Array {
  const data = Buffer.alloc(width * height * 4);
  let s = seed >>> 0;
  for (let i = 0; i < width * height; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i * 4] = (s >>> 24) & 0xff;
    data[i * 4 + 1] = (s >>> 16) & 0xff;
    data[i * 4 + 2] = (s >>> 8) & 0xff;
    data[i * 4 + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data, width, height }, quality).data);
}

async function keyBlockBytes(password: string): Promise<Uint8Array> {
  const { block } = await createKeyBlock(password, FAST);
  return serializeKeyBlock(block);
}

const W = 128;
const H = 128;

describe('JPEG stego round-trip', () => {
  it('embeds and extracts the exact key block, staying a valid same-size JPEG', async () => {
    const kb = await keyBlockBytes('correct horse');
    const cover = noisyJpeg(W, H);
    const stego = await embedKeyBlockStegoJpeg(cover, kb, 'correct horse', FAST);

    // Still a decodable JPEG, essentially the same size.
    expect(jpeg.decode(stego, { useTArray: true }).width).toBe(W);
    expect(Math.abs(stego.length - cover.length)).toBeLessThan(64);

    const out = await extractKeyBlockStegoJpeg(stego, 'correct horse', FAST);
    expect(out).not.toBeNull();
    expect([...out!]).toEqual([...kb]);
    expect(isSerializedKeyBlock(out!)).toBe(true);
  });

  it('extracts across NFC/NFD password forms', async () => {
    const nfc = 'passwörd';
    const nfd = 'passwörd'; // decomposed
    expect(nfc).not.toBe(nfd);
    const kb = await keyBlockBytes(nfc);
    const stego = await embedKeyBlockStegoJpeg(noisyJpeg(W, H), kb, nfc, FAST);
    const out = await extractKeyBlockStegoJpeg(stego, nfd, FAST);
    expect([...out!]).toEqual([...kb]);
  });

  it('is byte-faithful: header verbatim, camera entropy kept, minimal logical change', async () => {
    const kb = await keyBlockBytes('pw');
    const cover = noisyJpeg(W, H);
    const stego = await embedKeyBlockStegoJpeg(cover, kb, 'pw', FAST);

    // Same length (± the odd byte-stuffing byte).
    expect(Math.abs(stego.length - cover.length)).toBeLessThan(16);

    const model = (b: Uint8Array) => decodeJpeg(b);
    const mc = model(cover);
    const ms = model(stego);

    // Everything before the entropy scan is byte-for-byte identical (EXIF etc.).
    expect(mc.scanStart).toBe(ms.scanStart);
    expect([...cover.subarray(0, mc.scanStart)]).toEqual([...stego.subarray(0, ms.scanStart)]);

    // The entropy stream is the SAME (camera's own Huffman coding), not
    // re-serialized: unstuffing both, they differ in only the flipped coefficient
    // bytes — the theoretical minimum (≤ payload bits), never a full re-encode.
    const unstuff = (b: Uint8Array, s: number, e: number): number[] => {
      const o: number[] = [];
      for (let i = s; i < e; i++) {
        o.push(b[i]!);
        if (b[i] === 0xff && b[i + 1] === 0x00) i++;
      }
      return o;
    };
    const lc = unstuff(cover, mc.scanStart, mc.scanEnd);
    const ls = unstuff(stego, ms.scanStart, ms.scanEnd);
    expect(ls.length).toBe(lc.length); // same size category ⇒ same bit length
    let logicalDiff = 0;
    for (let i = 0; i < lc.length; i++) if (lc[i] !== ls[i]) logicalDiff++;
    expect(logicalDiff).toBeGreaterThan(0);
    expect(logicalDiff).toBeLessThanOrEqual(92 * 8); // ≤ 736 payload bits
  });

  it('only eligible AC coefficients change, by ±1 in magnitude', async () => {
    const kb = await keyBlockBytes('pw');
    const cover = noisyJpeg(W, H);
    const stego = await embedKeyBlockStegoJpeg(cover, kb, 'pw', FAST);

    const before = coeffList(cover);
    const after = coeffList(stego);
    expect(after.length).toBe(before.length);
    let changed = 0;
    for (let i = 0; i < before.length; i++) {
      if (before[i] === after[i]) continue;
      changed++;
      expect(Math.abs(Math.abs(after[i]!) - Math.abs(before[i]!))).toBe(1); // ±1 magnitude
      expect(Math.abs(before[i]!)).toBeGreaterThanOrEqual(2); // was eligible
      expect(Math.sign(after[i]!)).toBe(Math.sign(before[i]!)); // sign preserved
    }
    expect(changed).toBeGreaterThan(0);
    expect(changed).toBeLessThanOrEqual(92 * 8); // ≤ payload bits
  });
});

describe('JPEG stego rejection', () => {
  it('wrong password → null', async () => {
    const kb = await keyBlockBytes('right');
    const stego = await embedKeyBlockStegoJpeg(noisyJpeg(W, H), kb, 'right', FAST);
    expect(await extractKeyBlockStegoJpeg(stego, 'wrong', FAST)).toBeNull();
  });

  it('untouched JPEG → null', async () => {
    expect(await extractKeyBlockStegoJpeg(noisyJpeg(W, H, 85, 42), 'pw', FAST)).toBeNull();
  });

  it('non-JPEG bytes → null on extract', async () => {
    expect(
      await extractKeyBlockStegoJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'pw', FAST),
    ).toBeNull();
  });

  it('too few carriers → StegoCapacityError on embed', async () => {
    const kb = await keyBlockBytes('pw');
    // A tiny, low-quality (smooth) JPEG has almost no |coef|≥2 AC coefficients.
    const tiny = noisyJpeg(16, 16, 20);
    await expect(embedKeyBlockStegoJpeg(tiny, kb, 'pw', FAST)).rejects.toBeInstanceOf(
      StegoCapacityError,
    );
  });

  it('rejects a wrong-length payload', async () => {
    await expect(
      embedKeyBlockStegoJpeg(noisyJpeg(W, H), new Uint8Array(10), 'pw', FAST),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

function coeffList(jpg: Uint8Array): number[] {
  const m = decodeJpeg(jpg);
  const out: number[] = [];
  for (const c of m.components) for (const b of c.blocks) out.push(...b);
  return out;
}
