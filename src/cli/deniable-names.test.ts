/**
 * The deniability property, asserted rather than assumed.
 *
 * The disguised `.db` and gallery destinations exist so a folder listing raises
 * no flags. That property is easy to erode one filename at a time — a new
 * artifact named after the project, a share heading left branded — and nothing
 * else in the suite would notice. These tests fail the moment it slips.
 *
 * The overt destinations are checked in the opposite direction: they are
 * *supposed* to be branded, so a well-meaning sweep that de-brands everything
 * should fail too.
 */

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { encode as encodePng } from 'fast-png';
import { runGallerySave, runSave } from './commands';

const SLOW = { timeout: 90_000 };
const PW = 'a long unrelated passphrase for the deniability tests';
const tmp = () => mkdtempSync(join(tmpdir(), 'ss-deniable-'));

function write(dir: string, name: string, data: Uint8Array | string): string {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
}

/** A PNG with ample LSB capacity for a hidden key factor. */
function writeCover(dir: string, name: string, seed = 11): string {
  const w = 160;
  const h = 160;
  const data = new Uint8Array(w * h * 4);
  let s = seed >>> 0;
  for (let i = 0; i < data.length; i += 4) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i] = s & 0xff;
    data[i + 1] = (s >>> 8) & 0xff;
    data[i + 2] = (s >>> 16) & 0xff;
    data[i + 3] = 255;
  }
  return write(dir, name, encodePng({ width: w, height: h, data, channels: 4 }));
}

/** Every path a save reported, reduced to basenames. */
const names = (files: string[]) => files.map((f) => basename(f));

describe('deniable destinations name nothing after the project', () => {
  it('disguised .db with threshold shares: no filename mentions StegoShard', SLOW, async () => {
    const dir = tmp();
    const outDir = join(dir, 'out');
    const secret = write(dir, 'secret.txt', 'deniable naming check\n');

    const res = await runSave({
      inputs: [secret],
      outDir,
      password: PW,
      paper: false,
      zip: false,
      binary: 'disguised',
      mode: 'nonpossession',
      threshold: { k: 2, n: 3 },
      keyMode: 'embedded',
    });

    for (const name of names(res.files)) expect(name).not.toMatch(/stegoshard/i);
    // What it should be instead, so a rename to some *other* leaky scheme fails.
    expect(names(res.files)).toContain('cache.db');
    expect(names(res.files).filter((n) => /^recovery-\d+\.txt$/.test(n))).toHaveLength(3);

    // The share body must not reintroduce the brand the filename just dropped.
    for (const path of res.files.filter((f) => f.endsWith('.txt'))) {
      const body = readFileSync(path, 'utf8');
      expect(body).not.toMatch(/stegoshard/i);
      expect(body).toMatch(/^Recovery share \d+ of 3/);
    }

    // Nothing stray in the directory either — the manifest must be the whole story.
    for (const entry of readdirSync(outDir)) expect(entry).not.toMatch(/stegoshard/i);
  });

  it('disguised .db with a keyfile: the key is a plausible app database', SLOW, async () => {
    const dir = tmp();
    const outDir = join(dir, 'out');
    const secret = write(dir, 'secret.txt', 'keyfile naming check\n');

    const res = await runSave({
      inputs: [secret],
      outDir,
      password: PW,
      paper: false,
      zip: false,
      binary: 'disguised',
      keyMode: 'keyfile',
    });

    for (const name of names(res.files)) expect(name).not.toMatch(/stegoshard/i);
    expect(names(res.files).sort()).toEqual(['cache.db', 'settings.db']);
  });

  it(
    'gallery with threshold shares: photos keep cover names, shares stay neutral',
    SLOW,
    async () => {
      const dir = tmp();
      const outDir = join(dir, 'out');
      const secret = write(dir, 'secret.txt', 'gallery naming check\n');
      // Gallery needs carriers + decoys; 10 covers clears the minimum comfortably.
      const covers = Array.from({ length: 10 }, (_, i) =>
        writeCover(dir, `IMG_2${i}00.png`, 20 + i),
      );

      const res = await runGallerySave({
        secretFile: secret,
        covers,
        outDir,
        password: PW,
        keyMode: 'embedded',
        mode: 'nonpossession',
        threshold: { k: 2, n: 3 },
      });

      for (const name of names(res.files)) expect(name).not.toMatch(/stegoshard/i);
      expect(names(res.files).filter((n) => /^recovery-\d+\.txt$/.test(n))).toHaveLength(3);
      for (const path of res.files.filter((f) => f.endsWith('.txt'))) {
        expect(readFileSync(path, 'utf8')).not.toMatch(/stegoshard/i);
      }
    },
  );
});

describe('overt destinations stay branded', () => {
  it('branded .ssbn keeps the project name', SLOW, async () => {
    const dir = tmp();
    const outDir = join(dir, 'out');
    const secret = write(dir, 'secret.txt', 'overt naming check\n');

    const res = await runSave({
      inputs: [secret],
      outDir,
      password: PW,
      paper: false,
      zip: false,
      binary: 'branded',
      keyMode: 'embedded',
    });

    expect(names(res.files)).toEqual(['stegoshard-vault.ssbn']);
  });
});
