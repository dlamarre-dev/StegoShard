import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * The tests a mutation run needs, and no others.
 *
 * Stryker re-runs the suite once per mutant, so the suite it runs decides both
 * how long a pass takes and what the score means. Pointed at the default config
 * it replayed all 674 tests, including UI tests that cannot kill a mutant in
 * `src/core`, and did not finish a single file in ten minutes.
 *
 * The first narrowing went too far, though less than it first appeared. The nine
 * test files outside `src/core` that import the core are back in, at a cost of 81
 * tests and about 27 extra seconds of dry run.
 *
 * Measured on `access.ts` before and after: the score moved 64.8% to 69.14%, and
 * the no-coverage count did **not** move at all, staying at 33. So widening buys
 * a few kills, not the 65 the line-coverage comparison suggested. Those two
 * measures are not the same thing: lcov counts a line as covered if any test
 * executed it, while Stryker attributes coverage per test, and code reached only
 * through module setup or through a caller with no test of its own stays
 * unattributed either way.
 *
 * What the remaining no-coverage mutants actually mark is untested code.
 * `verifyDbRegion`, `buildDuressDbContainer` and `buildNonPossessionDbContainer`
 * have no direct tests at all; they are reached only from `src/ui/disk.ts` and
 * `src/cli/commands.ts`. That is a gap to close with tests, not with
 * configuration, and it is the more useful thing this run found.
 *
 * Deliberately still excluded: everything that imports no core module, since it
 * can only add dry-run time. `tests/e2e` is Playwright and never ran here.
 *
 * Coverage is off: instrumenting every run buys nothing when the thing being
 * measured is whether a test failed.
 */
export default defineConfig({
  resolve: {
    alias: { '@core': fileURLToPath(new URL('./src/core', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: [
      'src/core/**/*.test.ts',
      // The nine outside src/core that import it. Keep this list in step with
      // `grep -l "from '@core'" src/cli/*.test.ts src/ui/*.test.ts`: a file that
      // starts covering core and is not listed here comes back as a phantom
      // no-coverage mutant, which is how the first nightly under-reported.
      'src/cli/node-image-io.test.ts',
      'src/cli/paper.test.ts',
      'src/cli/roundtrip.test.ts',
      'src/ui/estimate.test.ts',
      'src/ui/input-limits.test.ts',
      'src/ui/paper-build.test.ts',
      'src/ui/pdf-restore.test.ts',
      'src/ui/run-in-worker.test.ts',
      'src/ui/save-controller.test.ts',
    ],
    env: { STEGOSHARD_LANG: 'en' },
  },
});
