/**
 * CLI Gallery Mode save→restore round-trip through real Node file I/O and the
 * production `@core` pipeline (blind winnowing, folder in / folder out).
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { decode as decodePng, encode as encodePng } from 'fast-png';
import { runGalleryRestore, runGallerySave } from './commands';

// Production Argon2 (64 MiB) runs on save and restore; give CI room.
const SLOW = { timeout: 60_000 };
const PW = 'correct horse battery staple';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ss-gallery-'));
}

/** A PNG cover with ample RGB LSB capacity for one gallery slot. */
function writePngCover(dir: string, name: string, seed: number): void {
  const w = 256;
  const h = 256;
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
    // dimensions, so no band was added.
    for (const file of save.files) {
      const out = decodePng(new Uint8Array(readFileSync(file)));
      expect(out.width, `${file} width`).toBe(256);
      expect(out.height, `${file} height`).toBe(256);
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
    await expect(
      runGalleryRestore({ inputs: [albumDir], outDir: tmp(), password: PW }),
    ).rejects.toThrow();

    // With the key, it restores. (Pass the photos, not the folder, so the walker
    // doesn't feed the .key in as a "photo".)
    const photos = save.files.filter((f) => !f.endsWith('.key'));
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
      // The produced stego key image keeps the cover's own filename (blends in).
      const stegoKeyPath = save.files.find((f) => f.endsWith('keycover.png'));
      expect(stegoKeyPath).toBeTruthy();

      // Without the key cover, restore fails (the factor is not embedded in fragments).
      await expect(
        runGalleryRestore({ inputs: [albumDir], outDir: tmp(), password: PW }),
      ).rejects.toThrow();

      // With the stego cover as the key, it restores.
      const photos = save.files.filter((f) => f !== stegoKeyPath);
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
    const photos = save.files.filter((f) => f.endsWith('.png'));

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
    const photos = save.files.filter((f) => f.endsWith('.png'));
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
