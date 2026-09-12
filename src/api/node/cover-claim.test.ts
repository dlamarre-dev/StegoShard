/**
 * The cover claim, through the real orchestration rather than through the core.
 *
 * `src/core/stego-guard.test.ts` covers the guard's own rules. This file covers
 * the part that lives in `commands.ts` and that a unit test cannot reach: when a
 * claim survives a failed save and when it does not. Both directions have been
 * wrong here, in separate reviews, and neither was caught by a test:
 *
 *   - releasing too eagerly re-opened the §5.3 leak, because a save writes
 *     incrementally and a failure AFTER the stego image landed was dropping a
 *     claim for a cover that really was on disk;
 *   - releasing too late (or not at all) burned the cover, refusing a retry for
 *     an artifact that never existed.
 *
 * So the interesting assertions are the two failure paths, not the happy one.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it, expect } from 'vitest';
import jpeg from 'jpeg-js';
import { StegoCoverReuseError, resetStegoCoverGuard } from '../../core';
import { runSave, type SaveOptions } from './commands';

const SLOW = { timeout: 120_000 };
const PW = 'a long unrelated passphrase for these tests';

beforeEach(resetStegoCoverGuard);

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'ss-claim-'));
}

/** One directory holding a secret and a reusable JPEG cover. */
function fixture(): { dir: string; secret: string; cover: string } {
  const dir = scratch();
  const secret = join(dir, 's.txt');
  writeFileSync(secret, 'the actual secret');
  const w = 256;
  const h = 256;
  const data = new Uint8Array(w * h * 4);
  let x = 90210;
  for (let p = 0; p < w * h; p++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    data[p * 4] = (x >>> 24) & 0xff;
    data[p * 4 + 1] = (x >>> 16) & 0xff;
    data[p * 4 + 2] = (x >>> 8) & 0xff;
    data[p * 4 + 3] = 255;
  }
  const cover = join(dir, 'cover.jpg');
  writeFileSync(cover, Buffer.from(jpeg.encode({ data, width: w, height: h }, 80).data));
  return { dir, secret, cover };
}

const opts = (f: ReturnType<typeof fixture>, outDir: string): SaveOptions => ({
  inputs: [f.secret],
  outDir,
  password: PW,
  paper: false,
  zip: false,
  binary: 'branded',
  keyMode: 'stego',
  cover: f.cover,
});

describe('a claim made by a save that landed', () => {
  it('refuses a second save into the same cover', SLOW, async () => {
    const f = fixture();
    await runSave(opts(f, join(f.dir, 'one')));
    await expect(runSave(opts(f, join(f.dir, 'two')))).rejects.toThrow(StegoCoverReuseError);
  });
});

describe('a claim made by a save that failed', () => {
  it('is released when the failure came before the key image was written', SLOW, async () => {
    // The collision has to be on the KEY IMAGE, not the vault. On the branded path
    // the vault is written BEFORE `externalKey` runs, so pre-creating it throws
    // before any embed happens and before any claim exists -- which is what the
    // first version of this test did, making it pass whether or not release
    // worked. The key image is written after the embed and is named after the
    // cover, so colliding on `cover.jpg` is the failure that actually has a claim
    // outstanding.
    const f = fixture();
    const out = join(f.dir, 'out');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'cover.jpg'), 'in the way');

    await expect(runSave(opts(f, out))).rejects.toMatchObject({ code: 'OUTPUT_EXISTS' });
    await expect(runSave({ ...opts(f, out), force: true })).resolves.toBeTruthy();
    expect(readdirSync(out).length).toBeGreaterThan(1);
  });

  it('is KEPT when the failure came after the key image was written', SLOW, async () => {
    // The invariant that makes this necessary: the stego image is NOT the last
    // write on every path. Non-possession writes recovery-N.txt afterwards, so a
    // collision there fails a save whose cover artifact is already on disk.
    // Releasing then would let the retry mint a second artifact from one cover
    // under one password -- the §5.3 leak. `landed` is what prevents it, and it is
    // set by the write rather than inferred from where the throw surfaced.
    const f = fixture();
    const out = join(f.dir, 'np');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'recovery-1.txt'), 'in the way');

    const np: SaveOptions = {
      ...opts(f, out),
      binary: 'disguised',
      mode: 'nonpossession',
      threshold: { k: 2, n: 3 },
    };
    await expect(runSave(np)).rejects.toMatchObject({ code: 'OUTPUT_EXISTS' });

    // The cover artifact landed before that collision, so it is claimed for good.
    await expect(runSave({ ...np, outDir: join(f.dir, 'np2') })).rejects.toThrow(
      StegoCoverReuseError,
    );
  });
});
