/**
 * `--export-number`: numbering an export, end to end through the command line.
 *
 * The weighting here follows what can actually go wrong. The happy path is two
 * assertions, because there is almost no mechanism left: the user supplies a
 * number, it goes in the envelope, both save and restore print it. Everything
 * else covers the ways it must refuse, and one invariant that is the whole point
 * of the design — that nothing is written outside the files you asked for.
 *
 * This file replaces the `--track` suite. That feature kept a registry of vault
 * identifiers and access times under the platform state directory, and most of
 * the tests here were about the registry degrading safely: a corrupt file, an
 * unwritable one, one that a restore must not create. None of those cases exist
 * any more, which is the point — the dangerous artifact is gone, so the tests
 * that made it safe are gone with it. What survives is the refusal behaviour,
 * which mattered then and matters now.
 */

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { run } from './run';
import type { CliIo } from './io';

const SLOW = { timeout: 120_000 };
const PW = 'a long unrelated passphrase for these tests';
const tmp = () => mkdtempSync(join(tmpdir(), 'ss-export-'));

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

/** The eight hex characters of the tag from a `tag … · export #n` line. */
function tagOf(stderr: string): string {
  const m = /tag ([0-9a-f]{8}) · export #(\d+)/.exec(stderr);
  if (!m) throw new Error(`no identity line in: ${stderr}`);
  return m[1]!;
}

describe('the number the user gives is the number the artifact carries', () => {
  it('round-trips from save to restore', SLOW, async () => {
    const io = fakeIo();
    const out = join(tmp(), 'out');
    expect(
      await run(['save', secret('x'), '--out', out, '--binary', '--export-number', '7'], io),
      io.stderr,
    ).toBe(0);
    expect(io.stderr).toContain('export #7');

    const rio = fakeIo();
    const restored = join(tmp(), 'r');
    expect(
      await run(['restore', join(out, readdirSync(out)[0]!), '--out', restored], rio),
      rio.stderr,
    ).toBe(0);
    // The exact number, not "some digits": an off-by-one here is the entire
    // failure this feature exists to make visible.
    expect(rio.stderr).toContain('export #7');
    expect(readFileSync(join(restored, 's.txt'), 'utf-8')).toBe('x');
  });

  it('accepts both ends of the u32 range', SLOW, async () => {
    // 4294967295 is the one that catches a parseInt/`>>> 0`/MAX_SAFE_INTEGER slip
    // against buildPayload's own range check.
    for (const n of ['1', '4294967295']) {
      const io = fakeIo();
      const out = join(tmp(), 'out');
      expect(
        await run(['save', secret(), '--out', out, '--binary', '--export-number', n], io),
        io.stderr,
      ).toBe(0);
      expect(io.stderr).toContain(`export #${n}`);
    }
  });
});

describe('the tag identifies the artifact, not the vault', () => {
  it('differs between two exports that share a number', SLOW, async () => {
    // The executable form of the SPEC §4.1 rule, and the regression test for the
    // change this file documents: a future contributor who "fixes" the tag to be
    // stable across exports is reintroducing a correlation handle that proves two
    // artifacts are versions of one thing. That must fail a test, not ship.
    const tags = new Set<string>();
    for (const _ of [0, 1]) {
      const io = fakeIo();
      const out = join(tmp(), 'out');
      await run(['save', secret(), '--out', out, '--binary', '--export-number', '4'], io);
      tags.add(tagOf(io.stderr));
    }
    expect(tags.size, 'two exports produced the same tag').toBe(2);
  });
});

describe('nothing is written that was not asked for', () => {
  it('leaves the state directory empty across a save and a restore', SLOW, async () => {
    // The regression test for the whole decision. `--track` wrote a registry of
    // vault identifiers and access times here; if anyone reintroduces one, this
    // fails. STEGOSHARD_HOME is what the old registryPath() consulted first, so
    // pointing it at an empty scratch directory is the tightest available probe.
    const home = tmp();
    const out = join(tmp(), 'out');
    const io = fakeIo({ STEGOSHARD_HOME: home });
    await run(['save', secret('x'), '--out', out, '--binary', '--export-number', '2'], io);
    expect(io.stderr).toContain('export #2');

    const rio = fakeIo({ STEGOSHARD_HOME: home });
    await run(['restore', join(out, readdirSync(out)[0]!), '--out', join(tmp(), 'r')], rio);
    expect(rio.stderr).toContain('export #2');

    // The restore read a number and printed it, and still wrote nothing here.
    expect(readdirSync(home), 'something was written to the state directory').toEqual([]);
  });

  it('prints no number and carries no identity when the flag is absent', SLOW, async () => {
    const io = fakeIo();
    const out = join(tmp(), 'out');
    expect(await run(['save', secret(), '--out', out, '--binary'], io)).toBe(0);
    expect(io.stderr).not.toMatch(/export #/);

    const rio = fakeIo();
    await run(['restore', join(out, readdirSync(out)[0]!), '--out', join(tmp(), 'r')], rio);
    expect(rio.stderr).not.toMatch(/export #/);
  });
});

describe('--export-number is refused wherever it cannot be honoured', () => {
  it('rejects every deniable destination', SLOW, async () => {
    const cases: string[][] = [
      ['save', '--binary', '--disguise'],
      ['save', '--binary', '--disguise', '--mode', 'duress', '--decoy'],
      ['save', '--binary', '--disguise', '--mode', 'nonpossession', '--threshold', '2-of-3'],
      ['gallery-save'],
    ];
    for (const argv of cases) {
      const src = secret();
      const full = [
        argv[0]!,
        src,
        ...argv.slice(1).map((a) => (a === '--decoy' ? '--decoy' : a)),
        ...(argv.includes('--decoy') ? [src] : []),
        '--out',
        join(tmp(), 'o'),
        '--export-number',
        '3',
      ];
      await expect(
        run(full, fakeIo()),
        `${argv.join(' ')} accepted --export-number`,
      ).rejects.toMatchObject({ code: 'EXPORT_NUMBER_NOT_DENIABLE' });
    }
  });

  it('rejects commands that number nothing', async () => {
    for (const command of ['restore', 'gallery-restore']) {
      await expect(
        run([command, join(tmp(), 'nothing'), '--export-number', '2'], fakeIo()),
        `${command} accepted --export-number and did nothing with it`,
      ).rejects.toMatchObject({ code: 'EXPORT_NUMBER_INVALID' });
    }
  });

  it('rejects every value that is not an export number, and writes nothing', SLOW, async () => {
    // Each of these once had its own way of going wrong. `''` and `'0'` are the
    // two that a truthiness guard would have let through as "no number"; `'1e3'`,
    // `'0x10'` and `' 1'` are the ones `Number()` alone accepts.
    for (const value of ['', '0', '1.5', 'abc', '1e3', '0x10', '4294967296', ' 1', '+1']) {
      const out = join(tmp(), 'o');
      await expect(
        run(['save', secret(), '--out', out, '--binary', '--export-number', value], fakeIo()),
        `--export-number ${JSON.stringify(value)} was accepted`,
      ).rejects.toMatchObject({ code: 'EXPORT_NUMBER_INVALID' });
      // The check runs before runSave, so a refused value leaves no artifact.
      expect(() => readdirSync(out)).toThrow();
    }
  });

  it('leaves a negative value to the argument parser, which refuses it first', SLOW, async () => {
    // `--export-number -1` never reaches our validation: `parseArgs` reads `-1`
    // as another option rather than as this one's value, and throws
    // ERR_PARSE_ARGS_INVALID_OPTION_VALUE. Refused either way, so the behaviour is
    // right, but the code differs and a JSON consumer sees a plain usage error.
    //
    // Asserted rather than left to chance, because the tempting "fix" is to make
    // the validator handle `-1` — which it cannot, since it is never called. If
    // this ever starts producing EXPORT_NUMBER_INVALID, `parseArgs` changed and
    // the boundary moved.
    await expect(
      run(
        ['save', secret(), '--out', join(tmp(), 'o'), '--binary', '--export-number', '-1'],
        fakeIo(),
      ),
    ).rejects.toMatchObject({ code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' });
  });

  it('carries its own codes rather than collapsing to USAGE', SLOW, async () => {
    // Without this the two codes silently become `fail()`'s default, and a JSON
    // consumer keying on the documented code never matches. That is exactly what
    // happened to TRACKING_NOT_DENIABLE, which was declared and never emitted.
    await expect(
      run(
        [
          'save',
          secret(),
          '--binary',
          '--disguise',
          '--export-number',
          '1',
          '--out',
          join(tmp(), 'o'),
        ],
        fakeIo(),
      ),
    ).rejects.toMatchObject({ code: 'EXPORT_NUMBER_NOT_DENIABLE' });
    await expect(
      run(
        ['save', secret(), '--binary', '--export-number', '0', '--out', join(tmp(), 'o')],
        fakeIo(),
      ),
    ).rejects.toMatchObject({ code: 'EXPORT_NUMBER_INVALID' });
  });
});

describe('--allow-cover-reuse is refused where nothing embeds', () => {
  it('rejects it on restore and gallery-restore', SLOW, async () => {
    // The same class of bug as `--track` on restore: a flag registered in the
    // shared options table but read only by the save branches, so it parsed fine
    // and did nothing. Pinned here because this project has now shipped it twice.
    for (const command of ['restore', 'gallery-restore']) {
      await expect(
        run([command, join(tmp(), 'nothing'), '--allow-cover-reuse'], fakeIo()),
        `${command} accepted --allow-cover-reuse and did nothing with it`,
      ).rejects.toThrow(/--allow-cover-reuse has no effect on/);
    }
  });
});

describe('the flags it replaced are gone', () => {
  it('rejects --track and --track-file as unknown options', SLOW, async () => {
    // Pinned rather than incidental: both were removed outright, with no alias,
    // because neither had ever shipped.
    for (const argv of [
      ['--track', 'notes'],
      ['--track-file', join(tmp(), 'r.json')],
    ]) {
      await expect(
        run(['save', secret(), '--out', join(tmp(), 'o'), '--binary', ...argv], fakeIo()),
        `${argv[0]} is still accepted`,
      ).rejects.toThrow();
    }
  });
});
