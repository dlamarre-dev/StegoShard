/**
 * `readArgon2`, the parser behind the DEFAULT_ARGON2 half of `golden:check`.
 *
 * It had no test at all until a review pointed out why: it was a closure inside
 * `main()`, reached only when `src/core/crypto.ts` appeared in the diff, so every
 * green `golden:check` in CI had run without ever calling it. A parser nothing
 * exercises is exactly the thing that rots quietly, and this one guards a constant
 * that IS the format on three paths (docs/VERSIONING.md).
 *
 * The cases below are the ones that have actually gone wrong, not a sweep: an
 * inline comment (the real literal carries one), a block comment containing a
 * brace (which truncated the capture), and the two silent-success shapes -- body
 * content that is not a `key: value` pair, and a subset of the three fields.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { DEFAULT_ARGON2 } from '../../src/core/crypto';
import { readArgon2 } from '../../scripts/check-golden';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the shapes it must read', () => {
  it('reads the constant as it is actually written today', () => {
    // Reads src/core/crypto.ts from disk rather than a hand-copied string. A
    // duplicate here would drift silently: reshape the real literal and this test
    // stays green while `golden:check` breaks, which is the opposite of what a
    // guard's test is for. Compared against the imported constant, so the expected
    // values cannot drift either.
    const source = readFileSync(join(ROOT, 'src/core/crypto.ts'), 'utf-8');
    expect(readArgon2(source)).toEqual({
      iterations: DEFAULT_ARGON2.iterations,
      memoryKiB: DEFAULT_ARGON2.memoryKiB,
      parallelism: DEFAULT_ARGON2.parallelism,
    });
  });

  it('reads a plain integer as well as a product', () => {
    expect(
      readArgon2(
        'DEFAULT_ARGON2 = Object.freeze({ iterations: 4, memoryKiB: 262144, parallelism: 1 })',
      ),
    ).toEqual({ iterations: 4, memoryKiB: 262144, parallelism: 1 });
  });

  it('survives a block comment containing a brace', () => {
    // The capture stops at the first `}`, so stripping comments AFTER locating the
    // literal left this truncated and reported unparseable -- failing CI for a
    // comment-only edit. Comments now come off the whole blob first.
    expect(
      readArgon2(`DEFAULT_ARGON2 = Object.freeze({
        /* calibrated 4 Sep {see the log} */
        iterations: 4,
        memoryKiB: 256 * 1024,
        parallelism: 1,
      })`),
    ).toEqual({ iterations: 4, memoryKiB: 262144, parallelism: 1 });
  });
});

describe('the shapes it must refuse, rather than half-read', () => {
  it('tells an absent constant from an unparseable one', () => {
    // The distinction is the whole point: 'absent' is benign (a new file), while
    // 'unparseable' means the guard cannot tell whether the cost changed.
    expect(readArgon2('export const SOMETHING_ELSE = 1;')).toBe('absent');
  });

  it('refuses a value it cannot evaluate', () => {
    expect(
      readArgon2(
        'DEFAULT_ARGON2 = Object.freeze({ iterations: 4, memoryKiB: MEM, parallelism: 1 })',
      ),
    ).toBe('unparseable');
  });

  it('refuses body content that is not a key: value pair', () => {
    // A spread would otherwise be skipped silently and the parse would look
    // confident about a literal it had not read.
    expect(
      readArgon2(
        'DEFAULT_ARGON2 = Object.freeze({ ...BASE, iterations: 4, memoryKiB: 262144, parallelism: 1 })',
      ),
    ).toBe('unparseable');
  });

  it('refuses a literal whose fields it could only half-read', () => {
    // A computed key is found by neither pass, so without the fragment check this
    // would have returned a confident two-field object for a three-field literal
    // and the caller would have compared triples that were never equal.
    expect(
      readArgon2('DEFAULT_ARGON2 = Object.freeze({ iterations: 4, memoryKiB: 262144, [k]: 1 })'),
    ).toBe('unparseable');
  });
});
