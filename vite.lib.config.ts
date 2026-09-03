import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { builtinModules } from 'node:module';

/**
 * Build the published library: two entry points, `stegoshard` (environment
 * neutral) and `stegoshard/node` (filesystem).
 *
 * Different from the CLI build in three ways, each deliberate.
 *
 * **Not minified, and shipped with source maps.** The CLI bundle is minified
 * because it is an executable people run. This is code people audit and step
 * through, in a project whose whole proposition is being checkable.
 *
 * **Real dependencies stay external.** A library that inlined `pdf-lib` and
 * `fflate` would duplicate whatever the consumer already installed and would
 * silently pin its own copies. Those five are declared `dependencies`, so npm
 * installs them and the consumer's resolver dedupes them.
 *
 * **Three are bundled anyway**, and this is the exception worth explaining:
 * `fast-png`, `jpeg-js` and `@pdf-lib/fontkit` are `devDependencies` that the
 * Node adapter imports at runtime. Promoting them trips two guards in
 * `scripts/generate-notices.ts` that exist for good reasons: `jpeg-js` is
 * BSD-3-Clause, which is not on the approved-licence list, and
 * `@pdf-lib/fontkit@1.1.1` declares MIT but ships no licence file. Bundling them
 * matches what `dist-cli` already does and leaves the notices, the SBOM and
 * `npm audit --omit=dev` untouched. Sorting that out is a licensing decision of
 * its own, tracked separately; see docs/API.md.
 *
 * No `inlineDynamicImports`: with two entries it is invalid, and the shared core
 * is better off as one chunk both entries import than duplicated into each.
 */
const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

/** Kept in step with `dependencies` in package.json; see the note above. */
const externalPackages = ['pdf-lib', 'fflate', 'hash-wasm', 'jsqr', 'qrcode'];

export default defineConfig({
  // Vite copies `public/` into outDir by default, which for this build would mean
  // shipping the browser extension's icons and locale catalogs inside the npm
  // package. Nothing in the library reads them.
  publicDir: false,
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist-lib'),
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: true,
    lib: {
      entry: {
        index: resolve(import.meta.dirname, 'src/api/index.ts'),
        node: resolve(import.meta.dirname, 'src/api/node.ts'),
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      // A subpath import of an external package (`pdf-lib/es/...`) must be
      // external too, hence the prefix match rather than a set lookup.
      external: (id) =>
        nodeBuiltins.includes(id) ||
        externalPackages.some((p) => id === p || id.startsWith(`${p}/`)),
      output: {
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
});
