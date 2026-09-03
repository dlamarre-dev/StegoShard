/**
 * The `--json` envelope, tested against fabricated results.
 *
 * These are the shape tests: no crypto, no filesystem, just what a caller parses.
 * The end-to-end behaviour through `run()` lives in run.json.test.ts.
 *
 * Each command gets a **key-set drift guard**, an assertion on the exact sorted
 * keys of `result`. Snapshots alone would not do: a field silently disappearing
 * is exactly the kind of change someone regenerates a snapshot past without
 * noticing, and it is a breaking change for every consumer.
 */

import { describe, it, expect } from 'vitest';
import { CLI_SCHEMA, jsonErrorCode, jsonPresenter } from './json';
import type { CliIo } from './io';
import { CliError, toCliFailure } from './errors';
import { StegoShardApiError } from '../api/errors';
import { FileTooLargeError, GalleryRestoreError, WrongPasswordError } from '@core';
import type { SaveResult } from '../api/node/commands';

interface Captured extends CliIo {
  stdout: string;
  stderr: string;
}

function fakeIo(): Captured {
  const io: Captured = {
    stdout: '',
    stderr: '',
    out: (t) => void (io.stdout += t),
    err: (t) => void (io.stderr += t),
    env: { STEGOSHARD_LANG: 'en' } as NodeJS.ProcessEnv,
    isStdinTty: false,
    isStderrTty: false,
  };
  return io;
}

/** The single stdout document, parsed. Asserts the one-document rule as it goes. */
function envelopeOf(io: Captured) {
  const lines = io.stdout.split('\n').filter((l) => l !== '');
  expect(lines, 'stdout must carry exactly one JSON document').toHaveLength(1);
  expect(io.stdout.endsWith('\n'), 'the document must be newline-terminated').toBe(true);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

/** Every stderr line, parsed. Asserts NDJSON validity as it goes. */
function eventsOf(io: Captured) {
  return io.stderr
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
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

describe('the envelope', () => {
  it('carries the schema, the stability and the command on success', () => {
    const io = fakeIo();
    jsonPresenter(io, 'estimate').estimate({ images: 7, k: 5, m: 2 });
    expect(envelopeOf(io)).toEqual({
      schema: CLI_SCHEMA,
      stability: 'unstable',
      ok: true,
      command: 'estimate',
      locale: 'en',
      result: { images: 7, k: 5, m: 2 },
    });
  });

  it('pins the schema version, which is a published contract', () => {
    expect(CLI_SCHEMA).toBe('stegoshard.cli/1');
  });

  it('reports the locale it rendered the message in', () => {
    const io = fakeIo();
    io.env = { STEGOSHARD_LANG: 'fr' } as NodeJS.ProcessEnv;
    jsonPresenter(io, 'estimate').estimate({ images: 1, k: 1, m: 2 });
    expect(envelopeOf(io).locale).toBe('fr');
  });

  it('names a null command when there was not one', () => {
    const io = fakeIo();
    jsonPresenter(io, null).estimate({ images: 1, k: 1, m: 2 });
    expect(envelopeOf(io).command).toBeNull();
  });
});

describe('result shapes', () => {
  const keysOf = (io: Captured) =>
    Object.keys(envelopeOf(io).result as Record<string, unknown>).sort();

  it('save', () => {
    const io = fakeIo();
    jsonPresenter(io, 'save').save(SAVE);
    expect(keysOf(io)).toEqual(['files', 'imageCount', 'keyMode', 'manifest', 'setId']);
  });

  it('save on a binary path names the variant and keeps an empty setId', () => {
    const io = fakeIo();
    jsonPresenter(io, 'save').save({ ...SAVE, binary: 'disguised', setId: '', imageCount: 0 });
    const result = envelopeOf(io).result as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual([
      'binary',
      'files',
      'imageCount',
      'keyMode',
      'manifest',
      'setId',
    ]);
    // Present but empty rather than absent: one shape for every save.
    expect(result.setId).toBe('');
    expect(result.binary).toBe('disguised');
  });

  it('restore', () => {
    const io = fakeIo();
    jsonPresenter(io, 'restore').restore({
      files: ['r/s.txt'],
      outPath: 'r/s.txt',
      filename: 's.txt',
      seen: 3,
      decoded: 3,
    });
    expect(keysOf(io)).toEqual(['decoded', 'filename', 'files', 'outPath', 'seen']);
  });

  it('gallery-save', () => {
    const io = fakeIo();
    jsonPresenter(io, 'gallery-save').gallerySave({
      files: ['g/1.png'],
      manifest: [{ name: 'g/1.png', purpose: 'photos' }],
      k: 3,
      m: 2,
      decoys: 2,
      setId: 'deadbeef',
      keyMode: 'embedded',
    });
    expect(keysOf(io)).toEqual(['decoys', 'files', 'k', 'keyMode', 'm', 'manifest', 'setId']);
  });

  it('gallery-restore', () => {
    const io = fakeIo();
    jsonPresenter(io, 'gallery-restore').galleryRestore({
      files: ['r/n.txt'],
      outPath: 'r/n.txt',
      filename: 'n.txt',
      seen: 9,
    });
    expect(keysOf(io)).toEqual(['filename', 'files', 'outPath', 'seen']);
  });

  it('estimate', () => {
    const io = fakeIo();
    jsonPresenter(io, 'estimate').estimate({ images: 7, k: 5, m: 2 });
    expect(keysOf(io)).toEqual(['images', 'k', 'm']);
  });
});

describe('paths', () => {
  it('are absolute, so a caller need not know our working directory', () => {
    const io = fakeIo();
    jsonPresenter(io, 'save').save(SAVE);
    const result = envelopeOf(io).result as { files: string[]; manifest: { name: string }[] };
    for (const f of result.files) {
      expect(f, f).not.toBe('out/a.png');
      // Absolute on either platform: a leading slash, or a drive letter.
      expect(/^([A-Za-z]:[\\/]|\/)/.test(f), f).toBe(true);
    }
    expect(result.manifest[0]!.name).toBe(result.files[0]);
  });
});

describe('warnings', () => {
  it('appear as an event when raised and again with the result', () => {
    const io = fakeIo();
    const p = jsonPresenter(io, 'save');
    p.warn({ code: 'PASSWORD_FLAG_VISIBLE', message: 'visible in your shell history' });
    p.save(SAVE);

    const events = eventsOf(io);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      schema: CLI_SCHEMA,
      event: 'warning',
      code: 'PASSWORD_FLAG_VISIBLE',
      message: 'visible in your shell history',
    });

    const result = envelopeOf(io).result as { warnings: unknown[] };
    expect(result.warnings).toEqual([
      { code: 'PASSWORD_FLAG_VISIBLE', message: 'visible in your shell history' },
    ]);
  });

  it('are absent from the result when there were none', () => {
    const io = fakeIo();
    jsonPresenter(io, 'save').save(SAVE);
    expect(envelopeOf(io).result).not.toHaveProperty('warnings');
  });

  it('carry their details when they have any', () => {
    const io = fakeIo();
    const p = jsonPresenter(io, 'save');
    p.warn({ code: 'LARGE_SECRET', message: 'that is a lot of images', details: { images: 40 } });
    p.save(SAVE);
    const result = envelopeOf(io).result as { warnings: { details?: unknown }[] };
    expect(result.warnings[0]!.details).toEqual({ images: 40 });
  });
});

describe('progress events', () => {
  it('report the raw phase name, not a localized label', () => {
    const io = fakeIo();
    const { onProgress } = jsonPresenter(io, 'save').progress(false);
    onProgress!({ phase: 'encrypt', done: 1024, total: 65536 });
    expect(eventsOf(io)[0]).toEqual({
      schema: CLI_SCHEMA,
      event: 'progress',
      phase: 'encrypt',
      done: 1024,
      total: 65536,
    });
  });

  // OnProgress fires per chunk, so a 1 GiB save would otherwise emit tens of
  // thousands of lines.
  it('throttle within a phase but never drop a phase change', () => {
    const io = fakeIo();
    const { onProgress } = jsonPresenter(io, 'save').progress(false);
    for (let i = 0; i < 500; i++) onProgress!({ phase: 'encrypt', done: i, total: 500 });
    for (let i = 0; i < 500; i++) onProgress!({ phase: 'verify', done: i, total: 500 });
    const events = eventsOf(io);
    expect(events.length).toBeLessThan(10);
    expect(events.map((e) => e.phase)).toContain('encrypt');
    expect(events.map((e) => e.phase)).toContain('verify');
  });

  it('emit nothing when quiet', () => {
    const io = fakeIo();
    const { onProgress } = jsonPresenter(io, 'save').progress(true);
    expect(onProgress).toBeUndefined();
    expect(io.stderr).toBe('');
  });
});

describe('failures', () => {
  const failOf = (err: unknown) => {
    const io = fakeIo();
    jsonPresenter(io, 'restore').failure(toCliFailure(err), err);
    return { io, envelope: envelopeOf(io) };
  };

  it('are a document on stdout, so a caller parses one stream either way', () => {
    const { envelope } = failOf(new WrongPasswordError());
    expect(envelope).toEqual({
      schema: CLI_SCHEMA,
      stability: 'unstable',
      ok: false,
      command: 'restore',
      locale: 'en',
      error: { code: 'WRONG_PASSWORD', message: 'wrong password' },
    });
  });

  it('also reach stderr, for a human tailing the log', () => {
    const { io } = failOf(new WrongPasswordError());
    expect(eventsOf(io)[0]).toEqual({
      schema: CLI_SCHEMA,
      event: 'error',
      code: 'WRONG_PASSWORD',
      message: 'wrong password',
    });
  });

  it('carry the numbers a caller would otherwise parse out of the message', () => {
    const { envelope } = failOf(new FileTooLargeError(2_000_000, 1_048_576));
    expect(envelope.error).toEqual({
      code: 'FILE_TOO_LARGE',
      message: expect.stringContaining('2000000') as unknown as string,
      details: { size: 2_000_000, limit: 1_048_576 },
    });
  });

  it('omit details when there are none', () => {
    const { envelope } = failOf(new WrongPasswordError());
    expect(envelope.error).not.toHaveProperty('details');
  });
});

describe('error codes span all three code spaces', () => {
  it('core', () => {
    expect(jsonErrorCode(new WrongPasswordError())).toBe('WRONG_PASSWORD');
    expect(jsonErrorCode(new GalleryRestoreError())).toBe('GALLERY_RESTORE_FAILED');
  });

  it('orchestration', () => {
    expect(jsonErrorCode(new StegoShardApiError('NO_INPUT_FILES', 'x'))).toBe('NO_INPUT_FILES');
  });

  it('command line', () => {
    expect(jsonErrorCode(new CliError('USAGE', 'x'))).toBe('USAGE');
    expect(jsonErrorCode(new CliError('PASSWORD_REQUIRED', 'x'))).toBe('PASSWORD_REQUIRED');
  });

  it('anything else is INTERNAL rather than an invented code', () => {
    expect(jsonErrorCode(new Error('boom'))).toBe('INTERNAL');
    expect(jsonErrorCode('a string')).toBe('INTERNAL');
  });

  // gallery.ts deliberately cannot tell "wrong password" from "no gallery here",
  // and the envelope must not appear to either.
  it('keeps one code for a gallery restore failure', () => {
    const { envelope } = (() => {
      const io = fakeIo();
      const err = new GalleryRestoreError();
      jsonPresenter(io, 'gallery-restore').failure(toCliFailure(err), err);
      return { envelope: envelopeOf(io) };
    })();
    const error = envelope.error as { code: string; message: string };
    expect(error.code).toBe('GALLERY_RESTORE_FAILED');
    expect(error.code).not.toMatch(/PASSWORD/);
  });
});
