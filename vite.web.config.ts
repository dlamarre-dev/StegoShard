import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const commit = process.env.GITHUB_SHA ?? 'development';

/**
 * Build for the standalone web app. Reuses the same core and disk/paper flows
 * as the extension.
 *
 * Two shapes come out of this one config, selected by environment:
 *
 *  - The Pages deploy (default) is served from a fixed project path,
 *    https://<user>.github.io/StegoShard/, so `base` is that absolute path.
 *  - The offline bundle is extracted and served from whatever directory the
 *    user puts it in, so it is built with a relative base — an absolute
 *    `/StegoShard/` would make every asset 404 anywhere but Pages.
 *
 * They must go to different output directories: `emptyOutDir` is on, so one
 * build would otherwise wipe the other.
 */
const base = process.env.STEGOSHARD_WEB_BASE ?? '/StegoShard/';
const outDir = process.env.STEGOSHARD_WEB_OUTDIR ?? 'web-dist';

export default defineConfig({
  root: 'src/web',
  base,
  publicDir: resolve(import.meta.dirname, 'public'),
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
    },
  },
  define: {
    __STEGOSHARD_VERSION__: JSON.stringify(pkg.version),
    __STEGOSHARD_COMMIT__: JSON.stringify(commit),
  },
  // Bundle the pipeline Web Worker as an ES module (see vite.config.ts).
  worker: { format: 'es' },
  build: {
    outDir: resolve(import.meta.dirname, outDir),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'src/web/index.html'),
        privacy: resolve(import.meta.dirname, 'src/web/privacy.html'),
        terms: resolve(import.meta.dirname, 'src/web/terms.html'),
      },
    },
  },
});
