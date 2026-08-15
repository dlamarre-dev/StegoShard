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
 * Measured on `access.ts` at each step, which is the only reason the rule ended
 * up right:
 *
 *   core only          64.8%   33 no-coverage
 *   + the grep list    69.14%  33 no-coverage   1m53
 *   + all of src/cli   79.01%   7 no-coverage   7m09
 *
 * The middle row is what made the grep rule look adequate and was not: the score
 * moved a little while the no-coverage count did not move at all. Taking the CLI
 * wholesale drops it from 33 to 7 and lifts the score by fourteen points, because
 * `modes.test.ts` alone drives both `.db` container builders end to end.
 *
 * Cost, measured: 1m53 to 7m09 on that file. Extrapolated over the 1,605 mutants
 * of the full scope that is roughly 70 to 80 minutes against the first nightly's
 * 40, which the 180-minute timeout covers. The next nightly measures it for real.
 *
 * The selection rule was wrong twice over before landing here. The first was
 * "only src/core". The second was "files that import '@core' directly", which
 * misses everything reaching the core one level down: four CLI test files go
 * through `commands.ts`, and `src/cli/modes.test.ts` exercises both `.db`
 * container builders and their `verifyDbRegion` calls end to end. A rule that
 * depends on an import line being spelled a particular way will keep being wrong.
 *
 * So the whole of `src/cli` is in, plus the six `src/ui` files that touch the
 * core. 130 tests, about 40 seconds of dry run against 33 for the previous list,
 * which is a small price for not having to maintain a grep.
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
      // All of the CLI: every one of these drives the core, most of them through
      // `commands.ts` rather than by importing `@core` themselves. Taking the
      // directory wholesale is what stops a new file from silently becoming a
      // phantom no-coverage mutant.
      'src/cli/**/*.test.ts',
      // The UI files that reach the core. The rest of src/ui needs a DOM and
      // cannot kill a core mutant, so it would only add dry-run time.
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
