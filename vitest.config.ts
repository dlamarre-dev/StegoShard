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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // Two zones, measured separately, because one number over both would say
      // less than either.
      //
      // `src/ui` used to be outside coverage entirely. That hid input-limits.ts,
      // whose whole job is bounding untrusted input and which had no tests at
      // all. It is in now.
      include: ['src/core/**/*.ts', 'src/ui/**/*.ts'],
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
        'src/ui/**/*.ts': {
          lines: 75,
          functions: 70,
          branches: 55,
          statements: 72,
        },
      },
    },
  },
});
