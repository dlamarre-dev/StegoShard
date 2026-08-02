/**
 * CLI save→restore for the §10 access modes on the disguised .db path: duress
 * (Mode A) and non-possession (Mode B), through real Node file I/O and @core.
 * Production Argon2 (256 MiB) runs here, so these are deliberately slow.
 */

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { encode as encodePng } from 'fast-png';
import { runRestore, runSave } from './commands';

const SLOW = { timeout: 90_000 };
const tmp = () => mkdtempSync(join(tmpdir(), 'ss-modes-'));
const REAL_PW = 'the real password is a long unrelated phrase';
const DURESS_PW = 'zzq plum tractor nine forty two';

function write(dir: string, name: string, data: Uint8Array | string): string {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
}

/** A PNG cover with ample RGB LSB capacity for the 37-byte SSKF factor envelope. */
function writeCover(dir: string, name = 'cover.png', seed = 7): string {
  const w = 128;
  const h = 128;
  const data = new Uint8Array(w * h * 4);
  let s = seed >>> 0;
  for (let p = 0; p < w * h; p++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[p * 4] = (s >>> 24) & 0xff;
    data[p * 4 + 1] = (s >>> 16) & 0xff;
    data[p * 4 + 2] = (s >>> 8) & 0xff;
    data[p * 4 + 3] = 255;
  }
  return write(dir, name, encodePng({ width: w, height: h, data, channels: 4, depth: 8 }));
}

describe('CLI .db duress (Mode A)', () => {
  it(
    'each password restores its own file; the duress one never yields the real',
    SLOW,
    async () => {
      const dir = tmp();
      const secret = write(dir, 'real.txt', 'REAL: seed alpha bravo charlie');
      const decoy = write(dir, 'decoy.txt', 'DECOY: shopping list, gym times');
      const outDir = tmp();

      const save = await runSave({
        inputFile: secret,
        outDir,
        password: REAL_PW,
        paper: false,
        zip: false,
        binary: 'disguised',
        mode: 'duress',
        duressPassword: DURESS_PW,
        decoyFile: decoy,
        keyMode: 'embedded',
      });
      const vault = save.files.find((f) => f.endsWith('.db'))!;
      expect(vault).toBeTruthy();

      // The real password restores the real file.
      const realOut = tmp();
      const real = await runRestore({ inputs: [vault], outDir: realOut, password: REAL_PW });
      expect(readFileSync(real.outPath, 'utf8')).toBe('REAL: seed alpha bravo charlie');

      // The duress password restores ONLY the decoy — indistinguishable success.
      const decoyOut = tmp();
      const dur = await runRestore({ inputs: [vault], outDir: decoyOut, password: DURESS_PW });
      expect(readFileSync(dur.outPath, 'utf8')).toBe('DECOY: shopping list, gym times');
    },
  );

  it('composes with a stego key factor gating the REAL region only', SLOW, async () => {
    const dir = tmp();
    const secret = write(dir, 'real.txt', 'REAL: the composed-factor secret');
    const decoy = write(dir, 'decoy.txt', 'DECOY: harmless notes');
    const cover = writeCover(dir);
    const outDir = tmp();

    const save = await runSave({
      inputFile: secret,
      outDir,
      password: REAL_PW,
      paper: false,
      zip: false,
      binary: 'disguised',
      mode: 'duress',
      duressPassword: DURESS_PW,
      decoyFile: decoy,
      keyMode: 'stego',
      cover,
    });
    const vault = save.files.find((f) => f.endsWith('.db'))!;
    const keyImage = save.files.find((f) => f.endsWith('cover.png'))!;
    expect(vault && keyImage).toBeTruthy();

    // The real region needs BOTH the real password and the stego cover (the extra
    // factor layer): the real password alone does not open it.
    await expect(
      runRestore({ inputs: [vault], outDir: tmp(), password: REAL_PW }),
    ).rejects.toThrow();

    // Real password + the stego cover → the real file.
    const realOut = tmp();
    const real = await runRestore({
      inputs: [vault],
      outDir: realOut,
      password: REAL_PW,
      keyPath: keyImage,
    });
    expect(readFileSync(real.outPath, 'utf8')).toBe('REAL: the composed-factor secret');

    // The decoy is meant to be surrendered under coercion: the duress password
    // opens it on its own, with no cover needed.
    const decoyOut = tmp();
    const dur = await runRestore({ inputs: [vault], outDir: decoyOut, password: DURESS_PW });
    expect(readFileSync(dur.outPath, 'utf8')).toBe('DECOY: harmless notes');
  });

  it('rejects a duress password too similar to the real one', SLOW, async () => {
    const dir = tmp();
    const secret = write(dir, 'real.txt', 'x');
    const decoy = write(dir, 'decoy.txt', 'y');
    await expect(
      runSave({
        inputFile: secret,
        outDir: tmp(),
        password: 'hunter2-abcdef',
        paper: false,
        zip: false,
        binary: 'disguised',
        mode: 'duress',
        duressPassword: 'hunter2-abcdeg', // one edit away
        decoyFile: decoy,
        keyMode: 'embedded',
      }),
    ).rejects.toThrow();
  });
});

describe('CLI .db non-possession (Mode B)', () => {
  it('writes n share files; any k restore, fewer than k (or none) fail', SLOW, async () => {
    const dir = tmp();
    const secret = write(dir, 'ledger.txt', 'gated ledger contents');
    const outDir = tmp();

    const save = await runSave({
      inputFile: secret,
      outDir,
      password: REAL_PW,
      paper: false,
      zip: false,
      binary: 'disguised',
      mode: 'nonpossession',
      threshold: { k: 2, n: 3 },
      keyMode: 'embedded',
    });
    const vault = save.files.find((f) => f.endsWith('.db'))!;
    const shares = readdirSync(outDir)
      .filter((f) => f.startsWith('stegoshard-share-'))
      .map((f) => join(outDir, f));
    expect(shares.length).toBe(3);

    // Password alone (no shares) cannot open it.
    await expect(
      runRestore({ inputs: [vault], outDir: tmp(), password: REAL_PW }),
    ).rejects.toThrow();

    // Any 2 of the 3 shares recover it.
    const out = tmp();
    const res = await runRestore({
      inputs: [vault],
      outDir: out,
      password: REAL_PW,
      sharePaths: [shares[0]!, shares[2]!],
    });
    expect(readFileSync(res.outPath, 'utf8')).toBe('gated ledger contents');
  });

  it('composes with a stego key factor: needs the cover AND a share quorum', SLOW, async () => {
    const dir = tmp();
    const secret = write(dir, 'ledger.txt', 'triple-gated ledger');
    const cover = writeCover(dir);
    const outDir = tmp();

    const save = await runSave({
      inputFile: secret,
      outDir,
      password: REAL_PW,
      paper: false,
      zip: false,
      binary: 'disguised',
      mode: 'nonpossession',
      threshold: { k: 2, n: 3 },
      keyMode: 'stego',
      cover,
    });
    const vault = save.files.find((f) => f.endsWith('.db'))!;
    const keyImage = save.files.find((f) => f.endsWith('cover.png'))!;
    const shares = readdirSync(outDir)
      .filter((f) => f.startsWith('stegoshard-share-'))
      .map((f) => join(outDir, f));
    expect(shares.length).toBe(3);

    // Shares without the cover → fail (the key factor is missing).
    await expect(
      runRestore({
        inputs: [vault],
        outDir: tmp(),
        password: REAL_PW,
        sharePaths: [shares[0]!, shares[1]!],
      }),
    ).rejects.toThrow();

    // Cover without a share quorum → fail (the gate stays closed).
    await expect(
      runRestore({ inputs: [vault], outDir: tmp(), password: REAL_PW, keyPath: keyImage }),
    ).rejects.toThrow();

    // Cover + any 2 shares → restore.
    const out = tmp();
    const res = await runRestore({
      inputs: [vault],
      outDir: out,
      password: REAL_PW,
      keyPath: keyImage,
      sharePaths: [shares[0]!, shares[2]!],
    });
    expect(readFileSync(res.outPath, 'utf8')).toBe('triple-gated ledger');
  });
});

describe('CLI mode refusal on excluded paths', () => {
  it('rejects a non-plain mode without --binary --disguise', async () => {
    const dir = tmp();
    const secret = write(dir, 's.txt', 'x');
    await expect(
      runSave({
        inputFile: secret,
        outDir: tmp(),
        password: REAL_PW,
        paper: false,
        zip: false,
        binary: 'branded', // excluded path
        mode: 'duress',
        duressPassword: DURESS_PW,
        decoyFile: secret,
        keyMode: 'embedded',
      }),
    ).rejects.toThrow(/only supported with --binary --disguise/);
  });
});
