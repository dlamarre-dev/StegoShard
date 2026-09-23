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
  mp4Trailer,
  spliceBeforeSos,
  withTrailer,
  xmpSegment,
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

const enc = new TextEncoder();

/** An Extended XMP chunk: prefix, GUID, the full length, this chunk's offset, then the text. */
function xmpChunk(text: string, offset: number, total: number): Uint8Array {
  const head = new Uint8Array(40);
  head.set(enc.encode('0123456789ABCDEF0123456789ABCDEF'), 0);
  new DataView(head.buffer).setUint32(32, total);
  new DataView(head.buffer).setUint32(36, offset);
  const prefix = enc.encode('http://ns.adobe.com/xmp/extension/\0');
  const body = enc.encode(text);
  const payload = new Uint8Array(prefix.length + head.length + body.length);
  payload.set(prefix, 0);
  payload.set(head, prefix.length);
  payload.set(body, prefix.length + head.length);
  return appSegment(0xe1, payload);
}

/** The coordinate as XMP writes it, which is text rather than rationals. */
const XMP_LAT = '45,30.25N';
const XMP_LON = '73,34.1W';

/**
 * EXIF is where a coordinate is expected, and not where it only is. Lightroom,
 * Apple Photos and most phone galleries write it into XMP as well, and a flag
 * that promises "GPS is removed" has to find it there.
 */
describe('coordinates outside the EXIF GPS IFD', () => {
  it('blanks GPS properties written as XMP attributes', () => {
    const xmp = xmpSegment(
      `<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" ` +
        `exif:GPSLatitude="${XMP_LAT}" exif:GPSLongitude='${XMP_LON}' exif:ExposureTime="1/60"/>`,
    );
    const photo = spliceBeforeSos(baseJpeg(64, 64), xmp);
    const { bytes, removed } = scrubGps(photo);
    expect(removed).toBe(true);
    expect(bytes.length).toBe(photo.length);
    expect(contains(bytes, enc.encode(XMP_LAT))).toBe(false);
    expect(contains(bytes, enc.encode(XMP_LON))).toBe(false);
    // What is not a coordinate stays, and the packet is still XML.
    expect(contains(bytes, enc.encode('exif:ExposureTime="1/60"'))).toBe(true);
    expect(contains(bytes, enc.encode('<rdf:Description'))).toBe(true);
  });

  it('blanks GPS properties written as elements, in any case and any prefix', () => {
    const xmp = xmpSegment(
      `<rdf:Description><exif:GPSLatitude>${XMP_LAT}</exif:GPSLatitude>` +
        `<drone-dji:GpsLongitude>${XMP_LON}</drone-dji:GpsLongitude>` +
        `<exif:GPSVersionID/><tiff:Make>Google</tiff:Make></rdf:Description>`,
    );
    const { bytes, removed } = scrubGps(spliceBeforeSos(baseJpeg(64, 64), xmp));
    expect(removed).toBe(true);
    expect(contains(bytes, enc.encode(XMP_LAT))).toBe(false);
    expect(contains(bytes, enc.encode(XMP_LON))).toBe(false);
    expect(contains(bytes, enc.encode('GPSVersionID'))).toBe(false);
    expect(contains(bytes, enc.encode('<tiff:Make>Google</tiff:Make>'))).toBe(true);
  });

  it('finds a property split across two Extended XMP chunks', () => {
    const text = `<rdf:Description exif:GPSLatitude="${XMP_LAT}"/>`;
    const cut = text.indexOf('GPS') + 2; // "...exif:GP" | "SLatitude=..."
    // Written out of order: the scrub has to reassemble by offset, not by position.
    const photo = spliceBeforeSos(
      spliceBeforeSos(baseJpeg(64, 64), xmpChunk(text.slice(cut), cut, text.length)),
      xmpChunk(text.slice(0, cut), 0, text.length),
    );
    const { bytes, removed } = scrubGps(photo);
    expect(removed).toBe(true);
    expect(bytes.length).toBe(photo.length);
    expect(contains(bytes, enc.encode(XMP_LAT))).toBe(false);
  });

  it('refuses an XMP packet that names GPS in a form it cannot remove', () => {
    // An element that is opened and never closed: no pattern matches it, and it
    // must not pass as clean.
    const xmp = xmpSegment(`<rdf:Description><exif:GPSLatitude>${XMP_LAT}</rdf:Description>`);
    expect(() => scrubGps(spliceBeforeSos(baseJpeg(64, 64), xmp))).toThrow(ExifScrubError);
  });

  /**
   * An MPF secondary image or a gain map is a JPEG of its own, after EOI, with
   * its own EXIF. The scrub used to leave every byte after EOI untouched.
   */
  it('scrubs the EXIF of an image after EOI, without moving it', () => {
    const secondary = spliceBeforeSos(baseJpeg(32, 32, 70, 9), exifSegmentWithGps(true));
    const photo = withTrailer(spliceBeforeSos(baseJpeg(64, 64), exifSegment()), secondary);
    expect(contains(photo, coordinateBytes(true))).toBe(true);
    const { bytes, removed } = scrubGps(photo);
    expect(removed).toBe(true);
    expect(bytes.length).toBe(photo.length);
    expect(contains(bytes, coordinateBytes(true))).toBe(false);
    // The secondary image still starts where the MPF index says it does.
    const trailer = parseJpegSegments(photo).trailerStart;
    expect(Array.from(bytes.subarray(trailer, trailer + 3))).toEqual([0xff, 0xd8, 0xff]);
    expect(decodeCoeff(bytes.subarray(trailer)).width).toBe(32);
  });

  it('refuses EXIF after EOI that is not inside an image it can walk', () => {
    const loose = new Uint8Array([...enc.encode('junk'), ...exifSegmentWithGps().subarray(4)]);
    expect(() => scrubGps(withTrailer(baseJpeg(64, 64), loose))).toThrow(ExifScrubError);
  });

  it('zeroes the location atom of a motion-photo video', () => {
    const where = enc.encode('+45.5042-073.5683/');
    const atom = new Uint8Array(12 + where.length);
    new DataView(atom.buffer).setUint32(0, atom.length);
    atom.set([0xa9, 0x78, 0x79, 0x7a], 4); // ©xyz
    new DataView(atom.buffer).setUint16(8, where.length);
    new DataView(atom.buffer).setUint16(10, 0x15c7); // language
    atom.set(where, 12);
    const video = new Uint8Array([...mp4Trailer(), ...atom]);
    const photo = withTrailer(baseJpeg(64, 64), video);
    const { bytes, removed } = scrubGps(photo);
    expect(removed).toBe(true);
    expect(bytes.length).toBe(photo.length);
    expect(contains(bytes, where)).toBe(false);
    // The box itself stays, so the video still parses.
    expect(contains(bytes, new Uint8Array([0xa9, 0x78, 0x79, 0x7a]))).toBe(true);
  });

  /**
   * The trailer walk: bytes that merely look like an SOI are skipped, loose
   * bytes before an embedded image are searched on their own, and the image is
   * still found and scrubbed after them.
   */
  it('skips a false SOI in the trailer and still scrubs the image after it', () => {
    const secondary = spliceBeforeSos(baseJpeg(32, 32, 70, 9), exifSegmentWithGps());
    const junk = new Uint8Array([0x00, 0x11, 0xff, 0xd8, 0xff, 0x00, 0x22]);
    const photo = withTrailer(baseJpeg(64, 64), new Uint8Array([...junk, ...secondary]));
    const { bytes, removed } = scrubGps(photo);
    expect(removed).toBe(true);
    expect(contains(bytes, coordinateBytes(false))).toBe(false);
  });

  /** A motion-photo video can carry its own XMP packet; it is scrubbed in place. */
  it('scrubs an XMP packet sitting loose in the trailer, closed or cut off', () => {
    const packet = `<x:xmpmeta><rdf:Description exif:GPSLatitude="${XMP_LAT}"/></x:xmpmeta>`;
    for (const text of [packet, packet.slice(0, -12)]) {
      const photo = withTrailer(
        baseJpeg(64, 64),
        new Uint8Array([...mp4Trailer(), ...enc.encode(text)]),
      );
      const { bytes, removed } = scrubGps(photo);
      expect(removed).toBe(true);
      expect(bytes.length).toBe(photo.length);
      expect(contains(bytes, enc.encode(XMP_LAT))).toBe(false);
    }
  });

  it('leaves four bytes that spell ©xyz alone unless they are a well-formed box', () => {
    const xyz = [0xa9, 0x78, 0x79, 0x7a];
    // At the very start of the trailer (no room for a size), with a size that
    // does not match its length, and a real box whose string is already empty.
    const empty = new Uint8Array(12 + 4);
    new DataView(empty.buffer).setUint32(0, empty.length);
    empty.set(xyz, 4);
    new DataView(empty.buffer).setUint16(8, 4);
    for (const trailer of [
      new Uint8Array([...xyz, 0, 0, 0, 0, 1, 2, 3, 4]),
      new Uint8Array([0, 0, 0, 99, ...xyz, 0, 4, 0, 0, 1, 2, 3, 4]),
      empty,
    ]) {
      const photo = withTrailer(baseJpeg(64, 64), trailer);
      expect(scrubGps(photo).bytes).toBe(photo);
    }
  });

  it('leaves Extended XMP with no coordinate unchanged', () => {
    const text = '<rdf:Description exif:ExposureTime="1/60"/>';
    const photo = spliceBeforeSos(baseJpeg(64, 64), xmpChunk(text, 0, text.length));
    expect(scrubGps(photo).bytes).toBe(photo);
  });

  it('refuses an EXIF or Extended XMP segment too short to hold its own header', () => {
    const shortExif = appSegment(0xe1, enc.encode('Exif  MM *'));
    expect(() => scrubGps(spliceBeforeSos(baseJpeg(64, 64), shortExif))).toThrow(ExifScrubError);
    const shortExt = appSegment(0xe1, enc.encode('http://ns.adobe.com/xmp/extension/ short'));
    expect(() => scrubGps(spliceBeforeSos(baseJpeg(64, 64), shortExt))).toThrow(ExifScrubError);
  });

  it('leaves a trailer with nothing to scrub byte for byte, and returns the original', () => {
    const photo = withTrailer(spliceBeforeSos(baseJpeg(64, 64), exifSegment()), gainMapTrailer());
    expect(scrubGps(photo).bytes).toBe(photo);
  });
});
