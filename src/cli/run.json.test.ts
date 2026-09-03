/**
 * `--json` driven through `run()`, against real saves and restores.
 *
 * json.test.ts covers the envelope's shape against fabricated results. This file
 * covers the contract a script actually depends on: that stdout is one parseable
 * document and nothing else, that stderr is newline-delimited JSON and nothing
 * else, and that nothing can make the process stop and wait for a human.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { run, wantsJson } from './run';
import type { CliIo } from './io';

const SLOW = { timeout: 90_000 };
const PW = 'a long unrelated passphrase for these tests';
const tmp = () => mkdtempSync(join(tmpdir(), 'ss-json-'));

interface Captured extends CliIo {
  stdout: string;
  stderr: string;
}

/**
 * A terminal with no human behind it.
 *
 * The prompts throw rather than being absent, so an unexpected prompt fails the
 * test loudly. `run()` replaces this io with a prompt-free one in JSON mode, so
 * reaching either of these would itself be the bug.
 */
function fakeIo(env: Record<string, string> = {}): Captured {
  const io: Captured = {
    stdout: '',
    stderr: '',
    out: (t) => void (io.stdout += t),
    err: (t) => void (io.stderr += t),
    env: { STEGOSHARD_LANG: 'en', ...env } as NodeJS.ProcessEnv,
    isStdinTty: false,
    isStderrTty: false,
    promptHidden: () => {
      throw new Error('unexpected prompt: promptHidden');
    },
    confirm: () => {
      throw new Error('unexpected prompt: confirm');
    },
  };
  return io;
}

function secret(bytes = 'json mode secret'): string {
  const path = join(tmp(), 's.txt');
  writeFileSync(path, bytes);
  return path;
}

/** Parse stdout, asserting the one-document rule that makes `| jq` work. */
function envelopeOf(io: Captured) {
  const lines = io.stdout.split('\n').filter((l) => l !== '');
  expect(lines, `stdout must be one document, got:\n${io.stdout}`).toHaveLength(1);
  return JSON.parse(lines[0]!) as {
    schema: string;
    stability: string;
    ok: boolean;
    command: string | null;
    locale: string;
    result?: Record<string, unknown>;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
}

/** Parse stderr, asserting every line is a JSON event. */
function eventsOf(io: Captured) {
  return io.stderr
    .split('\n')
    .filter((l) => l !== '')
    .map((l, i) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        throw new Error(`stderr line ${i} is not JSON: ${l}`);
      }
    });
}

describe('wantsJson', () => {
  it('finds the flag anywhere in the arguments', () => {
    expect(wantsJson(['estimate', 'f', '--json'])).toBe(true);
    expect(wantsJson(['--json', 'estimate', 'f'])).toBe(true);
    expect(wantsJson(['estimate', 'f'])).toBe(false);
  });

  // `--title` consumes the next argument, so this `--json` is a title.
  it('does not mistake a value-flag argument for the flag', () => {
    expect(wantsJson(['save', 'f', '--title', '--json'])).toBe(false);
    expect(wantsJson(['save', 'f', '--title', '--json', '--json'])).toBe(true);
  });

  it('stops at the end-of-options marker', () => {
    expect(wantsJson(['save', '--', '--json'])).toBe(false);
  });
});

describe('the stream contract', () => {
  it('puts one document on stdout and nothing on stderr for estimate', async () => {
    const io = fakeIo();
    await expect(run(['estimate', secret(), '--json'], io)).resolves.toBe(0);
    const env = envelopeOf(io);
    expect(env.ok).toBe(true);
    expect(env.command).toBe('estimate');
    expect(env.result).toHaveProperty('images');
    expect(io.stderr).toBe('');
  });

  it('keeps stdout to one document while stderr carries progress', SLOW, async () => {
    const io = fakeIo({ STEGOSHARD_PASSWORD: PW });
    await expect(run(['save', secret(), '--out', tmp(), '--binary', '--json'], io)).resolves.toBe(
      0,
    );

    const env = envelopeOf(io);
    expect(env.ok).toBe(true);
    expect(env.result!.binary).toBe('branded');

    const events = eventsOf(io);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.event).toBe('progress');
  });

  it('round-trips save then restore, both as documents', SLOW, async () => {
    const vault = tmp();
    const saveIo = fakeIo({ STEGOSHARD_PASSWORD: PW });
    await run(['save', secret(), '--out', vault, '--quiet', '--json'], saveIo);
    const saved = envelopeOf(saveIo);
    expect(saved.ok).toBe(true);
    expect(saved.result!.imageCount).toBeGreaterThan(0);

    const restoreIo = fakeIo({ STEGOSHARD_PASSWORD: PW });
    await expect(
      run(['restore', vault, '--out', tmp(), '--quiet', '--json'], restoreIo),
    ).resolves.toBe(0);
    const restored = envelopeOf(restoreIo);
    expect(restored.ok).toBe(true);
    expect(restored.result!.filename).toBe('s.txt');
    expect(restored.result!.decoded).toBe(restored.result!.seen);
    // The human line ("3 image(s) decoded of 3") must not leak onto the machine
    // channel; under --json that count is a field, not prose.
    expect(restoreIo.stderr).toBe('');
  });

  it('surfaces a warning as an event and again in the result', SLOW, async () => {
    const io = fakeIo();
    await expect(
      run(['save', secret(), '--out', tmp(), '--password', PW, '--quiet', '--json'], io),
    ).resolves.toBe(0);

    const events = eventsOf(io);
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('warning');
    expect(events[0]!.code).toBe('PASSWORD_FLAG_VISIBLE');

    const warnings = envelopeOf(io).result!.warnings as { code: string }[];
    expect(warnings.map((w) => w.code)).toEqual(['PASSWORD_FLAG_VISIBLE']);
  });
});

describe('failures are documents too', () => {
  it('reports a wrong password on stdout with a stable code', SLOW, async () => {
    const vault = tmp();
    await run(
      ['save', secret(), '--out', vault, '--quiet', '--json'],
      fakeIo({ STEGOSHARD_PASSWORD: PW }),
    );

    const io = fakeIo({ STEGOSHARD_PASSWORD: 'an entirely different passphrase' });
    const code = await run(['restore', vault, '--out', tmp(), '--quiet', '--json'], io);
    expect(code).toBe(1);
    const env = envelopeOf(io);
    expect(env.ok).toBe(false);
    expect(env.error!.code).toBe('WRONG_PASSWORD');
    // The localized sentence is there for a human, but the code is the contract.
    expect(env.error!.message).toBeTruthy();
  });

  it('reports a usage error rather than a bare line of prose', async () => {
    const io = fakeIo();
    const code = await run(['not-a-command', '--json'], io);
    expect(code).toBe(2);
    const env = envelopeOf(io);
    expect(env.ok).toBe(false);
    expect(env.error!.code).toBe('USAGE');
    expect(env.command).toBe('not-a-command');
  });

  it('refuses --json on the interactive ui command', async () => {
    const io = fakeIo();
    expect(await run(['ui', '--json'], io)).toBe(1);
    const env = envelopeOf(io);
    expect(env.error!.code).toBe('USAGE');
    expect(env.command).toBe('ui');
  });
});

describe('nothing can wait for a human', () => {
  it('refuses a save with no password source instead of reading stdin', async () => {
    const io = fakeIo();
    expect(await run(['save', secret(), '--out', tmp(), '--json'], io)).toBe(1);
    expect(envelopeOf(io).error!.code).toBe('PASSWORD_REQUIRED');
  });

  it('refuses a weak password instead of asking to confirm it', async () => {
    const io = fakeIo({ STEGOSHARD_PASSWORD: 'password1234' });
    expect(await run(['save', secret(), '--out', tmp(), '--json'], io)).toBe(1);
    expect(envelopeOf(io).error!.code).toBe('PASSWORD_WEAK');
  });

  it('refuses --entropy-prompt instead of swallowing piped input', async () => {
    const io = fakeIo({ STEGOSHARD_PASSWORD: PW });
    expect(await run(['save', secret(), '--out', tmp(), '--entropy-prompt', '--json'], io)).toBe(1);
    expect(envelopeOf(io).error!.code).toBe('ENTROPY_ARG');
  });
});

describe('the human mode is untouched', () => {
  it('still prints prose when --json is absent', SLOW, async () => {
    const io = fakeIo({ STEGOSHARD_PASSWORD: PW });
    await expect(run(['save', secret(), '--out', tmp(), '--quiet'], io)).resolves.toBe(0);
    expect(io.stdout).toMatch(/^Saved /m);
    expect(() => JSON.parse(io.stdout)).toThrow();
  });
});
