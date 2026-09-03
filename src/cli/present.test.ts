/**
 * The terminal presenter, tested directly.
 *
 * It is pure formatting over already-computed results, so it can be exercised
 * without a save: no Argon2, no filesystem. The gallery and paper paths had no
 * coverage at all because reaching them through `run()` costs a real
 * gallery-save, which is exactly the shape of gap a per-file ratchet is meant to
 * surface.
 *
 * The invariant every case asserts: results on stdout, everything else on
 * stderr. A pipeline is broken by a single line on the wrong stream.
 */

import { describe, it, expect } from 'vitest';
import { humanPresenter } from './present';
import type { CliIo } from './io';
import type { SaveResult } from '../api/node/commands';

interface Captured extends CliIo {
  stdout: string;
  stderr: string;
}

function fakeIo(isStderrTty = false): Captured {
  const io: Captured = {
    stdout: '',
    stderr: '',
    out: (t) => void (io.stdout += t),
    err: (t) => void (io.stderr += t),
    env: { STEGOSHARD_LANG: 'en' } as NodeJS.ProcessEnv,
    isStdinTty: false,
    isStderrTty,
  };
  return io;
}

const SAVE: SaveResult = {
  files: ['out/a.png', 'out/b.png'],
  manifest: [
    { name: 'out/a.png', purpose: 'vault' },
    { name: 'out/b.png', purpose: 'vault' },
  ],
  imageCount: 2,
  setId: 'a1b2c3d4',
  keyMode: 'embedded',
};

describe('save output', () => {
  it('names the image count and lists the files created', () => {
    const io = fakeIo();
    humanPresenter(io).save(SAVE);
    expect(io.stdout).toMatch(/^Saved 2 image/m);
    expect(io.stdout).toMatch(/Files created:/);
    expect(io.stdout).toContain('out/a.png');
    expect(io.stderr).toBe('');
  });

  it('names the variant instead of a count on a binary save', () => {
    const io = fakeIo();
    humanPresenter(io).save({ ...SAVE, binary: 'disguised', imageCount: 0, setId: '' });
    expect(io.stdout).toMatch(/disguised/);
  });

  // A key that travels separately is useless if the user throws it away, so the
  // reminder is not optional.
  it('reminds the user to keep an external key, and only then', () => {
    const embedded = fakeIo();
    humanPresenter(embedded).save(SAVE);
    const keyfile = fakeIo();
    humanPresenter(keyfile).save({ ...SAVE, keyMode: 'keyfile' });
    expect(keyfile.stdout.length).toBeGreaterThan(embedded.stdout.length);
  });

  /**
   * Numbered runs collapse so a 40-image save stays readable, but a pair reads
   * better in full than as a range.
   */
  it('collapses a numbered run but leaves a pair whole', () => {
    const many = fakeIo();
    humanPresenter(many).save({
      ...SAVE,
      imageCount: 12,
      files: Array.from({ length: 12 }, (_, i) => `out/img-${String(i + 1).padStart(2, '0')}.png`),
      manifest: Array.from({ length: 12 }, (_, i) => ({
        name: `out/img-${String(i + 1).padStart(2, '0')}.png`,
        purpose: 'vault' as const,
      })),
    });
    expect(many.stdout).toMatch(/…/);
    expect(many.stdout).toContain('(12)');

    const pair = fakeIo();
    humanPresenter(pair).save(SAVE);
    expect(pair.stdout).not.toMatch(/…/);
  });

  it('prints nothing for an empty manifest rather than a bare heading', () => {
    const io = fakeIo();
    humanPresenter(io).save({ ...SAVE, files: [], manifest: [], imageCount: 0 });
    expect(io.stdout).not.toMatch(/Files created:/);
  });
});

describe('restore output', () => {
  it('puts the restored path on stdout and the decode count on stderr', () => {
    const io = fakeIo();
    humanPresenter(io).restore({
      files: ['r/s.txt'],
      outPath: 'r/s.txt',
      filename: 's.txt',
      seen: 3,
      decoded: 3,
    });
    expect(io.stdout).toMatch(/^Restored s\.txt -> r\/s\.txt/m);
    expect(io.stderr).toMatch(/3/);
    expect(io.stderr).not.toMatch(/Restored/);
  });

  // A bundle unpacks to several files, so naming the envelope and one path would
  // describe neither.
  it('lists every file when a bundle unpacked', () => {
    const io = fakeIo();
    humanPresenter(io).restore({
      files: ['r/a.txt', 'r/b.pem', 'r/c.jpg'],
      outPath: 'r/a.txt',
      filename: 'bundle.zip',
      seen: 5,
      decoded: 5,
    });
    expect(io.stdout).toMatch(/3/);
    for (const f of ['r/a.txt', 'r/b.pem', 'r/c.jpg']) expect(io.stdout).toContain(f);
  });
});

describe('gallery output', () => {
  it('reports the shard split and how many photos to keep', () => {
    const io = fakeIo();
    humanPresenter(io).gallerySave({
      files: ['g/1.png', 'g/2.png'],
      manifest: [
        { name: 'g/1.png', purpose: 'photos' },
        { name: 'g/2.png', purpose: 'photos' },
      ],
      k: 3,
      m: 2,
      decoys: 2,
      setId: 'deadbeef',
      keyMode: 'embedded',
    });
    expect(io.stdout).toMatch(/3/);
    expect(io.stderr).toBe('');
  });

  it('adds the key reminder for a non-embedded gallery', () => {
    const embedded = fakeIo();
    const base = {
      files: ['g/1.png'],
      manifest: [{ name: 'g/1.png', purpose: 'photos' as const }],
      k: 3,
      m: 2,
      decoys: 2,
      setId: 'deadbeef',
    };
    humanPresenter(embedded).gallerySave({ ...base, keyMode: 'embedded' });
    const stego = fakeIo();
    humanPresenter(stego).gallerySave({ ...base, keyMode: 'stego' });
    expect(stego.stdout.length).toBeGreaterThan(embedded.stdout.length);
  });

  it('puts a gallery restore on stdout and the scan count on stderr', () => {
    const io = fakeIo();
    humanPresenter(io).galleryRestore({
      files: ['r/n.txt'],
      outPath: 'r/n.txt',
      filename: 'n.txt',
      seen: 9,
    });
    expect(io.stdout).toMatch(/^Restored n\.txt/m);
    expect(io.stderr).toMatch(/9/);
  });
});

describe('estimate output', () => {
  it('reports the image count and the shard split', () => {
    const io = fakeIo();
    humanPresenter(io).estimate({ images: 7, k: 5, m: 2 });
    expect(io.stdout).toMatch(/7/);
    expect(io.stderr).toBe('');
  });
});

describe('warnings and progress', () => {
  it('sends a warning to stderr, never to stdout', () => {
    const io = fakeIo();
    humanPresenter(io).warn({ code: 'PASSWORD_FLAG_VISIBLE', message: 'visible in your history' });
    expect(io.stderr).toBe('visible in your history\n');
    expect(io.stdout).toBe('');
  });

  it('emits one line per phase change when piped, and no redraw', () => {
    const io = fakeIo(false);
    const { onProgress, done } = humanPresenter(io).progress(false);
    onProgress!({ phase: 'encrypt', done: 1, total: 10 });
    onProgress!({ phase: 'encrypt', done: 5, total: 10 });
    onProgress!({ phase: 'verify', done: 1, total: 10 });
    done();
    // Two phases, two lines: the repeat within a phase is not worth a line when
    // there is no cursor to move.
    expect(io.stderr.split('\n').filter((l) => l !== '')).toHaveLength(2);
    expect(io.stderr.includes(`${String.fromCharCode(27)}[2K`)).toBe(false);
  });

  it('redraws a single line on a terminal, and clears it when done', () => {
    const io = fakeIo(true);
    const CLEAR = `${String.fromCharCode(27)}[2K`;
    const { onProgress, done } = humanPresenter(io).progress(false);
    onProgress!({ phase: 'encrypt', done: 5, total: 10 });
    expect(io.stderr).toContain(CLEAR);
    expect(io.stderr).toMatch(/50%/);
    const beforeDone = io.stderr.length;
    done();
    // The line is wiped rather than left dangling above the result.
    expect(io.stderr.length).toBeGreaterThan(beforeDone);
  });

  it('shows a bare ellipsis when a phase reports no total', () => {
    const io = fakeIo(true);
    const { onProgress } = humanPresenter(io).progress(false);
    onProgress!({ phase: 'unlock', done: 0, total: 0 });
    expect(io.stderr).toMatch(/…/);
    expect(io.stderr).not.toMatch(/%/);
  });

  it('emits nothing at all when quiet, and done() is still safe to call', () => {
    const io = fakeIo(true);
    const { onProgress, done } = humanPresenter(io).progress(true);
    expect(onProgress).toBeUndefined();
    done();
    expect(io.stderr).toBe('');
  });

  // The bootstrap owns the failure message, so the presenter must not also print
  // it: two copies on two streams is worse than one.
  it('writes nothing on failure, which the bootstrap handles', () => {
    const io = fakeIo();
    humanPresenter(io).failure({ message: 'wrong password', exitCode: 1 }, new Error('x'));
    expect(io.stdout).toBe('');
    expect(io.stderr).toBe('');
  });
});
