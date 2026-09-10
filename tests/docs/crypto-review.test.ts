/**
 * The audit dossier, checked against the code it describes.
 *
 * `docs/CRYPTO-REVIEW.md` is the map a reviewer navigates by. That makes a stale
 * sentence in it worse than a stale sentence anywhere else: it does not merely
 * fail to help, it sends someone to look in the wrong place and lets them
 * conclude a guard is missing, or absent when it is present.
 *
 * This is not hypothetical. A review found the dossier claiming DEKs came from
 * `subtle.generateKey` when the code had deliberately moved to `randomBytes`, so
 * that key material would go through the same entropy tap as everything else, and
 * claiming Argon2 parser bounds (`t ≤ 16`, `m ≤ 1 GiB`) wider than the code
 * enforces (`t ≤ 4`, `m ≤ 256 MiB`). Neither was a vulnerability; the code was
 * stricter than its documentation in one case and more careful in the other. Both
 * still cost the dossier its authority, which is the whole of its value.
 *
 * WHAT THIS CAN AND CANNOT DO. It pins the machine-checkable facts: numbers that
 * must equal a constant, and API names that must match what the core calls.
 * Prose can still drift, and no test will catch a paragraph that describes the
 * wrong threat model. Treat a green run here as "the figures agree", never as
 * "the dossier is accurate".
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { KEY_BLOCK_LEN, validateArgon2Params, type Argon2Params } from '../../src/core/crypto';

const ROOT = join(import.meta.dirname, '..', '..');
const DOSSIER = readFileSync(join(ROOT, 'docs', 'CRYPTO-REVIEW.md'), 'utf8');

/** The dossier, with line wrapping flattened, so a regex is not hostage to prettier. */
const FLAT = DOSSIER.replace(/\s+/g, ' ');

const CORE = readdirSync(join(ROOT, 'src', 'core'))
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => readFileSync(join(ROOT, 'src', 'core', f), 'utf8'))
  .join('\n');

describe('the dossier agrees with the code on Argon2id parser bounds', () => {
  const VALID: Argon2Params = { iterations: 1, memoryKiB: 8, parallelism: 1 };
  const accepts = (patch: Partial<Argon2Params>): boolean => {
    try {
      validateArgon2Params({ ...VALID, ...patch });
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Checked against the behaviour rather than against the constant behind it,
   * because the behaviour is what a reviewer would probe. A test that compared
   * the prose to `ARGON2_LIMITS` would still pass if the limits table stopped
   * being the thing `validateArgon2Params` consults.
   *
   * These parameters are attacker-controlled and consumed before authentication,
   * so the range is a real defence and not a formality.
   */
  it('states exactly the range validateArgon2Params enforces', () => {
    const stated =
      // Parallelism is pinned to a single value, so the dossier states it as
      // `p = 1` rather than a degenerate `p ∈ [1,1]`. Both forms are accepted
      // here; a fixed value is simply the range whose ends coincide, and the
      // assertions below still probe one step outside it in both directions.
      /`t ∈ \[(\d+),\s*(\d+)\]`, `m ∈ \[(\d+) KiB, (\d+) MiB\]`, `p (?:∈ \[(\d+),\s*(\d+)\]|= (\d+))`/.exec(
        FLAT,
      );
    expect(stated, 'the dossier no longer states the Argon2 bounds in the expected form').not.toBe(
      null,
    );
    const [tMin, tMax, mMinKiB, mMaxMiB, pRangeMin, pRangeMax, pFixed] = stated!
      .slice(1)
      .map((v) => (v === undefined ? undefined : Number(v)));
    const pMin = pFixed ?? pRangeMin!;
    const pMax = pFixed ?? pRangeMax!;

    const cases: [keyof Argon2Params, number, number][] = [
      ['iterations', tMin!, tMax!],
      ['memoryKiB', mMinKiB!, mMaxMiB! * 1024],
      ['parallelism', pMin, pMax],
    ];

    for (const [field, min, max] of cases) {
      const atMin: Partial<Argon2Params> = { [field]: min };
      const atMax: Partial<Argon2Params> = { [field]: max };
      // The stated ends are accepted, and one step outside either is not: that
      // is what makes the stated pair the enforced pair rather than merely a
      // pair inside it.
      expect(accepts(atMin), `${field}: documented minimum ${min} is rejected`).toBe(true);
      expect(accepts(atMax), `${field}: documented maximum ${max} is rejected`).toBe(true);
      expect(
        accepts({ [field]: min - 1 }),
        `${field}: ${min - 1} is accepted, below the documented minimum`,
      ).toBe(false);
      expect(
        accepts({ [field]: max + 1 }),
        `${field}: ${max + 1} is accepted, above the documented maximum`,
      ).toBe(false);
    }
  });
});

describe('the dossier agrees with the code on the key block', () => {
  // The truncation ladder is "all N proper prefixes", and N is the block length.
  it('names the real key block length in the truncation ladder', () => {
    const stated = /all (\d+) proper prefixes of the key block/.exec(FLAT);
    expect(stated, 'the truncation-ladder sentence changed shape').not.toBe(null);
    expect(Number(stated![1])).toBe(KEY_BLOCK_LEN);
  });
});

describe('the dossier agrees with the code on which WebCrypto calls exist', () => {
  /**
   * The drift that was actually found, generalized: every `subtle.X` the dossier
   * names must be a call the core really makes.
   *
   * The exception list is the other half of the guard rather than a hole in it.
   * A name may only be listed here while the core genuinely does not call it, so
   * a dossier that says "not generateKey" and a codebase that starts calling
   * `generateKey` fail this too, in the opposite direction.
   */
  const DOCUMENTED_AS_UNUSED = ['generateKey'];

  const mentioned = [
    ...new Set([...DOSSIER.matchAll(/`(?:crypto\.)?subtle\.([A-Za-z]+)`/g)].map((m) => m[1]!)),
  ].sort();

  it('mentions at least the calls this test is meant to police', () => {
    // Guards the guard: a regex that silently matches nothing would pass everything.
    expect(mentioned.length).toBeGreaterThan(0);
  });

  for (const api of DOCUMENTED_AS_UNUSED) {
    it(`does not call subtle.${api}, as the dossier says`, () => {
      expect(CORE).not.toContain(`subtle.${api}(`);
    });

    /**
     * Without this the exception list would be the hole it is not supposed to
     * be: the drift that started all of this was the sentence "generated by
     * `crypto.subtle.generateKey`", and simply excusing `generateKey` from the
     * must-be-called check would wave that sentence straight through.
     *
     * So an excused API may only appear in a sentence that denies it. Crude, and
     * it is prose, but it fires on exactly the wording that was wrong.
     */
    it(`only mentions subtle.${api} to say it is not used`, () => {
      const sentences = FLAT.split(/(?<=\.)\s+/).filter((s) => s.includes(`subtle.${api}`));
      const affirmative = sentences.filter((s) => !/\b(not|never|no|without|bypass)\b/i.test(s));
      expect(
        affirmative,
        `the dossier attributes work to subtle.${api}, which src/core does not call`,
      ).toEqual([]);
    });
  }

  it('names no WebCrypto call the core does not make', () => {
    const claimed = mentioned.filter((api) => !DOCUMENTED_AS_UNUSED.includes(api));
    const missing = claimed.filter((api) => !CORE.includes(`subtle.${api}(`));
    expect(missing, `the dossier names WebCrypto calls src/core never makes: ${missing}`).toEqual(
      [],
    );
  });
});
