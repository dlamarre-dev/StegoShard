/**
 * Conservative-profile recompression: image hosts and messaging tools may
 * re-encode uploads as JPEG (luminance-preserving, 4:2:0 chroma). This confirms
 * that profile survives a representative jpeg-js round-trip at typical qualities.
 *
 * It also confirms that a classic LSB does NOT survive JPEG — the reason the
 * (future) "invisible" stego mode is disk-only.
 */

import { describe, it, expect } from 'vitest';
import jpeg from 'jpeg-js';
import { colorGridCodec, qrGridCodec } from '@core';
import { PROFILE_CLOUD } from '@core';
import type { ImageDataLike } from '@core';

/** JPEG round-trip approximating a lossy image-host re-encode at a given quality. */
function recompress(img: ImageDataLike, quality: number): ImageDataLike {
  const encoded = jpeg.encode(
    {
      data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength),
      width: img.width,
      height: img.height,
    },
    quality,
  );
  const decoded = jpeg.decode(encoded.data, { useTArray: true });
  return {
    data: new Uint8ClampedArray(
      decoded.data.buffer,
      decoded.data.byteOffset,
      decoded.data.byteLength,
    ),
    width: decoded.width,
    height: decoded.height,
  };
}

/** Area-average box downscale, matching what a photo service does on resize. */
function downscale(img: ImageDataLike, factor: number): ImageDataLike {
  const w = Math.max(1, Math.round(img.width * factor));
  const h = Math.max(1, Math.round(img.height * factor));
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y0 = Math.floor(y * sy);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4;
          r += img.data[i]!;
          g += img.data[i + 1]!;
          b += img.data[i + 2]!;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

const payload = Uint8Array.from({ length: 900 }, (_, i) => (i * 41 + 7) & 0xff);

// Encoding a full-capacity grid, JPEG round-tripping it and decoding again is
// real work, and it runs alongside the rest of the suite under coverage.
const SLOW = { timeout: 60_000 };

describe('Cloud-profile recompression', () => {
  for (const quality of [92, 85, 75]) {
    it(`Cloud profile survives a JPEG round-trip at quality ${quality}`, SLOW, () => {
      const img = qrGridCodec.encode(payload, PROFILE_CLOUD);
      const recompressed = recompress(img, quality);
      const decoded = qrGridCodec.decode(recompressed);
      expect([...decoded]).toEqual([...payload]);
    });
  }

  // The color grid is the risk case: chroma is the first thing JPEG throws away
  // (4:2:0 subsampling, then coarser quantization than luma). These tests are
  // what gate the Cloud grid parameters in SPEC §2.2 — if they stop passing, the
  // fix is to lower the Cloud capacity or fall back to qr-grid, never to relax
  // the assertion.
  const colorPayload = Uint8Array.from(
    { length: colorGridCodec.capacity(PROFILE_CLOUD) },
    (_, i) => (i * 41 + 7) & 0xff,
  );

  for (const quality of [92, 85, 75]) {
    it(`color grid survives a JPEG round-trip at quality ${quality}`, SLOW, () => {
      const img = colorGridCodec.encode(colorPayload, PROFILE_CLOUD);
      const decoded = colorGridCodec.decode(recompress(img, quality));
      expect([...decoded]).toEqual([...colorPayload]);
    });
  }

  it('a part-full color grid survives JPEG, filler and all', SLOW, () => {
    // Unused capacity is pseudo-random rather than zeroed, so those blocks are
    // now as fragile as data blocks — and they carry CRCs, so a failure eats
    // parity budget. A quarter-full symbol is the case that exercises it.
    const quarter = Uint8Array.from(
      { length: Math.floor(colorGridCodec.capacity(PROFILE_CLOUD) / 4) },
      (_, i) => (i * 13 + 5) & 0xff,
    );
    const img = colorGridCodec.encode(quarter, PROFILE_CLOUD);
    expect([...colorGridCodec.decode(recompress(img, 75))]).toEqual([...quarter]);
  });

  it('color grid survives a downscale then a JPEG round-trip', SLOW, () => {
    // Photo services resize as well as recompress.
    const img = colorGridCodec.encode(colorPayload, PROFILE_CLOUD);
    const shrunk = downscale(img, 0.6);
    const decoded = colorGridCodec.decode(recompress(shrunk, 85));
    expect([...decoded]).toEqual([...colorPayload]);
  });

  it('a classic LSB does not survive JPEG (invisible stego is disk-only)', () => {
    // A flat gray image with a bit pattern in the low bit of each pixel.
    const w = 64;
    const h = 64;
    const data = new Uint8ClampedArray(w * h * 4);
    const bits: number[] = [];
    for (let p = 0; p < w * h; p++) {
      const bit = (p * 2654435761) & 1;
      bits.push(bit);
      const v = 128 | bit; // gray with LSB = bit
      data[p * 4] = v;
      data[p * 4 + 1] = v;
      data[p * 4 + 2] = v;
      data[p * 4 + 3] = 255;
    }
    const out = recompress({ data, width: w, height: h }, 85);
    let preserved = 0;
    for (let p = 0; p < w * h; p++) if ((out.data[p * 4]! & 1) === bits[p]) preserved++;
    const ratio = preserved / (w * h);
    // JPEG scrambles the low bit → ~chance level, nowhere near lossless.
    expect(ratio).toBeLessThan(0.9);
  });
});
