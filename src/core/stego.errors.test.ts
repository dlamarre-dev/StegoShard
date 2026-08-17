/**
 * The refusal paths of the stego layer.
 *
 * The first sharded mutation run put stego.ts last at 63.8%, with 22 mutants on
 * 13 lines carrying **no coverage at all**: every capacity guard, the cover
 * format error, the JPEG capacity probe, and the restart-marker fallback. Not
 * weakly tested, untested. A guard nothing exercises is a guard that can be
 * deleted without a single test noticing, which is the same shape of failure
 * this repository has now found a dozen times.
 *
 * These are the paths a user meets when the picture is too small or the wrong
 * kind, so they are also the ones whose message matters.
 */

import { describe, it, expect } from 'vitest';
import jpeg from 'jpeg-js';
import { decode as decodeCoeff, encode as encodeCoeff } from './jpeg-coeff';
import {
  type Argon2Params,
  StegoCapacityError,
  StegoCoverFormatError,
  embedBytesStegoRgba,
  extractBytesStegoRgba,
  embedBytesStegoJpeg,
  extractBytesStegoJpeg,
  embedKeyBlockStegoJpeg,
  jpegStegoCapacityBits,
  KEY_BLOCK_LEN,
} from './index';

const SEED = new Uint8Array(32).fill(7);
const FAST: Argon2Params = { iterations: 1, memoryKiB: 64, parallelism: 1 };

/** A deterministic baseline JPEG with enough detail to carry coefficients. */
function baseJpeg(width: number, height: number, quality = 80): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  let s = 12345;
  for (let p = 0; p < width * height; p++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[p * 4] = (s >>> 24) & 0xff;
    data[p * 4 + 1] = (s >>> 16) & 0xff;
    data[p * 4 + 2] = (s >>> 8) & 0xff;
    data[p * 4 + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data, width, height }, quality).data);
}

/** Splice `FFDD 0004 <interval>` in just before SOS. */
function insertDri(bytes: Uint8Array, interval: number): Uint8Array {
  let o = 2;
  while (o < bytes.length - 1) {
    if (bytes[o] !== 0xff) throw new Error('lost marker alignment building the fixture');
    if (bytes[o + 1] === 0xda) break; // SOS
    o += 2 + ((bytes[o + 2]! << 8) | bytes[o + 3]!);
  }
  const dri = Uint8Array.of(0xff, 0xdd, 0x00, 0x04, (interval >> 8) & 0xff, interval & 0xff);
  const out = new Uint8Array(bytes.length + dri.length);
  out.set(bytes.subarray(0, o), 0);
  out.set(dri, o);
  out.set(bytes.subarray(o), o + dri.length);
  return out;
}

/**
 * A JPEG that genuinely carries restart markers, which sends the stego layer
 * down its re-encode fallback instead of the in-place path.
 *
 * Markers first, DRI segment second. Splicing the header in first makes a file
 * the decoder is right to refuse: told to expect a marker every N MCUs and
 * finding none, it desynchronises. Same construction as jpeg-restart.test.ts.
 */
function jpegWithRestarts(interval: number, width: number, height: number): Uint8Array {
  const model = decodeCoeff(baseJpeg(width, height));
  model.restartInterval = interval;
  return insertDri(encodeCoeff(model), interval);
}

describe('StegoCoverFormatError', () => {
  it('names itself and says what is accepted', () => {
    // Constructed in image-io.ts and node-image-io.ts, never in core, so no core
    // test reached it. It is the message shown when someone picks a progressive
    // JPEG, a HEIC or a WebP, and the useful half of that message is the part
    // saying what *would* work.
    const err = new StegoCoverFormatError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('StegoCoverFormatError');
    expect(err.message).toContain('baseline JPEG');
    expect(err.message).toContain('PNG');
  });
});

describe('capacity refusals', () => {
  it('refuses an RGBA cover smaller than the payload, reporting the capacity', async () => {
    const width = 16;
    const height = 16;
    const capacity = width * height * 3; // 768 carrier bits
    const rgba = new Uint8Array(width * height * 4).fill(128);
    const tooBig = new Uint8Array(capacity / 8 + 1); // one byte past what fits

    // The number carried by the error is what the UI shows to explain the
    // refusal, so a guard that threw the payload size instead would still pass a
    // bare `rejects.toThrow()`. Asserted with `rejects` rather than a `.catch()`
    // block: a catch whose callback never runs asserts nothing and still passes.
    await expect(embedBytesStegoRgba(rgba, width, height, tooBig, SEED)).rejects.toMatchObject({
      name: 'StegoCapacityError',
      capacityBits: capacity,
    });
  });

  it('accepts a payload that exactly fills the margin it was given', async () => {
    // The boundary on the passing side, so the guard cannot be widened to `<=`
    // without a test objecting.
    const width = 16;
    const height = 16;
    const rgba = new Uint8Array(width * height * 4).fill(128);
    const exact = new Uint8Array((width * height * 3) / 8 / 2); // half capacity
    await expect(embedBytesStegoRgba(rgba, width, height, exact, SEED, 2)).resolves.toBeUndefined();
  });

  it('refuses at its default margin a payload that selection could not place', async () => {
    // `embedBytesStegoRgba` documented that its margin "guarantees pickPositions
    // never drains the keystream", and the default of 1 did not have that
    // property: the guard accepted a payload filling the cover, and selection
    // then ran out of stream and threw a bare internal error.
    //
    // The arithmetic says why. Picking b distinct positions out of N by
    // rejection costs about N·ln(N/(N-b)) draws while the stream supplies
    // 2b+1024. At b = N those are N·ln(N) against 2N+1024, and the left side
    // wins for any N past a few dozen. Measured at 16, 32, 64 and 128 square:
    // margin 1 drained at every size, margin 2 and above was clear, and 1.25 sat
    // on the boundary (1.61·N needed against 1.60·N+1024) so it is not claimed.
    //
    // Two fixes were tried. Converting the exhaustion into a StegoCapacityError
    // inside pickPositions was measured and rejected: mutants in StreamReader and
    // pickPositions that had been caught *because* they drained the stream then
    // produced an error a test welcomed, and stego.ts fell from 83.8% to 79.9%
    // with fourteen new survivors. Swallowing an internal fault into an expected
    // refusal is the same mistake in a different coat.
    //
    // So the default margin is 2 instead, which keeps the guard in front of the
    // condition and leaves exhaustion loud. This test pins the refusal a caller
    // now gets, and its type.
    const w = 32;
    const h = 32;
    const capacity = w * h * 3;
    const rgba = new Uint8Array(w * h * 4).fill(128);
    const fills = new Uint8Array(capacity / 8); // exactly capacity

    await expect(embedBytesStegoRgba(rgba, w, h, fills, SEED)).rejects.toMatchObject({
      name: 'StegoCapacityError',
      capacityBits: capacity,
    });

    // Half the capacity is what the default admits, so the boundary is pinned on
    // both sides rather than only on the refusing one.
    const half = new Uint8Array(capacity / 8 / 2);
    await expect(embedBytesStegoRgba(rgba, w, h, half, SEED)).resolves.toBeUndefined();
  });

  it('still reads a carrier written at the old margin of 1', async () => {
    // The compatibility half of that default change, and the half I got wrong.
    // Raising embedding's default to 2 is safe: it only refuses to *produce*
    // something denser. Raising extraction's default too was a break, caught in
    // review, because a payload written at margin 1 sits above the margin-2
    // threshold and extraction would answer null for data it used to read.
    //
    // So embedding defaults to 2 and extraction stays at 1. A reader must stay
    // able to open anything a writer once produced, and this pins that.
    const w = 32;
    const h = 32;
    const capacity = w * h * 3;
    const dense = new Uint8Array(Math.floor((capacity * 0.6) / 8)).map((_, i) => i & 0xff);

    const rgba = new Uint8Array(w * h * 4).fill(128);
    await embedBytesStegoRgba(rgba, w, h, dense, SEED, 1); // as an older writer would

    const back = await extractBytesStegoRgba(rgba, w, h, SEED, dense.length); // default margin
    expect(back, 'a carrier written at margin 1 is no longer readable by default').not.toBeNull();
    expect([...back!]).toEqual([...dense]);

    // And the same density is refused on the way in, so the guard still moved.
    await expect(
      embedBytesStegoRgba(new Uint8Array(w * h * 4).fill(128), w, h, dense, SEED),
    ).rejects.toMatchObject({ name: 'StegoCapacityError' });
  });

  it('refuses a JPEG whose eligible coefficients cannot hold the payload', async () => {
    const jpegBytes = baseJpeg(32, 32);
    const carriers = jpegStegoCapacityBits(jpegBytes);
    expect(carriers).toBeGreaterThan(0);

    const tooBig = new Uint8Array(Math.ceil(carriers / 8) + 16);
    await expect(embedBytesStegoJpeg(jpegBytes, tooBig, SEED)).rejects.toBeInstanceOf(
      StegoCapacityError,
    );
  });

  it('returns null rather than throwing when handed something that is not a JPEG', async () => {
    // The `catch` arm of extractBytesStegoJpeg, distinct from the capacity check
    // below: this one is the decoder failing outright. Extraction is a probe run
    // against arbitrary files, so a stack trace escaping here would both crash
    // the caller and reveal that a search was happening.
    expect(await extractBytesStegoJpeg(new Uint8Array(0), SEED, 16)).toBeNull();
    expect(await extractBytesStegoJpeg(new Uint8Array(64).fill(0xab), SEED, 16)).toBeNull();
    expect(
      await extractBytesStegoJpeg(new TextEncoder().encode('still not a picture'), SEED, 16),
    ).toBeNull();
  });

  it('returns null rather than throwing when extracting more than a JPEG holds', async () => {
    // The asymmetry is deliberate: embedding is a request that can fail loudly,
    // extraction is a probe that must stay quiet, because a wrong guess about a
    // stranger's photo is the normal case.
    const jpegBytes = baseJpeg(32, 32);
    const carriers = jpegStegoCapacityBits(jpegBytes);
    const out = await extractBytesStegoJpeg(jpegBytes, SEED, Math.ceil(carriers / 8) + 16);
    expect(out).toBeNull();
  });
});

describe('the restart-marker fallback refuses too', () => {
  // Restart markers put embedding on a separate path: the in-place toggle trick
  // does not survive them, so the scan is re-encoded whole. That path has its
  // own capacity guard, and the mutation report showed nothing reached either of
  // them. A JPEG with restarts is rare in the wild, which is exactly why the
  // branch could rot unnoticed.
  it('refuses an oversized payload on the re-encode path', async () => {
    const withRestarts = jpegWithRestarts(4, 32, 32);
    const carriers = jpegStegoCapacityBits(withRestarts);
    expect(carriers).toBeGreaterThan(0);

    const tooBig = new Uint8Array(Math.ceil(carriers / 8) + 16);
    await expect(embedBytesStegoJpeg(withRestarts, tooBig, SEED)).rejects.toMatchObject({
      name: 'StegoCapacityError',
    });
  });

  it('refuses a key block when a restart-marked cover is too small for it', async () => {
    // The same fallback, reached from the whitened key-block path rather than the
    // raw-bytes one. Its guard uses minCapacityJpeg (payload * 8 * 2, so 1472
    // carriers for a 92-byte key block) instead of a caller-supplied margin, and
    // it was the last line in the file with no coverage at all.
    const small = jpegWithRestarts(4, 24, 24);
    expect(jpegStegoCapacityBits(small)).toBeLessThan(KEY_BLOCK_LEN * 8 * 2);

    const keyBlock = new Uint8Array(KEY_BLOCK_LEN).fill(3);
    await expect(embedKeyBlockStegoJpeg(small, keyBlock, 'a password', FAST)).rejects.toMatchObject(
      { name: 'StegoCapacityError' },
    );
  });

  it('still round-trips a payload that fits, so the guard is not simply always firing', async () => {
    // Without this the test above would pass on a fallback path that rejected
    // everything, which is the failure it is meant to exclude.
    const withRestarts = jpegWithRestarts(4, 32, 32);
    const payload = new Uint8Array(16).map((_, i) => (i * 37) & 0xff);
    const stego = await embedBytesStegoJpeg(withRestarts, payload, SEED, 4);
    const out = await extractBytesStegoJpeg(stego, SEED, payload.length, 4);
    expect(out).not.toBeNull();
    expect([...out!]).toEqual([...payload]);
  });
});

describe('jpegStegoCapacityBits', () => {
  it('counts the eligible carriers of a decodable baseline JPEG', () => {
    const small = jpegStegoCapacityBits(baseJpeg(32, 32));
    const large = jpegStegoCapacityBits(baseJpeg(64, 64));
    expect(small).toBeGreaterThan(0);
    // Four times the blocks, so materially more carriers. Pinning the ordering
    // rather than a literal keeps this from breaking on an encoder change while
    // still refusing a stub that returns a constant.
    expect(large).toBeGreaterThan(small * 2);
  });

  it('answers 0 for bytes that are not a JPEG at all', () => {
    // The `catch` arm. A capacity probe runs against whatever file the user
    // pointed at, so it must not throw; returning 0 lets the caller say "this
    // picture cannot carry your vault" instead of showing a decoder stack trace.
    expect(jpegStegoCapacityBits(new Uint8Array(0))).toBe(0);
    expect(jpegStegoCapacityBits(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(0);
    expect(jpegStegoCapacityBits(new TextEncoder().encode('not a picture'))).toBe(0);
  });
});
