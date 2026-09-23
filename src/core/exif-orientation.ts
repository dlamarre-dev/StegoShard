/**
 * EXIF Orientation: read the tag, and apply it to decoded pixels.
 *
 * A phone stores a portrait photo as landscape sensor data plus a tag saying
 * "rotate me". Every browser applies that tag when it decodes (`createImageBitmap`
 * defaults to `imageOrientation: 'from-image'`); jpeg-js, which decodes for the
 * CLI and the Node library, does not. Before a cover is re-encoded that
 * difference is invisible. After, it is not: the profile writes no EXIF, so the
 * tag is gone and the pixels are all that is left, and a portrait delivered
 * from the CLI arrived sideways while the same photo from the web app did not.
 * A set with sideways photos in it is a set someone looks at twice.
 *
 * Fail soft, unlike the GPS scrub: a tag that cannot be read means the photo is
 * shown as stored, which is what every viewer does with it too.
 */

import type { ImageDataLike } from './codec/types';
import { parseJpegSegments, payloadStartsWith } from './jpeg-segments';

/** `Exif\0\0`: the APP1 payload prefix that introduces a TIFF block. */
const P_EXIF = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];

/** The Orientation tag, in IFD0. */
const TAG_ORIENTATION = 0x0112;

/**
 * The EXIF Orientation of a JPEG, 1 through 8, or 1 when there is none.
 *
 * 1 is "as stored". Anything unreadable, out of range, or absent reads as 1.
 */
export function exifOrientation(bytes: Uint8Array): number {
  try {
    const layout = parseJpegSegments(bytes);
    for (const seg of layout.segments) {
      if (seg.marker !== 0xe1 || !payloadStartsWith(bytes, seg, P_EXIF)) continue;
      const tiff = bytes.subarray(seg.payloadStart + P_EXIF.length, seg.end);
      if (tiff.length < 8) continue;
      const le = tiff[0] === 0x49 && tiff[1] === 0x49;
      if (!le && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) continue;
      const u16 = (o: number): number =>
        le ? tiff[o]! | (tiff[o + 1]! << 8) : (tiff[o]! << 8) | tiff[o + 1]!;
      const u32 = (o: number): number =>
        (le
          ? tiff[o]! | (tiff[o + 1]! << 8) | (tiff[o + 2]! << 16) | (tiff[o + 3]! << 24)
          : (tiff[o]! << 24) | (tiff[o + 1]! << 16) | (tiff[o + 2]! << 8) | tiff[o + 3]!) >>> 0;
      const ifd = u32(4);
      if (ifd < 8 || ifd + 2 > tiff.length) continue;
      const count = u16(ifd);
      for (let i = 0; i < count; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > tiff.length) break;
        // SHORT, one value, inlined in the first two bytes of the value field.
        if (u16(e) !== TAG_ORIENTATION || u16(e + 2) !== 3) continue;
        const v = u16(e + 8);
        return v >= 1 && v <= 8 ? v : 1;
      }
    }
  } catch {
    // Not a parseable JPEG: shown as stored.
  }
  return 1;
}

/**
 * Apply an EXIF orientation to `img`, returning the upright image.
 *
 * Orientations 5 through 8 swap width and height. 1, and anything out of range,
 * returns `img` itself. Integer-only, and a pure permutation of pixels, so no
 * sample changes value.
 */
export function orientImage(img: ImageDataLike, orientation: number): ImageDataLike {
  if (orientation < 2 || orientation > 8) return img;
  const { width: w, height: h } = img;
  const swap = orientation >= 5;
  const ow = swap ? h : w;
  const oh = swap ? w : h;
  const out = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Where the stored pixel (x, y) lands in the upright image.
      let dx: number;
      let dy: number;
      switch (orientation) {
        case 2: // mirrored horizontally
          dx = w - 1 - x;
          dy = y;
          break;
        case 3: // rotated 180
          dx = w - 1 - x;
          dy = h - 1 - y;
          break;
        case 4: // mirrored vertically
          dx = x;
          dy = h - 1 - y;
          break;
        case 5: // transposed
          dx = y;
          dy = x;
          break;
        case 6: // stored rotated 90 counter-clockwise: turn it clockwise
          dx = h - 1 - y;
          dy = x;
          break;
        case 7: // transversed
          dx = h - 1 - y;
          dy = w - 1 - x;
          break;
        default: // 8: stored rotated 90 clockwise: turn it counter-clockwise
          dx = y;
          dy = w - 1 - x;
          break;
      }
      const s = (y * w + x) * 4;
      const d = (dy * ow + dx) * 4;
      out[d] = img.data[s]!;
      out[d + 1] = img.data[s + 1]!;
      out[d + 2] = img.data[s + 2]!;
      out[d + 3] = img.data[s + 3]!;
    }
  }
  return { data: out, width: ow, height: oh };
}
