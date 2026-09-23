/**
 * Remove the EXIF GPS block from a JPEG, in place, without moving a byte.
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
 */

import { JpegStructureError, parseJpegSegments, payloadStartsWith } from './jpeg-segments';

/** `Exif\0\0`: the APP1 payload prefix that introduces a TIFF block. */
const P_EXIF = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];

/** GPS IFD pointer, in IFD0. The block it points at is what this removes. */
const TAG_GPS_IFD = 0x8825;

/** EXIF IFD pointer: followed, because a stray GPS pointer can sit inside it. */
const TAG_EXIF_IFD = 0x8769;

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
  /** True when a GPS block was found and removed. */
  removed: boolean;
}

/**
 * Strip the GPS IFD from every EXIF block in `bytes`.
 *
 * Returns the original array when there was nothing to do, so a caller can use
 * identity to mean "unchanged" and the operation is idempotent by construction.
 * Only the TIFF block is touched: the entropy-coded scan, every other segment
 * and every byte after EOI are left exactly where they were.
 */
export function scrubGps(bytes: Uint8Array): GpsScrubResult {
  const layout = parseJpegSegments(bytes);
  const app1 = layout.segments.filter(
    (s) => s.marker === 0xe1 && payloadStartsWith(bytes, s, P_EXIF),
  );
  if (app1.length === 0) return { bytes, removed: false };

  let out: Uint8Array | null = null;
  let removed = false;
  for (const seg of app1) {
    // The TIFF block starts after `Exif\0\0`; all its offsets are relative to it.
    const at = seg.payloadStart + P_EXIF.length;
    const end = seg.end;
    if (end - at < 8) throw new ExifScrubError('EXIF payload too short for a TIFF header');
    // Copy once, on the first block that actually carries a coordinate.
    const scratch = out ?? bytes;
    const edited = scrubTiff(scratch, at, end);
    if (edited) {
      out = edited;
      removed = true;
    }
  }
  return out ? { bytes: out, removed } : { bytes, removed: false };
}

/**
 * Scrub one TIFF block, returning a new buffer, or null when it holds no GPS.
 *
 * `from`/`to` bound the block inside the whole file, so the returned buffer is
 * the whole file with that range edited.
 */
function scrubTiff(bytes: Uint8Array, from: number, to: number): Uint8Array | null {
  const tiff = bytes.subarray(from, to);
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

  if (pointers.length === 0) return null;

  const out = Uint8Array.from(bytes);
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
  return out;
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
