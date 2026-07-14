import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildManifest, type Target } from './src/manifest.config';

const target = (process.env.IMAGEVAULT_TARGET ?? 'chrome') as Target;

/**
 * Emits manifest.json for the selected browser target. The manifest is derived
 * from a single source of truth (src/manifest.config.ts) so Chrome/Edge and
 * Firefox variants can never drift apart.
 */
function manifestPlugin(): Plugin {
  return {
    name: 'imagevault-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify(buildManifest(target), null, 2),
      });
    },
  };
}

export default defineConfig({
  root: 'src',
  publicDir: resolve(__dirname, 'public'),
  // Load .env from the project root and expose IMAGEVAULT_* to the app (e.g. the
  // optional Google Photos client id). Absent → the feature stays disabled.
  envDir: resolve(__dirname),
  envPrefix: ['VITE_', 'IMAGEVAULT_'],
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
    },
  },
  plugins: [manifestPlugin()],
  build: {
    // One directory per target so the Chrome and Firefox manifests never clobber
    // each other — load dist/chrome or dist/firefox accordingly.
    outDir: resolve(__dirname, `dist/${target}`),
    emptyOutDir: true,
    // Extensions load files by path, not by hashed URL — stable names keep the
    // manifest references valid across builds.
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/index.ts'),
        offscreen: resolve(__dirname, 'src/offscreen/offscreen.html'),
        app: resolve(__dirname, 'src/ui/app.html'),
        options: resolve(__dirname, 'src/ui/options.html'),
        photos: resolve(__dirname, 'src/ui/photos.html'),
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
});
