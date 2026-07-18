/**
 * CLI save→restore round-trips through the real Node file I/O + `@core`, for
 * every key mode and output shape. Byte-exact recovery confirms the headless
 * fast-png/jpeg-js shim matches the browser path.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { encode as encodePng } from 'fast-png';
import jpeg from 'jpeg-js';
import { runEstimate, runRestore, runSave } from './commands';

// Production Argon2 (64 MiB) runs on every save; give these room under CI.
const SLOW = { timeout: 60_000 };

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'iv-cli-'));
}

function writeSecret(dir: string, bytes: Uint8Array): string {
  const path = join(dir, 'secret.bin');
  writeFileSync(path, bytes);
  return path;
}

function pattern(len: number, seed = 5): Uint8Array {
  let s = seed >>> 0;
  return Uint8Array.from({ length: len }, () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 24) & 0xff;
  });
}

/** A deterministic cover photo big enough to hold a stego key. */
function writeCover(dir: string): string {
  const w = 160;
  const h = 160;
  const data = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    data[p * 4] = (p * 7) & 0xff;
    data[p * 4 + 1] = (p * 13) & 0xff;
    data[p * 4 + 2] = (p * 29) & 0xff;
    data[p * 4 + 3] = 255;
  }
  const path = join(dir, 'cover.png');
  writeFileSync(path, encodePng({ width: w, height: h, data, channels: 4, depth: 8 }));
  return path;
}

/** A textured baseline JPEG cover (jpeg-js) with plenty of DCT carriers. */
function writeJpegCover(dir: string): string {
  const w = 128;
  const h = 128;
  const data = Buffer.alloc(w * h * 4);
  let s = 99 >>> 0;
  for (let i = 0; i < w * h; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i * 4] = (s >>> 24) & 0xff;
    data[i * 4 + 1] = (s >>> 16) & 0xff;
    data[i * 4 + 2] = (s >>> 8) & 0xff;
    data[i * 4 + 3] = 255;
  }
  const path = join(dir, 'photo.jpg');
  writeFileSync(path, jpeg.encode({ data, width: w, height: h }, 85).data);
  return path;
}

const PW = 'correct horse battery staple';

describe('CLI round-trips', () => {
  it('embedded: PNG set → restore', SLOW, async () => {
    const dir = tmp();
    const content = pattern(3000);
    const input = writeSecret(dir, content);
    const { imageCount } = await runSave({
      inputFile: input,
      outDir: join(dir, 'out'),
      password: PW,
      paper: false,
      zip: false,
      keyMode: 'embedded',
    });
    expect(imageCount).toBeGreaterThan(1);
    const { outPath } = await runRestore({
      inputs: [join(dir, 'out')],
      outDir: join(dir, 'restored'),
      password: PW,
    });
    expect([...readFileSync(outPath)]).toEqual([...content]);
  });

  it('embedded zip: single .zip → restore', SLOW, async () => {
    const dir = tmp();
    const content = pattern(2500, 9);
    const input = writeSecret(dir, content);
    const { files } = await runSave({
      inputFile: input,
      outDir: join(dir, 'out'),
      password: PW,
      paper: false,
      zip: true,
      keyMode: 'embedded',
    });
    expect(files.some((f) => f.endsWith('.zip'))).toBe(true);
    const { outPath } = await runRestore({
      inputs: files.filter((f) => f.endsWith('.zip')),
      outDir: join(dir, 'restored'),
      password: PW,
    });
    expect([...readFileSync(outPath)]).toEqual([...content]);
  });

  it('keyfile: needs the .key to restore', SLOW, async () => {
    const dir = tmp();
    const content = pattern(1500, 3);
    const input = writeSecret(dir, content);
    const { files } = await runSave({
      inputFile: input,
      outDir: join(dir, 'out'),
      password: PW,
      paper: false,
      zip: false,
      keyMode: 'keyfile',
    });
    const keyPath = files.find((f) => f.endsWith('.key'))!;
    expect(keyPath).toBeTruthy();
    const images = files.filter((f) => f.endsWith('.png'));

    // Without the key → MissingKeyError.
    await expect(
      runRestore({ inputs: images, outDir: join(dir, 'r1'), password: PW }),
    ).rejects.toBeTruthy();

    const { outPath } = await runRestore({
      inputs: images,
      outDir: join(dir, 'r2'),
      password: PW,
      keyPath,
    });
    expect([...readFileSync(outPath)]).toEqual([...content]);
  });

  it('stego: key hidden in a cover photo → restore with --key image', SLOW, async () => {
    const dir = tmp();
    const content = pattern(1200, 11);
    const input = writeSecret(dir, content);
    const cover = writeCover(dir);
    const { files } = await runSave({
      inputFile: input,
      outDir: join(dir, 'out'),
      password: PW,
      paper: false,
      zip: false,
      keyMode: 'stego',
      cover,
    });
    // The stego key image reuses the cover's own filename (deniability), not a
    // "-key" name; the vault images are the stegoshard-*.png set.
    const keyImage = files.find((f) => f.endsWith('cover.png'))!;
    const images = files.filter((f) => /stegoshard-.*\.png$/.test(f));

    // Wrong password against the stego image → cannot restore.
    await expect(
      runRestore({ inputs: images, outDir: join(dir, 'r1'), password: 'wrong', keyPath: keyImage }),
    ).rejects.toBeTruthy();

    const { outPath } = await runRestore({
      inputs: images,
      outDir: join(dir, 'r2'),
      password: PW,
      keyPath: keyImage,
    });
    expect([...readFileSync(outPath)]).toEqual([...content]);
  });

  it('stego with a JPEG cover stays a same-named JPEG and restores', SLOW, async () => {
    const dir = tmp();
    const content = pattern(1200, 13);
    const input = writeSecret(dir, content);
    const cover = writeJpegCover(dir); // named photo.jpg
    const { files } = await runSave({
      inputFile: input,
      outDir: join(dir, 'out'),
      password: PW,
      paper: false,
      zip: false,
      keyMode: 'stego',
      cover,
    });
    // Output keeps the cover's format and filename.
    const keyImage = files.find((f) => f.endsWith('photo.jpg'))!;
    expect(keyImage).toBeTruthy();
    const images = files.filter((f) => /stegoshard-.*\.png$/.test(f));

    const { outPath } = await runRestore({
      inputs: images,
      outDir: join(dir, 'r'),
      password: PW,
      keyPath: keyImage,
    });
    expect([...readFileSync(outPath)]).toEqual([...content]);
  });

  it('binary branded: single .ssbn file → restore', SLOW, async () => {
    const dir = tmp();
    const content = pattern(5000, 31);
    const input = writeSecret(dir, content);
    const { files, binary, imageCount } = await runSave({
      inputFile: input,
      outDir: join(dir, 'out'),
      password: PW,
      paper: false,
      zip: false,
      binary: 'branded',
      keyMode: 'embedded',
    });
    expect(binary).toBe('branded');
    expect(imageCount).toBe(0);
    const vault = files.find((f) => f.endsWith('.ssbn'))!;
    expect(vault).toBeTruthy();
    const { outPath } = await runRestore({
      inputs: [vault],
      outDir: join(dir, 'r'),
      password: PW,
    });
    expect([...readFileSync(outPath)]).toEqual([...content]);
  });

  it('binary disguised keyfile: .db vault + .db key → restore', SLOW, async () => {
    const dir = tmp();
    const content = pattern(2000, 37);
    const input = writeSecret(dir, content);
    const { files } = await runSave({
      inputFile: input,
      outDir: join(dir, 'out'),
      password: PW,
      paper: false,
      zip: false,
      binary: 'disguised',
      keyMode: 'keyfile',
    });
    const vault = files.find((f) => f.endsWith('cache.db'))!;
    const keyFile = files.find((f) => f.endsWith('settings.db'))!;
    expect(vault).toBeTruthy();
    expect(keyFile).toBeTruthy();

    // Vault alone → MissingKeyError.
    await expect(
      runRestore({ inputs: [vault], outDir: join(dir, 'r1'), password: PW }),
    ).rejects.toBeTruthy();

    const { outPath } = await runRestore({
      inputs: [vault],
      outDir: join(dir, 'r2'),
      password: PW,
      keyPath: keyFile,
    });
    expect([...readFileSync(outPath)]).toEqual([...content]);
  });

  it('warns when a secret over 256 KiB is saved as images', SLOW, async () => {
    const dir = tmp();
    // Over the warn threshold by raw size, but highly compressible so it still
    // encodes to a handful of images — the warning keys on content.length.
    const content = new Uint8Array(300 * 1024); // zeros → gzips to ~1 image
    const input = writeSecret(dir, content);
    const { sizeWarning } = await runSave({
      inputFile: input,
      outDir: join(dir, 'out'),
      password: PW,
      paper: false,
      zip: true,
      keyMode: 'embedded',
    });
    expect(sizeWarning).toMatch(/binary/);
  });

  it('estimate matches the actual image count', SLOW, async () => {
    const dir = tmp();
    const content = pattern(4000, 21);
    const input = writeSecret(dir, content);
    const est = await runEstimate(input, false);
    const { imageCount } = await runSave({
      inputFile: input,
      outDir: join(dir, 'out'),
      password: PW,
      paper: false,
      zip: false,
      keyMode: 'embedded',
    });
    expect(est.images).toBe(imageCount);
  });
});
