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
      // The core (crypto / codec / erasure coding) is the trust boundary and
      // carries a high coverage bar. UI glue is exercised pragmatically.
      include: ['src/core/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
      thresholds: {
        // The core (crypto / codec / erasure) meets the plan's ≥90% target.
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
