import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * A narrower vitest for mutation runs.
 *
 * Stryker re-runs the suite once per mutant, so the suite it runs decides
 * whether a mutation pass takes minutes or hours. Pointed at the default config
 * it replayed all 674 tests, including the CLI and UI ones, none of which can
 * kill a mutant in `src/core`. The core suite alone is 464 tests in about seven
 * seconds.
 *
 * Coverage is off here for the same reason: instrumenting every run buys nothing
 * when the thing being measured is whether a test failed.
 */
export default defineConfig({
  resolve: {
    alias: { '@core': fileURLToPath(new URL('./src/core', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/core/**/*.test.ts'],
    env: { STEGOSHARD_LANG: 'en' },
  },
});
