/**
 * Output files are written atomically.
 *
 * The failure this guards against is not corruption in the ordinary sense. On
 * this format a truncated file is not a partly-readable document — it is a
 * secret that no longer exists. And post-save verification does not catch it,
 * because it verifies the bytes held in memory rather than the file that
 * reached the disk.
 *
 * So the interesting assertion is the one about a write that fails halfway:
 * whatever was already on disk must still be there, and no partial file may be
 * left behind. Testing only the happy path would pass on the old
 * `writeFileSync` implementation too.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `fsyncSync` is the flush the atomic write depends on, and an ESM namespace
 * cannot be spied in place, so the module is mocked with a switch this file
 * flips. Failing at the flush is the shape of a full disk or a removed device:
 * the bytes were handed over and never durably landed.
 */
const failFsync: { error: Error | null } = { error: null };
/**
 * `writeSync` is allowed to accept fewer bytes than it was given. It almost
 * never does on a local file, which is exactly why a caller that ignores the
 * return value looks correct for years and then silently truncates a vault, so
 * the short write is forced here rather than waited for.
 */
const shortWrite: { limit: number | null } = { limit: null };
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    fsyncSync: (fd: number) => {
      if (failFsync.error) throw failFsync.error;
      return real.fsyncSync(fd);
    },
    writeSync: (fd: number, data: Uint8Array, offset?: number, length?: number) => {
      const off = offset ?? 0;
      const len = length ?? data.length - off;
      const capped = shortWrite.limit === null ? len : Math.min(len, shortWrite.limit);
      return real.writeSync(fd, data, off, capped);
    },
  };
});

const { runSave, runRestore } = await import('./commands');

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'stegoshard-atomic-'));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  failFsync.error = null;
  shortWrite.limit = null;
});

afterEach(() => {
  failFsync.error = null;
  shortWrite.limit = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PASSWORD = 'correct horse battery staple';

async function saveInto(outDir: string, force = false) {
  const src = join(scratch(), 'secret.txt');
  writeFileSync(src, 'the actual secret');
  // The branded binary destination writes one file, which keeps the assertions
  // about "the target" unambiguous.
  return runSave({
    inputs: [src],
    outDir,
    password: PASSWORD,
    paper: false,
    zip: false,
    keyMode: 'embedded',
    binary: 'branded',
    force,
  });
}

describe('a successful write leaves no temporaries', () => {
  it('writes the requested files and nothing else', async () => {
    const out = scratch();
    const res = await saveInto(out);
    expect(res.files.length).toBeGreaterThan(0);

    const left = readdirSync(out);
    expect(
      left.filter((f) => f.endsWith('.tmp')),
      'a temporary survived a clean write',
    ).toEqual([]);
    for (const f of res.files) expect(readFileSync(f).length).toBeGreaterThan(0);
  });
});

describe('a write that fails partway leaves the previous file intact', () => {
  it('does not truncate the target, and cleans up the temporary', async () => {
    const out = scratch();
    const first = await saveInto(out);
    const target = first.files[0]!;
    const before = readFileSync(target);
    expect(before.length).toBeGreaterThan(0);

    // Fail after the temporary is opened and written, at the flush. This is the
    // shape of a full disk or a removed device: the data never durably lands.
    failFsync.error = new Error('ENOSPC: no space left on device');

    await expect(saveInto(out, true)).rejects.toThrow(/ENOSPC/);

    // The whole point: the old file is still the old file, byte for byte.
    const after = readFileSync(target);
    expect(after.length).toBe(before.length);
    expect(Buffer.compare(Buffer.from(after), Buffer.from(before))).toBe(0);

    // And nothing half-written was left lying next to it.
    expect(
      readdirSync(out).filter((f) => f.endsWith('.tmp')),
      'a temporary survived a failed write',
    ).toEqual([]);
  });

  it('leaves no file at all when the very first write fails', async () => {
    const out = scratch();
    failFsync.error = new Error('EIO: i/o error');
    await expect(saveInto(out)).rejects.toThrow(/EIO/);
    // Not even an empty placeholder: the target is never created before the
    // rename, so a failed first write is indistinguishable from no write.
    expect(readdirSync(out)).toEqual([]);
  });
});

describe('the overwrite guard still holds', () => {
  it('refuses an existing target without --force', async () => {
    const out = scratch();
    await saveInto(out);
    await expect(saveInto(out)).rejects.toThrow(/refusing to overwrite/);
  });

  it('replaces an existing target with --force', async () => {
    const out = scratch();
    const first = await saveInto(out);
    const before = readFileSync(first.files[0]!);
    const second = await saveInto(out, true);
    const after = readFileSync(second.files[0]!);
    // A fresh export uses a fresh IV, so the bytes must differ.
    expect(Buffer.compare(Buffer.from(after), Buffer.from(before))).not.toBe(0);
  });
});

describe('a short write is finished rather than trusted', () => {
  it('writes every byte when the kernel accepts them a chunk at a time', async () => {
    const out = scratch();
    // Whole bytes first, as the reference to compare against.
    const reference = readFileSync((await saveInto(out)).files[0]!);
    const chunk = 64;
    expect(reference.length).toBeGreaterThan(chunk);

    const chunked = scratch();
    shortWrite.limit = chunk;
    const res = await saveInto(chunked);
    const written = readFileSync(res.files[0]!);

    // A single unchecked `writeSync` would stop at `chunk` bytes here, and the
    // fsync and rename below it would install that stump as the finished vault:
    // a vault missing its tail is a secret you no longer have.
    expect(written.length, 'the vault was truncated at the first short write').toBe(
      reference.length,
    );
    // Not a byte comparison: each save draws a fresh salt and nonce, so two
    // vaults of the same secret differ everywhere but in length. The length is
    // the claim — and the round trip below is what proves it is a whole vault
    // rather than merely a file of the right size.
    const restored = scratch();
    await runRestore({ inputs: [res.files[0]!], outDir: restored, password: PASSWORD });
    expect(readFileSync(join(restored, 'secret.txt'), 'utf-8')).toBe('the actual secret');
    expect(readdirSync(chunked).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('fails loudly rather than looping forever when the write stalls', async () => {
    const out = scratch();
    shortWrite.limit = 0;
    await expect(saveInto(out)).rejects.toThrow(/write stalled at 0 of \d+ bytes/);
    expect(readdirSync(out)).toEqual([]);
  });
});
