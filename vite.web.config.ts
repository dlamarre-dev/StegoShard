import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/**
 * Build for the standalone web app (GitHub Pages). Reuses the same core and
 * disk/paper flows as the extension. `base` targets the project Pages path
 * (https://<user>.github.io/StegoShard/).
 */
export default defineConfig({
  root: 'src/web',
  base: '/StegoShard/',
  publicDir: resolve(__dirname, 'public'),
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
    },
  },
  build: {
    outDir: resolve(__dirname, 'web-dist'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/web/index.html'),
        privacy: resolve(__dirname, 'src/web/privacy.html'),
        terms: resolve(__dirname, 'src/web/terms.html'),
      },
    },
  },
});
