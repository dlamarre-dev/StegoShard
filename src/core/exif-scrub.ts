/**
 * Remove GPS coordinates from a JPEG, in place, without moving a byte.
 *
 * This is the one metadata removal StegoShard performs on a container it is not
 * re-encoding. The default gallery path re-encodes every cover into one profile
 * (SPEC §9.8), which drops all metadata as a side effect of being a new file;
 * `--preserve-container` keeps the device's own container, and a coordinate is
 * the one thing that must not survive that choice.
 *
 * WHY NOTHING MOVES
 * Every value in a TIFF block longer than four bytes lives outside its entry and
 * is addressed by an absolute offset from the start of the block. Maker notes
 * make this worse: several vendors write their own internal offsets, also
 * absolute, into an opaque blob no parser is allowed to rewrite. So the rule here
 * is that the file keeps its length and every surviving byte keeps its address.
 * Removing the GPS pointer shortens IFD0 by one 12-byte entry, and the twelve
 * bytes that frees are left in place as unreferenced padding rather than
 * reclaimed. A whole class of offset bugs is impossible rather than rare.
 *
 * WHY THE VALUES ARE ZEROED, NOT JUST THE POINTER
 * Dropping the pointer makes the coordinates invisible to every conforming
 * reader, and leaves them perfectly legible to anyone who looks at the bytes.
 * That is concealment, not removal, and the threat model here is someone reading
 * the bytes. So the GPS IFD's own entries are zeroed, and so is every out-of-line
 * value they address: latitude and longitude are rationals, eight bytes each,
 * which is to say they are always out of line.
 *
 * WHERE ELSE A COORDINATE HIDES
 * The EXIF GPS IFD is the obvious place and not the only one, and a flag whose
 * promise is "GPS is removed" owes all of them:
 *
 * - **XMP.** Lightroom, Apple Photos and most phone galleries write
 *   `exif:GPSLatitude` / `exif:GPSLongitude` into the XMP packet as well, and
 *   drones write their own (`drone-dji:GpsLatitude`). Every property whose local
 *   name starts with `GPS`, any case, any prefix, is overwritten with spaces:
 *   XML whitespace, so the packet stays well formed and keeps its length.
 *   Extended XMP chunks are read as the one text they are, so a property split
 *   across two segments is still found.
 * - **Images after EOI.** An MPF secondary image or an Ultra HDR gain map is a
 *   whole JPEG of its own, with its own APP1 blocks. Each is scrubbed by the same
 *   rules, in place, so the MPF offsets that address them stay true.
 * - **A motion-photo video after EOI.** Its location is a QuickTime `©xyz` atom,
 *   an ISO 6709 string, which is zeroed.
 *
 * Anything in the trailer that still looks like EXIF after that, in bytes no
 * image walk covered, is refused: it is a block nobody can assert holds no
 * coordinate, the same fail-closed rule as a TIFF block that does not parse.
 */

import {
  type JpegLayout,
  type JpegSegment,
  JpegStructureError,
  parseJpegSegments,
  payloadStartsWith,
} from './jpeg-segments';

/** `Exif\0\0`: the APP1 payload prefix that introduces a TIFF block. */
const P_EXIF = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];

/** GPS IFD pointer, in IFD0. The block it points at is what this removes. */
const TAG_GPS_IFD = 0x8825;

/** EXIF IFD pointer: followed, because a stray GPS pointer can sit inside it. */
const TAG_EXIF_IFD = 0x8769;

/** APP1 prefix of a standard XMP packet. */
const P_XMP = bytesOf('http://ns.adobe.com/xap/1.0/\0');

/** APP1 prefix of an Extended XMP chunk: then a 32-byte GUID, a length and an offset. */
const P_XMP_EXT = bytesOf('http://ns.adobe.com/xmp/extension/\0');

/** GUID, full length and chunk offset, between the Extended XMP prefix and the chunk. */
const XMP_EXT_HEADER = 32 + 4 + 4;

/** A GPS property as an XML attribute: `exif:GPSLatitude="45,30.25N"`. */
const XMP_GPS_ATTR = /\s[A-Za-z_][\w.-]*:gps[\w.-]*\s*=\s*(?:"[^"]*"|'[^']*')/gi;

/** A GPS property as an element, empty or with content. */
const XMP_GPS_ELEMENT = /<([A-Za-z_][\w.-]*:gps[\w.-]*)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1\s*>)/gi;

/** What must not be left in an XMP packet once the two patterns above have run. */
const XMP_GPS_RESIDUE = /:gps/i;

/** `©xyz`, the QuickTime location atom a motion-photo video carries. */
const QT_XYZ = [0xa9, 0x78, 0x79, 0x7a];

/** Bytes per TIFF value type, indexed by type code. 0 marks a type we do not size. */
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

/** A byte range inside the TIFF block. */
interface Range {
  at: number;
  len: number;
}

/**
 * Thrown when a photo carries an EXIF block this cannot walk.
 *
 * Fail closed, for the same reason §9.7 fails closed on a JPEG whose markers do
 * not parse: a block that cannot be walked is one nobody can assert carries no
 * coordinate. Silently passing it through would make the flag's one promise
 * conditional on the file being well formed, which is exactly the file it would
 * not hold for.
 */
export class ExifScrubError extends Error {
  constructor(reason: string) {
    super(`cannot scrub EXIF: ${reason}`);
    this.name = 'ExifScrubError';
  }
}

/** What a scrub did, for a report and for a test to assert on. */
export interface GpsScrubResult {
  bytes: Uint8Array;
  /** True when a coordinate was found and removed, from EXIF, XMP or the trailer. */
  removed: boolean;
}

/**
 * Strip every GPS coordinate from `bytes`: the EXIF GPS IFD, XMP GPS
 * properties, and the same again in every image after EOI (the module comment
 * has the full list).
 *
 * Returns the original array when there was nothing to do, so a caller can use
 * identity to mean "unchanged" and the operation is idempotent by construction.
 * Nothing moves: the entropy-coded scan, every segment and every byte after EOI
 * keep their offsets, and only the bytes that held a coordinate change.
 */
export function scrubGps(bytes: Uint8Array): GpsScrubResult {
  const main = parseJpegSegments(bytes);
  const out = Uint8Array.from(bytes);
  let removed = scrubImage(out, 0, main.segments);

  // The trailer: every embedded JPEG is scrubbed as an image of its own, and the
  // bytes between them, which no image walk covers, are searched on their own.
  let p = main.trailerStart;
  let loose = p;
  while (p + 3 <= out.length) {
    if (out[p] === 0xff && out[p + 1] === 0xd8 && out[p + 2] === 0xff) {
      let inner: JpegLayout | null = null;
      try {
        inner = parseJpegSegments(out.subarray(p));
      } catch (err) {
        if (!(err instanceof JpegStructureError)) throw err;
      }
      if (inner) {
        if (scrubLoose(out, loose, p)) removed = true;
        if (scrubImage(out, p, inner.segments)) removed = true;
        p += inner.trailerStart;
        loose = p;
        continue;
      }
    }
    p++;
  }
  if (scrubLoose(out, loose, out.length)) removed = true;

  return removed ? { bytes: out, removed } : { bytes, removed: false };
}

/**
 * Scrub one JPEG's APP1 blocks in place: the EXIF GPS IFD, and the GPS
 * properties in its XMP. `base` is where the image starts in `out`, and
 * `segments` are relative to it. True when anything changed.
 */
function scrubImage(out: Uint8Array, base: number, segments: readonly JpegSegment[]): boolean {
  const view = out.subarray(base);
  let removed = false;
  const extended: Range[] = [];
  for (const seg of segments) {
    if (seg.marker !== 0xe1) continue;
    if (payloadStartsWith(view, seg, P_EXIF)) {
      // The TIFF block starts after `Exif\0\0`; all its offsets are relative to it.
      const at = seg.payloadStart + P_EXIF.length;
      if (seg.end - at < 8) throw new ExifScrubError('EXIF payload too short for a TIFF header');
      if (scrubTiff(out, base + at, base + seg.end)) removed = true;
    } else if (payloadStartsWith(view, seg, P_XMP)) {
      const at = seg.payloadStart + P_XMP.length;
      if (scrubXmp(out, [{ at: base + at, len: seg.end - at }])) removed = true;
    } else if (payloadStartsWith(view, seg, P_XMP_EXT)) {
      const at = seg.payloadStart + P_XMP_EXT.length;
      if (seg.end - at < XMP_EXT_HEADER) throw new ExifScrubError('Extended XMP chunk too short');
      extended.push({ at: base + at, len: seg.end - at });
    }
  }
  if (extended.length > 0) {
    // One text, in chunk-offset order, so a property cut across two chunks is
    // read whole. The offset is the u32 after the 32-byte GUID and the length.
    const offsetOf = (r: Range): number => {
      const o = r.at + 36;
      return ((out[o]! << 24) | (out[o + 1]! << 16) | (out[o + 2]! << 8) | out[o + 3]!) >>> 0;
    };
    const chunks = [...extended]
      .sort((a, b) => offsetOf(a) - offsetOf(b))
      .map((r) => ({ at: r.at + XMP_EXT_HEADER, len: r.len - XMP_EXT_HEADER }));
    if (scrubXmp(out, chunks)) removed = true;
  }
  return removed;
}

/**
 * Overwrite every GPS property in one XMP text with spaces, in place.
 *
 * `pieces` are the byte ranges that together make the text, in order. It is read
 * as Latin-1, one character per byte, so a match's position is a byte count: the
 * XML syntax the patterns rely on is all ASCII, and a multi-byte UTF-8 value
 * inside a match is blanked with the rest of it. Refuses if anything naming a
 * GPS property survives, which means a packet shaped in a way the patterns did
 * not anticipate, and so one nobody can assert is clean.
 */
function scrubXmp(out: Uint8Array, pieces: readonly Range[]): boolean {
  const where: number[] = [];
  for (const r of pieces) for (let i = 0; i < r.len; i++) where.push(r.at + i);
  const read = (): string => where.map((at) => String.fromCharCode(out[at]!)).join('');

  let removed = false;
  // Elements first, so an element's own attributes go with it, then attributes.
  for (const pattern of [XMP_GPS_ELEMENT, XMP_GPS_ATTR]) {
    for (const m of read().matchAll(pattern)) {
      for (let i = 0; i < m[0].length; i++) out[where[m.index + i]!] = 0x20;
      removed = true;
    }
  }
  if (XMP_GPS_RESIDUE.test(read())) {
    throw new ExifScrubError('an XMP packet names a GPS property in a form this cannot remove');
  }
  return removed;
}

/**
 * Trailer bytes from `from` to `to` that no embedded image covers: an XMP packet
 * is scrubbed, a QuickTime `©xyz` atom is zeroed, and an EXIF block is refused,
 * because there is no image structure around it to walk.
 */
function scrubLoose(out: Uint8Array, from: number, to: number): boolean {
  if (to <= from) return false;
  if (indexOf(out, P_EXIF, from, to) >= 0) {
    throw new ExifScrubError('an EXIF block after the image is not inside a JPEG this can walk');
  }
  let removed = false;
  const open = bytesOf('<x:xmpmeta');
  const close = bytesOf('</x:xmpmeta>');
  for (let p = indexOf(out, open, from, to); p >= 0; p = indexOf(out, open, p + 1, to)) {
    const end = indexOf(out, close, p, to);
    const stop = end < 0 ? to : end + close.length;
    if (scrubXmp(out, [{ at: p, len: stop - p }])) removed = true;
  }
  // `©xyz` is a box: a u32 size, the type, a u16 string length and a u16
  // language, then the string. Checked for exactly that shape, so four bytes of
  // compressed video that happen to spell the type are left alone.
  for (let p = indexOf(out, QT_XYZ, from, to); p >= 0; p = indexOf(out, QT_XYZ, p + 1, to)) {
    if (p < from + 4 || p + 8 > to) continue;
    const size =
      ((out[p - 4]! << 24) | (out[p - 3]! << 16) | (out[p - 2]! << 8) | out[p - 1]!) >>> 0;
    const len = (out[p + 4]! << 8) | out[p + 5]!;
    if (size !== 12 + len || p - 4 + size > to) continue;
    const text = out.subarray(p + 8, p + 8 + len);
    if (text.some((b) => b !== 0)) {
      text.fill(0);
      removed = true;
    }
  }
  return removed;
}

/** First index of `needle` in `hay[from, to)`, or -1. */
function indexOf(
  hay: Uint8Array,
  needle: readonly number[] | Uint8Array,
  from: number,
  to: number,
): number {
  outer: for (let i = from; i + needle.length <= to; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

/** ASCII to bytes. */
function bytesOf(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

/**
 * Scrub one TIFF block in place. True when it held a GPS IFD.
 *
 * `from`/`to` bound the block inside `out`. The walk finishes before the first
 * write, so editing the buffer it reads from is safe.
 */
function scrubTiff(out: Uint8Array, from: number, to: number): boolean {
  const tiff = out.subarray(from, to);
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  const be = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!le && !be) throw new ExifScrubError('EXIF block has no byte-order mark');
  const u16 = (o: number): number =>
    le ? tiff[o]! | (tiff[o + 1]! << 8) : (tiff[o]! << 8) | tiff[o + 1]!;
  const u32 = (o: number): number =>
    (le
      ? tiff[o]! | (tiff[o + 1]! << 8) | (tiff[o + 2]! << 16) | (tiff[o + 3]! << 24)
      : (tiff[o]! << 24) | (tiff[o + 1]! << 16) | (tiff[o + 2]! << 8) | tiff[o + 3]!) >>> 0;
  if (u16(2) !== 42) throw new ExifScrubError('EXIF block is not TIFF (magic is not 42)');

  /** Where each GPS pointer sits: the IFD holding it, and the entry's offset. */
  const pointers: { ifd: number; entry: number; target: number }[] = [];
  /** Value ranges of everything that is NOT GPS, so a shared value is never zeroed. */
  const keep: Range[] = [];
  /** The GPS IFDs themselves, and the value ranges they address. */
  const drop: Range[] = [];

  const seen = new Set<number>();
  const queue: { at: number; gps: boolean }[] = [{ at: u32(4), gps: false }];
  while (queue.length > 0) {
    const { at: ifd, gps } = queue.shift()!;
    // A malformed file can point an IFD at itself, or at one already walked;
    // visiting each offset once bounds the walk without trusting the file.
    if (ifd <= 0 || ifd + 2 > tiff.length || seen.has(ifd)) continue;
    seen.add(ifd);
    const count = u16(ifd);
    // 2 count bytes, `count` 12-byte entries, then a 4-byte next-IFD offset.
    if (ifd + 2 + count * 12 + 4 > tiff.length) {
      throw new ExifScrubError('an IFD runs past the end of the EXIF block');
    }
    if (gps) drop.push({ at: ifd, len: 2 + count * 12 + 4 });

    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const n = u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 0) * n;
      // A value of four bytes or fewer is inlined in the entry, so it has no
      // range of its own and goes with the entry either way.
      const outOfLine = size > 4;
      const valueAt = outOfLine ? u32(e + 8) : -1;
      if (outOfLine && (valueAt < 0 || valueAt + size > tiff.length)) {
        throw new ExifScrubError('a tag value runs past the end of the EXIF block');
      }

      if (!gps && tag === TAG_GPS_IFD) {
        pointers.push({ ifd, entry: e, target: u32(e + 8) });
        queue.push({ at: u32(e + 8), gps: true });
        continue;
      }
      if (!gps && tag === TAG_EXIF_IFD) queue.push({ at: u32(e + 8), gps: false });
      if (outOfLine) (gps ? drop : keep).push({ at: valueAt, len: size });
    }
    // The next IFD in the chain (IFD1, the thumbnail) is never a GPS IFD.
    if (!gps) queue.push({ at: u32(ifd + 2 + count * 12), gps: false });
  }

  if (pointers.length === 0) return false;

  const write = (o: number, v: number, wide: boolean): void => {
    const base = from + o;
    if (wide) {
      out[base + (le ? 0 : 3)] = v & 0xff;
      out[base + (le ? 1 : 2)] = (v >>> 8) & 0xff;
      out[base + (le ? 2 : 1)] = (v >>> 16) & 0xff;
      out[base + (le ? 3 : 0)] = (v >>> 24) & 0xff;
    } else {
      out[base + (le ? 0 : 1)] = v & 0xff;
      out[base + (le ? 1 : 0)] = (v >>> 8) & 0xff;
    }
  };

  // The GPS IFD and its values, gone from the bytes and not merely unreachable.
  // A range another tag also addresses is left alone: no sane encoder shares a
  // value between the GPS block and anything else, and zeroing one would corrupt
  // a tag this has no business touching.
  for (const r of drop) {
    if (keep.some((k) => k.at < r.at + r.len && r.at < k.at + k.len)) continue;
    out.fill(0, from + r.at, from + r.at + r.len);
  }

  // Then the pointer entries, removed from their IFDs. Later entries shift down
  // by twelve bytes, the next-IFD offset with them, and the twelve bytes freed
  // at the end are zeroed and abandoned: the block keeps its length, so every
  // absolute offset in it, including the ones inside a maker note, stays true.
  for (const p of [...pointers].sort((a, b) => b.entry - a.entry)) {
    const count = u16(p.ifd);
    const tailFrom = p.entry + 12;
    const tailTo = p.ifd + 2 + count * 12 + 4;
    out.copyWithin(from + p.entry, from + tailFrom, from + tailTo);
    out.fill(0, from + tailTo - 12, from + tailTo);
    write(p.ifd, count - 1, false);
  }
  return true;
}

/** True when `bytes` still carries a GPS IFD pointer. For tests and reports. */
export function hasGps(bytes: Uint8Array): boolean {
  try {
    const layout = parseJpegSegments(bytes);
    for (const seg of layout.segments) {
      if (seg.marker !== 0xe1 || !payloadStartsWith(bytes, seg, P_EXIF)) continue;
      const tiff = bytes.subarray(seg.payloadStart + P_EXIF.length, seg.end);
      if (tiff.length < 8) continue;
      const le = tiff[0] === 0x49 && tiff[1] === 0x49;
      const u16 = (o: number): number =>
        le ? tiff[o]! | (tiff[o + 1]! << 8) : (tiff[o]! << 8) | tiff[o + 1]!;
      const u32 = (o: number): number =>
        (le
          ? tiff[o]! | (tiff[o + 1]! << 8) | (tiff[o + 2]! << 16) | (tiff[o + 3]! << 24)
          : (tiff[o]! << 24) | (tiff[o + 1]! << 16) | (tiff[o + 2]! << 8) | tiff[o + 3]!) >>> 0;
      const ifd = u32(4);
      if (ifd <= 0 || ifd + 2 > tiff.length) continue;
      const count = u16(ifd);
      if (ifd + 2 + count * 12 > tiff.length) continue;
      for (let i = 0; i < count; i++) {
        if (u16(ifd + 2 + i * 12) === TAG_GPS_IFD) return true;
      }
    }
    return false;
  } catch (err) {
    if (err instanceof JpegStructureError) return false;
    throw err;
  }
}
