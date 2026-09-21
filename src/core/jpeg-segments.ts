/**
 * JPEG **marker-segment** layout: the structural half of the file, deliberately
 * separate from `jpeg-coeff.ts`, which owns the entropy-coded half.
 *
 * `jpeg-coeff.ts` reads the same marker sequence, but it reads it to find the
 * scan and then forgets it; everything outside the scan is a byte range it
 * copies verbatim (see `applyScanToggles`). This module is the other view: it
 * enumerates those segments so a caller can decide that one of them should not
 * be in the file. Nothing here touches, decodes, or even looks at the entropy
 * stream, which is the property that lets provenance surgery run before an embed
 * without disturbing a single DCT coefficient.
 *
 * Fail-closed by construction: every length is bounds-checked against the buffer
 * before it is trusted, and a file that does not parse throws
 * {@link JpegStructureError} rather than returning a partial layout. A caller
 * that gets an exception holds the original bytes and nothing else, so there is
 * no path that emits a half-edited JPEG.
 */

/** Thrown when a JPEG's marker structure is malformed or truncated. */
export class JpegStructureError extends Error {
  constructor(reason: string) {
    super(`malformed JPEG: ${reason}`);
    this.name = 'JpegStructureError';
  }
}

/** One length-carrying marker segment, as a byte range into the source buffer. */
export interface JpegSegment {
  /** The marker byte that follows `0xFF` (e.g. `0xEB` for APP11). */
  marker: number;
  /** Offset of the `0xFF` that opens the marker. */
  start: number;
  /** Offset of the first payload byte, i.e. `start + 4` (marker, then u16 length). */
  payloadStart: number;
  /** Offset one past the segment's last byte. */
  end: number;
}

/** What sits after the EOI marker, when anything does. */
export type TrailerKind =
  /** Nothing follows EOI. */
  | 'none'
  /** A second JPEG stream: the MPO / Ultra HDR gain map. */
  | 'mpo'
  /** An ISOBMFF stream: an Android motion-photo video. */
  | 'mp4'
  /** Bytes that are neither. */
  | 'unknown';

/** The structural map of one JPEG file. */
export interface JpegLayout {
  /** Every length-carrying segment, in file order. Includes SOS. */
  segments: JpegSegment[];
  /** Offset of the `0xFF` opening the first SOS. */
  sosStart: number;
  /** Offset one past the EOI marker: where the trailer begins. */
  trailerStart: number;
  /** `bytes.length`, so a caller can size the trailer without holding the buffer. */
  length: number;
}

const u16 = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;

/** True if the bytes start with the JPEG SOI marker. Mirrors `jpeg-coeff.isJpeg`. */
export function hasSoi(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/**
 * Walk the entropy-coded data from `from` to the next real marker, skipping
 * stuffed `FF 00` bytes and `RSTn` restart markers. Same rule as
 * `jpeg-coeff.findScanEnd`, which is deliberate: the two must agree on where a
 * scan ends, or this module would offer to remove bytes that are coefficients.
 */
function skipEntropy(bytes: Uint8Array, from: number): number {
  let p = from;
  while (p < bytes.length - 1) {
    if (bytes[p] === 0xff) {
      const m = bytes[p + 1]!;
      if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) {
        p += 2;
        continue;
      }
      return p;
    }
    p++;
  }
  return bytes.length;
}

/**
 * Map a JPEG's marker segments. Throws {@link JpegStructureError} on anything
 * that does not parse cleanly: no SOI, a segment length that runs past the end
 * of the buffer, a length below the two bytes it occupies, a byte where a marker
 * must be, or no EOI at all.
 *
 * Multi-scan files are handled by looping rather than by assuming a single SOS,
 * so a file with a second scan maps correctly instead of reporting its second
 * scan header as an ordinary removable segment.
 */
export function parseJpegSegments(bytes: Uint8Array): JpegLayout {
  if (!hasSoi(bytes)) throw new JpegStructureError('no SOI');
  const segments: JpegSegment[] = [];
  let sosStart = -1;
  let o = 2;

  while (o < bytes.length) {
    // A marker may be preceded by any number of 0xFF fill bytes.
    while (o + 1 < bytes.length && bytes[o] === 0xff && bytes[o + 1] === 0xff) o++;
    if (o + 1 >= bytes.length) throw new JpegStructureError('truncated before a marker');
    if (bytes[o] !== 0xff) throw new JpegStructureError(`expected a marker at offset ${o}`);
    const marker = bytes[o + 1]!;

    if (marker === 0xd9) {
      if (sosStart < 0) throw new JpegStructureError('EOI before any scan');
      return { segments, sosStart, trailerStart: o + 2, length: bytes.length };
    }
    // Standalone markers: TEM and the restart markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2;
      continue;
    }
    if (marker === 0xd8) throw new JpegStructureError(`nested SOI at offset ${o}`);

    if (o + 4 > bytes.length) throw new JpegStructureError('truncated segment length');
    const segLen = u16(bytes, o + 2);
    // The length field counts itself, so anything under 2 cannot be a segment and
    // would make `end` walk backwards.
    if (segLen < 2) throw new JpegStructureError(`segment length ${segLen} at offset ${o}`);
    const end = o + 2 + segLen;
    if (end > bytes.length) throw new JpegStructureError('segment runs past end of file');

    segments.push({ marker, start: o, payloadStart: o + 4, end });

    if (marker === 0xda) {
      if (sosStart < 0) sosStart = o;
      o = skipEntropy(bytes, end);
    } else {
      o = end;
    }
  }
  throw new JpegStructureError('no EOI');
}

/** The payload bytes of a segment, i.e. everything after its length field. */
export function segmentPayload(bytes: Uint8Array, seg: JpegSegment): Uint8Array {
  return bytes.subarray(seg.payloadStart, seg.end);
}

/** True when a segment's payload begins with `prefix`. */
export function payloadStartsWith(
  bytes: Uint8Array,
  seg: JpegSegment,
  prefix: Uint8Array | readonly number[],
): boolean {
  if (seg.end - seg.payloadStart < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[seg.payloadStart + i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * ASCII bytes of `text`, for the many `"Exif\0\0"`-style payload prefixes here.
 *
 * Named `asciiBytes` rather than `ascii` because `src/core/index.ts` is an
 * `export *` barrel: a name this generic in that namespace is one the next
 * module has to avoid without knowing it exists.
 */
export function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** How far into the trailer to look past padding, for either kind. */
const TRAILER_SCAN_BYTES = 512;

/**
 * True when a second JPEG stream opens the trailer, padding allowed for.
 *
 * Zero bytes are skipped, and then a run of `FF`: an `FF` ahead of a marker is
 * legal JPEG fill, so `00 00 FF FF D8` is a gain map that starts two bytes late,
 * not a trailer nobody can name. The tolerance matches the `ftyp` search below,
 * which is the point: requiring `FF D8` at exactly `trailerStart` while
 * searching for a padded `ftyp` made a padded MPO the one padded trailer called
 * `unknown`, and in a set of Ultra HDR photos from two producers that showed up
 * as a trailer-kind difference the photos do not have.
 */
function soiAfterPadding(bytes: Uint8Array, trailerStart: number): boolean {
  const limit = Math.min(bytes.length, trailerStart + TRAILER_SCAN_BYTES);
  let p = trailerStart;
  while (p < limit && bytes[p] === 0x00) p++;
  if (bytes[p] !== 0xff) return false;
  while (p < limit && bytes[p] === 0xff) p++;
  return bytes[p] === 0xd8;
}

/**
 * Classify whatever follows EOI.
 *
 * Two kinds matter, and they are distinguishable. An Ultra HDR gain map is a
 * second JPEG stream, so it opens with its own SOI. An Android motion photo
 * appends an ISOBMFF stream, whose first box is `ftyp` at offset 4 of the box.
 * Neither is required at a fixed offset, because some producers pad between EOI
 * and what follows; a padded MP4 is still an MP4, a padded gain map is still a
 * gain map, and calling either `unknown` would send a caller down the wrong
 * branch.
 */
export function classifyTrailer(bytes: Uint8Array, trailerStart: number): TrailerKind {
  if (trailerStart >= bytes.length) return 'none';
  if (soiAfterPadding(bytes, trailerStart)) return 'mpo';
  const limit = Math.min(bytes.length - 4, trailerStart + TRAILER_SCAN_BYTES);
  for (let p = trailerStart; p <= limit; p++) {
    if (
      bytes[p] === 0x66 && // f
      bytes[p + 1] === 0x74 && // t
      bytes[p + 2] === 0x79 && // y
      bytes[p + 3] === 0x70 // p
    ) {
      return 'mp4';
    }
  }
  return 'unknown';
}
