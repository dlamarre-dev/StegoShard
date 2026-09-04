/**
 * Mutation testing for the security-critical core.
 *
 * Coverage says a line ran. It does not say that anything would have noticed had
 * the line been wrong. This repository has found the difference the hard way more
 * than once: a GF(256) test whose name promised a known-answer check and whose
 * body asserted commutativity; an invalid-vector count that a decryptor accepting
 * all 3,919 forgeries still passed; a fuzzer that discarded every parser's return
 * value while claiming to check it; an `if (found) break;` in `openSlotArray`
 * that 669 tests could not see.
 *
 * Each of those was found by hand, by deliberately breaking the code and watching
 * what stayed green. Mutation testing is that method, automated. It changes an
 * operator or drops a condition and reports whether any test failed.
 *
 * CURRENT SCORE, and read this before quoting any number further down.
 *
 * Everything below the next heading is a dated log of how the measurement was
 * built, not the state of the project. A review quoted this file's 16 August
 * figures ("about 76% overall, steganography around 64%") as if they were
 * current; they are three weeks and two forced runs stale, and stego.ts in
 * particular has moved by more than twenty points since. Hence this block, at
 * the top, where the live numbers are.
 *
 * The Sunday forced runs are the only ones whose score means anything (the other
 * nights are incremental; see .github/workflows/mutation.yml):
 *
 *                    23 Aug   30 Aug
 *   overall           83.58%   84.51%
 *   reed-solomon.ts   92.09%   99.44%
 *   codes shard       87.53%   91.13%
 *   stego.ts          85.45%   85.45%
 *   crypto.ts         82.29%   82.25%
 *   vault.ts          79.51%   79.51%   <- the weakest, and what `break` is set against
 *
 * access.ts measured 80.25% locally on 4 September. Note how still the three
 * unchanged files are across two independent cold runs: mutation testing is
 * deterministic given the same code and tests, so movement is a signal, not noise.
 *
 * THE THRESHOLD, calibrated 4 September
 *
 * `break` was `null` for as long as the score was unmeasured, on the same
 * principle as the TestU01 tolerance (calibrated over 40 runs before being fixed
 * at 2) and the erasure job's duration (measured, not estimated). Two forced runs
 * now agree to within 0.05 points on every file that did not change, which is the
 * stability that was being waited for.
 *
 * It is set to 75, and it is a **regression alarm, not a quality target**. Stryker
 * applies `break` to whichever run it is in, and the nightly runs one shard at a
 * time, so the value has to clear the weakest shard rather than the average:
 * vault.ts at 79.51% is the binding one, leaving about four and a half points of
 * margin. That is enough to absorb a file legitimately gaining a few survivors and
 * not enough to sleep through a collapse.
 *
 * This gates no pull request. The workflow is scheduled only, so the effect is
 * that a score drop turns a nightly red instead of scrolling past in a summary
 * table nobody opens. Raise it deliberately, the way the coverage ratchet is
 * raised, and record the new calibration here when you do.
 *
 * ---
 *
 * HISTORY, in order. None of the figures below are current.
 *
 * FIRST NIGHTLY, 15 August 2026: 73.52% over 1,605 mutants in 40 minutes 16
 * seconds. Read it with three caveats, all measured rather than guessed.
 *
 * gf256.ts (92%) and reed-solomon.ts (91%) lead the eight files, and they are
 * exactly the two anchored against an external implementation earlier. stego.ts
 * (63.8%), vault.ts (64.7%) and access.ts (64.8%) trail.
 *
 * SECOND NIGHTLY, 16 August: cancelled at the 180-minute timeout having tested
 * 1,509 of 1,605 mutants, so a full pass is about 3h20 at 7.0 seconds per mutant.
 * Widening the test selection is what did it: vault and stego mutants now re-run
 * the CLI integration tests. Extrapolating 70 to 80 minutes from access.ts alone
 * was wrong by a factor of nearly three, because per-mutant cost varies by an
 * order of magnitude between files.
 *
 * The nightly is sharded and incremental since, so this default scope is what a
 * local run covers rather than what CI runs in one go.
 *
 * FIRST SHARDED RUN, 16 August, cold: 76.45% over the same 1,605 mutants, in 69
 * minutes of wall clock against 3h20 in sequence. Per file:
 *
 *   erasure.ts       100.0%    stego.ts    63.8%   (22 uncovered)
 *   gf256.ts          92.0%    vault.ts    68.9%   (31 uncovered)
 *   reed-solomon.ts   91.5%    access.ts   79.0%    (7 uncovered)
 *   crypto.ts         82.1%     (9 uncovered)
 *
 * A second run with nothing changed took 3 minutes of wall clock against 69,
 * which is what the incremental mode is for.
 *
 * Up from 73.52%, and the rise is a measurement change rather than better tests:
 * widening the test selection recovered access.ts from 64.8% and vault.ts from
 * 64.7%. stego.ts did not move at all, and its 22 uncovered mutants are the
 * clearest remaining gap in the scope.
 *
 * 115 mutants had no coverage, and that number was an artefact of the test
 * selection after all. Measured on access.ts: core-only gave 64.8% with 33
 * uncovered; adding all of src/cli gives 79.01% with 7. `modes.test.ts` drives
 * both `.db` container builders and verifyDbRegion end to end, and an earlier
 * selection rule based on direct `@core` imports had excluded it. The score the
 * next nightly reports is the first one worth comparing against anything.
 *
 * The StringLiteral mutator looks like noise at 29 survivors and is not: it kills
 * 81, including `super('wrong password')`, whose uniform text carries the
 * failure-indistinguishability property. It stays on.
 *
 * The earlier local data point, kept for scale: gf256.ts scores 92%, 50 mutants
 * in 2 minutes 38 seconds. **Do not plan against that duration.** The same file on
 * 4 September, on a different machine and with the test selection since widened
 * back to include `src/api`, took 19 minutes 47 for an unchanged 92% over the same
 * 50 mutants. The two are not comparable and the point is only that per-mutant
 * cost tracks the selection, not the mutants. The score is the part that held.
 * Two of its four survivors are *equivalent* mutants,
 * unkillable by any test: `for (let i = 255; i < 512; i++)` relaxed to `<= 512`
 * writes past the end of a 512-byte array, which is silently ignored, and
 * `i < 255` relaxed to `<= 255` is repaired by the loop that follows. A score
 * below 100 is therefore not by itself a gap, and any threshold has to leave
 * room for that.
 *
 * SCOPE
 * Narrow on purpose. Mutating everything would take hours and drown the signal in
 * report noise from UI glue. These eight files are the trust boundary: key
 * derivation and slot opening, the access structures, the vault and stego layers,
 * and the erasure maths underneath them.
 */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  // Without this Stryker replays all 674 tests per mutant, including the CLI and
  // UI ones, none of which can kill a mutant in src/core. The core suite alone is
  // 464 tests in about seven seconds. A first attempt without it did not finish a
  // single file in ten minutes.
  vitest: { configFile: 'vitest.mutation.config.ts' },
  reporters: ['clear-text', 'progress', 'json'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  htmlReporter: { fileName: 'reports/mutation/index.html' },

  // The default scope. The nightly overrides it per shard with --mutate; this
  // list is what a local `npm run mutation` covers and the union the shards must
  // add back up to.
  //
  // `src/core/slots.ts` used to be listed here and does not exist: only
  // slots.test.ts does, and the slot logic lives in crypto.ts. Stryker ignores a
  // pattern that matches nothing, so the entry sat there silently. Worth noticing
  // for the general case: had a real file been renamed, its disappearance from
  // the scope would have been just as quiet.
  mutate: [
    'src/core/crypto.ts',
    'src/core/access.ts',
    'src/core/vault.ts',
    'src/core/stego.ts',
    'src/core/erasure.ts',
    'src/core/reed-solomon.ts',
    'src/core/gf256.ts',
  ],

  // `break` is a regression alarm set below the weakest shard (vault.ts, 79.51%
  // on both forced runs), not a quality target. See "THE THRESHOLD" above for the
  // calibration; raise it deliberately and record the new one there.
  thresholds: { high: 80, low: 60, break: 75 },

  // Argon2id at the production parameters takes seconds per call, and a mutation
  // run performs thousands. The suite's own fast parameters keep this bounded;
  // this timeout covers the rest.
  timeoutMS: 60_000,

  // Four workers on a four-vCPU GitHub runner, while vitest parallelises inside
  // each of them. That is very likely oversubscribed, and it is a plausible part
  // of why the per-mutant cost is 7.0 seconds. Plausible, not established: the
  // dominant cost is that widening the test selection put CLI integration tests
  // in the covering set for vault and stego mutants.
  //
  // Left at 4 on purpose until someone measures 3 and 2 on a single shard. A
  // number changed on a hunch is how this file would end up with a comment
  // asserting something nobody checked.
  concurrency: 4,
};
