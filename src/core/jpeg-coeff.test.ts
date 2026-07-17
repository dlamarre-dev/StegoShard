/**
 * Baseline JPEG coefficient codec: decode → coefficients → encode must be a
 * faithful round-trip (re-decoding yields identical coefficients), and the
 * non-baseline / malformed cases must be rejected rather than mis-parsed.
 */

import { describe, it, expect } from 'vitest';
import jpeg from 'jpeg-js';
import { JpegUnsupportedError, decode, encode, eligibleCoefficients, isJpeg } from './jpeg-coeff';

/** A deterministic baseline JPEG (jpeg-js emits 4:4:4 baseline Huffman). */
function makeJpeg(width: number, height: number, quality = 80, seed = 1): Uint8Array {
  const data = Buffer.alloc(width * height * 4);
  let s = seed >>> 0;
  for (let i = 0; i < width * height; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i * 4] = (i * 9) & 0xff;
    data[i * 4 + 1] = (i * 5) & 0xff;
    data[i * 4 + 2] = (s >>> 24) & 0xff;
    data[i * 4 + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data, width, height }, quality).data);
}

function allCoeffs(model: ReturnType<typeof decode>): number[] {
  const out: number[] = [];
  for (const c of model.components) for (const b of c.blocks) out.push(...b);
  return out;
}

describe('baseline JPEG coefficient codec', () => {
  it('decodes then re-encodes to an equivalent baseline JPEG (coefficient identity)', () => {
    const jpg = makeJpeg(64, 48, 85, 7);
    const m1 = allCoeffs(decode(jpg));
    const reencoded = encode(decode(jpg));
    const m2 = allCoeffs(decode(reencoded));
    expect(m2).toEqual(m1); // re-decoding our output yields identical coefficients
    // Non-scan segments are preserved verbatim; size stays close.
    expect(Math.abs(reencoded.length - jpg.length)).toBeLessThan(64);
  });

  it('stays valid: jpeg-js can still decode our re-encoded output to pixels', () => {
    const jpg = makeJpeg(32, 32, 75, 3);
    const reencoded = encode(decode(jpg));
    const px = jpeg.decode(reencoded, { useTArray: true });
    expect(px.width).toBe(32);
    expect(px.height).toBe(32);
  });

  it('round-trips across quality levels and sizes', () => {
    for (const [w, h, q] of [
      [16, 16, 50],
      [40, 24, 92],
      [80, 80, 70],
    ] as const) {
      const jpg = makeJpeg(w, h, q, w + h + q);
      const before = allCoeffs(decode(jpg));
      const after = allCoeffs(decode(encode(decode(jpg))));
      expect(after).toEqual(before);
    }
  });

  it('exposes eligible AC coefficients (|coef| ≥ 2) and edits only their magnitude LSB', () => {
    const model = decode(makeJpeg(64, 64, 88, 11));
    const elig = eligibleCoefficients(model);
    expect(elig.count).toBeGreaterThan(736); // enough carriers for a key block
    // Flipping the LSB keeps |coef| ≥ 2 (same Huffman size category).
    const before = elig.get(0);
    elig.setLsb(0, before ^ 1);
    expect(elig.get(0)).toBe(before ^ 1);
  });

  it('rejects progressive JPEG', () => {
    // Hand-craft a minimal header with SOF2 (progressive) after SOI.
    const b = new Uint8Array([0xff, 0xd8, 0xff, 0xc2, 0x00, 0x02]);
    expect(() => decode(b)).toThrow(JpegUnsupportedError);
  });

  it('rejects non-JPEG bytes', () => {
    expect(isJpeg(new Uint8Array([0x89, 0x50]))).toBe(false);
    expect(() => decode(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow(JpegUnsupportedError);
  });
});
