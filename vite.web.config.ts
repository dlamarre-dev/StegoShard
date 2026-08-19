import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { copyFileSync, readdirSync, readFileSync } from 'node:fs';

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
 *    user puts it in, so it is built with a relative base; an absolute
 *    `/StegoShard/` would make every asset 404 anywhere but Pages.
 *
 * They must go to different output directories: `emptyOutDir` is on, so one
 * build would otherwise wipe the other.
 */
const base = process.env.STEGOSHARD_WEB_BASE ?? '/StegoShard/';
const outDir = process.env.STEGOSHARD_WEB_OUTDIR ?? 'web-dist';

/**
 * Copy `src/web/site-root/` verbatim to the top of the deployed site.
 *
 * For files a search engine or a certificate authority insists on finding at a
 * fixed URL, whose contents are a token rather than something to build. They
 * cannot go in `public/`, which this config shares with the *extension* build
 * (`vite.config.ts`), and a Google verification token has no business inside a
 * package submitted to the browser stores.
 *
 * Pages only. The offline bundle sets `STEGOSHARD_WEB_BASE`, and a site
 * verification file means nothing in a zip someone unpacks on their own machine.
 *
 * Copied byte for byte and never rewritten: verification fails on any edit, so
 * these are also excluded from Prettier (`.prettierignore`) and pinned by
 * `src/web/site-root/site-root.test.ts`.
 */
function siteRootFiles(): Plugin {
  const from = resolve(import.meta.dirname, 'src/web/site-root');
  return {
    name: 'stegoshard-site-root',
    apply: 'build',
    // `writeBundle`, not `closeBundle`: the output directory exists and has been
    // emptied by then, so a copy into it survives.
    writeBundle() {
      if (process.env.STEGOSHARD_WEB_BASE) return; // offline bundle, not the site
      const out = resolve(import.meta.dirname, outDir);
      // Everything in the directory rather than a list to keep in step: a second
      // verification file should need no edit here.
      for (const name of readdirSync(from)) {
        if (name.endsWith('.test.ts')) continue; // the guard, not a site file
        copyFileSync(resolve(from, name), resolve(out, name));
      }
    },
  };
}

export default defineConfig({
  plugins: [siteRootFiles()],
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
