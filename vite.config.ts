import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
// The explicit `.ts` is deliberate, and this is the only import in the repo that
// carries one.
//
// Node loads this config file directly — Vite 8 is moving to `configLoader:
// 'native'`, which strips types and hands the result to the ordinary ESM
// resolver. That resolver needs a complete relative specifier; it will not try
// `./src/manifest.config.ts` for you. Everything under `src/` is bundled by
// rolldown instead, which does its own resolution, so those ~270 extensionless
// imports are unaffected and should stay as they are.
//
// `allowImportingTsExtensions` in tsconfig.json is what lets tsc accept this. It
// only ever *permits* the extension, so it changes nothing else.
import { buildManifest, type Target } from './src/manifest.config.ts';

const target = (process.env.STEGOSHARD_TARGET ?? 'chrome') as Target;

/**
 * Emits manifest.json for the selected browser target. The manifest is derived
 * from a single source of truth (src/manifest.config.ts) so Chrome/Edge and
 * Firefox variants can never drift apart.
 */
function manifestPlugin(): Plugin {
  return {
    name: 'stegoshard-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify(buildManifest(target), null, 2),
      });
    },
  };
}

export default defineConfig(() => {
  return {
    root: 'src',
    publicDir: resolve(import.meta.dirname, 'public'),
    resolve: {
      alias: {
        '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      },
    },
    plugins: [manifestPlugin()],
    // Bundle Web Workers as ES modules (the app is ES modules and the worker
    // imports @core, which pulls in hash-wasm) instead of the default iife, which
    // would inline a duplicate copy of the core into the worker bundle.
    worker: { format: 'es' as const },
    build: {
      // One directory per target so the Chrome and Firefox manifests never
      // clobber each other — load dist/chrome or dist/firefox accordingly.
      outDir: resolve(import.meta.dirname, `dist/${target}`),
      emptyOutDir: true,
      // Extensions load files by path, not by hashed URL — stable names keep the
      // manifest references valid across builds.
      rollupOptions: {
        input: {
          background: resolve(import.meta.dirname, 'src/background/index.ts'),
          app: resolve(import.meta.dirname, 'src/ui/app.html'),
          options: resolve(import.meta.dirname, 'src/ui/options.html'),
        },
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name].js',
          assetFileNames: 'assets/[name][extname]',
        },
      },
      target: 'es2022',
      sourcemap: true,
    },
  };
});
