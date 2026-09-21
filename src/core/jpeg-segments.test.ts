/**
 * The marker-segment parser: what it maps, and what it refuses.
 *
 * The refusals carry as much weight as the mapping here. This module decides
 * which bytes another module is allowed to delete, so a parser that guesses on a
 * malformed file is a parser that deletes the wrong range. Every failure path
 * below is a case where the honest answer is "I cannot tell", and the test
 * asserts that it is given rather than worked around.
 */

import { describe, expect, it } from 'vitest';
import {
  JpegStructureError,
  classifyTrailer,
  hasSoi,
  parseJpegSegments,
  payloadStartsWith,
  segmentPayload,
} from './jpeg-segments';
import {
  appSegment,
  baseJpeg,
  c2paSegment,
  gainMapTrailer,
  mp4Trailer,
  mpfSegment,
  spliceAfterSoi,
  spliceBeforeSos,
  withC2pa,
  withTrailer,
} from './jpeg-fixtures';
import { JUMBF_APP11_PREFIX } from './normalize';

const APP11 = 0xeb;

describe('parseJpegSegments', () => {
  it('maps a plain baseline JPEG: segments, SOS, and EOI at the end', () => {
    const jpg = baseJpeg(64, 64);
    const layout = parseJpegSegments(jpg);
    expect(layout.segments.length).toBeGreaterThan(2);
    expect(layout.sosStart).toBeGreaterThan(2);
    expect(jpg[layout.sosStart]).toBe(0xff);
    expect(jpg[layout.sosStart + 1]).toBe(0xda);
    // Nothing follows EOI on a bare file, so the trailer is empty.
    expect(layout.trailerStart).toBe(jpg.length);
    expect(layout.length).toBe(jpg.length);
  });

  it('every segment is framed correctly and none overlaps the scan', () => {
    const layout = parseJpegSegments(withC2pa(baseJpeg(64, 64), 2));
    for (const seg of layout.segments) {
      expect(seg.payloadStart).toBe(seg.start + 4);
      expect(seg.end).toBeGreaterThan(seg.payloadStart);
      // SOS is the last segment; nothing may be mapped inside the entropy data.
      if (seg.marker !== 0xda) expect(seg.end).toBeLessThanOrEqual(layout.sosStart);
    }
  });

  /**
   * The case the removal rule exists for: a manifest too large for one segment
   * is split, and each fragment repeats the prefix. A reader that stops at the
   * first one leaves the rest of the manifest in the file.
   */
  it('finds every fragment of a manifest split across segments', () => {
    const jpg = withC2pa(baseJpeg(64, 64), 4);
    const layout = parseJpegSegments(jpg);
    const fragments = layout.segments.filter(
      (s) => s.marker === APP11 && payloadStartsWith(jpg, s, JUMBF_APP11_PREFIX),
    );
    expect(fragments).toHaveLength(4);
    // In file order, and each one's payload really does start with the prefix.
    for (const f of fragments) {
      expect([...segmentPayload(jpg, f).subarray(0, 2)]).toEqual([...JUMBF_APP11_PREFIX]);
    }
  });

  it('keeps an APP11 that is not JUMBF distinguishable from one that is', () => {
    const jpg = spliceBeforeSos(baseJpeg(64, 64), appSegment(APP11, new Uint8Array([0x58, 0x58])));
    const layout = parseJpegSegments(jpg);
    const app11 = layout.segments.filter((s) => s.marker === APP11);
    expect(app11).toHaveLength(1);
    expect(payloadStartsWith(jpg, app11[0]!, JUMBF_APP11_PREFIX)).toBe(false);
  });

  it('records segment order, so a removal can be placed relative to the MPF index', () => {
    // C2PA after SOI, MPF before SOS: the manifest precedes the index.
    const safe = spliceBeforeSos(spliceAfterSoi(baseJpeg(64, 64), c2paSegment(1)), mpfSegment());
    const layout = parseJpegSegments(safe);
    const c2pa = layout.segments.find((s) => s.marker === APP11)!;
    const mpf = layout.segments.find((s) => s.marker === 0xe2)!;
    expect(c2pa.start).toBeLessThan(mpf.start);
  });

  describe('refuses rather than guesses', () => {
    it.each([
      ['no SOI', new Uint8Array([0x00, 0x01, 0x02, 0x03])],
      [
        'a segment length that runs past the end',
        new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]),
      ],
      [
        'a length below the two bytes it occupies',
        new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]),
      ],
      ['a byte where a marker must be', new Uint8Array([0xff, 0xd8, 0x41, 0x41, 0x41, 0x41])],
    ])('%s', (_label, bytes) => {
      expect(() => parseJpegSegments(bytes)).toThrow(JpegStructureError);
    });

    it('a file truncated before EOI', () => {
      const jpg = baseJpeg(64, 64);
      expect(() => parseJpegSegments(jpg.subarray(0, jpg.length - 8))).toThrow(JpegStructureError);
    });

    it('a header with no scan at all', () => {
      // SOI, one well-formed APP0, then EOI: nothing was ever encoded.
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
      expect(() => parseJpegSegments(bytes)).toThrow(JpegStructureError);
    });

    it('names the file position, so a failure is actionable', () => {
      const bytes = new Uint8Array([0xff, 0xd8, 0x41, 0x41, 0x41, 0x41]);
      expect(() => parseJpegSegments(bytes)).toThrow(/offset 2/);
    });
  });
});

describe('hasSoi', () => {
  it('accepts a JPEG and rejects everything else', () => {
    expect(hasSoi(baseJpeg(32, 32))).toBe(true);
    expect(hasSoi(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    // Too short to be anything, and must not read past the buffer.
    expect(hasSoi(new Uint8Array([0xff, 0xd8]))).toBe(false);
    expect(hasSoi(new Uint8Array(0))).toBe(false);
  });
});

describe('classifyTrailer', () => {
  it('reports none when EOI ends the file', () => {
    const jpg = baseJpeg(32, 32);
    const { trailerStart } = parseJpegSegments(jpg);
    expect(classifyTrailer(jpg, trailerStart)).toBe('none');
  });

  it('tells an Ultra HDR gain map from a motion-photo video', () => {
    const base = baseJpeg(32, 32);
    const mpo = withTrailer(base, gainMapTrailer());
    const mp4 = withTrailer(base, mp4Trailer());
    expect(classifyTrailer(mpo, parseJpegSegments(mpo).trailerStart)).toBe('mpo');
    expect(classifyTrailer(mp4, parseJpegSegments(mp4).trailerStart)).toBe('mp4');
  });

  /**
   * Some producers pad between EOI and the video. A padded MP4 is still an MP4,
   * and calling it 'unknown' would send the caller down the branch for bytes
   * nobody can account for.
   */
  it('finds a padded ftyp box', () => {
    const padded = new Uint8Array(32 + mp4Trailer().length);
    padded.set(mp4Trailer(), 32);
    const file = withTrailer(baseJpeg(32, 32), padded);
    expect(classifyTrailer(file, parseJpegSegments(file).trailerStart)).toBe('mp4');
  });

  /**
   * The mirror of the padded `ftyp` above. Requiring `FF D8` at exactly the
   * trailer start made a padded MPO the one padded trailer called 'unknown', so
   * a set of Ultra HDR photos from two producers reported a trailer-kind
   * difference the photos do not have.
   */
  it('finds a gain map that starts after padding', () => {
    const gainMap = gainMapTrailer();
    const padded = new Uint8Array(2 + gainMap.length);
    padded.set(gainMap, 2);
    const file = withTrailer(baseJpeg(32, 32), padded);
    expect(classifyTrailer(file, parseJpegSegments(file).trailerStart)).toBe('mpo');

    // `FF` ahead of a marker is legal JPEG fill, not padding to skip over.
    const filled = new Uint8Array(1 + gainMap.length);
    filled[0] = 0xff;
    filled.set(gainMap, 1);
    const withFill = withTrailer(baseJpeg(32, 32), filled);
    expect(classifyTrailer(withFill, parseJpegSegments(withFill).trailerStart)).toBe('mpo');
  });

  it('reports unknown for bytes that are neither', () => {
    const file = withTrailer(baseJpeg(32, 32), new Uint8Array(64).fill(0x5a));
    expect(classifyTrailer(file, parseJpegSegments(file).trailerStart)).toBe('unknown');
  });
});
