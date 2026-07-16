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
    const keyImage = files.find((f) => f.endsWith('-key.png'))!;
    const images = files.filter((f) => f.endsWith('.png') && f !== keyImage);

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
