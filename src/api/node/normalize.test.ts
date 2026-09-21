/**
 * The `normalize` command, through real Node file I/O.
 *
 * `src/core/normalize.test.ts` covers the surgery itself. What is left here is
 * everything the command adds around it, and the decisions worth pinning are
 * mostly refusals: `--out` is required, an existing file is not overwritten
 * without `--force`, and a file the command cannot read produces no output while
 * the run carries on. That last one is a deliberate split: "never emit corrupt
 * output" is satisfied by writing nothing for the bad file, and failing the whole
 * command because one photo in a library of three hundred is odd would make the
 * tool useless on exactly the libraries it exists for.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { encode as encodePng } from 'fast-png';
import { runNormalize } from './commands';
import { StegoShardApiError } from '../errors';
import { inspectJpegCover } from '../../core';
import {
  baseJpeg,
  c2paSegment,
  gainMapTrailer,
  heicHeader,
  mpfIndexSegment,
  mpfSegment,
  patchMpfIndex,
  pixelXmp,
  spliceAfterSoi,
  spliceBeforeSos,
  withC2pa,
  withTrailer,
} from '../../core/jpeg-fixtures';
import { parseMpfIndex } from '../../core/mpf';
import { parseJpegSegments } from '../../core/jpeg-segments';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ss-normalize-'));
}

function write(dir: string, name: string, bytes: Uint8Array): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

function pngBytes(): Uint8Array {
  const w = 8;
  const h = 8;
  return encodePng({ width: w, height: h, data: new Uint8Array(w * h * 4), channels: 4, depth: 8 });
}

describe('runNormalize', () => {
  it('writes normalized copies and leaves the originals alone', async () => {
    const inDir = tmp();
    const outDir = tmp();
    const dirty = withC2pa(baseJpeg(64, 64), 2);
    write(inDir, 'a.jpg', dirty);
    write(inDir, 'b.jpg', baseJpeg(64, 64, 85, 2));

    const res = await runNormalize({ inputs: [inDir], outDir });

    expect(res.files).toHaveLength(2);
    expect(res.removed).toEqual({ covers: 1, segments: 2, bytes: expect.any(Number) });
    // The original is untouched: it is still the comparison the manifest was.
    expect([...readFileSync(join(inDir, 'a.jpg'))]).toEqual([...dirty]);
    expect(inspectJpegCover(readFileSync(join(outDir, 'a.jpg'))).jumbf.segments).toBe(0);
    expect(res.set.uniform).toBe(true);
  });

  it('refuses to write without --out, and says why', async () => {
    const inDir = tmp();
    write(inDir, 'a.jpg', withC2pa(baseJpeg(64, 64), 1));
    await expect(runNormalize({ inputs: [inDir] })).rejects.toMatchObject({
      code: 'NORMALIZE_OUT_REQUIRED',
    });
  });

  it('--report computes everything and writes nothing', async () => {
    const inDir = tmp();
    const outDir = tmp();
    write(inDir, 'a.jpg', withC2pa(spliceBeforeSos(baseJpeg(64, 64), pixelXmp(128)), 3));

    const res = await runNormalize({ inputs: [inDir], report: true });

    expect(res.files).toEqual([]);
    expect(readdirSync(outDir)).toEqual([]);
    expect(res.removed.segments).toBe(3);
    // The inventory is the whole point of the mode: it is what a policy for the
    // XMP and EXIF identifiers would be written from.
    const profile = res.covers[0]!.profile!;
    expect(profile.jumbf.segments).toBe(3);
    expect(profile.xmp?.documentId).toBe(true);
    expect(profile.xmp?.instanceId).toBe(true);
  });

  it('reports what would remain, so --report answers "what would I get"', async () => {
    const inDir = tmp();
    write(inDir, 'a.jpg', withC2pa(spliceBeforeSos(baseJpeg(64, 64, 85, 1), pixelXmp(128)), 1));
    write(inDir, 'b.jpg', withC2pa(baseJpeg(64, 64, 85, 2), 1));

    const res = await runNormalize({ inputs: [inDir], report: true });

    // Both manifests would be gone, and the set would still be sortable on XMP.
    expect(res.set.withManifest).toEqual([]);
    expect(res.set.uniform).toBe(false);
    expect(res.set.divergent.map((d) => d.segmentClass)).toContain('xmp');
  });

  it('refuses to overwrite an existing output without --force', async () => {
    const inDir = tmp();
    const outDir = tmp();
    write(inDir, 'a.jpg', withC2pa(baseJpeg(64, 64), 1));
    write(outDir, 'a.jpg', new Uint8Array([1, 2, 3]));

    await expect(runNormalize({ inputs: [inDir], outDir })).rejects.toBeInstanceOf(
      StegoShardApiError,
    );
    const forced = await runNormalize({ inputs: [inDir], outDir, force: true });
    expect(forced.files).toHaveLength(1);
  });

  it('records a file it cannot read and carries on with the rest', async () => {
    const inDir = tmp();
    const outDir = tmp();
    const good = withC2pa(baseJpeg(64, 64), 1);
    const broken = baseJpeg(64, 64);
    write(inDir, 'good.jpg', good);
    write(inDir, 'bad.jpg', broken.subarray(0, broken.length - 12));

    const res = await runNormalize({ inputs: [inDir], outDir });

    const bad = res.covers.find((c) => c.name === 'bad.jpg')!;
    expect(bad.problem).toMatch(/malformed JPEG/);
    expect(bad.output).toBeUndefined();
    expect(existsSync(join(outDir, 'bad.jpg'))).toBe(false);
    // The good one still landed.
    expect(res.files).toHaveLength(1);
    expect(res.skipped).toBe(1);
  });

  /**
   * An Ultra HDR photo, normalized: the manifest goes, the gain map stays where
   * the index can still find it (SPEC §9.7.1), and the trailer comes through
   * byte for byte. The manifest is placed *behind* the MPF index on purpose,
   * which is the position that used to be refused outright.
   */
  it('normalizes an Ultra HDR photo and keeps its gain map resolvable', async () => {
    const inDir = tmp();
    const outDir = tmp();
    const gainMap = gainMapTrailer();
    const indexed = spliceBeforeSos(baseJpeg(64, 64), mpfIndexSegment());
    const late = spliceBeforeSos(indexed, c2paSegment(2));
    write(inDir, 'ultra.jpg', patchMpfIndex(withTrailer(late, gainMap), [gainMap.length]));

    const res = await runNormalize({ inputs: [inDir], outDir });

    // One APP11 fragment, carried behind the index rather than ahead of it.
    expect(res.removed.segments).toBe(1);
    expect(res.covers[0]!.problem).toBeUndefined();
    const out = readFileSync(join(outDir, 'ultra.jpg'));
    const index = parseMpfIndex(out)!;
    const { trailerStart } = parseJpegSegments(out);
    expect(index.endianAt + index.entries[1]!.offset).toBe(trailerStart);
    expect([...out.subarray(trailerStart)]).toEqual([...gainMap]);
    expect(index.entries[0]!.size).toBe(trailerStart);
  });

  /**
   * A photo that inventoried fine and then refused removal: an MPF index this
   * code cannot read, over a trailer it claims to locate. The two steps shared a
   * try block, so the successful inventory was thrown away and the row was filed
   * as "did not parse" with no profile at all, which is the one photo in a
   * library a user most needs the inventory of.
   */
  it('keeps the inventory of a photo whose manifest cannot be removed', async () => {
    const inDir = tmp();
    const outDir = tmp();
    const ultra = withTrailer(
      spliceBeforeSos(spliceAfterSoi(baseJpeg(64, 64), mpfSegment()), c2paSegment(1)),
      gainMapTrailer(),
    );
    write(inDir, 'ultra.jpg', ultra);

    const res = await runNormalize({ inputs: [inDir], outDir });

    const row = res.covers[0]!;
    expect(row.problem).toMatch(/MPF/);
    expect(row.profile).not.toBeNull();
    expect(row.profile!.jumbf.segments).toBe(1);
    expect(row.profile!.trailer.kind).toBe('mpo');
    // Nothing written for it, and it counts against the set all the same.
    expect(row.output).toBeUndefined();
    expect(existsSync(join(outDir, 'ultra.jpg'))).toBe(false);
    expect(res.skipped).toBe(1);
    expect(res.set.uniform).toBe(false);
  });

  /**
   * `files` is empty in report mode and also empty when every member was
   * skipped, and a presenter cannot tell those apart from the result. Telling a
   * user their library has been normalized when nothing was written is the one
   * wrong thing to say here.
   */
  it('says which mode produced the result', async () => {
    const inDir = tmp();
    const outDir = tmp();
    write(inDir, 'a.jpg', withC2pa(baseJpeg(64, 64), 1));
    expect((await runNormalize({ inputs: [inDir], report: true })).report).toBe(true);
    expect((await runNormalize({ inputs: [inDir], outDir })).report).toBe(false);
  });

  it('names a HEIC rather than trying to decode it, and writes nothing for it', async () => {
    const inDir = tmp();
    const outDir = tmp();
    write(inDir, 'a.jpg', baseJpeg(64, 64));
    write(inDir, 'b.heic', heicHeader());

    const res = await runNormalize({ inputs: [inDir], outDir });

    expect(res.covers.find((c) => c.name === 'b.heic')?.kind).toBe('heif');
    expect(existsSync(join(outDir, 'b.heic'))).toBe(false);
    // A mixed-format set is not one uniformity can be claimed over.
    expect(res.set.uniform).toBe(false);
  });

  it('skips a PNG rather than copying it through unnormalized', async () => {
    const inDir = tmp();
    const outDir = tmp();
    write(inDir, 'a.jpg', baseJpeg(64, 64));
    write(inDir, 'b.png', pngBytes());

    const res = await runNormalize({ inputs: [inDir], outDir });

    // Copying it would promise a normalization that did not happen: this module
    // does not rewrite PNG chunks.
    expect(existsSync(join(outDir, 'b.png'))).toBe(false);
    expect(res.covers.find((c) => c.name === 'b.png')?.kind).toBe('png');
    expect(res.skipped).toBe(1);
  });

  it('preserves a gain map through the command, byte for byte', async () => {
    const inDir = tmp();
    const outDir = tmp();
    const gainMap = gainMapTrailer();
    write(inDir, 'hdr.jpg', withTrailer(withC2pa(baseJpeg(64, 64), 2), gainMap));

    await runNormalize({ inputs: [inDir], outDir });

    const out = new Uint8Array(readFileSync(join(outDir, 'hdr.jpg')));
    expect([...out.subarray(out.length - gainMap.length)]).toEqual([...gainMap]);
  });

  it('is idempotent through the command', async () => {
    const inDir = tmp();
    const once = tmp();
    const twice = tmp();
    write(inDir, 'a.jpg', withC2pa(baseJpeg(64, 64), 3));

    const first = await runNormalize({ inputs: [inDir], outDir: once });
    const second = await runNormalize({ inputs: [once], outDir: twice });

    expect(first.removed.segments).toBe(3);
    expect(second.removed.segments).toBe(0);
    expect([...readFileSync(join(twice, 'a.jpg'))]).toEqual([...readFileSync(join(once, 'a.jpg'))]);
  });

  /**
   * Its own code, not the gallery's `NO_COVERS_FOUND`: sharing that one made the
   * terminal answer an empty folder with a sentence about gallery cover photos,
   * for a command that has nothing to do with hiding a secret.
   */
  it('refuses an input set with no images at all', async () => {
    const inDir = tmp();
    writeFileSync(join(inDir, 'notes.txt'), 'hello');
    await expect(runNormalize({ inputs: [inDir], outDir: tmp() })).rejects.toMatchObject({
      code: 'NO_NORMALIZE_FILES',
    });
  });

  it('disambiguates two inputs sharing a basename', async () => {
    const a = tmp();
    const b = tmp();
    const outDir = tmp();
    write(a, 'IMG_0001.jpg', withC2pa(baseJpeg(64, 64, 85, 1), 1));
    write(b, 'IMG_0001.jpg', withC2pa(baseJpeg(64, 64, 85, 2), 1));

    const res = await runNormalize({ inputs: [a, b], outDir });

    expect(res.files).toHaveLength(2);
    expect(readdirSync(outDir).sort()).toEqual(['IMG_0001-2.jpg', 'IMG_0001.jpg']);
  });
});
