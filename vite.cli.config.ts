import { defineConfig } from 'vite';
import { recordBundledPackages } from './scripts/bundled-packages';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { builtinModules } from 'node:module';

/**
 * Build the CLI into a single self-contained ESM bundle with a shebang, so it
 * can be published to npm (`npx stegoshard`) and fed to `deno compile` for
 * standalone per-OS binaries. All npm deps are bundled (hash-wasm inlines its
 * WASM as base64, as in the web build); only Node's own builtins stay external.
 * both Node and Deno (via its node: compat, included by `deno compile`) provide
 * them, so no npm resolution happens at compile time.
 */
const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
  plugins: [recordBundledPackages('cli')],
  // Vite copies `public/` into outDir by default, which put the extension's
  // `_locales/` and `icons/` beside the CLI bundle. Nothing reads them there: the
  // CLI's own strings are compiled in from `src/cli/i18n`, and the browser UI
  // that `stegoshard ui` serves carries its own assets under `dist-cli/web-ui/`.
  // They were dead weight in the npm tarball and in the `deno compile` input.
  publicDir: false,
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist-cli'),
    emptyOutDir: true,
    target: 'node20',
    // Minify the bundle: the npm/npx path ships this file directly, and a
    // smaller bundle also means a slightly smaller `deno compile` payload.
    minify: 'esbuild',
    lib: {
      entry: resolve(import.meta.dirname, 'src/cli/main.ts'),
      formats: ['es'],
      fileName: () => 'stegoshard.js',
    },
    rollupOptions: {
      external: nodeBuiltins,
      output: {
        banner: '#!/usr/bin/env node',
        inlineDynamicImports: true,
      },
    },
  },
});
