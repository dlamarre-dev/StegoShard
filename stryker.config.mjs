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
 *                    23 Aug   30 Aug    6 Sep
 *   overall           83.58%   84.51%   89.61%
 *   crypto.ts         82.29%   82.25%   92.66%
 *   reed-solomon.ts   92.09%   99.44%   92.66%   <- see the anomaly below
 *   vault.ts          79.51%   79.51%   90.59%
 *   codes shard       87.53%   91.13%   88.25%
 *   gf256.ts               -        -   92.00%
 *   erasure.ts             -        -  100.00%
 *   access.ts              -        -   80.25%
 *   stego.ts          85.45%   85.45%   85.76%   <- now the weakest shard
 *
 * The 6 September jump in crypto.ts and vault.ts, about ten points each, is the
 * survivor work of 4 to 6 September landing. access.ts at 80.25% is the selection
 * fix holding on the runner: it matches a local measurement to the digit, and
 * without that fix the same file reads 70.37% with 33 mutants wrongly reported as
 * uncovered.
 *
 * 6 SEPTEMBER IS STILL THE LAST REAL MEASUREMENT. The nightlies of 10 and 11
 * September reported crypto at 28.39% and vault at 74.27%; both numbers are
 * garbage and neither is in the table above.
 *
 * vitest 5.0.0 arrived on 8 September (#165) against
 * `@stryker-mutator/vitest-runner@10`, whose peer range (`vitest >=2.0.0`) is
 * loose enough to install it and too loose to mean anything. Under vitest 5 the
 * runner selects each mutant's covering tests and executes none of them, so every
 * mutant it measures comes back survived. Measured on one 15-mutant slice of
 * crypto.ts, identical source both times:
 *
 *   vitest 4.1.11   100.00%   10 killed + 5 timeout   4.27 tests per mutant
 *   vitest 5.0.0      0.00%   15 survived             0.00 tests per mutant
 *
 * Confirmed independently of Stryker: hand-applying one of the reported
 * survivors (dropping the `throw` from validateArgon2Params) fails 13 tests in
 * crypto.hardening.test.ts. The suite kills it; the harness could not see that.
 *
 * vitest is pinned to 4.x with an `ignore` in .github/dependabot.yml until a
 * runner release declares support for 5. The reason it took two days and looked
 * like a code regression is in .github/workflows/mutation.yml; the short version
 * is that a green incremental night means "nothing was re-measured".
 *
 * The reflex this should build: before quoting any score here, check the run's
 * `Ran N tests per mutant`. At zero, the number below it is noise.
 *
 * AN ANOMALY, unexplained, do not build on the 30 August reed-solomon figure.
 *
 * reed-solomon.ts reads 92.09%, then 99.44%, then 92.66%. Two of the three forced
 * runs agree within half a point and 30 August does not: twelve mutants counted
 * killed that night are not reproducibly killed, on identical code, since nothing
 * touched reed-solomon.ts or its tests between those dates. Mutation testing is
 * supposed to be deterministic given the same code and the same tests, so this is
 * a hole in that assumption rather than a change in the project.
 *
 * That 99.44% went into the table above when it was written, which is the reason
 * to leave the whole row visible rather than quietly replace it. If a fourth run
 * lands near 92% again, treat 30 August as the outlier it looks like. If it lands
 * near 99%, something in the harness varies between runs and is worth finding
 * before any threshold is tightened.
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
 * time, so the value has to clear the weakest shard rather than the average.
 *
 * When it was set, vault.ts at 79.51% was the binding one and 75 left four and a
 * half points. After 6 September the weakest shard is stego at 85.76%, so the
 * margin is now about eleven points, which is looser than intended.
 *
 * Deliberately left at 75 anyway, for one more forced run. The reed-solomon swing
 * above is seven points on untouched code, and a threshold tightened against
 * numbers that move that far would fail on a night when nothing was wrong. Raise
 * it once a fourth run says the new levels are the levels.
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
