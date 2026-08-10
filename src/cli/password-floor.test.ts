/**
 * The 12-character floor gates *creation only*.
 *
 * Applying it to restore would be a data-loss bug, not a hardening measure: a
 * vault created under the old policy (or by an older build) must still open, and
 * refusing to try a password the user already has destroys their data to protect
 * them from nothing. This test exists so that stays true.
 *
 * Enforcement lives at the entry points — `main.ts` for the CLI, each surface's
 * accept-gate for the app — rather than in `runSave` here, which is the
 * programmatic API the tests drive directly. That placement is what lets this
 * test build a legacy-shaped vault at all.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { runRestore, runSave } from './commands';

const SLOW = { timeout: 90_000 };
const SHORT_PW = 'old4'; // far below the floor: what a pre-policy vault may carry

describe('the password floor never blocks a restore', () => {
  it('opens a vault whose password predates the 12-character minimum', SLOW, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-floor-'));
    const secret = join(dir, 'secret.txt');
    writeFileSync(secret, 'a vault made under the old policy\n');

    const saved = await runSave({
      inputs: [secret],
      outDir: join(dir, 'vault'),
      password: SHORT_PW,
      paper: false,
      zip: false,
      binary: 'branded',
      keyMode: 'embedded',
    });

    await runRestore({
      inputs: [saved.files[0]!],
      outDir: join(dir, 'restored'),
      password: SHORT_PW,
    });

    expect(readFileSync(join(dir, 'restored', 'secret.txt'), 'utf8')).toBe(
      'a vault made under the old policy\n',
    );
  });
});
