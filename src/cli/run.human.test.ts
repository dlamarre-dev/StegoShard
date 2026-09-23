/**
 * The command line's own behaviour, driven through `run(argv, io)`.
 *
 * Before the split this was untestable: `main.ts` invoked itself at module scope
 * and every failure went through a `fail()` that called `process.exit`, so the
 * first bad flag took the test runner with it. Every CLI test therefore imported
 * the orchestration layer directly and skipped the argument layer entirely.
 *
 * These are the regression net for that refactor. They assert the two things a
 * user would notice if it went wrong: that results still land on stdout while
 * progress and warnings land on stderr, and that failures still print the same
 * localized message. They also pin the property the coming machine-readable mode
 * depends on, that withholding `promptHidden` makes prompting unreachable rather
 * than merely unlikely.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { encode as encodePng } from 'fast-png';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { run } from './run';
import type { CliIo } from './io';
import { CliError, toCliFailure } from './errors';
import { StegoShardApiError } from '../api/errors';
import { WrongPasswordError } from '@core';

const SLOW = { timeout: 90_000 };

/** A noisy PNG, textured enough to carry a gallery fragment after re-encoding. */
function noisyPng(side: number, seed: number): Uint8Array {
  const data = new Uint8Array(side * side * 4);
  let s = seed >>> 0;
  for (let i = 0; i < side * side; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i * 4] = s >>> 24;
    data[i * 4 + 1] = (s >>> 16) & 0xff;
    data[i * 4 + 2] = (s >>> 8) & 0xff;
    data[i * 4 + 3] = 255;
  }
  return encodePng({ width: side, height: side, data, channels: 4, depth: 8 });
}
const PW = 'a long unrelated passphrase for these tests';
const tmp = () => mkdtempSync(join(tmpdir(), 'ss-run-'));

interface Captured extends CliIo {
  stdout: string;
  stderr: string;
}

/**
 * A terminal that records instead of printing.
 *
 * `promptHidden` and `confirm` throw rather than being absent, so a test that
 * expects no prompting fails loudly on an unexpected one instead of hanging or
 * silently taking a different branch. Pass `interactive: false` to model the
 * non-interactive modes, where the prompts are absent entirely.
 */
function fakeIo(opts: { env?: Record<string, string>; interactive?: boolean } = {}): Captured {
  const io: Captured = {
    stdout: '',
    stderr: '',
    out(text) {
      io.stdout += text;
    },
    err(text) {
      io.stderr += text;
    },
    env: { STEGOSHARD_LANG: 'en', ...opts.env } as NodeJS.ProcessEnv,
    isStdinTty: false,
    isStderrTty: false,
  };
  if (opts.interactive !== false) {
    io.promptHidden = () => {
      throw new Error('unexpected prompt: promptHidden');
    };
    io.confirm = () => {
      throw new Error('unexpected prompt: confirm');
    };
  }
  return io;
}

function secret(text = 'hello secret'): string {
  const path = join(tmp(), 's.txt');
  writeFileSync(path, text);
  return path;
}

/** Run and capture the failure the bootstrap would have printed. */
async function failureOf(argv: string[], io: CliIo) {
  try {
    await run(argv, io);
  } catch (err) {
    return { ...toCliFailure(err), err };
  }
  throw new Error('expected run() to reject');
}

describe('run() does not own the process', () => {
  it('throws a CliError instead of exiting, so a test survives a bad flag', async () => {
    const io = fakeIo();
    const { err, exitCode } = await failureOf(['save'], io);
    expect(err).toBeInstanceOf(CliError);
    expect(exitCode).toBe(1);
    // Nothing was printed: the bootstrap, not run(), writes the message.
    expect(io.stderr).toBe('');
    expect(io.stdout).toBe('');
  });

  it('keeps the one exit code that is not 1', async () => {
    const { exitCode, message } = await failureOf(['not-a-command'], fakeIo());
    expect(exitCode).toBe(2);
    expect(message).toMatch(/not-a-command/);
  });
});

describe('the stdout / stderr split', () => {
  it('puts help on stdout and returns 0', async () => {
    const io = fakeIo();
    await expect(run(['--help'], io)).resolves.toBe(0);
    expect(io.stdout).toMatch(/save/);
    expect(io.stderr).toBe('');
  });

  it('puts an estimate on stdout, nothing on stderr', async () => {
    const io = fakeIo();
    await expect(run(['estimate', secret()], io)).resolves.toBe(0);
    expect(io.stdout).toMatch(/image/i);
    expect(io.stderr).toBe('');
  });

  it('saves with the result and the manifest on stdout', SLOW, async () => {
    const io = fakeIo({ env: { STEGOSHARD_PASSWORD: PW } });
    await expect(run(['save', secret(), '--out', tmp()], io)).resolves.toBe(0);
    expect(io.stdout).toMatch(/^Saved /m);
    expect(io.stdout).toMatch(/Files created:/);
    // Progress goes to stderr, never stdout: one line per stage when piped, in
    // the order the save runs them. The image path used to report nothing; it
    // now reports its stages like every other path, weighted by time.
    expect(io.stdout).not.toMatch(/Encrypting|Verifying|Rendering/);
    const stages = io.stderr.split(/\r?\n/).filter((l) => l.endsWith('…'));
    expect(stages).toEqual(['Deriving the key…', 'Encrypting…', 'Verifying…', 'Rendering…']);
  });

  /**
   * A gallery save used to print nothing between the password and the result,
   * through a re-encode of every cover and four Argon2 derivations. It now names
   * each stage on stderr as it starts, the first one at once.
   */
  it('reports gallery stages on stderr, the first one at once', { timeout: 180_000 }, async () => {
    const dir = tmp();
    const covers = join(dir, 'covers');
    mkdirSync(covers);
    for (let i = 0; i < 9; i++) {
      writeFileSync(join(covers, `c${i}.png`), noisyPng(768, i + 1));
    }
    const io = fakeIo({ env: { STEGOSHARD_PASSWORD: PW } });
    await expect(
      run(['gallery-save', secret(), covers, '--out', join(dir, 'album')], io),
    ).resolves.toBe(0);
    expect(io.stdout).toMatch(/Files created:/);
    const stages = io.stderr.split(/\r?\n/).filter((l) => l.endsWith('…'));
    expect(stages[0]).toBe('Preparing photos…');
    expect(stages).toContain('Hiding in photos…');
    expect(stages[stages.length - 1]).toBe('Verifying…');
    expect(io.stdout).not.toMatch(/Preparing photos|Hiding in photos/);
  });

  it('reports binary phases on stderr, never on stdout', SLOW, async () => {
    const io = fakeIo({ env: { STEGOSHARD_PASSWORD: PW } });
    await expect(run(['save', secret(), '--out', tmp(), '--binary'], io)).resolves.toBe(0);
    expect(io.stdout).toMatch(/^Saved /m);
    // Not a TTY, so one plain line per phase change rather than a redraw. The
    // clear-line sequence is built from a char code and matched with `includes`:
    // an escape character is invisible in source, and inside a regex it would
    // also trip `no-control-regex`.
    const CLEAR_LINE = `${String.fromCharCode(27)}[2K`;
    expect(io.stderr).toMatch(/…\n/);
    expect(io.stderr.includes(CLEAR_LINE)).toBe(false);
    expect(io.stderr).not.toMatch(/Files created:/);
  });

  it('restores with the result on stdout and the decode count on stderr', SLOW, async () => {
    const io = fakeIo({ env: { STEGOSHARD_PASSWORD: PW } });
    const vault = tmp();
    await run(['save', secret(), '--out', vault, '--quiet'], io);
    const io2 = fakeIo({ env: { STEGOSHARD_PASSWORD: PW } });
    await expect(run(['restore', vault, '--out', tmp(), '--quiet'], io2)).resolves.toBe(0);
    expect(io2.stdout).toMatch(/^Restored s\.txt -> /m);
    expect(io2.stderr).toMatch(/decoded/i);
    expect(io2.stderr).not.toMatch(/Restored/);
  });

  it('--quiet silences progress but not the result', SLOW, async () => {
    const io = fakeIo({ env: { STEGOSHARD_PASSWORD: PW } });
    await expect(run(['save', secret(), '--out', tmp(), '--quiet'], io)).resolves.toBe(0);
    expect(io.stdout).toMatch(/^Saved /m);
    expect(io.stderr).toBe('');
  });

  it('warns on stderr when the password rides on the command line', SLOW, async () => {
    const io = fakeIo();
    await expect(
      run(['save', secret(), '--out', tmp(), '--password', PW, '--quiet'], io),
    ).resolves.toBe(0);
    expect(io.stderr).toMatch(/visible in your shell history/);
    expect(io.stdout).not.toMatch(/shell history/);
  });
});

describe('failure messages stay localized', () => {
  it('renders an orchestration code in the catalog language', async () => {
    // A stego save with no cover reaches the orchestration layer's coded error
    // only if the argv check does not catch it first; either way the printed
    // text must be the catalog's, never the code.
    const failure = toCliFailure(
      new StegoShardApiError('MODE_NEEDS_DISGUISE', 'english fallback', { mode: 'duress' }),
    );
    expect(failure.message).toMatch(/--binary --disguise/);
    expect(failure.message).toMatch(/duress/);
    expect(failure.message).not.toMatch(/MODE_NEEDS_DISGUISE/);
    expect(failure.message).not.toBe('english fallback');
  });

  it('renders a core typed error from the catalog', () => {
    expect(toCliFailure(new WrongPasswordError()).message).toBe('wrong password');
  });

  it('falls back to the raw message for anything unclassified', () => {
    expect(toCliFailure(new Error('boom')).message).toBe('boom');
    expect(toCliFailure('a string').message).toBe('a string');
  });
});

describe('non-interactive mode cannot prompt', () => {
  it('refuses a save with no password source rather than reading stdin', async () => {
    const io = fakeIo({ interactive: false });
    const { err, message } = await failureOf(['save', secret(), '--out', tmp()], io);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('PASSWORD_REQUIRED');
    expect(message).toBeTruthy();
  });

  it('refuses --entropy-prompt rather than swallowing piped input', async () => {
    const io = fakeIo({ interactive: false, env: { STEGOSHARD_PASSWORD: PW } });
    const { err } = await failureOf(['save', secret(), '--out', tmp(), '--entropy-prompt'], io);
    expect((err as CliError).code).toBe('ENTROPY_ARG');
  });

  it('refuses a weak password rather than asking for confirmation', async () => {
    const io = fakeIo({ interactive: false, env: { STEGOSHARD_PASSWORD: 'password1234' } });
    const { err } = await failureOf(['save', secret(), '--out', tmp()], io);
    expect((err as CliError).code).toBe('PASSWORD_WEAK');
  });

  it('still enforces the hard length floor, which no flag waives', async () => {
    const io = fakeIo({ interactive: false, env: { STEGOSHARD_PASSWORD: 'short' } });
    const { err } = await failureOf(
      ['save', secret(), '--out', tmp(), '--allow-weak-password'],
      io,
    );
    expect((err as CliError).code).toBe('PASSWORD_TOO_SHORT');
  });
});
