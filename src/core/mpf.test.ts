/**
 * The MPF index reader and the offset rewrite (SPEC §9.7.1).
 *
 * Two things are being tested, and the second is the reason the first exists.
 *
 * The rewrite is four lines of arithmetic over numbers read out of a TIFF
 * structure inside an APP2 segment, and getting it wrong does not throw: it
 * produces a photo that opens, renders, and has lost its gain map. So the
 * positive cases assert on the *resolved bytes* rather than on the numbers, by
 * following the rewritten offset and comparing what is there to the gain map
 * that went in.
 *
 * The reader's refusals get the same attention as its successes. Every field it
 * reads comes from the file, the file may be hostile or merely broken, and the
 * answer for anything it cannot make sense of has to be "no index" rather than a
 * plausible-looking number: the callers turn that into a refusal, and a wrong
 * number would instead move a trailer under offsets nobody checked.
 */

import { describe, expect, it } from 'vitest';
import {
  baseJpeg,
  gainMapTrailer,
  mpfEntryOffsetField,
  mpfEntrySizeField,
  mpfIndexSegment,
  mpfSegment,
  pokeMpfIndex as poke,
  spliceBeforeSos,
  withMpfGainMap,
  withTrailer,
} from './jpeg-fixtures';
import { parseJpegSegments } from './jpeg-segments';
import { mpfTrailerLink, parseMpfIndex, retargetMpfIndex } from './mpf';

const gainMap = gainMapTrailer();

/** An Ultra HDR file, and the numbers a test needs about it. */
function ultraHdr(littleEndian = false) {
  const bytes = withMpfGainMap(baseJpeg(64, 64), littleEndian);
  const link = mpfTrailerLink(bytes);
  if (link.kind !== 'index') throw new Error(`fixture link is ${link.kind}`);
  return { bytes, link, trailerStart: parseJpegSegments(bytes).trailerStart };
}

/**
 * Simulate an embed that made the scan `grow` bytes longer, without running one:
 * the byte-stuffing drift an embed produces is one or two bytes and depends on
 * the keyed carrier positions, so a test that wanted a specific delta from a real
 * embed would be asserting on a coincidence.
 */
function growScan(file: Uint8Array, grow: number): Uint8Array {
  const eoi = parseJpegSegments(file).trailerStart - 2;
  const out = new Uint8Array(file.length + grow);
  out.set(file.subarray(0, eoi));
  out.set(file.subarray(eoi), eoi + grow);
  return out;
}

describe('parseMpfIndex', () => {
  it.each([
    ['big-endian', false],
    ['little-endian', true],
  ])('reads a %s index and locates the gain map', (_name, little) => {
    const { bytes, trailerStart } = ultraHdr(little);
    const index = parseMpfIndex(bytes)!;

    expect(index.littleEndian).toBe(little);
    expect(index.entries).toHaveLength(2);
    // The primary image: offset 0 by definition, size spanning SOI to EOI.
    expect(index.entries[0]!.offset).toBe(0);
    expect(index.entries[0]!.size).toBe(trailerStart);
    // The gain map, at an offset measured from the endian header.
    expect(index.entries[1]!.size).toBe(gainMap.length);
    const at = index.endianAt + index.entries[1]!.offset;
    expect(at).toBe(trailerStart);
    expect([...bytes.subarray(at, at + gainMap.length)]).toEqual([...gainMap]);
  });

  it('answers null for a JPEG with no MPF segment, and for bytes that are not one', () => {
    expect(parseMpfIndex(baseJpeg(32, 32))).toBeNull();
    expect(parseMpfIndex(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });

  /**
   * One case per field the reader validates. Each is a real file with one thing
   * changed, so a check that stopped happening fails here rather than in the
   * caller that trusted the number.
   */
  it.each([
    ['a byte order that is neither II nor MM', (f: Uint8Array) => poke(f, 0, 0x58, 0x58)],
    ['a TIFF magic that is not 42', (f: Uint8Array) => poke(f, 2, 0x00, 0x2b)],
    ['an IFD offset inside the header', (f: Uint8Array) => poke(f, 4, 0, 0, 0, 4)],
    ['an IFD offset past the segment', (f: Uint8Array) => poke(f, 4, 0xff, 0xff, 0xff, 0xff)],
    ['an IFD tag count of zero', (f: Uint8Array) => poke(f, 8, 0, 0)],
    ['an IFD tag count past the segment', (f: Uint8Array) => poke(f, 8, 0xff, 0xff)],
    ['no MPEntry tag at all', (f: Uint8Array) => poke(f, 34, 0xb0, 0x05)],
    ['an entry array that is not whole records', (f: Uint8Array) => poke(f, 38, 0, 0, 0, 18)],
    ['an entry array of zero length', (f: Uint8Array) => poke(f, 38, 0, 0, 0, 0)],
    ['more images than any MPO carries', (f: Uint8Array) => poke(f, 38, 0, 0, 0x04, 0x00)],
    ['an entry array inside the header', (f: Uint8Array) => poke(f, 42, 0, 0, 0, 4)],
    ['an entry array past the segment', (f: Uint8Array) => poke(f, 42, 0, 0, 0xff, 0x00)],
  ])('answers null for %s', (_what, break_) => {
    const { bytes } = ultraHdr();
    // The fixture itself must parse, or a broken `poke` would pass vacuously.
    expect(parseMpfIndex(bytes)).not.toBeNull();
    expect(parseMpfIndex(break_(bytes))).toBeNull();
  });

  it('answers null for an index with a header and nothing behind it', () => {
    // The shape `mpfSegment` builds: enough to classify the segment, not enough
    // to rewrite. Distinguishing the two is the whole point of the reader.
    expect(parseMpfIndex(spliceBeforeSos(baseJpeg(32, 32), mpfSegment()))).toBeNull();
  });
});

describe('mpfTrailerLink', () => {
  it('is none when no index locates anything', () => {
    // No MPF segment at all, and an MPF index with nothing after EOI: neither
    // has an offset that a shift could invalidate.
    expect(mpfTrailerLink(withTrailer(baseJpeg(32, 32), gainMap)).kind).toBe('none');
    expect(mpfTrailerLink(spliceBeforeSos(baseJpeg(32, 32), mpfIndexSegment())).kind).toBe('none');
    expect(mpfTrailerLink(new Uint8Array([0xff, 0xd8, 0xff])).kind).toBe('none');
  });

  it('carries the geometry of a file whose index locates a trailer', () => {
    const { bytes, trailerStart } = ultraHdr();
    const link = mpfTrailerLink(bytes);
    expect(link).toMatchObject({ kind: 'index', trailerStart, length: bytes.length });
  });

  it('is unreadable when an index it cannot read locates a trailer', () => {
    const broken = withTrailer(spliceBeforeSos(baseJpeg(32, 32), mpfSegment()), gainMap);
    const link = mpfTrailerLink(broken);
    expect(link.kind).toBe('unreadable');
    // The reason is what a caller prints, so it has to say what is wrong.
    expect(link.kind === 'unreadable' && link.reason).toMatch(/could not be read/);
  });
});

describe('retargetMpfIndex', () => {
  it.each([
    ['big-endian', false],
    ['little-endian', true],
  ])('follows the trailer of a %s file, and the gain map still resolves', (_name, little) => {
    const { bytes, link } = ultraHdr(little);
    const grown = growScan(bytes, 3);

    expect(retargetMpfIndex(grown, link)).toEqual({ ok: true, rewritten: 2 });

    const after = parseMpfIndex(grown)!;
    const layout = parseJpegSegments(grown);
    expect(layout.trailerStart).toBe(link.trailerStart + 3);
    // The assertion that matters: follow the offset and find the gain map.
    const at = after.endianAt + after.entries[1]!.offset;
    expect(at).toBe(layout.trailerStart);
    expect([...grown.subarray(at, at + gainMap.length)]).toEqual([...gainMap]);
    // And the primary image's size is the trailer's new position.
    expect(after.entries[0]!.size).toBe(layout.trailerStart);
    // The gain map itself was never touched.
    expect([...grown.subarray(layout.trailerStart)]).toEqual([...gainMap]);
  });

  it('writes nothing when the trailer did not move', () => {
    // The common embed: the re-stuffed scan comes out the same length. Rewriting
    // a field to the value it already holds would change the head for no reason,
    // so "the file is already correct" has to be a no-op, not a no-change write.
    const { bytes, link } = ultraHdr();
    const copy = Uint8Array.from(bytes);
    expect(retargetMpfIndex(copy, link)).toEqual({ ok: true, rewritten: 0 });
    expect([...copy]).toEqual([...bytes]);
  });

  it('leaves a primary size that was already wrong alone, and still fixes the offset', () => {
    // A producer whose own number disagreed with its own file meant something
    // this cannot infer. Turning one wrong value into a different wrong value is
    // not a repair, so only the offset moves.
    const { bytes, link } = ultraHdr();
    const odd = poke(bytes, mpfEntrySizeField(0), 0, 0, 0, 9);
    const grown = growScan(odd, 2);
    expect(retargetMpfIndex(grown, link)).toEqual({ ok: true, rewritten: 1 });
    const after = parseMpfIndex(grown)!;
    expect(after.entries[0]!.size).toBe(9);
    expect(after.endianAt + after.entries[1]!.offset).toBe(parseJpegSegments(grown).trailerStart);
  });

  it('refuses an entry that does not locate the trailer', () => {
    // Either the producer measured from somewhere other than the endian header,
    // or the index was already pointing outside its own file. Both are numbers
    // whose meaning would be a guess, and a guess here silently breaks a photo.
    const { bytes, link } = ultraHdr();
    for (const offset of [
      [0, 0, 0, 0x10],
      [0xff, 0xff, 0x00, 0x00],
    ]) {
      const odd = poke(bytes, mpfEntryOffsetField(1), ...offset);
      const res = retargetMpfIndex(growScan(odd, 2), link);
      expect(res.ok).toBe(false);
      expect(!res.ok && res.reason).toMatch(/MPF entry 2/);
    }
  });

  it('refuses when the index cannot be read back out of the edited file', () => {
    const { link } = ultraHdr();
    const notAJpeg = retargetMpfIndex(new Uint8Array([0xff, 0xd8, 0xff]), link);
    expect(notAJpeg.ok).toBe(false);
    expect(!notAJpeg.ok && notAJpeg.reason).toMatch(/no longer parses/);

    const noIndex = retargetMpfIndex(baseJpeg(32, 32), link);
    expect(noIndex.ok).toBe(false);
    expect(!noIndex.ok && noIndex.reason).toMatch(/could not be read after the edit/);
  });

  it('leaves the file untouched when it refuses', () => {
    // The writes are held until every entry has been checked, so a refusal never
    // leaves a half-rewritten index behind.
    const { bytes, link } = ultraHdr();
    const odd = growScan(poke(bytes, mpfEntryOffsetField(1), 0, 0, 0, 0x10), 2);
    const before = Uint8Array.from(odd);
    expect(retargetMpfIndex(odd, link).ok).toBe(false);
    expect([...odd]).toEqual([...before]);
  });
});
