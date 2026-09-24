/**
 * Pixels to a baseline JPEG, in the one profile every normalized cover wears.
 *
 * WHY THIS EXISTS RATHER THAN A LIBRARY CALL
 * Cover normalization used to be segment surgery: remove the provenance manifest,
 * leave everything else. That leaves the maker's quantization tables, its ICC
 * profile, its makernote and its XMP dialect in place, and a set of photos from
 * three different devices stays three different kinds of file. The answer is to
 * re-encode every cover identically, which needs an encoder whose every axis is
 * pinned by us (see `jpeg-profile.ts`).
 *
 * No library reachable from all four targets can do that. `jpeg-js` hardcodes
 * 4:4:4 in its SOF0 and always writes a JFIF APP0, and it is bundled only in the
 * CLI and library builds — the web app and the extension carry no JS image codec
 * at all. `canvas.convertToBlob({type:'image/jpeg'})` exists everywhere in the
 * browser and is pinnable on no axis whatsoever: tables, subsampling and APP0 all
 * vary by browser, OS and GPU, which is the opposite of the property wanted here.
 *
 * DETERMINISM
 * Every arithmetic step is integer. The forward DCT runs on a fixed-point cosine
 * table written out below rather than computed from `Math.cos`, whose last bits
 * are implementation-defined in ECMAScript: two engines could round a coefficient
 * differently and produce two different files from one photo, which would defeat
 * a profile whose whole purpose is that files agree. Same reasoning as the
 * integer-only rule in `jpeg-coeff.ts`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * No resizing: the output has the input's dimensions. Imitating a particular
 * service's pipeline would be a partial imitation, which is worse than being
 * generic, and those pipelines change. The target is the most ordinary JPEG
 * possible, not a recognisable one.
 */

import { BitWriter, buildHuff, encodeBlock } from './jpeg-coeff';
import { type JpegLayout, lumaQuantSum, parseJpegSegments } from './jpeg-segments';
import type { ImageDataLike } from './codec/types';
import {
  HUFF_AC_CHROMA_COUNTS,
  HUFF_AC_CHROMA_VALUES,
  HUFF_AC_LUMA_COUNTS,
  HUFF_AC_LUMA_VALUES,
  HUFF_DC_CHROMA_COUNTS,
  HUFF_DC_CHROMA_VALUES,
  HUFF_DC_LUMA_COUNTS,
  HUFF_DC_LUMA_VALUES,
  QUANT_CHROMA,
  QUANT_LUMA,
} from './jpeg-profile';

/** Thrown when pixels cannot be encoded into the profile. */
export class JpegEncodeError extends Error {
  constructor(reason: string) {
    super(`cannot encode JPEG: ${reason}`);
    this.name = 'JpegEncodeError';
  }
}

/**
 * Fixed-point forward-DCT basis, `T[u][x]`, at 13 fractional bits.
 *
 *     T[u][x] = round(2^13 · c(u)/2 · cos((2x+1)·u·π/16)),  c(0)=1/√2, else 1
 *
 * Written out rather than computed so the transform cannot drift with an
 * engine's `Math.cos`. Two passes of this table over a block give the standard
 * DCT-II scaled by 8, which is what the quantization tables expect: a flat block
 * of value A yields a DC of exactly 8A, and the test asserts that.
 */
const DCT_COS: readonly (readonly number[])[] = [
  [2896, 2896, 2896, 2896, 2896, 2896, 2896, 2896],
  [4017, 3406, 2276, 799, -799, -2276, -3406, -4017],
  [3784, 1567, -1567, -3784, -3784, -1567, 1567, 3784],
  [3406, -799, -4017, -2276, 2276, 4017, 799, -3406],
  [2896, -2896, -2896, 2896, 2896, -2896, -2896, 2896],
  [2276, -4017, 799, 3406, -3406, -799, 4017, -2276],
  [1567, -3784, 3784, -1567, -1567, 3784, -3784, 1567],
  [799, -2276, 3406, -4017, 4017, -3406, 2276, -799],
];
const DCT_BITS = 13;
const DCT_ROUND = 1 << (DCT_BITS - 1);

/** 4:2:0: one chroma sample per 2x2 luma, so an MCU is 16x16 pixels. */
const MCU = 16;

/**
 * Ceiling on pixels, so a hostile size cannot ask for an unbounded allocation.
 * The decoder in `jpeg-coeff.ts` refuses past the same value; keep them equal,
 * or a photo written here could not be read back.
 */
const MAX_PIXELS = 100_000_000;

/**
 * SOF0 stores each dimension in 16 bits. A wider or taller image fits under the
 * pixel ceiling (a 70000x100 strip is 7 megapixels) and would have its size
 * truncated by the frame header, producing a JPEG that decodes as something else.
 */
const MAX_SIDE = 0xffff;

/**
 * Re-encode `img` into the pinned profile.
 *
 * The output is baseline sequential, 4:2:0, with the profile's quantization and
 * Huffman tables, a JFIF APP0 carrying an aspect-ratio density and no thumbnail,
 * no restart interval, and no other segment of any kind: no EXIF, no XMP, no ICC,
 * no MPF, nothing after EOI. Whatever the input carried, the output carries none
 * of it, which is the point.
 */
export function encodeJpegProfile(img: ImageDataLike): Uint8Array {
  const { width, height } = img;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new JpegEncodeError(`dimensions must be positive integers, got ${width}x${height}`);
  }
  if (width > MAX_SIDE || height > MAX_SIDE) {
    throw new JpegEncodeError(`${width}x${height} is past JPEG's ${MAX_SIDE}-pixel side limit`);
  }
  if (width * height > MAX_PIXELS) {
    throw new JpegEncodeError(`${width}x${height} is past the ${MAX_PIXELS}-pixel ceiling`);
  }
  if (img.data.length < width * height * 4) {
    throw new JpegEncodeError(
      `RGBA buffer holds ${img.data.length} bytes, need ${width * height * 4}`,
    );
  }

  // Padded to whole MCUs by replicating the edge pixel: the padding is never
  // displayed (SOF0 carries the true size), and replication keeps the invented
  // blocks smooth, which costs fewer bits than zeros and invents no edge.
  const paddedW = Math.ceil(width / MCU) * MCU;
  const paddedH = Math.ceil(height / MCU) * MCU;
  const { y: luma, cb, cr } = toYCbCr(img, paddedW, paddedH);
  const cbHalf = downsample(cb, paddedW, paddedH);
  const crHalf = downsample(cr, paddedW, paddedH);

  const dcLuma = buildHuff([...HUFF_DC_LUMA_COUNTS], [...HUFF_DC_LUMA_VALUES]);
  const acLuma = buildHuff([...HUFF_AC_LUMA_COUNTS], [...HUFF_AC_LUMA_VALUES]);
  const dcChroma = buildHuff([...HUFF_DC_CHROMA_COUNTS], [...HUFF_DC_CHROMA_VALUES]);
  const acChroma = buildHuff([...HUFF_AC_CHROMA_COUNTS], [...HUFF_AC_CHROMA_VALUES]);

  const bw = new BitWriter();
  const pred = [0, 0, 0];
  const block = new Int16Array(64);
  const halfW = paddedW / 2;
  for (let my = 0; my < paddedH / MCU; my++) {
    for (let mx = 0; mx < paddedW / MCU; mx++) {
      // Four luma blocks, in the interleaved order SOF0 declares.
      for (let by = 0; by < 2; by++) {
        for (let bx = 0; bx < 2; bx++) {
          forwardBlock(luma, paddedW, mx * MCU + bx * 8, my * MCU + by * 8, QUANT_LUMA, block);
          encodeBlock(bw, block, dcLuma, acLuma, pred, 0);
        }
      }
      forwardBlock(cbHalf, halfW, mx * 8, my * 8, QUANT_CHROMA, block);
      encodeBlock(bw, block, dcChroma, acChroma, pred, 1);
      forwardBlock(crHalf, halfW, mx * 8, my * 8, QUANT_CHROMA, block);
      encodeBlock(bw, block, dcChroma, acChroma, pred, 2);
    }
  }
  bw.align();

  return assemble(width, height, Uint8Array.from(bw.bytes()));
}

/** Coarseness of the profile itself: what every source is compared against. */
export const PROFILE_QUANT_SUM = QUANT_LUMA.reduce((a, b) => a + b, 0);

/**
 * Re-encode one cover into the profile, refusing the sources it would betray.
 *
 * `source` is the file the pixels came from, and it is read for one number: how
 * coarsely it was quantized. Re-quantizing **finer** than the source leaves empty
 * bins in the coefficient histogram, the comb a first-order detector looks for,
 * and it is the failure mode of a photo that has already been through a
 * messaging app — those recompress at a coarseness this profile sits under.
 * Measured on the repository's own camera photographs: four quantize at 437 and
 * one at 864, against this profile's 1109, so all five are safe;
 * quality 90 would sum to 736 and comb the fifth.
 *
 * Refused rather than warned about, and refused from the source alone, before any
 * work: the photo is named so the user knows which one to drop. A cover that
 * would arrive with a detectable artifact is not a cover, which is the same rule
 * the complexity filter applies to texture.
 *
 * `source` is omitted for pixels that never were a JPEG (a PNG cover): with no
 * table to compare against there is no comb to create, and the re-encode goes
 * ahead. A `source` that *is* given but whose luma table cannot be read (a
 * truncated file jpeg-js still decodes, or one that files luma under another
 * table id) is refused: "cannot measure" is not "nothing to measure", and the
 * refusal is the only safe answer to a question this cannot ask.
 *
 * A source already in the profile is returned unchanged. Re-encoding it could
 * only lose a generation, and it is the one case where the input matters beyond
 * its pixels: a delivered gallery photo is exactly such a file, its payload lives
 * in the coefficients a re-encode would rewrite, and a library caller loading a
 * delivered set with the default options would otherwise wipe what restore is
 * about to read. Passing it through keeps that call working and costs no
 * uniformity, since the bytes already are the profile.
 */
export function reencodeCover(
  pixels: ImageDataLike,
  source?: Uint8Array,
  label?: string,
): Uint8Array {
  const named = label ? `${label}: ` : '';
  if (source) {
    if (isProfileJpeg(source)) return source;
    const coarseness = lumaQuantSum(source);
    if (coarseness === null) {
      throw new JpegEncodeError(
        `${named}its quantization table could not be read, so there is no telling whether ` +
          're-encoding it would leave a double-quantization comb in the histogram. The file ' +
          'may be truncated; use the original if you still have it.',
      );
    }
    if (coarseness > PROFILE_QUANT_SUM) {
      throw new JpegEncodeError(
        `${named}the source was quantized more coarsely than this profile ` +
          `(${coarseness} against ${PROFILE_QUANT_SUM}), so re-encoding it would leave a ` +
          'double-quantization comb in the histogram. It has probably been through a ' +
          'messaging app or another re-encode; use the original if you still have it.',
      );
    }
  }
  return encodeJpegProfile(pixels);
}

/**
 * True when `bytes` is, header byte for byte, a file `encodeJpegProfile` wrote.
 *
 * Stricter than `profileMismatch`, deliberately: that one reports on uniformity,
 * this one decides that a file skips the re-encode, so it compares everything
 * before the scan against the header the encoder would write for those
 * dimensions. A JFIF thumbnail, a different chroma or Huffman table, or a byte
 * after EOI all fail it, and such a file is re-encoded like any other.
 */
export function isProfileJpeg(bytes: Uint8Array): boolean {
  if (profileMismatch(bytes) !== null) return false;
  const sof = parseJpegSegments(bytes).segments[2]!.payloadStart;
  const height = (bytes[sof + 1]! << 8) | bytes[sof + 2]!;
  const width = (bytes[sof + 3]! << 8) | bytes[sof + 4]!;
  if (width < 1 || height < 1) return false;
  const header = assemble(width, height, new Uint8Array(0));
  const headLen = header.length - 2; // everything but the EOI
  if (bytes.length < headLen) return false;
  for (let i = 0; i < headLen; i++) if (bytes[i] !== header[i]) return false;
  return true;
}

/**
 * Why these bytes are not a file this profile produced, or null when they are.
 *
 * The re-encode itself happens where the pixels are, which is the image adapter
 * on each surface, so this is the check rather than the enforcement: it is what
 * the tests hold the four surfaces to, and what a library consumer assembling
 * `GalleryCover` objects by hand can call to see whether their set has the
 * uniformity the feature is for.
 *
 * `galleryEncode` deliberately does **not** call it. A raster cover is a
 * legitimate input to the core (SPEC §9 has always taken one), and the
 * container-preserving mode exists precisely to hand it covers that are not in
 * the profile, so a refusal here would be the core overriding a decision the
 * caller is entitled to make. The uniformity rule is stated normatively in
 * SPEC §9.8 and kept by the adapters, which is where the pixels and the mode
 * both are.
 *
 * Structural, and cheap: the quantization table, the segment sequence, the
 * sampling factors and the absence of a trailer are all readable without
 * touching the entropy-coded scan.
 */
export function profileMismatch(bytes: Uint8Array): string | null {
  let layout: JpegLayout;
  try {
    layout = parseJpegSegments(bytes);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (layout.trailerStart < bytes.length) {
    return `${bytes.length - layout.trailerStart} bytes follow EOI`;
  }
  const markers = layout.segments.map((s) => s.marker);
  const wanted = [0xe0, 0xdb, 0xc0, 0xc4, 0xda];
  if (markers.length !== wanted.length || markers.some((m, i) => m !== wanted[i])) {
    const seen = markers.map((m) => `0x${m.toString(16)}`).join(' ');
    return `segments are ${seen}, not the profile's APP0 DQT SOF0 DHT SOS`;
  }
  const quant = lumaQuantSum(bytes);
  if (quant !== PROFILE_QUANT_SUM) {
    return `luma quantization sums to ${quant}, not the profile's ${PROFILE_QUANT_SUM}`;
  }
  // SOF0 payload: precision, height, width, component count, then (id, HV, tq).
  const sof = layout.segments[2]!;
  const at = sof.payloadStart;
  if (bytes[at + 5] !== 3) return `${bytes[at + 5]} components, not 3`;
  const sampling = [bytes[at + 7], bytes[at + 10], bytes[at + 13]];
  if (sampling[0] !== 0x22 || sampling[1] !== 0x11 || sampling[2] !== 0x11) {
    return `sampling factors ${sampling.map((s) => s?.toString(16)).join('/')}, not 4:2:0`;
  }
  return null;
}

/**
 * RGB to YCbCr (ITU-R BT.601, the JPEG transform), level-shifted by -128 and
 * padded to whole MCUs.
 *
 * Fixed point at 16 bits, the coefficients libjpeg uses, so no float enters the
 * pipeline. The alpha channel is discarded rather than composited: a cover with
 * transparency is a PNG being converted, and compositing it onto an invented
 * background would be this module choosing a colour nobody asked for.
 */
function toYCbCr(
  img: ImageDataLike,
  paddedW: number,
  paddedH: number,
): { y: Int16Array; cb: Int16Array; cr: Int16Array } {
  const y = new Int16Array(paddedW * paddedH);
  const cb = new Int16Array(paddedW * paddedH);
  const cr = new Int16Array(paddedW * paddedH);
  for (let row = 0; row < paddedH; row++) {
    const srcRow = Math.min(row, img.height - 1);
    for (let col = 0; col < paddedW; col++) {
      const srcCol = Math.min(col, img.width - 1);
      const p = (srcRow * img.width + srcCol) * 4;
      const r = img.data[p]!;
      const g = img.data[p + 1]!;
      const b = img.data[p + 2]!;
      const at = row * paddedW + col;
      y[at] = ((19595 * r + 38470 * g + 7471 * b + 32768) >> 16) - 128;
      cb[at] = (-11056 * r - 21712 * g + 32768 * b + 8388608) >> 16;
      cr[at] = (32768 * r - 27440 * g - 5328 * b + 8388608) >> 16;
    }
  }
  // The chroma planes still carry the +128 offset from the transform above;
  // level-shift them the same way luma already is.
  for (let i = 0; i < cb.length; i++) {
    cb[i] = cb[i]! - 128;
    cr[i] = cr[i]! - 128;
  }
  return { y, cb, cr };
}

/** Box-average each 2x2 to one sample: the 4:2:0 chroma plane. */
function downsample(plane: Int16Array, w: number, h: number): Int16Array {
  const outW = w / 2;
  const out = new Int16Array(outW * (h / 2));
  for (let row = 0; row < h; row += 2) {
    for (let col = 0; col < w; col += 2) {
      const a = plane[row * w + col]!;
      const b = plane[row * w + col + 1]!;
      const c = plane[(row + 1) * w + col]!;
      const d = plane[(row + 1) * w + col + 1]!;
      // Round half away from zero, so the transform is symmetric about 0 and a
      // flat plane survives the round trip unchanged.
      const sum = a + b + c + d;
      out[(row / 2) * outW + col / 2] = sum >= 0 ? (sum + 2) >> 2 : -((-sum + 2) >> 2);
    }
  }
  return out;
}

/**
 * One 8x8 block: forward DCT, quantize, and leave the result in zig-zag order.
 *
 * Zig-zag is the order the DQT segment is written in *and* the order
 * `jpeg-coeff`'s decoder indexes coefficients by, so the quantization tables are
 * stored that way too and no permutation happens anywhere in this file.
 */
function forwardBlock(
  plane: Int16Array,
  stride: number,
  x0: number,
  y0: number,
  quant: readonly number[],
  out: Int16Array,
): void {
  // Pass 1: rows into a frequency-by-row intermediate.
  const tmp = new Int32Array(64);
  for (let u = 0; u < 8; u++) {
    const basis = DCT_COS[u]!;
    for (let row = 0; row < 8; row++) {
      let sum = 0;
      const at = (y0 + row) * stride + x0;
      for (let x = 0; x < 8; x++) sum += plane[at + x]! * basis[x]!;
      tmp[u * 8 + row] = (sum + DCT_ROUND) >> DCT_BITS;
    }
  }
  // Pass 2: columns, quantizing straight into the zig-zag slot.
  for (let v = 0; v < 8; v++) {
    const basis = DCT_COS[v]!;
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let row = 0; row < 8; row++) sum += tmp[u * 8 + row]! * basis[row]!;
      const coef = (sum + DCT_ROUND) >> DCT_BITS;
      const zz = ZIGZAG_OF[v * 8 + u]!;
      const q = quant[zz]!;
      // Round half away from zero: the symmetric rule, so a negative coefficient
      // is quantized exactly as its positive mirror would be.
      out[zz] = coef >= 0 ? Math.round(coef / q) : -Math.round(-coef / q);
    }
  }
}

/** Natural position (v·8+u) to zig-zag index, the inverse of the profile's table. */
const ZIGZAG_OF: readonly number[] = (() => {
  const zigzag = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
    13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59,
    52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
  ];
  const inverse = new Array<number>(64);
  for (let i = 0; i < 64; i++) inverse[zigzag[i]!] = i;
  return inverse;
})();

/** Frame the segments around the scan, in the one order the profile allows. */
function assemble(width: number, height: number, scan: Uint8Array): Uint8Array {
  const out: number[] = [];
  const u8 = (v: number) => out.push(v & 0xff);
  const u16 = (v: number) => out.push((v >> 8) & 0xff, v & 0xff);
  const marker = (m: number) => out.push(0xff, m);

  marker(0xd8); // SOI

  // APP0/JFIF. Kept, not dropped: a baseline JPEG without one is the unusual
  // case, and this one carries nothing identifying — version 1.1, aspect-ratio
  // units, 1:1 density, no thumbnail.
  marker(0xe0);
  u16(16);
  for (const c of 'JFIF') u8(c.charCodeAt(0));
  u8(0);
  u8(1);
  u8(1); // version 1.1
  u8(0); // units: aspect ratio only
  u16(1);
  u16(1); // density
  u8(0);
  u8(0); // no thumbnail

  // DQT, both tables in one segment.
  marker(0xdb);
  u16(2 + 2 * 65);
  u8(0x00); // 8-bit precision, table 0
  for (const q of QUANT_LUMA) u8(q);
  u8(0x01); // 8-bit precision, table 1
  for (const q of QUANT_CHROMA) u8(q);

  // SOF0: baseline, 8-bit, three components, 4:2:0 sampling.
  marker(0xc0);
  u16(8 + 3 * 3);
  u8(8);
  u16(height);
  u16(width);
  u8(3);
  u8(1);
  u8(0x22);
  u8(0); // Y, 2x2, quant table 0
  u8(2);
  u8(0x11);
  u8(1); // Cb, 1x1, quant table 1
  u8(3);
  u8(0x11);
  u8(1); // Cr, 1x1, quant table 1

  // DHT, all four tables in one segment.
  const tables: [number, readonly number[], readonly number[]][] = [
    [0x00, HUFF_DC_LUMA_COUNTS, HUFF_DC_LUMA_VALUES],
    [0x10, HUFF_AC_LUMA_COUNTS, HUFF_AC_LUMA_VALUES],
    [0x01, HUFF_DC_CHROMA_COUNTS, HUFF_DC_CHROMA_VALUES],
    [0x11, HUFF_AC_CHROMA_COUNTS, HUFF_AC_CHROMA_VALUES],
  ];
  marker(0xc4);
  u16(2 + tables.reduce((n, [, counts, values]) => n + 1 + counts.length + values.length, 0));
  for (const [id, counts, values] of tables) {
    u8(id);
    for (const c of counts) u8(c);
    for (const v of values) u8(v);
  }

  // SOS: baseline spectral selection, no successive approximation.
  marker(0xda);
  u16(6 + 2 * 3);
  u8(3);
  u8(1);
  u8(0x00); // Y uses DC 0 / AC 0
  u8(2);
  u8(0x11); // Cb uses DC 1 / AC 1
  u8(3);
  u8(0x11); // Cr uses DC 1 / AC 1
  u8(0);
  u8(63);
  u8(0);

  const head = Uint8Array.from(out);
  const file = new Uint8Array(head.length + scan.length + 2);
  file.set(head, 0);
  file.set(scan, head.length);
  file[head.length + scan.length] = 0xff;
  file[head.length + scan.length + 1] = 0xd9; // EOI
  return file;
}
