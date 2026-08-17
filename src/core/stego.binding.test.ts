/**
 * The stego layer is bound to its cover, and nothing checked that.
 *
 * SPEC §5.3 states it as a property: "This binds the keystream to the specific
 * cover: the same password over two different covers (or the same cover reused)
 * never repeats the whitening pad or the carrier layout." The mechanism is the
 * cover fingerprint, hashed from embedding-invariant bits and used as the HKDF
 * salt, so the derived key differs per cover while surviving the embedding.
 *
 * The first mutation run showed that claim was unprotected. Of the 94 survivors
 * in stego.ts, 34 sat in the two fingerprint functions, and the pattern is
 * uniform: replacing a function body with `{}`, emptying a loop, forcing
 * `Math.abs(v) >= 2` to false. Every one of those makes the fingerprint
 * **constant**, and a constant fingerprint round-trips perfectly, because embed
 * and extract compute the same wrong value.
 *
 * A constant fingerprint would be a real weakness rather than a cosmetic one:
 * two vaults hidden in two different photos under one password would share their
 * whitening pad and their carrier positions, which is precisely what the spec
 * says never happens.
 *
 * Round-trip tests cannot see any of this. They verify consistency, and a
 * constant is consistent. So these tests compare *across* covers instead.
 */

import { describe, it, expect } from 'vitest';
import jpeg from 'jpeg-js';
import { decode as decodeCoeff, encode as encodeCoeff, type JpegModel } from './jpeg-coeff';
import {
  type Argon2Params,
  createKeyBlock,
  embedKeyBlockStego,
  extractKeyBlockStego,
  embedKeyBlockStegoJpeg,
  extractKeyBlockStegoJpeg,
  serializeKeyBlock,
  KEY_BLOCK_LEN,
} from './index';

const FAST: Argon2Params = { iterations: 1, memoryKiB: 64, parallelism: 1 };
const W = 128;
const H = 128;
const PW = 'correct horse battery staple';

/**
 * A deterministic "photo". Every channel is driven by the seeded PRNG.
 *
 * The first version of this helper wrote `(p * 7 + seed)` into red and green.
 * Two seeds differing by an even number then produced *identical low bits* in
 * two thirds of the carriers, and a test comparing low bits across covers was
 * really measuring this function. Channels that differ only by a constant are
 * not two different images in the only bits this file cares about.
 */
function makeCover(seed: number): Uint8Array {
  const rgba = new Uint8Array(W * H * 4);
  let s = (seed * 2654435761) >>> 0;
  const next = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 24) & 0xff;
  };
  for (let p = 0; p < W * H; p++) {
    rgba[p * 4] = next();
    rgba[p * 4 + 1] = next();
    rgba[p * 4 + 2] = next();
    rgba[p * 4 + 3] = 255;
  }
  return rgba;
}

async function keyBlockBytes(password: string): Promise<Uint8Array> {
  const { block } = await createKeyBlock(password, FAST);
  return serializeKeyBlock(block);
}

/**
 * Indices of the RGB low bits embedding changed, in carrier order.
 *
 * This is the carrier layout the spec talks about, observed from outside: alpha
 * is never touched, so every difference is one of the 736 positions.
 */
function changedPositions(before: Uint8Array, after: Uint8Array): number[] {
  const out: number[] = [];
  let carrier = 0;
  for (let i = 0; i < before.length; i++) {
    if (i % 4 === 3) continue; // alpha carries nothing
    if ((before[i]! & 1) !== (after[i]! & 1)) out.push(carrier);
    carrier++;
  }
  return out;
}

describe('the carrier layout is bound to the cover (SPEC §5.3)', () => {
  it('picks different positions in two different covers under one password', async () => {
    // Same dimensions on purpose. Capacity is identical, so the position stream
    // depends on nothing but the derived key: if the fingerprint were constant,
    // or ignored, these two lists would match exactly.
    const kb = await keyBlockBytes(PW);
    const a = makeCover(1);
    const b = makeCover(999);
    const a0 = a.slice();
    const b0 = b.slice();

    await embedKeyBlockStego(a, W, H, kb, PW, FAST);
    await embedKeyBlockStego(b, W, H, kb, PW, FAST);

    const pa = changedPositions(a0, a);
    const pb = changedPositions(b0, b);

    // Both must have embedded something, or the comparison is vacuous.
    expect(pa.length).toBeGreaterThan(0);
    expect(pb.length).toBeGreaterThan(0);

    const overlap = pa.filter((p) => pb.includes(p)).length;
    // Some coincidental overlap is expected: 736 positions drawn from 49,152
    // collide by chance. What must not happen is the same layout.
    expect(
      overlap,
      `the same ${overlap} of ${pa.length} positions were used in both covers`,
    ).toBeLessThan(pa.length / 2);
  });

  // The spec's other half, that the whitening *pad* also never repeats, has no
  // test here on purpose. The pad is only observable through the bits written at
  // the chosen positions, and those positions differ between covers, so there is
  // no aligned comparison to make from outside the module. Pad and layout are
  // derived from the same key by the same stream, so the test above fails if
  // that key stops depending on the cover, which is the property that matters.
  // Asserting more than that would mean reaching into the module to fabricate
  // agreement, which is the failure mode this file exists to avoid.

  it('extraction fails when the cover the key was hidden in is swapped', async () => {
    // The consequence a user would meet. Cover A carries a key block; extracting
    // with the right password from cover B finds nothing, because the
    // fingerprint, and therefore the layout, belongs to A.
    const kb = await keyBlockBytes(PW);
    const a = makeCover(1);
    await embedKeyBlockStego(a, W, H, kb, PW, FAST);

    const b = makeCover(999);
    await embedKeyBlockStego(b, W, H, kb, PW, FAST);

    // Sanity: each extracts from its own cover.
    expect(await extractKeyBlockStego(a, W, H, PW, FAST)).not.toBeNull();

    // Now graft A's low bits onto B's pixels. The layout is A's, the fingerprint
    // is B's, so nothing should be recoverable.
    const grafted = b.slice();
    for (let i = 0; i < grafted.length; i++) {
      if (i % 4 === 3) continue;
      grafted[i] = (grafted[i]! & 0xfe) | (a[i]! & 1);
    }
    expect(await extractKeyBlockStego(grafted, W, H, PW, FAST)).toBeNull();
  });
});

describe('the fingerprint survives embedding (SPEC §5.3)', () => {
  it('re-embedding the same key block changes nothing at all', async () => {
    // The reason the fingerprint masks off the low bits before hashing. If
    // embedding moved the fingerprint, extraction could never recompute it and
    // the format would have to store it, which is what the design avoids.
    //
    // Idempotence is the sharp observable, and it took a wrong test to find it.
    // The first attempt embedded a *different* key block second and required
    // every position it touched to have been touched by the first write too.
    // That failed on 163 positions, and the code was right: a position belongs
    // to the layout whether or not the write changed the bit there, so the first
    // write is only visible on about half of its own 736 positions. The
    // comparison was against the wrong set.
    //
    // Writing the *same* key block twice removes the ambiguity. Same layout and
    // same pad means the second write is a no-op, byte for byte. A fingerprint
    // disturbed by embedding sends the second write somewhere else, and roughly
    // half of those positions flip.
    const kb = await keyBlockBytes(PW);
    const cover = makeCover(42);
    const pristine = cover.slice();

    await embedKeyBlockStego(cover, W, H, kb, PW, FAST);
    const once = cover.slice();
    expect(changedPositions(pristine, once).length).toBeGreaterThan(0);

    await embedKeyBlockStego(cover, W, H, kb, PW, FAST);
    const moved = changedPositions(once, cover);
    expect(
      moved.length,
      `${moved.length} carriers moved on a repeat embed, so embedding disturbed the fingerprint`,
    ).toBe(0);
    expect([...cover]).toEqual([...once]);

    const out = await extractKeyBlockStego(cover, W, H, PW, FAST);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(KEY_BLOCK_LEN);
    expect([...out!]).toEqual([...kb]);
  });
});

/**
 * The JPEG half of the same property.
 *
 * The RGBA tests above left `coverFingerprintJpeg` untouched, and the mutation
 * run said so plainly: `BlockStatement -> {}` still survived on its body and on
 * both of its inner loops. A photo is the primary cover for this feature, so the
 * unprotected half was the one that matters most.
 *
 * Comparing across JPEG covers needs more care than across RGBA buffers. The
 * carrier positions are indices into the *eligible* coefficient list, and two
 * unrelated photos have different numbers of eligible coefficients, so their
 * index lists cannot be compared and a difference would prove nothing.
 *
 * So the covers here are built to differ in content while holding the eligible
 * count fixed. Adding 2 to a coefficient keeps its sign, its parity and its
 * |v| >= 2 eligibility, and negating one keeps its magnitude and parity. Both
 * change what the fingerprint hashes and neither changes what it counts, which
 * makes the position lists directly comparable.
 */

/** Eligible AC coefficients in `eligibleCoefficients` order: |v| >= 2, k = 1..63. */
function eligible(model: JpegModel): { block: Int16Array; k: number }[] {
  const refs: { block: Int16Array; k: number }[] = [];
  for (const comp of model.components) {
    for (const block of comp.blocks) {
      for (let k = 1; k < 64; k++) {
        if (Math.abs(block[k]!) >= 2) refs.push({ block, k });
      }
    }
  }
  return refs;
}

function baseJpeg(width: number, height: number, quality = 80): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  let s = 24680;
  for (let p = 0; p < width * height; p++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[p * 4] = (s >>> 24) & 0xff;
    data[p * 4 + 1] = (s >>> 16) & 0xff;
    data[p * 4 + 2] = (s >>> 8) & 0xff;
    data[p * 4 + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data, width, height }, quality).data);
}

/** Rewrite every `stride`-th eligible coefficient with `fn`, then re-encode. */
function variant(cover: Uint8Array, stride: number, fn: (v: number) => number): Uint8Array {
  const model = decodeCoeff(cover);
  const refs = eligible(model);
  for (let i = 0; i < refs.length; i += stride) {
    const { block, k } = refs[i]!;
    block[k] = fn(block[k]!);
  }
  return encodeCoeff(model);
}

/** Carrier indices whose embedded bit differs between a cover and its stego output. */
function changedCarriers(cover: Uint8Array, stego: Uint8Array): number[] {
  const a = eligible(decodeCoeff(cover));
  const b = eligible(decodeCoeff(stego));
  expect(b.length, 'embedding changed the eligible carrier count').toBe(a.length);
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) {
    const va = Math.abs(a[i]!.block[a[i]!.k]!) & 1;
    const vb = Math.abs(b[i]!.block[b[i]!.k]!) & 1;
    if (va !== vb) out.push(i);
  }
  return out;
}

describe('the JPEG carrier layout is bound to the cover (SPEC §5.3)', () => {
  const PWJ = 'a password for the jpeg path';

  it('picks different positions in covers that differ only in coefficient values', async () => {
    const kb = await keyBlockBytes(PWJ);
    const a = baseJpeg(64, 64);
    // +2 keeps sign, parity and eligibility; the masked magnitude the fingerprint
    // hashes changes. Same carrier count, different fingerprint.
    const b = variant(a, 5, (v) => (v < 0 ? v - 2 : v + 2));

    const ea = eligible(decodeCoeff(a)).length;
    const eb = eligible(decodeCoeff(b)).length;
    expect(eb, 'the variant must not move the carrier count').toBe(ea);
    expect(ea).toBeGreaterThan(KEY_BLOCK_LEN * 8);

    const pa = changedCarriers(a, await embedKeyBlockStegoJpeg(a, kb, PWJ, FAST));
    const pb = changedCarriers(b, await embedKeyBlockStegoJpeg(b, kb, PWJ, FAST));
    expect(pa.length).toBeGreaterThan(0);
    expect(pb.length).toBeGreaterThan(0);

    const overlap = pa.filter((p) => pb.includes(p)).length;
    expect(
      overlap,
      `the same ${overlap} of ${pa.length} carriers were used in both covers`,
    ).toBeLessThan(pa.length / 2);
  });

  it('picks different positions when only the coefficient signs differ', async () => {
    // Magnitude and parity identical, sign flipped. A fingerprint that hashed
    // |v| and dropped the sign would produce the same layout for both, which is
    // what the `v < 0 ? -m : m` mutants amount to.
    const kb = await keyBlockBytes(PWJ);
    const a = baseJpeg(64, 64);
    const c = variant(a, 7, (v) => -v);
    expect(eligible(decodeCoeff(c)).length).toBe(eligible(decodeCoeff(a)).length);

    const pa = changedCarriers(a, await embedKeyBlockStegoJpeg(a, kb, PWJ, FAST));
    const pc = changedCarriers(c, await embedKeyBlockStegoJpeg(c, kb, PWJ, FAST));
    const overlap = pa.filter((p) => pc.includes(p)).length;
    expect(overlap).toBeLessThan(pa.length / 2);
  });

  it('re-embedding the same key block into a JPEG changes no coefficient', async () => {
    // Invariance, JPEG side. The fingerprint masks bit 0 of each magnitude and
    // embedding only writes bit 0, so a repeat embed must be a no-op.
    const kb = await keyBlockBytes(PWJ);
    const cover = baseJpeg(64, 64);
    const once = await embedKeyBlockStegoJpeg(cover, kb, PWJ, FAST);
    expect(changedCarriers(cover, once).length).toBeGreaterThan(0);

    const twice = await embedKeyBlockStegoJpeg(once, kb, PWJ, FAST);
    expect(
      changedCarriers(once, twice).length,
      'a repeat embed moved carriers, so embedding disturbed the JPEG fingerprint',
    ).toBe(0);

    const out = await extractKeyBlockStegoJpeg(twice, PWJ, FAST);
    expect(out).not.toBeNull();
    expect([...out!]).toEqual([...kb]);
  });
});
