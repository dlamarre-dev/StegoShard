import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: [
      'dist/**',
      'web-dist/**',
      'web-dist-offline/**',
      'dist-cli/**',
      'dist-release/**',
      'coverage/**',
      'node_modules/**',
      'local/**',
      // Playwright's own output. Both hold third-party bundles it copies in for
      // the HTML viewer, which lint every one of their minified globals as
      // errors, so `npm run lint` failed for anyone who had ever opened a report.
      // CI never noticed: it lints before it runs a browser.
      'playwright-report/**',
      // Stryker's sandbox and reports, same story one tool over: a mutation run
      // copies the whole source tree into .stryker-tmp and rewrites it with
      // `@ts-nocheck` headers, so `npm run lint` reported 181 errors in files
      // nobody wrote. CI never noticed either, because the mutation job runs in
      // its own workspace and lints nothing.
      '.stryker-tmp/**',
      'reports/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  {
    // .mjs as well as .ts: scripts/mutation-summary.mjs runs under plain node in a
    // CI job that installs no dependencies, so it cannot go through tsx like the
    // rest of scripts/. Without this glob it inherited no globals and lint
    // reported `process` and `console` as undefined.
    files: ['**/*.ts', '**/*.mjs'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.worker,
        ...globals.webextensions,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // TypeScript handles undefined identifiers (incl. type-only references);
      // no-undef only produces false positives here (typescript-eslint guidance).
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      // Zeroizing key material relies on deliberate reassignment/void patterns.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Extension entry points and the diagnostic spike log to the console on
    // purpose (that is how the WASM spike is validated in-browser).
    files: ['src/background/**', 'scripts/**'],
    rules: {
      'no-console': 'off',
    },
  },
  prettier,
];
