/**
 * Argument validation, the branches that refuse before any work starts.
 *
 * These are cheap to test and were entirely uncovered: reaching them through a
 * real save costs Argon2 at 256 MiB, so `run.human.test.ts` exercises the happy
 * paths and little else. Each case here is a mistake a user can actually make,
 * and each refusal must arrive *before* a password is read or a file is written.
 *
 * Every assertion is on the `CliError` code rather than on the message, so the
 * localized text stays free to change.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { run } from './run';
import type { CliIo } from './io';
import { CliError } from './errors';
import { stegoErrorCode } from '@core';
import type { StegoShardApiError } from '../api/errors';

const tmp = () => mkdtempSync(join(tmpdir(), 'ss-args-'));

/**
 * A terminal whose prompts throw.
 *
 * That is the point: a validation error must be raised before anything asks for
 * a credential, so any of these tests reaching a prompt is itself the failure.
 */
function fakeIo(env: Record<string, string> = {}): CliIo & { stdout: string; stderr: string } {
  const io = {
    stdout: '',
    stderr: '',
    out: (t: string) => void (io.stdout += t),
    err: (t: string) => void (io.stderr += t),
    env: { STEGOSHARD_LANG: 'en', ...env } as NodeJS.ProcessEnv,
    isStdinTty: false,
    isStderrTty: false,
    promptHidden: () => {
      throw new Error('validation should have refused before prompting');
    },
    confirm: () => {
      throw new Error('validation should have refused before prompting');
    },
  };
  return io;
}

function secret(): string {
  const path = join(tmp(), 's.txt');
  writeFileSync(path, 'argument validation test');
  return path;
}

/** Run and return the CliError, asserting one was thrown. */
async function refusal(argv: string[], io: CliIo = fakeIo()): Promise<CliError> {
  try {
    await run(argv, io);
  } catch (err) {
    expect(err, `expected a CliError from: ${argv.join(' ')}`).toBeInstanceOf(CliError);
    return err as CliError;
  }
  throw new Error(`expected ${argv.join(' ')} to be refused`);
}

describe('missing positionals', () => {
  const cases: [string, string[]][] = [
    ['save with no inputs', ['save']],
    ['restore with no inputs', ['restore']],
    ['estimate with no file', ['estimate']],
    ['gallery-save with no secret', ['gallery-save']],
    ['gallery-save with no covers', ['gallery-save', 'note.txt']],
    ['gallery-restore with no photos', ['gallery-restore']],
  ];
  for (const [what, argv] of cases) {
    it(`refuses ${what}`, async () => {
      expect((await refusal(argv)).code).toBe('USAGE');
    });
  }
});

describe('contradictory save flags', () => {
  it('refuses --binary with --paper', async () => {
    expect((await refusal(['save', secret(), '--binary', '--paper'])).code).toBe('USAGE');
  });

  it('refuses --disguise without --binary', async () => {
    expect((await refusal(['save', secret(), '--disguise'])).code).toBe('USAGE');
  });

  // The codec default is 'color', so validating the resolved value instead of
  // what the user typed once broke plain `--paper` outright.
  it('refuses an explicit --codec color with --paper, but not plain --paper', async () => {
    expect((await refusal(['save', secret(), '--paper', '--codec', 'color'])).code).toBe('USAGE');
    // Plain --paper is legitimate, so it gets past validation and on to the
    // credential. An io with no prompts at all is what turns that into a code,
    // rather than fakeIo's deliberately-throwing one.
    const noPrompts: CliIo = {
      out: () => {},
      err: () => {},
      env: { STEGOSHARD_LANG: 'en' } as NodeJS.ProcessEnv,
      isStdinTty: false,
      isStderrTty: false,
    };
    expect((await refusal(['save', secret(), '--paper'], noPrompts)).code).toBe(
      'PASSWORD_REQUIRED',
    );
  });

  it('refuses an unknown codec', async () => {
    expect((await refusal(['save', secret(), '--codec', 'rainbow'])).code).toBe('USAGE');
  });

  it('refuses an unknown key mode', async () => {
    expect((await refusal(['save', secret(), '--key-mode', 'telepathy'])).code).toBe('USAGE');
  });

  it('refuses stego without a cover', async () => {
    expect((await refusal(['save', secret(), '--key-mode', 'stego'])).code).toBe('USAGE');
  });
});

describe('access-mode arguments', () => {
  it('refuses an unknown mode', async () => {
    expect(
      (await refusal(['save', secret(), '--binary', '--disguise', '--mode', 'invisible'])).code,
    ).toBe('USAGE');
  });

  it('refuses a non-plain mode without the disguised binary path', async () => {
    expect((await refusal(['save', secret(), '--mode', 'duress'])).code).toBe('USAGE');
  });

  it('refuses duress without a decoy', async () => {
    expect(
      (await refusal(['save', secret(), '--binary', '--disguise', '--mode', 'duress'])).code,
    ).toBe('USAGE');
  });

  it('refuses non-possession without a threshold', async () => {
    expect(
      (await refusal(['save', secret(), '--binary', '--disguise', '--mode', 'nonpossession'])).code,
    ).toBe('USAGE');
  });

  const badThresholds = ['2of3', 'two-of-three', '0-of-3', '4-of-3', '2-of-256', ''];
  for (const spec of badThresholds) {
    it(`refuses the threshold ${JSON.stringify(spec)}`, async () => {
      const argv = ['save', secret(), '--binary', '--disguise', '--mode', 'nonpossession'];
      if (spec !== '') argv.push('--threshold', spec);
      expect((await refusal(argv)).code).toBe('USAGE');
    });
  }

  // Gallery has no winnowing key that could host two independent credentials,
  // so duress there is refused rather than silently downgraded.
  it('refuses duress on a gallery', async () => {
    expect((await refusal(['gallery-save', 'note.txt', './photos', '--mode', 'duress'])).code).toBe(
      'USAGE',
    );
  });

  it('refuses an unknown gallery mode', async () => {
    expect(
      (await refusal(['gallery-save', 'note.txt', './photos', '--mode', 'invisible'])).code,
    ).toBe('USAGE');
  });

  it('refuses a gallery non-possession save with no threshold', async () => {
    expect(
      (await refusal(['gallery-save', 'note.txt', './photos', '--mode', 'nonpossession'])).code,
    ).toBe('USAGE');
  });

  it('refuses a gallery stego save with no cover', async () => {
    expect(
      (await refusal(['gallery-save', 'note.txt', './photos', '--key-mode', 'stego'])).code,
    ).toBe('USAGE');
  });

  it('refuses an unknown gallery key mode', async () => {
    expect(
      (await refusal(['gallery-save', 'note.txt', './photos', '--key-mode', 'telepathy'])).code,
    ).toBe('USAGE');
  });
});

describe('entropy arguments', () => {
  const pw = { STEGOSHARD_PASSWORD: 'a long unrelated passphrase for tests' };

  it('refuses two entropy sources at once', async () => {
    expect(
      (
        await refusal(
          ['save', secret(), '--entropy', 'dice', '--entropy-file', 'dice.txt'],
          fakeIo(pw),
        )
      ).code,
    ).toBe('ENTROPY_ARG');
  });

  it('refuses an explicitly empty --entropy', async () => {
    expect((await refusal(['save', secret(), '--entropy', ''], fakeIo(pw))).code).toBe(
      'ENTROPY_ARG',
    );
  });

  it('refuses an unreadable entropy file by name, not as a raw ENOENT', async () => {
    const err = await refusal(
      ['save', secret(), '--entropy-file', join(tmp(), 'nope.txt')],
      fakeIo(pw),
    );
    expect(err.code).toBe('ENTROPY_ARG');
    expect(err.message).toMatch(/nope\.txt/);
  });

  /**
   * The environment variable is ambient: a user may export it in their shell
   * profile, so it must never turn a restore into an error. A typed flag on a
   * command that generates nothing is a different thing, and is named.
   */
  it('refuses an entropy flag on a command that generates nothing', async () => {
    expect((await refusal(['restore', './vault', '--entropy', 'dice'], fakeIo(pw))).code).toBe(
      'USAGE',
    );
  });

  it('tolerates the ambient variable on a restore', async () => {
    // Past validation, and failing later on there being nothing to restore,
    // which the orchestration layer reports rather than the argument layer. So
    // the assertion is that it is *not* a usage refusal.
    const empty = tmp();
    try {
      await run(
        ['restore', empty, '--out', tmp()],
        fakeIo({ ...pw, STEGOSHARD_ENTROPY: 'exported in a profile' }),
      );
      throw new Error('expected the restore to fail on an empty directory');
    } catch (err) {
      expect(err).not.toBeInstanceOf(CliError);
      expect(stegoErrorCode(err) ?? (err as StegoShardApiError).code).toBe('NO_READABLE_IMAGES');
    }
  });
});

describe('the ui command', () => {
  // '-1' is absent deliberately: parseArgs reads it as an option and refuses it
  // before this validation runs, so it tests Node rather than us.
  const badPorts = ['not-a-number', '70000', '8137.5', '0.5'];
  for (const port of badPorts) {
    it(`refuses the port ${JSON.stringify(port)}`, async () => {
      expect((await refusal(['ui', '--port', port])).code).toBe('USAGE');
    });
  }
});

describe('unknown input', () => {
  it('refuses an unknown command with exit code 2', async () => {
    const err = await refusal(['not-a-command']);
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
  });

  // parseArgs throws for these, which must surface as a failure rather than an
  // unhandled rejection.
  it('refuses an unknown option', async () => {
    await expect(run(['save', 'f', '--not-a-flag'], fakeIo())).rejects.toThrow();
  });
});

describe('help', () => {
  for (const argv of [[], ['--help'], ['-h'], ['help']]) {
    it(`prints usage for ${JSON.stringify(argv)} and exits 0`, async () => {
      const io = fakeIo();
      await expect(run(argv, io)).resolves.toBe(0);
      expect(io.stdout).toMatch(/save/);
      expect(io.stdout).toMatch(/--json/);
      expect(io.stderr).toBe('');
    });
  }
});
