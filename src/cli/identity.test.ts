/**
 * The two pieces of the export-number feature that are not the CLI plumbing.
 *
 * Small, but one of these assertions is load-bearing: `mintVaultId` must produce
 * a different value every time. A stable id is the obvious-looking "fix" for
 * anyone who notices the tag changes between two exports of one vault, and it is
 * precisely the regression the design exists to prevent — a persistent id is a
 * correlation handle proving two artifacts are versions of one thing, readable
 * by anyone who unlocks either.
 */

import { describe, it, expect } from 'vitest';
import { identityLine, mintVaultId } from './identity';

describe('the tag', () => {
  it('is a fresh 16 bytes every time', () => {
    const a = mintVaultId();
    expect(a).toHaveLength(16);
    // 64 draws: if this ever collides, the CSPRNG is broken, not the test.
    const seen = new Set(Array.from({ length: 64 }, () => Array.from(mintVaultId()).join(',')));
    expect(seen.size, 'mintVaultId returned a repeated value').toBe(64);
  });
});

describe('the printed line', () => {
  it('shows the first eight hex characters and the number', () => {
    // Pinned exactly: it is user-visible, and both the slice and the separator
    // are easy to change by accident.
    expect(identityLine(new Uint8Array(16).fill(0xa1), 4)).toBe('tag a1a1a1a1 · export #4');
  });

  it('says "tag", not "vault"', () => {
    // The word is doing work. The eight characters identify this artifact and
    // change on every export, so calling them a vault invites the one misreading
    // that matters: seeing a different tag on #5 and concluding it is a different
    // vault. See SPEC §4.1.
    const line = identityLine(mintVaultId(), 1);
    expect(line.startsWith('tag ')).toBe(true);
    expect(line).not.toContain('vault');
  });

  it('pads a leading zero byte rather than shortening the tag', () => {
    // `toHex` uses padStart; a regression there would silently produce a
    // seven-character tag and still look plausible.
    const id = new Uint8Array(16);
    id[0] = 0x00;
    id[1] = 0x0b;
    expect(identityLine(id, 12)).toBe('tag 000b0000 · export #12');
  });
});
