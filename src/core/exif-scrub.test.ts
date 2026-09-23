/**
 * The GPS scrub, on its own.
 *
 * It is the one metadata removal that runs on a container StegoShard is not
 * re-encoding, so the properties it owes are unusually tight: the coordinate has
 * to leave the *bytes*, everything else has to stay exactly where it was, and the
 * file has to keep its length so that no absolute offset anywhere in the TIFF
 * block, or inside a maker note this code will not parse, is quietly invalidated.
 *
 * Fixtures are synthetic, for the reason `jpeg-fixtures.ts` gives: a real camera
 * original would carry the maintainer's coordinates into a public git history,
 * which is the thing this feature exists to prevent.
 */

import { describe, it, expect } from 'vitest';
import { decode as decodeCoeff } from './jpeg-coeff';
import { ExifScrubError, hasGps, scrubGps } from './exif-scrub';
import { parseJpegSegments } from './jpeg-segments';
import { inspectJpegCover } from './normalize';
import {
  GPS_FIXTURE_RATIONALS,
  appSegment,
  baseJpeg,
  exifSegment,
  exifSegmentWithGps,
  gainMapTrailer,
  iccSegment,
  spliceBeforeSos,
  withTrailer,
} from './jpeg-fixtures';

/** The latitude value as it sits in the file: three big-endian RATIONALs. */
function coordinateBytes(littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(24);
  GPS_FIXTURE_RATIONALS.forEach((v, i) => {
    const b = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    out.set(littleEndian ? b.reverse() : b, i * 4);
  });
  return out;
}

/** True when `needle` appears anywhere in `hay`. */
function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}

describe.each([
  ['big-endian', false],
  ['little-endian', true],
])('scrubbing a %s EXIF block', (_label, le) => {
  const photo = spliceBeforeSos(baseJpeg(64, 64), exifSegmentWithGps(le));

  it('removes the block a reader would follow', () => {
    expect(hasGps(photo), 'the fixture should carry GPS to begin with').toBe(true);
    const { bytes, removed } = scrubGps(photo);
    expect(removed).toBe(true);
    expect(hasGps(bytes)).toBe(false);
    expect(inspectJpegCover(bytes).exif?.gps).toBe(false);
  });

  // The assertion that separates removal from concealment. Dropping the pointer
  // alone would pass every test above and leave the coordinate legible to anyone
  // reading the file with their eyes.
  it('removes the coordinate from the bytes, not just from the index', () => {
    const coord = coordinateBytes(le);
    expect(contains(photo, coord), 'the fixture should hold the coordinate').toBe(true);
    expect(contains(scrubGps(photo).bytes, coord)).toBe(false);
  });

  it('keeps the file the same length, so no offset moves', () => {
    expect(scrubGps(photo).bytes.length).toBe(photo.length);
  });

  it('keeps the other EXIF tags', () => {
    const found = inspectJpegCover(scrubGps(photo).bytes).exif;
    expect(found?.parsed).toBe(true);
    expect(found?.make).toBe('Google');
    expect(found?.model).toBe('Pixel 10');
  });

  it('leaves the coefficients alone', () => {
    const before = decodeCoeff(photo);
    const after = decodeCoeff(scrubGps(photo).bytes);
    expect(after.components.length).toBe(before.components.length);
    for (let c = 0; c < before.components.length; c++) {
      const a = before.components[c]!.blocks;
      const b = after.components[c]!.blocks;
      expect(b.length).toBe(a.length);
      for (let i = 0; i < a.length; i++) expect(Array.from(b[i]!)).toEqual(Array.from(a[i]!));
    }
  });

  it('is idempotent', () => {
    const once = scrubGps(photo).bytes;
    const twice = scrubGps(once);
    expect(twice.removed).toBe(false);
    expect(twice.bytes).toEqual(once);
  });
});

describe('what it leaves alone', () => {
  it('returns a photo with no GPS unchanged, by identity', () => {
    const photo = spliceBeforeSos(baseJpeg(64, 64), exifSegment());
    const res = scrubGps(photo);
    expect(res.removed).toBe(false);
    expect(res.bytes).toBe(photo);
  });

  it('returns a photo with no EXIF at all unchanged', () => {
    const photo = baseJpeg(64, 64);
    expect(scrubGps(photo).bytes).toBe(photo);
  });

  it('keeps every other segment, and every byte after EOI', () => {
    const photo = withTrailer(
      spliceBeforeSos(spliceBeforeSos(baseJpeg(64, 64), exifSegmentWithGps()), iccSegment()),
      gainMapTrailer(),
    );
    const before = parseJpegSegments(photo);
    const { bytes } = scrubGps(photo);
    const after = parseJpegSegments(bytes);

    expect(after.segments.map((s) => s.marker)).toEqual(before.segments.map((s) => s.marker));
    expect(after.trailerStart).toBe(before.trailerStart);
    expect(Array.from(bytes.subarray(after.trailerStart))).toEqual(
      Array.from(photo.subarray(before.trailerStart)),
    );
  });

  // Two APP1 blocks, only one of them EXIF: an XMP packet is APP1 too, and a
  // scrub that keyed on the marker rather than the payload would eat it.
  it('scrubs the EXIF APP1 and not the other one', () => {
    const xmp = appSegment(0xe1, new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0<x/>'));
    const photo = spliceBeforeSos(spliceBeforeSos(baseJpeg(64, 64), exifSegmentWithGps()), xmp);
    const { bytes, removed } = scrubGps(photo);
    expect(removed).toBe(true);
    expect(contains(bytes, new TextEncoder().encode('http://ns.adobe.com/xap/1.0/'))).toBe(true);
  });
});

/**
 * Fail closed rather than fail soft. A block that cannot be walked is one nobody
 * can assert carries no coordinate, so passing it through would make the promise
 * conditional on the file being well formed, which is the file it would not hold
 * for. `readExif` is fail-soft by contrast, and correctly so: it is answering a
 * question about curiosity, this one is answering a question about safety.
 */
describe('EXIF it cannot walk', () => {
  const broken = (edit: (tiff: Uint8Array) => void): Uint8Array => {
    const seg = exifSegmentWithGps();
    edit(seg.subarray(4 + 6)); // past the marker, the length and `Exif\0\0`
    return spliceBeforeSos(baseJpeg(64, 64), seg);
  };

  it('refuses a block with no byte-order mark', () => {
    expect(() => scrubGps(broken((t) => t.set([0x00, 0x00], 0)))).toThrow(ExifScrubError);
  });

  it('refuses a block whose TIFF magic is not 42', () => {
    expect(() => scrubGps(broken((t) => t.set([0x00, 0x2b], 2)))).toThrow(ExifScrubError);
  });

  it('refuses an IFD that runs past the end of the block', () => {
    // An entry count far larger than the block can hold.
    expect(() => scrubGps(broken((t) => t.set([0xff, 0xff], 8)))).toThrow(ExifScrubError);
  });

  it('refuses a tag whose value runs past the end of the block', () => {
    // The Make entry's value offset, pushed past the end.
    expect(() => scrubGps(broken((t) => t.set([0xff, 0xff, 0xff, 0xf0], 8 + 2 + 8)))).toThrow(
      ExifScrubError,
    );
  });
});
