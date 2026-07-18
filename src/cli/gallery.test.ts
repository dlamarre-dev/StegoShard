/**
 * CLI Gallery Mode save→restore round-trip through real Node file I/O and the
 * production `@core` pipeline (blind winnowing, folder in / folder out).
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { encode as encodePng } from 'fast-png';
import { runGalleryRestore, runGallerySave } from './commands';

// Production Argon2 (64 MiB) runs on save and restore; give CI room.
const SLOW = { timeout: 60_000 };
const PW = 'correct horse battery staple';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'iv-gallery-'));
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
    const coverDir = tmp();
    for (let i = 0; i < 6; i++) writePngCover(coverDir, `photo-${i}.png`, i + 1);

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
    expect(save.files.length).toBe(6);
    expect(save.k + save.m + save.decoys).toBe(6);
    expect(save.decoys).toBeGreaterThanOrEqual(2);

    const restoreDir = tmp();
    const res = await runGalleryRestore({ inputs: [albumDir], outDir: restoreDir, password: PW });
    expect(res.filename).toBe('note.txt');
    expect(res.seen).toBe(6);
    expect(new Uint8Array(readFileSync(res.outPath))).toEqual(new Uint8Array(secret));
  });
});
