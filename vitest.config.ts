import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // The CLI now answers in the system language, and several tests assert its
    // English text. Without this they pass or fail by whose machine they run on
    // (this was written on a fr-CA one).
    env: { STEGOSHARD_LANG: 'en' },
    // Vitest's 5s default was never a deliberate budget for this suite. Argon2id
    // at 256 MiB, the 4096-iteration container corruption sweeps and the erasure
    // reconstruct matrices legitimately take seconds, and several of them sat just
    // inside 5s: adding any test raised the parallel load enough to push whichever
    // one lost the race over the edge, first sqlite-container.test.ts, then
    // vault.reconstruct.test.ts, and only under `--coverage`, where the v8
    // instrumentation adds its own overhead. That is a flake, not a signal.
    //
    // 20s still catches a genuinely hung test well inside the CI job budget, and
    // the deliberately long tests keep declaring their own `SLOW` timeouts (30s to
    // 90s), so the intent of those stays visible in the test files.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // Two zones, measured separately, because one number over both would say
      // less than either.
      //
      // `src/ui` used to be outside coverage entirely. That hid input-limits.ts,
      // whose whole job is bounding untrusted input and which had no tests at
      // all. It is in now.
      include: ['src/core/**/*.ts', 'src/ui/**/*.ts', 'src/cli/**/*.ts', 'src/api/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        // Measured nowhere, and saying so is the point of this list.
        //
        // These modules need a DOM, a Worker, or browser storage. They are
        // exercised by the Playwright suite in tests/e2e, which does not collect
        // coverage, so vitest reports them at or near zero. Leaving them in would
        // not make the number more honest; it would make it mean less, by mixing
        // "untested" with "tested somewhere this tool cannot see".
        //
        // The rule for adding to this list: the module must be unreachable from
        // node without a browser environment. Anything that is merely awkward to
        // test belongs above the line, with a floor.
        'src/ui/app.ts',
        'src/ui/dom.ts',
        'src/ui/domhelpers.ts',
        'src/ui/i18n.ts',
        'src/ui/icons.ts',
        'src/ui/keymanager.ts',
        'src/ui/keystore.ts',
        'src/ui/options.ts',
        'src/ui/paper.ts',
        'src/ui/pipeline.worker.ts',
        'src/ui/prefs.ts',
        'src/ui/progress-ui.ts',
        'src/ui/tooltips.ts',
        'src/ui/wizard.ts',
        'src/ui/disk.ts',
        'src/ui/image-io.ts',
        'src/ui/pdf-restore.ts',
        'src/ui/save-controller.ts',
        // The same rule, one layer over: unreachable from a test, not merely
        // awkward. Both exist precisely to isolate what cannot be measured, so
        // covering them would mean testing Node rather than StegoShard.
        //
        // `main.ts` calls `run()` at module scope and then exits the process, so
        // importing it *is* running the CLI. That is deliberate: it is what lets
        // `run(argv, io)` be tested at all.
        //
        // `io.ts` is the real terminal: raw-mode stdin for the hidden password
        // prompt, a readline confirmation, and the TTY flags. Its whole purpose is
        // that every other file can take a `CliIo` instead.
        //
        // `serve-standalone.ts` is the same shape as main.ts, and additionally is
        // the closest match to the src/ui reasoning above: it *is* covered, by the
        // Playwright `cli-ui` project ("offline serve.mjs serves an app that
        // runs"), which collects no coverage.
        'src/cli/main.ts',
        'src/cli/io.ts',
        'src/cli/serve-standalone.ts',
      ],
      thresholds: {
        // Per file, not aggregate. The aggregate gate let seven files sit below
        // the branch threshold behind an average that cleared it, sqlite-container
        // among them at 71.91%.
        perFile: true,
        // The core is the trust boundary: crypto, codec, erasure coding.
        //
        // Each floor is the weakest file today, rounded down: lines by stego.ts
        // (90.87), branches by segmented.ts (81.43), functions by compress.ts
        // (83.33), statements by stego.ts (88.35). Branches at 81 is *below* the
        // old aggregate 85 and is still the stricter gate, because the aggregate
        // let sqlite-container sit at 71.91% behind an average that cleared it.
        //
        // A ratchet. Raise them as coverage rises; never lower one to make a
        // build pass. jpeg-coeff is the next to move, in the JPEG corpus work.
        'src/core/**/*.ts': {
          lines: 90,
          functions: 83,
          branches: 81,
          statements: 88,
        },
        // The UI modules that can be measured from node. Lower on purpose, and
        // the numbers say which file sets each floor rather than hiding it:
        // run-in-worker.ts for lines (75.86) and branches (55.56), estimate.ts
        // for functions (70.00). Same ratchet rule.
        //
        // run-in-worker.ts is no longer the one setting them: widening the Worker
        // error boundary to all nineteen core classes needed tests for its own
        // uncovered paths, and it now measures 98/92/100/100. The floors stay
        // where they are, since a ratchet is only ever raised deliberately.
        'src/ui/**/*.ts': {
          lines: 75,
          functions: 70,
          branches: 55,
          statements: 72,
        },
        /**
         * The published library. Higher than the CLI because it is the surface
         * third parties build on, and lower than the core because the Node
         * adapters branch heavily on image format.
         *
         * Each floor is the weakest file today, rounded down, and image-io.ts
         * sets every one of them: statements 79.33, branches 52.08, functions
         * 93.33, lines 82.07. Its branches are the PNG/JPEG dispatch, where the
         * unexercised arms are mostly malformed-input paths worth covering next.
         */
        'src/api/**/*.ts': {
          lines: 82,
          functions: 93,
          branches: 52,
          statements: 79,
        },
        /**
         * The command line. The lowest floors in the project, and deliberately
         * honest about it rather than propped up by excluding what is merely
         * hard.
         *
         * `run.ts` sets statements (74.78), functions (80.00) and lines (74.61);
         * `ui.ts` sets branches (70.83). What is left uncovered in `run.ts` is the
         * body of the save and gallery-save commands, which cost a real Argon2id
         * derivation at 256 MiB each to reach, so they are exercised by
         * `run.human.test.ts` and the round-trip suites rather than exhaustively.
         * Two files are excluded above, for reasons stated there.
         */
        'src/cli/**/*.ts': {
          lines: 74,
          functions: 80,
          branches: 70,
          statements: 74,
        },
      },
    },
  },
});
