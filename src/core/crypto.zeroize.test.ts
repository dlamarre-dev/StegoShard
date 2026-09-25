/**
 * The key-mixing steps leave no copy of a KEK behind.
 *
 * Found in review: `KEK || factor` and `KEK || secret` were built inline for
 * HKDF and never zeroed, while the KEK they copied was. Watching the buffers
 * `concatBytes` hands out is the only way to see that from outside, so the
 * module is wrapped here and every buffer of the concatenation's size is kept.
 */

import { describe, it, expect, vi } from 'vitest';

const made: Uint8Array[] = [];
vi.mock('./bytes', async (importOriginal) => {
  const real = await importOriginal<typeof import('./bytes')>();
  return {
    ...real,
    concatBytes: (...parts: Uint8Array[]) => {
      const out = real.concatBytes(...parts);
      made.push(out);
      return out;
    },
  };
});

const { randomBytes, slotKekCandidates, slotKekRaw } = await import('./crypto');

const FAST = { iterations: 1, memoryKiB: 256, parallelism: 1 };
const KEK_PLUS_32 = 64;

/** The concatenations a call made that are the size of KEK || 32 bytes. */
async function concatenationsOf(run: () => Promise<unknown>): Promise<Uint8Array[]> {
  made.length = 0;
  await run();
  return made.filter((b) => b.length === KEK_PLUS_32);
}

describe('KEK copies are zeroed', () => {
  it('after mixing in a key factor', async () => {
    const copies = await concatenationsOf(() =>
      slotKekRaw('pw', randomBytes(16), randomBytes(32), FAST),
    );
    expect(copies.length).toBeGreaterThan(0);
    for (const c of copies) expect(c.every((b) => b === 0)).toBe(true);
  });

  it('after gating on threshold material, with and without a factor', async () => {
    const copies = await concatenationsOf(() =>
      slotKekCandidates('pw', randomBytes(16), randomBytes(32), randomBytes(32), FAST),
    );
    // One factor mix, and one gate for each of the two bases.
    expect(copies.length).toBe(3);
    for (const c of copies) expect(c.every((b) => b === 0)).toBe(true);
  });
});
