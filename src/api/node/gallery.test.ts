/**
 * CLI Gallery Mode save→restore round-trip through real Node file I/O and the
 * production `@core` pipeline (blind winnowing, folder in / folder out).
 */

import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { encode as encodePng } from 'fast-png';
import { zipSync } from 'fflate';
import {
  StegoCoverFormatError,
  decode as decodeCoeff,
  galleryDecode,
  hasGps,
  inspectJpegCover,
  profileMismatch,
} from '../../core';
import {
  baseJpeg,
  exifSegmentWithGps,
  heicHeader,
  spliceBeforeSos,
} from '../../core/jpeg-fixtures';
import { runGalleryRestore, runGallerySave } from './commands';
import { extractKeyFactorImage, fileToGalleryCover } from './image-io';

// Production Argon2 (64 MiB) runs on save and restore; give CI room.
//
// 180s rather than 60s because a gallery save now re-encodes every cover with
// the repository's own JPEG encoder, which is pure integer JavaScript by design
// (SPEC §9.8: two engines must not produce two files). Twelve covers at 768
// square, encoded on the way in and again by the post-save verify, are seconds
// of real work, and the v8 coverage instrumentation roughly triples it.
const SLOW = { timeout: 180_000 };
const PW = 'correct horse battery staple';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ss-gallery-'));
}

/** A PNG cover with ample RGB LSB capacity for one gallery slot. */
/**
 * A cover big enough to clear the capacity margin **after** normalization.
 *
 * 256x256 was sized for the old pipeline, where a JPEG cover was carried
 * verbatim. Every cover is re-encoded into the profile now, which costs
 * carriers, and the margin is measured against what survives that. 768x768 of
 * noise yields about 400k carriers where the slot needs 270k.
 */
function writePngCover(dir: string, name: string, seed: number): void {
  const w = 768;
  const h = 768;
  const data = new Uint8Array(w * h * 4);
  let s = seed >>> 0;
  for (let p = 0; p < w * h; p++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[p * 4] = (s >>> 24) & 0xff;
    data[p * 4 + 1] = (s >>> 16) & 0xff;
    data[p * 4 + 2] = (s >>> 8) & 0xff;
    data[p * 4 + 3] = 255;
  }
  writeFileSync(join(dir, name), encodePng({ width: w, height: h, data, channels: 4, depth: 8 }));
}

/**
 * A JPEG cover as a camera would hand one over: textured enough to clear the
 * embed margin, and carrying a GPS coordinate.
 *
 * 768 square because the margin is measured on what survives a re-encode, and
 * because this one is *not* re-encoded it has to clear the bar as it stands.
 */
function writeJpegCover(dir: string, name: string, seed: number): void {
  const photo = spliceBeforeSos(baseJpeg(768, 768, 85, seed), exifSegmentWithGps());
  writeFileSync(join(dir, name), photo);
}

/**
 * `--preserve-container`, which is the whole of the opt-in mode: the photo keeps
 * the container the device wrote, and loses its coordinate.
 *
 * Both halves are asserted, because each without the other is a different
 * feature. Keeping the container without scrubbing would publish where the photo
 * was taken; scrubbing while re-encoding is just the default path.
 */
describe('CLI gallery save with --preserve-container', () => {
  it('keeps each container, and takes the GPS out of every one', SLOW, async () => {
    const coverDir = tmp();
    const COVERS = 12;
    for (let i = 0; i < COVERS; i++) writeJpegCover(coverDir, `photo-${i}.jpg`, i + 1);

    const secretDir = tmp();
    const secretPath = join(secretDir, 'note.txt');
    const secret = Buffer.from('the container is the camera’s own');
    writeFileSync(secretPath, secret);

    const albumDir = tmp();
    const save = await runGallerySave({
      secretFile: secretPath,
      covers: [coverDir],
      outDir: albumDir,
      password: PW,
      preserveContainer: true,
    });
    expect(save.files.length).toBe(COVERS);
    expect(save.provenance.gpsScrubbed, 'every cover carried a coordinate').toBe(COVERS);

    for (const file of save.files) {
      const bytes = new Uint8Array(readFileSync(file));
      // Not the profile: these are the device's own tables, which is the point.
      expect(profileMismatch(bytes), `${file} should NOT be in the profile`).not.toBeNull();
      expect(hasGps(bytes), `${file} still has GPS`).toBe(false);
      // The rest of the EXIF is still there. The flag preserves the container;
      // the scrub is surgical, not a metadata wipe wearing a different name.
      expect(inspectJpegCover(bytes).exif?.make).toBe('Google');
    }

    const res = await runGalleryRestore({ inputs: [albumDir], outDir: tmp(), password: PW });
    expect(new Uint8Array(readFileSync(res.outPath))).toEqual(new Uint8Array(secret));
  });
});

/**
 * `--preserve-container` keeps the key photo's container as-is, and an as-is
 * key photo normally copies its cover's timestamps to agree with the EXIF it
 * keeps. Not in a gallery: every photo beside it is written today, so a key
 * photo dated like its years-old cover would be the one file to look at. The
 * container is preserved; the date is not.
 */
describe('CLI gallery key photo under --preserve-container', () => {
  it('is dated like the photos beside it, not like its cover', SLOW, async () => {
    const coverDir = tmp();
    for (let i = 0; i < 12; i++) writeJpegCover(coverDir, `photo-${i}.jpg`, i + 200);
    const secretDir = tmp();
    const secretPath = join(secretDir, 'note.txt');
    writeFileSync(secretPath, Buffer.from('an old photo, delivered today'));
    const keyDir = tmp();
    writeJpegCover(keyDir, 'old.jpg', 299);
    const keyCover = join(keyDir, 'old.jpg');
    utimesSync(keyCover, new Date('2001-01-01'), new Date('2001-01-01'));

    const save = await runGallerySave({
      secretFile: secretPath,
      covers: [coverDir],
      outDir: tmp(),
      password: PW,
      keyMode: 'stego',
      keyCover,
      preserveContainer: true,
    });
    const keyPath = save.manifest.find((m) => m.purpose === 'stegoCover')!.name;
    const fd = openSync(keyPath, 'r');
    try {
      expect(fstatSync(fd).mtime.getFullYear()).toBeGreaterThan(2001);
    } finally {
      closeSync(fd);
    }
  });
});

/**
 * The whole delivery zipped up and handed to gallery-restore as one file.
 *
 * Delivered photos are all named IMG_nnnn, so zipping everything a save wrote,
 * key included, is the natural way to keep it together. The zip is opened, and
 * the key is found inside it: the key photo of a stego gallery, or the .key of
 * a keyfile one.
 */
describe('CLI gallery restore from a .zip', () => {
  const zipAll = (files: string[]): string => {
    const zipPath = join(tmp(), 'album.zip');
    writeFileSync(
      zipPath,
      zipSync(Object.fromEntries(files.map((f) => [basename(f), readFileSync(f)]))),
    );
    return zipPath;
  };

  it.each(['stego', 'keyfile'] as const)(
    'restores a %s gallery from one .zip holding its photos and its key',
    SLOW,
    async (keyMode) => {
      const coverDir = tmp();
      for (let i = 0; i < 12; i++) writePngCover(coverDir, `c${i}.png`, i + 400);
      const secretDir = tmp();
      const secretPath = join(secretDir, 'note.txt');
      const secret = Buffer.from(`zipped ${keyMode} gallery`);
      writeFileSync(secretPath, secret);
      let keyCover: string | undefined;
      if (keyMode === 'stego') {
        writePngCover(secretDir, 'key.png', 499);
        keyCover = join(secretDir, 'key.png');
      }
      const save = await runGallerySave({
        secretFile: secretPath,
        covers: [coverDir],
        outDir: tmp(),
        password: PW,
        keyMode,
        keyCover,
      });
      const res = await runGalleryRestore({
        inputs: [zipAll(save.files)],
        outDir: tmp(),
        password: PW,
      });
      expect(new Uint8Array(readFileSync(res.outPath))).toEqual(new Uint8Array(secret));
    },
  );
});

describe('CLI gallery round-trip', () => {
  it('saves a secret across a folder of photos and restores it blindly', SLOW, async () => {
    // The §10 geometry doubles the blob, so a tiny secret spans ~5 data shards;
    // provision 12 photos to clear the carrier + decoy floor.
    const coverDir = tmp();
    const COVERS = 12;
    for (let i = 0; i < COVERS; i++) writePngCover(coverDir, `photo-${i}.png`, i + 1);

    const secretDir = tmp();
    const secretPath = join(secretDir, 'note.txt');
    const secret = Buffer.from('meet at the old mill, midnight');
    writeFileSync(secretPath, secret);

    const albumDir = tmp();
    const save = await runGallerySave({
      secretFile: secretPath,
      covers: [coverDir],
      outDir: albumDir,
      password: PW,
    });
    expect(save.files.length).toBe(COVERS);
    expect(save.k + save.m + save.decoys).toBe(COVERS);
    expect(save.decoys).toBeGreaterThanOrEqual(2);

    // Gallery photos must carry no StegoShard branding; the whole point is that
    // they pass as ordinary pictures. Every output keeps its cover's exact
    // dimensions, so no band was added — and every one is now a JPEG in the one
    // profile, whatever it arrived as, which is what makes the set one kind of
    // file instead of several (SPEC §9.7). The PNGs went in, JPEGs come out, and
    // their names say so.
    for (const file of save.files) {
      expect(file, 'a re-encoded cover is a JPEG').toMatch(/\.jpg$/);
      const bytes = new Uint8Array(readFileSync(file));
      expect(profileMismatch(bytes), `${file} profile`).toBeNull();
      const out = decodeCoeff(bytes);
      expect(out.width, `${file} width`).toBe(768);
      expect(out.height, `${file} height`).toBe(768);
    }

    const restoreDir = tmp();
    const res = await runGalleryRestore({ inputs: [albumDir], outDir: restoreDir, password: PW });
    expect(res.filename).toBe('note.txt');
    expect(res.seen).toBe(COVERS);
    expect(new Uint8Array(readFileSync(res.outPath))).toEqual(new Uint8Array(secret));
  });

  it('round-trips a keyfile gallery: the separate .key is needed to restore', SLOW, async () => {
    const coverDir = tmp();
    for (let i = 0; i < 12; i++) writePngCover(coverDir, `photo-${i}.png`, i + 10);
    const secretDir = tmp();
    const secretPath = join(secretDir, 'note.txt');
    const secret = Buffer.from('the key rides separately');
    writeFileSync(secretPath, secret);

    const albumDir = tmp();
    const save = await runGallerySave({
      secretFile: secretPath,
      covers: [coverDir],
      outDir: albumDir,
      password: PW,
      keyMode: 'keyfile',
    });
    expect(save.keyMode).toBe('keyfile');
    const keyPath = save.files.find((f) => f.endsWith('.key'));
    expect(keyPath).toBeTruthy();

    // Without the key, restore fails.
    const photos = save.files.filter((f) => !f.endsWith('.key'));
    await expect(
      runGalleryRestore({ inputs: photos, outDir: tmp(), password: PW }),
    ).rejects.toThrow();

    // With the .key left in the album folder, it is found and used.
    const fromFolder = await runGalleryRestore({ inputs: [albumDir], outDir: tmp(), password: PW });
    expect(new Uint8Array(readFileSync(fromFolder.outPath))).toEqual(new Uint8Array(secret));

    // And with the key given explicitly.
    const res = await runGalleryRestore({
      inputs: photos,
      outDir: tmp(),
      password: PW,
      keyPath,
    });
    expect(new Uint8Array(readFileSync(res.outPath))).toEqual(new Uint8Array(secret));
  });

  it(
    'round-trips a stego gallery: the 32-byte key factor hides in a cover photo',
    SLOW,
    async () => {
      const coverDir = tmp();
      for (let i = 0; i < 12; i++) writePngCover(coverDir, `photo-${i}.png`, i + 50);
      const secretDir = tmp();
      const secretPath = join(secretDir, 'note.txt');
      const secret = Buffer.from('the key hides in plain sight');
      writeFileSync(secretPath, secret);
      // A separate cover photo carries the SSKF-wrapped key factor.
      writePngCover(secretDir, 'keycover.png', 999);
      const keyCoverPath = join(secretDir, 'keycover.png');

      const albumDir = tmp();
      const save = await runGallerySave({
        secretFile: secretPath,
        covers: [coverDir],
        outDir: albumDir,
        password: PW,
        keyMode: 'stego',
        keyCover: keyCoverPath,
      });
      expect(save.keyMode).toBe('stego');
      // The produced stego key image follows the set's format, which is what
      // keeps it from being the one file in the delivery that does not match. A
      // PNG key photo among twelve profile JPEGs would be the single most
      // interesting file in the folder, and it is the one holding the key
      // (SPEC §9.8). Its name is drawn like theirs; the manifest says which.
      const stegoKeyPath = save.manifest.find((m) => m.purpose === 'stegoCover')?.name;
      expect(stegoKeyPath).toBeTruthy();
      expect(basename(stegoKeyPath!)).toMatch(/^IMG_\d{4}\.jpg$/);
      expect(profileMismatch(new Uint8Array(readFileSync(stegoKeyPath!)))).toBeNull();

      // Without the key photo, restore fails (the factor is not embedded in fragments).
      const photos = save.files.filter((f) => f !== stegoKeyPath);
      await expect(
        runGalleryRestore({ inputs: photos, outDir: tmp(), password: PW }),
      ).rejects.toThrow();

      // With the key photo simply left in the folder with the others, it is found:
      // every delivered photo is named IMG_nnnn, so nothing marks it out, and
      // handing over the whole folder is the natural thing to do.
      const fromFolder = await runGalleryRestore({
        inputs: [albumDir],
        outDir: tmp(),
        password: PW,
      });
      expect(new Uint8Array(readFileSync(fromFolder.outPath))).toEqual(new Uint8Array(secret));

      // And with the key photo given explicitly, as before.
      const res = await runGalleryRestore({
        inputs: photos,
        outDir: tmp(),
        password: PW,
        keyPath: stegoKeyPath,
      });
      expect(new Uint8Array(readFileSync(res.outPath))).toEqual(new Uint8Array(secret));
    },
  );

  it('non-possession gallery: threshold shares gate the restore', SLOW, async () => {
    const coverDir = tmp();
    for (let i = 0; i < 12; i++) writePngCover(coverDir, `photo-${i}.png`, i + 30);
    const secretDir = tmp();
    const secretPath = join(secretDir, 'note.txt');
    const secret = Buffer.from('gated across a photo album');
    writeFileSync(secretPath, secret);

    const albumDir = tmp();
    const save = await runGallerySave({
      secretFile: secretPath,
      covers: [coverDir],
      outDir: albumDir,
      password: PW,
      mode: 'nonpossession',
      threshold: { k: 2, n: 3 },
    });
    const shares = save.files.filter(
      (f) => f.endsWith('.txt') && basename(f).startsWith('recovery-'),
    );
    expect(shares.length).toBe(3);
    // The covers went in as PNGs and come out as profile JPEGs: one encoder for
    // the whole set is the point, and the extension follows the file.
    const photos = save.files.filter((f) => f.endsWith('.jpg'));

    // Password + photos alone cannot restore (no threshold material).
    await expect(
      runGalleryRestore({ inputs: photos, outDir: tmp(), password: PW }),
    ).rejects.toThrow();

    // Any 2 of the 3 shares open it.
    const res = await runGalleryRestore({
      inputs: photos,
      outDir: tmp(),
      password: PW,
      sharePaths: [shares[0]!, shares[2]!],
    });
    expect(new Uint8Array(readFileSync(res.outPath))).toEqual(new Uint8Array(secret));
  });

  it('non-possession + keyfile gallery: needs BOTH the .key and a share quorum', SLOW, async () => {
    const coverDir = tmp();
    for (let i = 0; i < 12; i++) writePngCover(coverDir, `photo-${i}.png`, i + 70);
    const secretDir = tmp();
    const secretPath = join(secretDir, 'note.txt');
    const secret = Buffer.from('double-gated: key file plus shares');
    writeFileSync(secretPath, secret);

    // Exercises the save-time verify that previously passed an undefined key factor
    // for a keyfile non-possession gallery; the self-check would have thrown.
    const albumDir = tmp();
    const save = await runGallerySave({
      secretFile: secretPath,
      covers: [coverDir],
      outDir: albumDir,
      password: PW,
      keyMode: 'keyfile',
      mode: 'nonpossession',
      threshold: { k: 2, n: 3 },
    });
    expect(save.keyMode).toBe('keyfile');
    const keyPath = save.files.find((f) => f.endsWith('.key'))!;
    const shares = save.files.filter(
      (f) => f.endsWith('.txt') && basename(f).startsWith('recovery-'),
    );
    // The covers went in as PNGs and come out as profile JPEGs: one encoder for
    // the whole set is the point, and the extension follows the file.
    const photos = save.files.filter((f) => f.endsWith('.jpg'));
    expect(keyPath).toBeTruthy();
    expect(shares.length).toBe(3);

    // A share quorum WITHOUT the key file → fail (the factor is missing).
    await expect(
      runGalleryRestore({
        inputs: photos,
        outDir: tmp(),
        password: PW,
        sharePaths: [shares[0]!, shares[1]!],
      }),
    ).rejects.toThrow();

    // The key file WITHOUT a share quorum → fail (the gate stays closed).
    await expect(
      runGalleryRestore({ inputs: photos, outDir: tmp(), password: PW, keyPath }),
    ).rejects.toThrow();

    // Key file + any 2 shares → restore.
    const res = await runGalleryRestore({
      inputs: photos,
      outDir: tmp(),
      password: PW,
      keyPath,
      sharePaths: [shares[0]!, shares[2]!],
    });
    expect(new Uint8Array(readFileSync(res.outPath))).toEqual(new Uint8Array(secret));
  });
});

describe('CLI gallery save: the key photo', () => {
  /**
   * Every delivered file is named `IMG_nnnn`, the key photo included, drawn from
   * one set so that its name does not single it out; the manifest is what says
   * which one is the key. Nothing of a cover's own name survives, since that
   * name is the device's. The key photo is dated like its neighbours rather than
   * copying its cover's timestamps: one file dated years ago in a folder written
   * today would be the one to look at.
   *
   * The same save then restores through the library's default loader, which is
   * what a third-party caller reaches for. Delivered photos are already in the
   * profile, so it hands them over untouched instead of re-encoding the payload
   * out of them.
   */
  it(
    'names every photo and the key IMG_nnnn from one set, dates the key like the rest, and restores through the default loader',
    SLOW,
    async () => {
      const coverDir = tmp();
      for (let i = 0; i < 12; i++) writePngCover(coverDir, `PXL_20260921_14301${i}.png`, i + 70);
      const secretDir = tmp();
      const secretPath = join(secretDir, 'note.txt');
      const secret = Buffer.from('twelve photos and a key, all alike');
      writeFileSync(secretPath, secret);
      const keyDir = tmp();
      const keyCover = join(keyDir, 'PXL_20010101_000000.png');
      writePngCover(keyDir, basename(keyCover), 998);
      utimesSync(keyCover, new Date('2001-01-01'), new Date('2001-01-01'));

      const albumDir = tmp();
      const save = await runGallerySave({
        secretFile: secretPath,
        covers: [coverDir],
        outDir: albumDir,
        password: PW,
        keyMode: 'stego',
        keyCover,
      });
      const names = save.files.map((f) => basename(f));
      expect(new Set(names).size).toBe(13);
      for (const n of names) expect(n).toMatch(/^IMG_\d{4}\.jpg$/);
      const keyPath = save.manifest.find((m) => m.purpose === 'stegoCover')!.name;
      const photos = save.manifest.filter((m) => m.purpose === 'photos').map((m) => m.name);
      expect(photos).toHaveLength(12);
      // One descriptor for both the date and the bytes, so they describe one file.
      const fd = openSync(keyPath, 'r');
      let keyBytes: Uint8Array;
      try {
        expect(fstatSync(fd).mtime.getFullYear()).toBeGreaterThan(2001);
        keyBytes = new Uint8Array(readFileSync(fd));
      } finally {
        closeSync(fd);
      }

      const keyBlock = await extractKeyFactorImage(keyBytes, basename(keyPath), PW);
      expect(keyBlock).not.toBeNull();
      const covers = photos.map((p) =>
        fileToGalleryCover(new Uint8Array(readFileSync(p)), basename(p)),
      );
      const { content } = await galleryDecode(covers, PW, { keyBlock: keyBlock! });
      expect(content).toEqual(new Uint8Array(secret));
    },
  );

  it('refuses a HEIC key cover by name, not as a jpeg-js stack trace', SLOW, async () => {
    const coverDir = tmp();
    for (let i = 0; i < 12; i++) writePngCover(coverDir, `photo-${i}.png`, i + 90);
    const secretDir = tmp();
    const secretPath = join(secretDir, 'note.txt');
    writeFileSync(secretPath, Buffer.from('never ingested'));
    writeFileSync(join(secretDir, 'IMG_0001.HEIC'), heicHeader());

    await expect(
      runGallerySave({
        secretFile: secretPath,
        covers: [coverDir],
        outDir: tmp(),
        password: PW,
        keyMode: 'stego',
        keyCover: join(secretDir, 'IMG_0001.HEIC'),
      }),
    ).rejects.toBeInstanceOf(StegoCoverFormatError);
  });
});
