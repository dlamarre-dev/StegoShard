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
 * WHAT THIS DOES NOT DO YET
 * There is no threshold. The first runs exist to measure a mutation score that
 * nobody has seen, and turning an unmeasured number into a gate is the mistake
 * this project keeps correcting elsewhere: the TestU01 tolerance was calibrated
 * over 40 runs before being fixed at 2, and the erasure job's duration was
 * measured on a real run rather than estimated. `break: null` below is
 * deliberate. Set it once the score is known and stable, and record the
 * calibration in the commit that does so.
 *
 * FIRST NIGHTLY, 15 August 2026: 73.52% over 1,605 mutants in 40 minutes 16
 * seconds. Read it with three caveats, all measured rather than guessed.
 *
 * gf256.ts (92%) and reed-solomon.ts (91%) lead the eight files, and they are
 * exactly the two anchored against an external implementation earlier. stego.ts
 * (63.8%), vault.ts (64.7%) and access.ts (64.8%) trail.
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
 * in 2 minutes 38 seconds. Two of its four survivors are *equivalent* mutants,
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

  mutate: [
    'src/core/crypto.ts',
    'src/core/access.ts',
    'src/core/slots.ts',
    'src/core/vault.ts',
    'src/core/stego.ts',
    'src/core/erasure.ts',
    'src/core/reed-solomon.ts',
    'src/core/gf256.ts',
  ],

  // No gate yet. See the note above: the score has not been measured, and a
  // threshold set from a guess would either pass everything or block every PR.
  thresholds: { high: 80, low: 60, break: null },

  // Argon2id at the production parameters takes seconds per call, and a mutation
  // run performs thousands. The suite's own fast parameters keep this bounded;
  // this timeout covers the rest.
  timeoutMS: 60_000,
  concurrency: 4,
};
