/**
 * The APP2 `MPF\0` index: the one structure in a JPEG that points at bytes
 * outside itself.
 *
 * WHY THIS MODULE EXISTS
 * An Ultra HDR photo is two JPEG streams in one file: the image, then a gain map
 * after EOI. A reader finds the second one through the Multi-Picture Format index
 * in an APP2 segment, whose entries give each image's size and its **offset from
 * the MP endian header** (CIPA DC-007). That makes the index the only part of a
 * JPEG whose correctness depends on where other bytes sit, and both things
 * StegoShard does to a cover move those bytes:
 *
 *  - removing a provenance manifest ahead of the index shifts the header and the
 *    trailer together, and a removal *after* the header shifts only the trailer;
 *  - an embed re-serializes the entropy scan, whose length drifts by the
 *    byte-stuffing it re-applies, which moves the trailer and nothing else.
 *
 * Refusing such covers was the first answer, and it cost the feature the photos
 * it most needed to work on: a recent Pixel writes a gain map on every HDR shot.
 * So the offsets are rewritten instead. The arithmetic is small, and it is
 * pinned by SPEC §9.7.1 so an independent implementation gets the same bytes.
 *
 * FAIL CLOSED WHERE THE REWRITE CANNOT BE TRUSTED
 * Every read here is bounds-checked against the segment it lives in, and
 * anything unexpected answers "unreadable" rather than a guess: an index this
 * module cannot parse is one it must not silently leave pointing into the middle
 * of a file. The callers turn that into their own refusal, which is the same
 * behaviour the whole feature had before rewriting existed.
 *
 * Nothing here touches the entropy-coded scan or a single byte of the trailer.
 */

import {
  type JpegLayout,
  type JpegSegment,
  asciiBytes,
  parseJpegSegments,
  payloadStartsWith,
} from './jpeg-segments';

const APP2 = 0xe2;
const P_MPF = asciiBytes('MPF\0');

/** `0xB002`, the MP Entry tag: the array of per-image size/offset records. */
const TAG_MP_ENTRY = 0xb002;
/** One MP Entry: attribute u32, size u32, data offset u32, two dependency u16s. */
const MP_ENTRY_LEN = 16;
/** One TIFF IFD entry: tag u16, type u16, count u32, value-or-offset u32. */
const IFD_ENTRY_LEN = 12;
/** The TIFF magic both byte orders spell as 42. */
const TIFF_MAGIC = 42;
/**
 * A ceiling on the image count, so a corrupt entry byte count cannot turn into
 * a long loop. MPO in the wild carries two or three images; a stereo camera
 * might write a dozen.
 */
const MAX_IMAGES = 64;

/** One image's record in the MP Index IFD. */
export interface MpfEntryFields {
  /** File offset of this entry's 16 bytes, so a caller can write a field back. */
  at: number;
  /** Individual Image Attribute: type and role flags, never rewritten here. */
  attribute: number;
  /** Individual Image Size, in bytes. */
  size: number;
  /**
   * Individual Image Data Offset, measured from the MP endian header, and **0
   * for the primary image** by definition: it is the image the index sits in.
   */
  offset: number;
}

/** A parsed MP Index IFD, with the positions needed to rewrite it. */
export interface MpfIndex {
  /** File offset of the MP endian header. Every offset below is measured from here. */
  endianAt: number;
  /** Byte order of the index. Rewrites must use it, not the platform's. */
  littleEndian: boolean;
  /** One per image, in index order. The first is the primary image. */
  entries: MpfEntryFields[];
}

/**
 * Read the MP Index IFD, or answer null for a file that does not have a usable
 * one: no APP2 `MPF\0` segment, a byte order or magic that is not TIFF's, an IFD
 * or entry array that does not fit inside the segment carrying it, or an entry
 * count that is not a whole number of records.
 *
 * `layout` is accepted because both callers already have one and walking the
 * markers twice for the same file would be waste; it must be the layout **of
 * these bytes**.
 */
export function parseMpfIndex(bytes: Uint8Array, layout?: JpegLayout): MpfIndex | null {
  const map = layoutOf(bytes, layout);
  if (!map) return null;
  const seg = mpfSegment(bytes, map);
  if (!seg) return null;

  const endianAt = seg.payloadStart + P_MPF.length;
  // Everything the index declares lives inside the segment that carries it, so
  // that is the bound every read below is checked against, not the file length.
  const end = seg.end;
  if (endianAt + 8 > end) return null;

  const little = bytes[endianAt] === 0x49 && bytes[endianAt + 1] === 0x49; // "II"
  const big = bytes[endianAt] === 0x4d && bytes[endianAt + 1] === 0x4d; // "MM"
  if (!little && !big) return null;
  const u16 = (at: number): number =>
    little ? bytes[at]! | (bytes[at + 1]! << 8) : (bytes[at]! << 8) | bytes[at + 1]!;
  const u32 = (at: number): number =>
    (little
      ? bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)
      : (bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
  if (u16(endianAt + 2) !== TIFF_MAGIC) return null;

  const ifdAt = endianAt + u32(endianAt + 4);
  if (ifdAt < endianAt + 8 || ifdAt + 2 > end) return null;
  const tags = u16(ifdAt);
  if (tags === 0 || ifdAt + 2 + tags * IFD_ENTRY_LEN + 4 > end) return null;

  let entriesAt = -1;
  let arrayBytes = 0;
  for (let i = 0; i < tags; i++) {
    const tag = ifdAt + 2 + i * IFD_ENTRY_LEN;
    if (u16(tag) !== TAG_MP_ENTRY) continue;
    arrayBytes = u32(tag + 4);
    // The array is always longer than the four bytes an IFD entry can hold
    // inline, so this field is an offset rather than a value. Relative to the
    // endian header, like every other offset in the index.
    entriesAt = endianAt + u32(tag + 8);
    break;
  }
  if (entriesAt < 0 || arrayBytes === 0 || arrayBytes % MP_ENTRY_LEN !== 0) return null;
  const images = arrayBytes / MP_ENTRY_LEN;
  if (images > MAX_IMAGES) return null;
  if (entriesAt < endianAt + 8 || entriesAt + arrayBytes > end) return null;

  const entries: MpfEntryFields[] = [];
  for (let i = 0; i < images; i++) {
    const at = entriesAt + i * MP_ENTRY_LEN;
    entries.push({ at, attribute: u32(at), size: u32(at + 4), offset: u32(at + 8) });
  }
  return { endianAt, littleEndian: little, entries };
}

/**
 * What a file's MPF index has to say about its trailer, captured **before** an
 * edit so the same index can be made true again afterwards.
 *
 * Three answers, because they call for three different things:
 *
 *  - `none`: no MPF index, or nothing after EOI for one to locate. Nothing to
 *    keep resolvable, so an edit needs no fixing up. A file whose markers do not
 *    parse at all also lands here: the decode that follows refuses it with a
 *    better message than this could give, and there is no path on which this
 *    answer lets such a file through.
 *  - `index`: the geometry {@link retargetMpfIndex} needs.
 *  - `unreadable`: there is an index and there is a trailer, and this module
 *    cannot read the index. The caller must refuse: moving the trailer under an
 *    index nobody understands is exactly the outcome SPEC §9.7 forbids.
 */
export type MpfLink =
  | { kind: 'none' }
  | {
      kind: 'index';
      /** File offset of the MP endian header. */
      endianAt: number;
      /** Where the trailer began, i.e. one past the outer EOI. */
      trailerStart: number;
      /** The whole file's length, to bound where an entry may point. */
      length: number;
    }
  | { kind: 'unreadable'; reason: string };

export function mpfTrailerLink(bytes: Uint8Array, layout?: JpegLayout): MpfLink {
  const map = layoutOf(bytes, layout);
  if (!map) return { kind: 'none' };
  if (!mpfSegment(bytes, map)) return { kind: 'none' };
  if (map.trailerStart >= bytes.length) return { kind: 'none' };
  const index = parseMpfIndex(bytes, map);
  if (!index) {
    return {
      kind: 'unreadable',
      reason:
        'an APP2 MPF index that could not be read locates bytes after EOI, so the ' +
        'offsets it carries cannot be kept correct',
    };
  }
  return {
    kind: 'index',
    endianAt: index.endianAt,
    trailerStart: map.trailerStart,
    length: bytes.length,
  };
}

/** Whether the rewrite could be made, and how many fields it touched. */
export type MpfRetarget = { ok: true; rewritten: number } | { ok: false; reason: string };

/**
 * Rewrite `out`'s MPF index so it describes `out` rather than the file it was
 * edited from. `before` is that file's geometry, from {@link mpfTrailerLink}.
 *
 * THE ARITHMETIC (SPEC §9.7.1)
 * The trailer is copied verbatim, so an image inside it keeps its position
 * *within* the trailer. For an entry whose data offset is not 0:
 *
 * ```
 * P_old  = endianAt_old + offset_old          # where the image was
 * P_new  = trailerStart_new + (P_old - trailerStart_old)
 * offset_new = P_new - endianAt_new
 * ```
 *
 * One formula covers both callers, and it is the identity when header and
 * trailer moved by the same amount, which is the case a removal ahead of the
 * index already handled by doing nothing.
 *
 * The primary image's entry carries offset 0 and a size that spans the whole
 * first image, SOI to EOI, so its size is the position of the trailer. It is
 * rewritten to match, and only when it matched before: a producer whose value
 * already disagreed with its own file meant something this cannot infer, and
 * turning one wrong number into a different wrong number is not a repair.
 *
 * Mutates `out` in place. Both callers hand it a buffer they have just built, so
 * there is nothing else holding a view of these bytes.
 */
export function retargetMpfIndex(
  out: Uint8Array,
  before: { endianAt: number; trailerStart: number; length: number },
): MpfRetarget {
  let layout: JpegLayout;
  try {
    layout = parseJpegSegments(out);
  } catch (err) {
    return { ok: false, reason: `the edited file no longer parses: ${message(err)}` };
  }
  const index = parseMpfIndex(out, layout);
  if (!index) return { ok: false, reason: 'the MPF index could not be read after the edit' };

  const puts: { at: number; value: number }[] = [];
  for (const [i, entry] of index.entries.entries()) {
    if (entry.offset === 0) {
      // The primary image: everything up to EOI, so its size is where the
      // trailer starts. Left alone when it did not say that to begin with.
      if (entry.size === before.trailerStart && entry.size !== layout.trailerStart) {
        puts.push({ at: entry.at + 4, value: layout.trailerStart });
      }
      continue;
    }
    const was = before.endianAt + entry.offset;
    if (was < before.trailerStart || was >= before.length) {
      // Either the offset is not measured from the endian header the way
      // CIPA DC-007 says, or the index was already pointing outside its own
      // file. Refuse rather than move a number whose meaning is a guess.
      return {
        ok: false,
        reason:
          `MPF entry ${i + 1} locates byte ${was}, which is not inside the trailer at ` +
          `${before.trailerStart}..${before.length}`,
      };
    }
    const now = layout.trailerStart + (was - before.trailerStart) - index.endianAt;
    if (now < 0 || now > 0xffffffff) {
      return { ok: false, reason: `MPF entry ${i + 1} would need an offset of ${now}` };
    }
    if (now !== entry.offset) puts.push({ at: entry.at + 8, value: now });
  }

  // Written only once every entry has been checked, so a refusal leaves the
  // buffer exactly as it arrived rather than half rewritten.
  for (const { at, value } of puts) putU32(out, at, value, index.littleEndian);
  return { ok: true, rewritten: puts.length };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function layoutOf(bytes: Uint8Array, layout?: JpegLayout): JpegLayout | null {
  if (layout) return layout;
  try {
    return parseJpegSegments(bytes);
  } catch {
    return null;
  }
}

function mpfSegment(bytes: Uint8Array, layout: JpegLayout): JpegSegment | undefined {
  return layout.segments.find((s) => s.marker === APP2 && payloadStartsWith(bytes, s, P_MPF));
}

function putU32(bytes: Uint8Array, at: number, value: number, littleEndian: boolean): void {
  const v = value >>> 0;
  if (littleEndian) {
    bytes[at] = v & 0xff;
    bytes[at + 1] = (v >>> 8) & 0xff;
    bytes[at + 2] = (v >>> 16) & 0xff;
    bytes[at + 3] = (v >>> 24) & 0xff;
  } else {
    bytes[at] = (v >>> 24) & 0xff;
    bytes[at + 1] = (v >>> 16) & 0xff;
    bytes[at + 2] = (v >>> 8) & 0xff;
    bytes[at + 3] = v & 0xff;
  }
}
