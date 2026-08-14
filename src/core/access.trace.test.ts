/**
 * Operation counts, not outcomes.
 *
 * The equal-control-flow claims are stated in three places in `crypto.ts`:
 * "Argon2id runs EXACTLY ONCE" (slotKekCandidates), "EVERY candidate KEK against
 * EVERY slot with no early exit" (openSlotArray), and the fixed candidate
 * schedule those two rest on. Until this file, all three were carried by English
 * comments and by tests asserting the value returned or the error type thrown.
 *
 * That is not enough, and the gap is concrete rather than theoretical. Adding
 * `if (found) break;` after the outer candidate loop in `openSlotArray` would
 * have been **invisible** to the entire suite: every existing test checks that
 * the right DEK comes back or that a uniform WrongPasswordError is raised, and
 * both remain true with an early exit. Only the timing changes, and timing is
 * exactly what the design is trying not to leak.
 *
 * So this counts. Argon2 invocations are counted by mocking `hash-wasm` and
 * delegating to the real implementation. Slot attempts are counted through
 * `crypto.subtle.decrypt`, which `tryOpenSlot` performs once per slot: counting
 * the expensive operation rather than the private function avoids opening a seam
 * in production code purely for a test.
 *
 * `docs/CLAIMS.md` calls this an equal-control-flow design, not a formal
 * side-channel proof, and these tests do not change that. A fixed operation count
 * is necessary for the claim and nowhere near sufficient: it says nothing about
 * cache behaviour, branch prediction, or what the operations themselves leak.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const argon2Calls = { n: 0 };

// Delegates to the real implementation and counts. A stub returning fixed bytes
// would make every assertion below meaningless, since nothing would actually be
// derived and no slot could open.
vi.mock('hash-wasm', async (importOriginal) => {
  const real = await importOriginal<typeof import('hash-wasm')>();
  return {
    ...real,
    argon2id: (...args: Parameters<typeof real.argon2id>) => {
      argon2Calls.n++;
      return real.argon2id(...args);
    },
  };
});

import type { Argon2Params } from './crypto';

const {
  DEK_LEN,
  SLOT_COUNT,
  buildSlotArray,
  deriveKekBytes,
  gateKek,
  importAesGcmKey,
  openSlotArray,
  randomBytes,
  slotKekCandidates,
  unlockSlotArray,
  WrongPasswordError,
} = await import('./crypto');

const PARAMS: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };

let decryptCalls = 0;
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  argon2Calls.n = 0;
  decryptCalls = 0;
  const real = globalThis.crypto.subtle.decrypt.bind(globalThis.crypto.subtle);
  spy = vi.spyOn(globalThis.crypto.subtle, 'decrypt').mockImplementation((...args) => {
    decryptCalls++;
    return real(...(args as Parameters<typeof real>));
  });
});

afterEach(() => spy.mockRestore());

async function arrayWithOneLiveSlot(password: string, salt: Uint8Array) {
  const kekBytes = await deriveKekBytes(password, salt, PARAMS);
  const kek = await importAesGcmKey(kekBytes);
  const dek = randomBytes(DEK_LEN);
  return { array: await buildSlotArray([{ kek, dek, regionIndex: 1 }]), dek };
}

describe('unlock: Argon2 runs exactly once', () => {
  it('once per unlock, whatever the outcome', async () => {
    const salt = randomBytes(16);
    const { array } = await arrayWithOneLiveSlot('right', salt);

    argon2Calls.n = 0;
    await unlockSlotArray(array, salt, 'right', PARAMS);
    expect(argon2Calls.n, 'a successful unlock ran Argon2 more than once').toBe(1);

    argon2Calls.n = 0;
    await expect(unlockSlotArray(array, salt, 'wrong', PARAMS)).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    expect(argon2Calls.n, 'a failed unlock ran Argon2 a different number of times').toBe(1);
  });

  it('once regardless of how many candidate KEKs the inputs produce', async () => {
    // The property that makes the schedule affordable: a key factor and a
    // threshold secret each multiply the candidate count, and every extra
    // candidate is a cheap HKDF over the one Argon2 output. If Argon2 ran per
    // candidate, an unlock with a factor would take twice as long as one without,
    // which is observable.
    const salt = randomBytes(16);
    for (const [label, factor, secret] of [
      ['password only', null, null],
      ['with a key factor', randomBytes(32), null],
      ['with a threshold secret', null, randomBytes(32)],
      ['with both', randomBytes(32), randomBytes(32)],
    ] as const) {
      argon2Calls.n = 0;
      const candidates = await slotKekCandidates('pw', salt, factor, secret, PARAMS);
      expect(argon2Calls.n, `${label} ran Argon2 ${argon2Calls.n} times`).toBe(1);
      // And the schedule length depends only on the inputs offered.
      const expected = (factor ? 2 : 1) * (secret ? 2 : 1);
      expect(candidates.length, `${label} produced ${candidates.length} candidates`).toBe(expected);
    }
  });
});

describe('openSlotArray: every slot is attempted, with no early exit', () => {
  it('performs the same number of attempts on success and on failure', async () => {
    const salt = randomBytes(16);
    const { array } = await arrayWithOneLiveSlot('right', salt);
    const right = await slotKekCandidates('right', salt, null, null, PARAMS);
    const wrong = await slotKekCandidates('wrong', salt, null, null, PARAMS);

    decryptCalls = 0;
    await openSlotArray(array, right);
    const onSuccess = decryptCalls;

    decryptCalls = 0;
    await expect(openSlotArray(array, wrong)).rejects.toBeInstanceOf(WrongPasswordError);
    const onFailure = decryptCalls;

    // Measured, so the split is on the record: an early exit *inside* the slot
    // loop fails this test and the position test; one placed after the outer
    // candidate loop fails only the candidate-count test below, since with a
    // single candidate there is nothing left to skip. Both mutations leave all
    // 669 other tests green.
    expect(onSuccess, 'a successful open stopped early').toBe(SLOT_COUNT);
    expect(onFailure).toBe(SLOT_COUNT);
    expect(onSuccess).toBe(onFailure);
  });

  it('scales with the candidate count and nothing else', async () => {
    const salt = randomBytes(16);
    const { array } = await arrayWithOneLiveSlot('right', salt);
    const base = await deriveKekBytes('right', salt, PARAMS);

    for (const n of [1, 2, 3]) {
      const candidates = [];
      for (let i = 0; i < n; i++) {
        candidates.push(
          i === 0 ? await importAesGcmKey(base) : await gateKek(base, randomBytes(32), salt),
        );
      }
      decryptCalls = 0;
      try {
        await openSlotArray(array, candidates);
      } catch {
        // A gated candidate matches nothing; the count is what is under test.
      }
      expect(decryptCalls, `${n} candidate(s) produced ${decryptCalls} attempts`).toBe(
        n * SLOT_COUNT,
      );
    }
  });

  it('attempts every slot whichever position the live one occupies', async () => {
    // buildSlotArray shuffles, so repeating this lands the live slot in different
    // positions. The count must not move with it: an early exit would make the
    // work depend on where the match happened to be.
    const salt = randomBytes(16);
    const counts = new Set<number>();
    for (let i = 0; i < 8; i++) {
      const { array } = await arrayWithOneLiveSlot('right', salt);
      const candidates = await slotKekCandidates('right', salt, null, null, PARAMS);
      decryptCalls = 0;
      await openSlotArray(array, candidates);
      counts.add(decryptCalls);
    }
    expect([...counts], 'the attempt count varied with slot position').toEqual([SLOT_COUNT]);
  });
});
