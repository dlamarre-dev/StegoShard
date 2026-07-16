import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { builtinModules } from 'node:module';

/**
 * Build the CLI into a single self-contained ESM bundle with a shebang, so it
 * can be published to npm (`npx imagevault`) and fed to `deno compile` for
 * standalone per-OS binaries. All npm deps are bundled (hash-wasm inlines its
 * WASM as base64, as in the web build); only Node's own builtins stay external —
 * both Node and Deno (via its node: compat, included by `deno compile`) provide
 * them, so no npm resolution happens at compile time.
 */
const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist-cli'),
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    lib: {
      entry: resolve(__dirname, 'src/cli/main.ts'),
      formats: ['es'],
      fileName: () => 'imagevault.js',
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
