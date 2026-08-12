import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { builtinModules } from 'node:module';

/**
 * Build `serve.mjs`, the launcher shipped inside the downloadable offline web
 * bundle. Same shape as `vite.cli.config.ts` (single ESM file, Node target, only
 * builtins external) because it has the same job: run under whatever Node the
 * user has, with nothing to install.
 *
 * It emits *into* `web-dist-offline`, which `vite.web.config.ts` empties, so this
 * must run after that build and must not empty the directory itself.
 */
const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
  build: {
    outDir: resolve(import.meta.dirname, 'web-dist-offline'),
    emptyOutDir: false,
    target: 'node20',
    minify: false, // shipped in the open beside the app it serves; keep it readable
    lib: {
      entry: resolve(import.meta.dirname, 'src/cli/serve-standalone.ts'),
      formats: ['es'],
      fileName: () => 'serve.mjs',
    },
    rollupOptions: {
      external: nodeBuiltins,
      output: { banner: '#!/usr/bin/env node' },
    },
  },
});
