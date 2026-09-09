/**
 * `--track`: rollback detection, end to end through the command line.
 *
 * The feature's value is narrow and its cost is not, so the tests are weighted
 * accordingly. Two of them cover the happy path; the rest cover the ways it must
 * refuse, stay quiet, or degrade — because the failure that matters here is not
 * "the counter was wrong", it is "a file appeared that the user did not ask for",
 * or "a deniable save left a record that it happened".
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { run } from './run';
import { REGISTRY_SCHEMA } from '../api/node/vault-registry';
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

describe('a restore never creates the registry on its own', () => {
  it('reports the identity but writes no file without a prior opt-in', SLOW, async () => {
    // The case the "nothing happens unless asked" test above misses: that one
    // restores an *untracked* vault, which has no identity to check. A tracked
    // vault restored with no --track is the one that used to create the file.
    const saveReg = regPath();
    const out = join(tmp(), 'out');
    await run(
      ['save', secret('x'), '--out', out, '--binary', '--track', 'n', '--track-file', saveReg],
      fakeIo(),
    );

    // A registry path that does not exist, standing in for the default platform
    // state path on a machine that has never tracked anything.
    const fresh = regPath();
    const io = fakeIo();
    const code = await run(
      [
        'restore',
        join(out, readdirSync(out)[0]!),
        '--out',
        join(tmp(), 'r'),
        '--track-file',
        fresh,
      ],
      io,
    );
    expect(code, io.stderr).toBe(0);
    // The part worth relying on still prints, and needs no file at all.
    expect(io.stderr).toMatch(/export #1/);
    expect(existsSync(fresh), 'a restore created a registry unasked').toBe(false);
  });

  it('still advances a registry the user has already opted into', SLOW, async () => {
    const reg = regPath();
    const out = join(tmp(), 'out');
    await run(
      ['save', secret('x'), '--out', out, '--binary', '--track', 'n', '--track-file', reg],
      fakeIo(),
    );
    const before = readFileSync(reg, 'utf-8');
    const io = fakeIo();
    expect(
      await run(
        [
          'restore',
          join(out, readdirSync(out)[0]!),
          '--out',
          join(tmp(), 'r'),
          '--track-file',
          reg,
        ],
        io,
      ),
      io.stderr,
    ).toBe(0);
    // `lastSeen` moves, so the file is touched — the check is that it is the
    // same registry, not a new one.
    const after = JSON.parse(readFileSync(reg, 'utf-8')) as { vaults: Record<string, unknown> };
    expect(Object.keys(after.vaults)).toEqual(
      Object.keys((JSON.parse(before) as { vaults: Record<string, unknown> }).vaults),
    );
  });
});

describe('a damaged registry is never used as a starting point', () => {
  it('refuses a tracked save rather than overwriting records it could not read', SLOW, async () => {
    const reg = regPath();
    const src = secret();
    // Two labels, so there is something to lose.
    for (const label of ['notes', 'keys']) {
      await run(
        ['save', src, '--out', join(tmp(), 'o'), '--binary', '--track', label, '--track-file', reg],
        fakeIo(),
      );
    }
    const intact = readFileSync(reg, 'utf-8');
    writeFileSync(reg, `${intact}trailing junk`);
    const damaged = readFileSync(reg, 'utf-8');

    await expect(
      run(
        [
          'save',
          src,
          '--out',
          join(tmp(), 'o2'),
          '--binary',
          '--track',
          'notes',
          '--track-file',
          reg,
        ],
        fakeIo(),
      ),
      'a tracked save built on a registry it could not read',
    ).rejects.toThrow(/could not be read/);
    // The point of the finding: the prior records survive untouched.
    expect(readFileSync(reg, 'utf-8')).toBe(damaged);
  });

  it('treats a non-numeric sequence as damaged instead of failing every save', SLOW, async () => {
    const reg = regPath();
    const src = secret();
    await run(
      ['save', src, '--out', join(tmp(), 'o'), '--binary', '--track', 'n', '--track-file', reg],
      fakeIo(),
    );
    const parsed = JSON.parse(readFileSync(reg, 'utf-8')) as {
      vaults: Record<string, { sequence: unknown }>;
    };
    const key = Object.keys(parsed.vaults)[0]!;
    parsed.vaults[key]!.sequence = '5';
    writeFileSync(reg, JSON.stringify(parsed));

    // Previously this reached buildPayload as "5" + 1 === "51" and every later
    // save of this label died with `sequence out of range`.
    await expect(
      run(
        ['save', src, '--out', join(tmp(), 'o2'), '--binary', '--track', 'n', '--track-file', reg],
        fakeIo(),
      ),
    ).rejects.toThrow(/could not be read/);
  });
});

describe('--track is refused wherever it cannot be honoured', () => {
  it('rejects an empty label instead of silently not tracking', SLOW, async () => {
    const reg = regPath();
    const io = fakeIo();
    await expect(
      run(
        [
          'save',
          secret(),
          '--out',
          join(tmp(), 'o'),
          '--binary',
          '--track',
          '',
          '--track-file',
          reg,
        ],
        io,
      ),
    ).rejects.toThrow(/--track was empty/);
    expect(existsSync(reg)).toBe(false);
  });

  it('rejects it on commands that number nothing', async () => {
    for (const command of ['restore', 'gallery-restore']) {
      await expect(
        run([command, join(tmp(), 'nothing'), '--track', 'n'], fakeIo()),
        `${command} accepted --track and did nothing with it`,
      ).rejects.toThrow(/--track has no effect on/);
    }
  });

  it('carries TRACKING_NOT_DENIABLE and TRACKING_UNAVAILABLE, not USAGE', async () => {
    const cases: [string[], string][] = [
      [['save', secret(), '--binary', '--disguise', '--track', 'n'], 'TRACKING_NOT_DENIABLE'],
      [['restore', 'x', '--track', 'n'], 'TRACKING_UNAVAILABLE'],
      [['save', secret(), '--binary', '--track', ''], 'TRACKING_UNAVAILABLE'],
    ];
    for (const [argv, code] of cases) {
      await expect(run([...argv, '--out', join(tmp(), 'o')], fakeIo())).rejects.toMatchObject({
        code,
      });
    }
  });
});

describe('a registry that cannot be written does not fail a save that worked', () => {
  it('warns, keeps exit 0, and leaves the vault in place', SLOW, async () => {
    // `writeRegistry` refuses to write through a symlink, so this is a real
    // throw from the commit — the same shape as EACCES or a full disk. It used
    // to escape as {"ok":false,"code":"INTERNAL"} and exit 1 while the vault was
    // already on disk, which invites a caller to retry or clean up a real vault.
    const dir = tmp();
    mkdirSync(join(dir, 'state'), { recursive: true });
    const reg = join(dir, 'state', 'known-vaults.json');
    // The link has to resolve, or `writeRegistry`'s `existsSync` guard never
    // reaches the `lstatSync` that spots it.
    const target = join(dir, 'elsewhere.json');
    // A *valid* empty registry, so the read succeeds and the failure is the
    // write, which is what this test is about.
    writeFileSync(target, JSON.stringify({ schema: REGISTRY_SCHEMA, vaults: {} }));
    symlinkSync(target, reg);

    const io = fakeIo();
    const out = join(tmp(), 'out');
    const code = await run(
      ['save', secret('x'), '--out', out, '--binary', '--track', 'n', '--track-file', reg],
      io,
    );
    expect(code, io.stderr).toBe(0);
    expect(io.stderr).toMatch(/could not be updated/);
    // The save itself reported success and the artifact exists.
    expect(io.stdout).toMatch(/Saved|saved/);
    expect(readdirSync(out).length).toBeGreaterThan(0);
  });
});
