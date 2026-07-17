import { defineConfig, loadEnv, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildManifest, type Target } from './src/manifest.config';

const target = (process.env.STEGOSHARD_TARGET ?? 'chrome') as Target;

/**
 * Emits manifest.json for the selected browser target. The manifest is derived
 * from a single source of truth (src/manifest.config.ts) so Chrome/Edge and
 * Firefox variants can never drift apart. When Google Photos is not configured
 * (no client id — e.g. the store build via `--mode store`), its optional
 * permissions are omitted so the public build requests nothing it does not use.
 */
function manifestPlugin(googlePhotos: boolean): Plugin {
  return {
    name: 'stegoshard-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify(buildManifest(target, { googlePhotos }), null, 2),
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(__dirname), 'STEGOSHARD_');
  const googlePhotos = Boolean(env.STEGOSHARD_GOOGLE_CLIENT_ID);
  return {
    root: 'src',
    publicDir: resolve(__dirname, 'public'),
    // Load .env from the project root and expose STEGOSHARD_* to the app (e.g. the
    // optional Google Photos client id). Absent → the feature stays disabled.
    envDir: resolve(__dirname),
    envPrefix: ['VITE_', 'STEGOSHARD_'],
    resolve: {
      alias: {
        '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      },
    },
    plugins: [manifestPlugin(googlePhotos)],
    build: {
      // One directory per target so the Chrome and Firefox manifests never
      // clobber each other — load dist/chrome or dist/firefox accordingly.
      outDir: resolve(__dirname, `dist/${target}`),
      emptyOutDir: true,
      // Extensions load files by path, not by hashed URL — stable names keep the
      // manifest references valid across builds.
      rollupOptions: {
        input: {
          background: resolve(__dirname, 'src/background/index.ts'),
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
  };
});
