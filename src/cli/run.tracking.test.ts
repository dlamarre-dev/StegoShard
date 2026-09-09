/**
 * `--track`: rollback detection, end to end through the command line.
 *
 * The feature's value is narrow and its cost is not, so the tests are weighted
 * accordingly. Two of them cover the happy path; the rest cover the ways it must
 * refuse, stay quiet, or degrade — because the failure that matters here is not
 * "the counter was wrong", it is "a file appeared that the user did not ask for",
 * or "a deniable save left a record that it happened".
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { run } from './run';
import type { CliIo } from './io';

const SLOW = { timeout: 120_000 };
const PW = 'a long unrelated passphrase for these tests';
const tmp = () => mkdtempSync(join(tmpdir(), 'ss-track-'));

interface Captured extends CliIo {
  stdout: string;
  stderr: string;
}

function fakeIo(env: Record<string, string> = {}): Captured {
  const io: Captured = {
    stdout: '',
    stderr: '',
    out(t) {
      io.stdout += t;
    },
    err(t) {
      io.stderr += t;
    },
    env: { STEGOSHARD_LANG: 'en', STEGOSHARD_PASSWORD: PW, ...env } as NodeJS.ProcessEnv,
    isStdinTty: false,
    isStderrTty: false,
  };
  return io;
}

function secret(text = 'hello secret'): string {
  const p = join(tmp(), 's.txt');
  writeFileSync(p, text);
  return p;
}

/** A registry path inside a scratch directory, so nothing touches the real one. */
const regPath = () => join(tmp(), 'state', 'known-vaults.json');

describe('the sequence advances across saves of one label', () => {
  it('numbers successive exports of the same vault', SLOW, async () => {
    const reg = regPath();
    const src = secret();
    for (const expected of [1, 2, 3]) {
      const io = fakeIo();
      const out = join(tmp(), 'out');
      const code = await run(
        ['save', src, '--out', out, '--binary', '--track', 'notes', '--track-file', reg],
        io,
      );
      expect(code, io.stderr).toBe(0);
      expect(io.stderr).toContain(`export #${expected}`);
    }
    const parsed = JSON.parse(readFileSync(reg, 'utf-8')) as {
      vaults: Record<string, { sequence: number; label: string }>;
    };
    const entries = Object.values(parsed.vaults);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.sequence).toBe(3);
    expect(entries[0]!.label).toBe('notes');
  });

  it('keeps two labels on separate counters', SLOW, async () => {
    const reg = regPath();
    const src = secret();
    for (const label of ['notes', 'keys']) {
      const code = await run(
        ['save', src, '--out', join(tmp(), 'out'), '--track', label, '--track-file', reg],
        fakeIo(),
      );
      expect(code).toBe(0);
    }
    const parsed = JSON.parse(readFileSync(reg, 'utf-8')) as { vaults: Record<string, unknown> };
    expect(Object.keys(parsed.vaults)).toHaveLength(2);
  });
});

describe('a restored older copy is reported', () => {
  it('warns VAULT_ROLLBACK and still restores', SLOW, async () => {
    const reg = regPath();
    const src = secret('the real contents');

    // Export #1, kept aside; then #2, which advances the record.
    const firstOut = join(tmp(), 'v1');
    expect(
      await run(
        ['save', src, '--out', firstOut, '--binary', '--track', 'n', '--track-file', reg],
        fakeIo(),
      ),
    ).toBe(0);
    expect(
      await run(
        ['save', src, '--out', join(tmp(), 'v2'), '--track', 'n', '--track-file', reg],
        fakeIo(),
      ),
    ).toBe(0);

    // Restoring the stale copy: a warning, exit 0, and the file comes back.
    const io = fakeIo();
    const restored = join(tmp(), 'restored');
    const vault = join(firstOut, readdirSync(firstOut)[0]!);
    const code = await run(['restore', vault, '--out', restored, '--track-file', reg], io);

    expect(code, io.stderr).toBe(0);
    expect(io.stderr).toMatch(/export #1/);
    expect(io.stderr).toMatch(/older copy/);
    expect(readFileSync(join(restored, 's.txt'), 'utf-8')).toBe('the real contents');
  });

  it('reports it again on a second restore of the same stale copy', SLOW, async () => {
    // The high-water mark must not be lowered by the rollback itself, or the
    // warning would fire once and then go quiet on the very file it is about.
    const reg = regPath();
    const src = secret();
    const firstOut = join(tmp(), 'v1');
    await run(
      ['save', src, '--out', firstOut, '--binary', '--track', 'n', '--track-file', reg],
      fakeIo(),
    );
    await run(
      ['save', src, '--out', join(tmp(), 'v2'), '--track', 'n', '--track-file', reg],
      fakeIo(),
    );
    const vault = join(firstOut, readdirSync(firstOut)[0]!);
    for (const n of [1, 2]) {
      const io = fakeIo();
      await run(['restore', vault, '--out', join(tmp(), `r${n}`), '--track-file', reg], io);
      expect(io.stderr, `restore ${n} did not report the rollback`).toMatch(/older copy/);
    }
  });

  it('says nothing when the copy is current', SLOW, async () => {
    const reg = regPath();
    const out = join(tmp(), 'out');
    await run(['save', secret(), '--out', out, '--track', 'n', '--track-file', reg], fakeIo());
    const io = fakeIo();
    await run(
      ['restore', join(out, readdirSync(out)[0]!), '--out', join(tmp(), 'r'), '--track-file', reg],
      io,
    );
    expect(io.stderr).not.toMatch(/older copy/);
    expect(io.stderr).toMatch(/export #1/);
  });
});

describe('tracking is refused on every deniable destination', () => {
  it.each([
    ['gallery-save', ['gallery-save']],
    ['a disguised .db', ['save', '--binary', '--disguise']],
    ['duress', ['save', '--binary', '--disguise', '--mode', 'duress']],
    ['non-possession', ['save', '--binary', '--disguise', '--mode', 'nonpossession']],
  ])('refuses --track with %s', SLOW, async (_name, head) => {
    const reg = regPath();
    const io = fakeIo();
    const argv = [
      ...head,
      secret(),
      '--out',
      join(tmp(), 'out'),
      '--track',
      'n',
      '--track-file',
      reg,
    ];

    // `fail()` throws a CliError; the bootstrap in main.ts turns it into an exit
    // code, so at this level the assertion is on the throw and its message.
    await expect(run(argv, io), 'a deniable save with --track was allowed').rejects.toThrow(
      /--track cannot be used with/,
    );
    // And, the part that actually matters: nothing was recorded on disk.
    expect(existsSync(reg), 'a deniable save wrote to the registry').toBe(false);
  });
});

describe('nothing happens unless asked', () => {
  it('writes no registry and prints no counter without --track', SLOW, async () => {
    const reg = regPath();
    const io = fakeIo();
    const out = join(tmp(), 'out');
    expect(await run(['save', secret(), '--out', out, '--binary'], io)).toBe(0);

    expect(existsSync(reg)).toBe(false);
    expect(io.stderr).not.toMatch(/export #/);

    // And the restore of an untracked vault stays silent too.
    const rio = fakeIo();
    await run(
      ['restore', join(out, readdirSync(out)[0]!), '--out', join(tmp(), 'r'), '--track-file', reg],
      rio,
    );
    expect(rio.stderr).not.toMatch(/export #/);
    expect(existsSync(reg), 'an untracked restore created a registry').toBe(false);
  });
});

describe('a damaged registry degrades instead of blocking', () => {
  it('warns and still restores', SLOW, async () => {
    const reg = regPath();
    const out = join(tmp(), 'out');
    await run(
      ['save', secret('x'), '--out', out, '--binary', '--track', 'n', '--track-file', reg],
      fakeIo(),
    );
    writeFileSync(reg, 'not json at all');

    const io = fakeIo();
    const restored = join(tmp(), 'r');
    const code = await run(
      ['restore', join(out, readdirSync(out)[0]!), '--out', restored, '--track-file', reg],
      io,
    );
    expect(code, io.stderr).toBe(0);
    expect(io.stderr).toMatch(/could not be read/);
    expect(readFileSync(join(restored, 's.txt'), 'utf-8')).toBe('x');
  });
});
