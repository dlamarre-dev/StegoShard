/**
 * Cover normalization (SPEC §9.7): what comes out, what stays, and what refuses.
 *
 * THE CENTRAL ASSERTION IS AT THE DCT LEVEL, NOT THE PIXEL LEVEL
 * "The image is unchanged" is not the property that matters here. Normalization
 * runs immediately before an embed that hides bits in quantized AC coefficients,
 * so what has to hold is that those coefficients are **bit-identical** across it.
 * A pixel comparison would pass on a file that had been re-quantized, which is
 * exactly the failure that would silently destroy a payload. So the test decodes
 * both sides to coefficients and compares block by block.
 *
 * WHAT THESE FIXTURES CANNOT TELL US
 * They are synthesised (`jpeg-fixtures.ts`), so they exercise every branch and
 * prove nothing about what a Pixel 10, an iPhone or a Leica actually writes. The
 * repo holds no photo with a real manifest: the five camera JPEGs under
 * `tests/steganalysis/covers-jpeg/` were run through `jpegtran -copy none`, which
 * stripped every metadata marker (see their PROVENANCE.md). The opt-in suite
 * under `tests/provenance/` is what closes that gap, against a directory of real
 * photos and a third-party C2PA verifier.
 */

import { describe, expect, it } from 'vitest';
import { decode as decodeJpeg } from './jpeg-coeff';
import { JpegStructureError } from './jpeg-segments';
import {
  ProvenanceNormalizeError,
  inspectCoverSet,
  inspectJpegCover,
  isHeif,
  normalizeCoverBytes,
  normalizeJpegCover,
} from './normalize';
import {
  adobeSegment,
  baseJpeg,
  c2paSegment,
  commentSegment,
  exifSegment,
  exifSegmentLE,
  foreignApp11,
  gainMapTrailer,
  heicHeader,
  iccSegment,
  iptcSegment,
  jumbfSegment,
  mp4Trailer,
  mpfSegment,
  pixelXmp,
  spliceAfterSoi,
  spliceBeforeSos,
  unknownAppSegment,
  withC2pa,
  withTrailer,
  xmpExtensionSegment,
} from './jpeg-fixtures';

/** Every quantized coefficient, component by component, block by block. */
function coefficients(bytes: Uint8Array): number[] {
  const model = decodeJpeg(bytes);
  const out: number[] = [];
  for (const comp of model.components) {
    for (const block of comp.blocks) out.push(...block);
  }
  return out;
}

describe('normalizeJpegCover', () => {
  it('removes every fragment of a manifest, not just the first', () => {
    const jpg = withC2pa(baseJpeg(64, 64), 4);
    expect(inspectJpegCover(jpg).jumbf.segments).toBe(4);

    const { bytes, removed } = normalizeJpegCover(jpg);
    expect(removed.segments).toBe(4);
    expect(removed.bytes).toBeGreaterThan(0);
    expect(bytes.length).toBe(jpg.length - removed.bytes);
    expect(inspectJpegCover(bytes).jumbf.segments).toBe(0);
  });

  /**
   * The reason the prefix is two bytes and not four.
   *
   * The next two bytes of an APP11 JUMBF header are a box *instance number*. The
   * manifests this was built against all use instance 1, so a four-byte match
   * looked right and would have let a manifest at any other instance through.
   * Matching a counter as though it were a magic is the bug; this is its test.
   */
  it('removes a JUMBF box at any instance number, not only instance 1', () => {
    let jpg = baseJpeg(64, 64);
    for (const instance of [0, 2, 7, 0xffff]) {
      jpg = spliceBeforeSos(jpg, jumbfSegment(1, instance));
    }
    expect(inspectJpegCover(jpg).jumbf.segments).toBe(4);
    expect(normalizeJpegCover(jpg).removed.segments).toBe(4);
    expect(inspectJpegCover(normalizeJpegCover(jpg).bytes).classes).not.toContain('jumbf');
  });

  /** The property the whole ordering decision rests on. */
  it('leaves the quantized DCT coefficients bit-identical', () => {
    const clean = baseJpeg(96, 96, 85, 5);
    const dirty = withC2pa(clean, 3);
    const normalized = normalizeJpegCover(dirty).bytes;

    const before = coefficients(clean);
    const after = coefficients(normalized);
    expect(after).toHaveLength(before.length);
    expect(after).toEqual(before);
  });

  it('leaves the entropy-coded scan byte-identical', () => {
    const clean = baseJpeg(64, 64);
    const normalized = normalizeJpegCover(withC2pa(clean, 2)).bytes;
    const a = decodeJpeg(clean);
    const b = decodeJpeg(normalized);
    expect([...normalized.subarray(b.scanStart, b.scanEnd)]).toEqual([
      ...clean.subarray(a.scanStart, a.scanEnd),
    ]);
  });

  it('is idempotent', () => {
    const once = normalizeJpegCover(withC2pa(baseJpeg(64, 64), 2)).bytes;
    const twice = normalizeJpegCover(once);
    expect(twice.removed.segments).toBe(0);
    expect([...twice.bytes]).toEqual([...once]);
  });

  /**
   * Byte-for-byte is asserted by reference identity, which is stronger and is
   * what the implementation promises: a file with nothing to remove is returned,
   * not rebuilt. A copy that happened to be equal would still be a copy, and the
   * next change could make it an unequal one.
   */
  it('returns a file with no manifest completely untouched', () => {
    const clean = baseJpeg(64, 64);
    const res = normalizeJpegCover(clean);
    expect(res.bytes).toBe(clean);
    expect(res.removed).toEqual({ segments: 0, bytes: 0 });
  });

  /**
   * The other side of the widened match: wider does not mean "all of APP11".
   * A segment that is not box carriage at all is left where it is.
   */
  it('leaves an APP11 that is not JUMBF alone', () => {
    const jpg = spliceBeforeSos(baseJpeg(64, 64), foreignApp11());
    expect(normalizeJpegCover(jpg).bytes).toBe(jpg);
    expect(inspectJpegCover(jpg).classes).toContain('other-app');
  });

  it('keeps every other segment, including EXIF and XMP', () => {
    const jpg = withC2pa(
      spliceBeforeSos(spliceAfterSoi(baseJpeg(64, 64), exifSegment()), pixelXmp(512)),
      2,
    );
    const after = inspectJpegCover(normalizeJpegCover(jpg).bytes);
    expect(after.classes).toContain('exif');
    expect(after.classes).toContain('xmp');
    expect(after.classes).not.toContain('jumbf');
  });
});

describe('the trailer after EOI', () => {
  it('survives byte for byte: an Ultra HDR gain map', () => {
    const gainMap = gainMapTrailer();
    const jpg = withTrailer(withC2pa(baseJpeg(64, 64), 2), gainMap);
    const out = normalizeJpegCover(jpg).bytes;
    expect([...out.subarray(out.length - gainMap.length)]).toEqual([...gainMap]);
    expect(inspectJpegCover(out).trailer).toEqual({ kind: 'mpo', bytes: gainMap.length });
  });

  it('survives byte for byte: an Android motion-photo video', () => {
    const video = mp4Trailer(160);
    const jpg = withTrailer(withC2pa(baseJpeg(64, 64), 1), video);
    const out = normalizeJpegCover(jpg).bytes;
    expect([...out.subarray(out.length - video.length)]).toEqual([...video]);
    expect(inspectJpegCover(out).trailer).toEqual({ kind: 'mp4', bytes: video.length });
  });

  /**
   * Ultra HDR declares the gain map's size in the XMP container directory. If
   * normalization ever changed the trailer, the declaration and the bytes would
   * disagree and the file would be visibly broken, so the two are compared.
   */
  it('stays consistent with the Item:Length the XMP container declares', () => {
    const gainMap = gainMapTrailer();
    const jpg = withTrailer(
      withC2pa(spliceBeforeSos(baseJpeg(64, 64), pixelXmp(gainMap.length)), 2),
      gainMap,
    );
    const profile = inspectJpegCover(normalizeJpegCover(jpg).bytes);
    expect(profile.jumbf.segments).toBe(0);
    expect(profile.xmp?.containerDirectory).toBe(true);
    expect(profile.xmp?.itemLengths).toContain(gainMap.length);
    expect(profile.trailer.bytes).toBe(gainMap.length);
  });
});

describe('the MPF offset assertion', () => {
  it('accepts a removal that precedes the MPF index', () => {
    // The real-world order: APP11 early, APP2/MPF later. Both shift together.
    const jpg = spliceBeforeSos(spliceAfterSoi(baseJpeg(64, 64), c2paSegment(1)), mpfSegment());
    const out = normalizeJpegCover(jpg);
    expect(out.removed.segments).toBe(1);
    expect(inspectJpegCover(out.bytes).mpf).toBe(true);
  });

  /**
   * Fails closed rather than emitting an Ultra HDR file whose gain map no longer
   * resolves. Checked rather than assumed: "APP11 comes first in practice" is an
   * observation about the files this was built for, not a guarantee.
   */
  /** An APP11 behind the MPF index, with a gain map for that index to locate. */
  const lateRemovalOverGainMap = (): Uint8Array =>
    withTrailer(
      spliceBeforeSos(spliceAfterSoi(baseJpeg(64, 64), mpfSegment()), c2paSegment(1)),
      gainMapTrailer(),
    );

  it('refuses a removal that follows it', () => {
    const jpg = lateRemovalOverGainMap();
    expect(() => normalizeJpegCover(jpg)).toThrow(ProvenanceNormalizeError);
    expect(() => normalizeJpegCover(jpg)).toThrow(/MPF/);
  });

  it('names the file when the caller supplied a label', () => {
    expect(() => normalizeJpegCover(lateRemovalOverGainMap(), 'IMG_2043.jpg')).toThrow(
      /IMG_2043\.jpg/,
    );
  });

  /**
   * Nothing after EOI means the index locates no second image, so there is no
   * offset for a shift to invalidate. Refusing this file turned away a cover
   * that was never at risk, to protect a gain map that is not in it.
   */
  it('allows a late removal when there is no trailer to break', () => {
    const jpg = spliceBeforeSos(spliceAfterSoi(baseJpeg(64, 64), mpfSegment()), c2paSegment(1));
    const out = normalizeJpegCover(jpg);
    expect(out.removed.segments).toBe(1);
    expect(inspectJpegCover(out.bytes).mpf).toBe(true);
  });
});

describe('malformed input', () => {
  it('refuses a truncated file instead of writing a partial one', () => {
    const jpg = withC2pa(baseJpeg(64, 64), 2);
    expect(() => normalizeJpegCover(jpg.subarray(0, jpg.length - 10))).toThrow(JpegStructureError);
  });

  it('names the file in a structural failure too', () => {
    const jpg = baseJpeg(64, 64);
    expect(() => normalizeJpegCover(jpg.subarray(0, jpg.length - 10), 'broken.jpg')).toThrow(
      /broken\.jpg/,
    );
  });

  /**
   * The embed-path wrapper speaks the embed layer's vocabulary. A JPEG whose
   * structure cannot be walked is one this layer cannot promise carries no
   * manifest, so it must not be embedded into; but the adapters already
   * translate `JpegUnsupportedError` into a cover-format refusal, and raising a
   * new class would leak an unhandled type through them to say the same thing.
   */
  it('normalizeCoverBytes reports a broken JPEG as an unsupported cover', () => {
    const jpg = baseJpeg(64, 64);
    expect(() => normalizeCoverBytes(jpg.subarray(0, jpg.length - 10))).toThrow(/unsupported JPEG/);
  });

  it('normalizeCoverBytes passes non-JPEG bytes straight through', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    expect(normalizeCoverBytes(png).bytes).toBe(png);
  });
});

describe('inspectJpegCover', () => {
  it('reads the XMP identifiers a policy would have to decide about', () => {
    const jpg = spliceBeforeSos(baseJpeg(64, 64), pixelXmp(4096));
    const xmp = inspectJpegCover(jpg).xmp!;
    expect(xmp.documentId).toBe(true);
    expect(xmp.instanceId).toBe(true);
    expect(xmp.history).toBe(true);
    expect(xmp.gcamera).toBe(true);
    expect(xmp.hdrGainMap).toBe(true);
    expect(xmp.containerDirectory).toBe(true);
    expect(xmp.itemLengths).toEqual([4096]);
  });

  it('reads EXIF values for the device, and only flags for the serial', () => {
    const jpg = spliceAfterSoi(baseJpeg(64, 64), exifSegment());
    const exif = inspectJpegCover(jpg).exif!;
    expect(exif.parsed).toBe(true);
    expect(exif.make).toBe('Google');
    expect(exif.model).toBe('Pixel 10');
    expect(exif.software).toBe('HDR+ 1.0.0');
    // A body serial is reported as present and never as a value: a report must
    // not copy an identifier out of the file it is warning about.
    expect(exif.bodySerial).toBe(true);
    expect(JSON.stringify(exif)).not.toContain('AB0');
  });

  it('does not throw on an EXIF block it cannot parse', () => {
    const broken = spliceAfterSoi(
      baseJpeg(64, 64),
      // "Exif\0\0" followed by bytes that are not a TIFF header.
      // Length 0x000a covers the two length bytes, "Exif  ", and the two after it.
      Uint8Array.from([0xff, 0xe1, 0x00, 0x0a, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x41, 0x41]),
    );
    expect(inspectJpegCover(broken).exif?.parsed).toBe(false);
  });

  it('reads a little-endian EXIF as well as a big-endian one', () => {
    const jpg = spliceAfterSoi(baseJpeg(64, 64), exifSegmentLE('Adobe Lightroom'));
    const exif = inspectJpegCover(jpg).exif!;
    expect(exif.parsed).toBe(true);
    expect(exif.software).toBe('Adobe Lightroom');
  });

  it('reports no xmp and no exif when the file carries neither', () => {
    const profile = inspectJpegCover(baseJpeg(64, 64));
    expect(profile.xmp).toBeNull();
    expect(profile.exif).toBeNull();
  });

  /**
   * Every class a real camera JPEG can carry, in one file.
   *
   * The inventory is what a policy for the remaining identifiers will be written
   * from (SPEC §9.7 leaves them out on purpose), so a class this cannot name is
   * a class that policy will not know about. An unrecognized APPn counts too:
   * its presence or absence is a difference between two photos even when we
   * cannot say what it is.
   */
  it('names every segment class it can be handed', () => {
    let jpg = baseJpeg(64, 64);
    for (const seg of [
      iccSegment(),
      iptcSegment(),
      adobeSegment(),
      commentSegment(),
      xmpExtensionSegment(),
      unknownAppSegment(),
      pixelXmp(128),
    ]) {
      jpg = spliceBeforeSos(jpg, seg);
    }
    jpg = spliceAfterSoi(jpg, exifSegment());

    const classes = inspectJpegCover(withC2pa(jpg, 1)).classes;
    for (const expected of [
      'jfif',
      'exif',
      'xmp',
      'xmp-extension',
      'icc',
      'iptc',
      'adobe',
      'comment',
      'other-app',
      'jumbf',
    ]) {
      expect(classes, expected).toContain(expected);
    }
  });

  it('removing the manifest leaves every other class in place', () => {
    let jpg = baseJpeg(64, 64);
    for (const seg of [iccSegment(), iptcSegment(), adobeSegment(), commentSegment()]) {
      jpg = spliceBeforeSos(jpg, seg);
    }
    const before = inspectJpegCover(jpg).classes;
    const after = inspectJpegCover(normalizeJpegCover(withC2pa(jpg, 2)).bytes).classes;
    expect(after.sort()).toEqual(before.sort());
  });
});

describe('isHeif', () => {
  it('recognizes HEIC and leaves JPEG and PNG alone', () => {
    expect(isHeif(heicHeader())).toBe(true);
    expect(isHeif(baseJpeg(32, 32))).toBe(false);
    expect(isHeif(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(isHeif(new Uint8Array([0x00, 0x01]))).toBe(false);
  });

  it('does not claim an unrelated ISOBMFF file', () => {
    const mov = new Uint8Array(32);
    mov[3] = 0x18;
    mov.set([0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20], 4); // ftypqt
    expect(isHeif(mov)).toBe(false);
  });

  /**
   * The brand list ends where the `ftyp` box ends. Scanning a fixed 64 bytes
   * read on into whatever box came next, so an ISOBMFF file carrying the ASCII
   * of a HEIF brand in a later box was refused as a HEIC it is not.
   */
  it('stops at the end of the ftyp box', () => {
    const ascii = (into: Uint8Array, at: number, text: string) => {
      for (let i = 0; i < text.length; i++) into[at + i] = text.charCodeAt(i);
    };
    const iso = new Uint8Array(64);
    iso[3] = 0x10; // a 16-byte ftyp: major brand only, no compatible brands
    ascii(iso, 4, 'ftypisom');
    iso[19] = 0x28; // the next box, 40 bytes, whose payload spells a HEIF brand
    ascii(iso, 20, 'moovmif1');
    expect(isHeif(iso)).toBe(false);
  });
});

describe('inspectCoverSet', () => {
  const named = (name: string, bytes: Uint8Array) => ({ name, bytes });

  it('calls a set of matching, manifest-free JPEGs uniform', () => {
    const report = inspectCoverSet([
      named('a.jpg', baseJpeg(64, 64, 85, 1)),
      named('b.jpg', baseJpeg(64, 64, 85, 2)),
      named('c.jpg', baseJpeg(64, 64, 85, 3)),
    ]);
    expect(report.uniform).toBe(true);
    expect(report.divergent).toEqual([]);
    expect(report.withManifest).toEqual([]);
  });

  it('refuses to call a set uniform while a manifest is left in it', () => {
    const report = inspectCoverSet([
      named('a.jpg', baseJpeg(64, 64, 85, 1)),
      named('b.jpg', withC2pa(baseJpeg(64, 64, 85, 2), 1)),
    ]);
    expect(report.uniform).toBe(false);
    expect(report.withManifest).toEqual(['b.jpg']);
  });

  /**
   * The case the whole feature exists for, one layer out: every manifest is
   * gone, and the set is still trivially sortable because only some photos
   * carry XMP.
   */
  it('names a class that only some covers carry', () => {
    const report = inspectCoverSet([
      named('a.jpg', spliceBeforeSos(baseJpeg(64, 64, 85, 1), pixelXmp(512))),
      named('b.jpg', baseJpeg(64, 64, 85, 2)),
      named('c.jpg', baseJpeg(64, 64, 85, 3)),
    ]);
    expect(report.uniform).toBe(false);
    expect(report.withManifest).toEqual([]);
    const xmp = report.divergent.find((d) => d.segmentClass === 'xmp')!;
    expect(xmp.presentIn).toEqual(['a.jpg']);
    expect(xmp.absentFrom).toEqual(['b.jpg', 'c.jpg']);
  });

  it('flags a set that mixes formats, and says which members it cannot speak for', () => {
    const report = inspectCoverSet([
      named('a.jpg', baseJpeg(64, 64, 85, 1)),
      named('b.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])),
      named('c.heic', heicHeader()),
    ]);
    expect(report.uniform).toBe(false);
    expect(report.files.map((f) => f.kind)).toEqual(['jpeg', 'png', 'heif']);
    // Not "unparsed": a PNG is a format this module does not inspect, not a file
    // it could not read. The mix of kinds is what makes the set sortable, and
    // `kind` is where a caller reads that.
    expect(report.unparsed).toEqual([]);
    expect(report.files.filter((f) => f.problem)).toEqual([]);
  });

  /**
   * The verdict this whole feature exists to deliver, on a library that is not
   * JPEG at all. Counting every non-JPEG as unparsed made this set non-uniform
   * with an empty list of divergences to justify it: the report said the photos
   * could be told apart and then named nothing that told them apart.
   */
  it('calls a set of one non-JPEG format uniform, having inspected nothing', () => {
    const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n, 0, 0, 0]);
    const report = inspectCoverSet([named('a.png', png(1)), named('b.png', png(2))]);
    expect(report.uniform).toBe(true);
    expect(report.unparsed).toEqual([]);
    expect(report.divergent).toEqual([]);
    // What it is not saying: that a PNG chunk was looked at. `files` says so.
    expect(report.files.every((f) => f.kind === 'png' && f.profile === null)).toBe(true);
  });

  it('flags a set whose members carry different kinds of trailer', () => {
    const report = inspectCoverSet([
      named('a.jpg', withTrailer(baseJpeg(64, 64, 85, 1), gainMapTrailer())),
      named('b.jpg', baseJpeg(64, 64, 85, 2)),
    ]);
    expect(report.uniform).toBe(false);
    expect(report.trailerKinds.sort()).toEqual(['mpo', 'none']);
  });

  it('records a member it could not read without failing the whole report', () => {
    const broken = baseJpeg(64, 64);
    const report = inspectCoverSet([
      named('a.jpg', baseJpeg(64, 64, 85, 1)),
      named('bad.jpg', broken.subarray(0, broken.length - 10)),
    ]);
    expect(report.unparsed).toEqual(['bad.jpg']);
    expect(report.files[1]!.problem).toMatch(/malformed JPEG/);
    expect(report.uniform).toBe(false);
  });

  it('an empty set is vacuously uniform', () => {
    expect(inspectCoverSet([]).uniform).toBe(true);
  });
});
