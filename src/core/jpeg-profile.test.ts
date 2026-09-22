/**
 * The encoder profile, asserted on the bytes it emits.
 *
 * The point of pinning a profile is that two builds of StegoShard, on two
 * machines, years apart, write the same file from the same photo. A test that
 * checked `quality: 85` would not notice a library version changing what 85
 * means, nor a refactor that let a subsampling factor drift — and those are
 * exactly the failures that would quietly undo cover uniformity, because every
 * one of them is invisible in the image and loud in the container.
 *
 * So these read the quantization tables, the Huffman tables, the sampling
 * factors and the segment sequence out of the produced file and compare them to
 * the profile. The one test that does not assert bytes asserts the arithmetic
 * behind them: that the fixed-point DCT is scaled the way the tables assume.
 */

import { describe, expect, it } from 'vitest';
import jpeg from 'jpeg-js';
import { decode as decodeCoeff } from './jpeg-coeff';
import { parseJpegSegments } from './jpeg-segments';
import { JpegEncodeError, encodeJpegProfile } from './jpeg-encode';
import {
  HUFF_AC_CHROMA_COUNTS,
  HUFF_AC_CHROMA_VALUES,
  HUFF_AC_LUMA_COUNTS,
  HUFF_AC_LUMA_VALUES,
  HUFF_DC_CHROMA_COUNTS,
  HUFF_DC_CHROMA_VALUES,
  HUFF_DC_LUMA_COUNTS,
  HUFF_DC_LUMA_VALUES,
  PROFILE_QUALITY,
  QUANT_CHROMA,
  QUANT_LUMA,
  ZIGZAG,
} from './jpeg-profile';

/** A deterministic noisy image, textured enough to exercise every code path. */
function noise(width: number, height: number, seed = 1): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  let s = seed >>> 0;
  for (let i = 0; i < width * height; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i * 4] = (s >>> 24) & 0xff;
    data[i * 4 + 1] = (s >>> 16) & 0xff;
    data[i * 4 + 2] = (s >>> 8) & 0xff;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height } as ImageData;
}

/** A flat image of one grey, for the transform-scaling check. */
function flat(width: number, height: number, level: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = level;
    data[i * 4 + 1] = level;
    data[i * 4 + 2] = level;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height } as ImageData;
}

/** The payload bytes of the first segment with this marker. */
function segment(file: Uint8Array, marker: number): Uint8Array {
  const seg = parseJpegSegments(file).segments.find((s) => s.marker === marker);
  if (!seg) throw new Error(`no segment 0x${marker.toString(16)}`);
  return file.subarray(seg.payloadStart, seg.end);
}

describe('the emitted profile', () => {
  const file = encodeJpegProfile(noise(64, 48));

  it('writes the segments the profile allows, in order, and nothing else', () => {
    const markers = parseJpegSegments(file).segments.map((s) => s.marker);
    // APP0, DQT, SOF0, DHT, SOS. No APP1 (EXIF), no APP2 (ICC/MPF), no APP11
    // (JUMBF), no COM, no DRI.
    expect(markers).toEqual([0xe0, 0xdb, 0xc0, 0xc4, 0xda]);
    expect(file[0]).toBe(0xff);
    expect(file[1]).toBe(0xd8); // SOI
    expect([...file.subarray(file.length - 2)]).toEqual([0xff, 0xd9]); // EOI
    // Nothing after EOI: no gain map, no motion photo, no stray bytes.
    expect(parseJpegSegments(file).trailerStart).toBe(file.length);
  });

  it('writes both quantization tables verbatim', () => {
    const dqt = segment(file, 0xdb);
    expect(dqt[0]).toBe(0x00); // 8-bit precision, table id 0
    expect([...dqt.subarray(1, 65)]).toEqual([...QUANT_LUMA]);
    expect(dqt[65]).toBe(0x01); // 8-bit precision, table id 1
    expect([...dqt.subarray(66, 130)]).toEqual([...QUANT_CHROMA]);
    expect(dqt.length).toBe(130);
  });

  it('writes the four standard Huffman tables verbatim', () => {
    const dht = segment(file, 0xc4);
    const expected = [
      [0x00, HUFF_DC_LUMA_COUNTS, HUFF_DC_LUMA_VALUES],
      [0x10, HUFF_AC_LUMA_COUNTS, HUFF_AC_LUMA_VALUES],
      [0x01, HUFF_DC_CHROMA_COUNTS, HUFF_DC_CHROMA_VALUES],
      [0x11, HUFF_AC_CHROMA_COUNTS, HUFF_AC_CHROMA_VALUES],
    ] as const;
    let at = 0;
    for (const [id, counts, values] of expected) {
      expect(dht[at]).toBe(id);
      expect([...dht.subarray(at + 1, at + 1 + 16)]).toEqual([...counts]);
      at += 1 + 16;
      expect([...dht.subarray(at, at + values.length)]).toEqual([...values]);
      at += values.length;
    }
    expect(at).toBe(dht.length);
  });

  it('declares baseline 8-bit 4:2:0 with the two quantization tables', () => {
    const sof = segment(file, 0xc0);
    expect(sof[0]).toBe(8); // sample precision
    expect((sof[1]! << 8) | sof[2]!).toBe(48); // height
    expect((sof[3]! << 8) | sof[4]!).toBe(64); // width
    expect(sof[5]).toBe(3); // components
    // Y: id 1, 2x2 sampling, quant table 0. Cb/Cr: 1x1, quant table 1.
    expect([...sof.subarray(6, 15)]).toEqual([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  });

  it('writes a JFIF APP0 that identifies nothing', () => {
    const app0 = segment(file, 0xe0);
    expect([...app0.subarray(0, 5)]).toEqual([0x4a, 0x46, 0x49, 0x46, 0x00]); // "JFIF\0"
    expect([...app0.subarray(5, 7)]).toEqual([1, 1]); // version 1.1
    expect(app0[7]).toBe(0); // units: aspect ratio only, no physical density
    expect([...app0.subarray(8, 12)]).toEqual([0, 1, 0, 1]); // 1:1
    expect([...app0.subarray(12, 14)]).toEqual([0, 0]); // no thumbnail
  });

  /**
   * The literals are the contract, but a table nobody can re-derive is a table
   * nobody can review. This re-runs the documented derivation and compares.
   */
  it('carries the Annex K tables scaled by the documented formula', () => {
    const YQT = [
      16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69,
      56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104,
      113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
    ];
    const sf =
      PROFILE_QUALITY < 50 ? Math.floor(5000 / PROFILE_QUALITY) : 200 - PROFILE_QUALITY * 2;
    const scale = (t: number) => Math.min(255, Math.max(1, Math.floor((t * sf + 50) / 100)));
    // Zig-zag order, which is both the DQT wire order and how blocks are indexed.
    expect([...QUANT_LUMA]).toEqual(ZIGZAG.map((i) => scale(YQT[i]!)));
    // The coarseness that sets the ceiling: finer than a source's table combs it.
    expect(QUANT_LUMA.reduce((a, b) => a + b, 0)).toBe(1109);
  });
});

describe('the encoder', () => {
  it('produces a file our own decoder reads as 4:2:0 baseline', () => {
    const model = decodeCoeff(encodeJpegProfile(noise(64, 48)));
    expect([model.width, model.height]).toEqual([64, 48]);
    expect(model.components.map((c) => `${c.h}x${c.v}`)).toEqual(['2x2', '1x1', '1x1']);
    expect(model.restartInterval).toBe(0);
  });

  it('produces a file a third-party decoder reads at the same size', () => {
    // Our decoder and our encoder agreeing proves only that they agree.
    const out = encodeJpegProfile(noise(64, 48));
    const back = jpeg.decode(out, { useTArray: true, formatAsRGBA: true });
    expect([back.width, back.height]).toEqual([64, 48]);
  });

  it('keeps dimensions that are not whole MCUs', () => {
    // 4:2:0 codes 16x16 MCUs, so 30x18 is padded to 32x32 and cropped back by
    // SOF0. A padding bug shows up as a decoder reporting the padded size.
    const out = encodeJpegProfile(noise(30, 18));
    expect([decodeCoeff(out).width, decodeCoeff(out).height]).toEqual([30, 18]);
    const back = jpeg.decode(out, { useTArray: true, formatAsRGBA: true });
    expect([back.width, back.height]).toEqual([30, 18]);
  });

  it('is deterministic, which is what lets two builds agree', () => {
    const img = noise(64, 48, 9);
    expect([...encodeJpegProfile(img)]).toEqual([...encodeJpegProfile(img)]);
  });

  /**
   * The fixed-point DCT is scaled so a flat block of value A gives a DC of
   * exactly 8A, which is what the quantization tables assume. Checked through
   * the file rather than by calling the transform: a flat mid-grey must come
   * back as that grey, and its AC coefficients must all be zero.
   */
  it('transforms a flat image to DC only, at the scale the tables expect', () => {
    const level = 200;
    const model = decodeCoeff(encodeJpegProfile(flat(64, 48, level)));
    const luma = model.components[0]!;
    for (const block of luma.blocks) {
      expect([...block.subarray(1)].every((c) => c === 0)).toBe(true);
    }
    // DC = 8 * (level - 128) / q[0], quantized. q[0] is the first luma entry.
    const expected = Math.round((8 * (level - 128)) / QUANT_LUMA[0]!);
    expect(luma.blocks[0]![0]).toBe(expected);
    const back = jpeg.decode(encodeJpegProfile(flat(64, 48, level)), {
      useTArray: true,
      formatAsRGBA: true,
    });
    expect(Math.abs(back.data[0]! - level)).toBeLessThanOrEqual(2);
  });

  it('refuses what it cannot encode', () => {
    const img = noise(8, 8);
    expect(() => encodeJpegProfile({ ...img, width: 0 })).toThrow(JpegEncodeError);
    expect(() => encodeJpegProfile({ ...img, width: 1.5 })).toThrow(/positive integers/);
    expect(() => encodeJpegProfile({ ...img, width: 20000, height: 20000 })).toThrow(/ceiling/);
    // A buffer shorter than the dimensions claim would otherwise read undefined.
    expect(() => encodeJpegProfile({ ...img, width: 64, height: 64 })).toThrow(/RGBA buffer/);
  });
});
