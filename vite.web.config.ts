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

/** Where the deployed site lives. Only the Pages build has a public address. */
const SITE_ORIGIN = 'https://dlamarre-dev.github.io';

/**
 * The canonical path of each page, relative to the deployed base.
 *
 * Only the path is listed. The title and the description are *read back out of
 * the page* below rather than repeated here, so the summary a search engine
 * shows and the one a link preview shows cannot drift from each other or from
 * the page itself. Repeating them was the first version of this, and it
 * immediately produced two different descriptions for the home page.
 */
const PAGE_PATHS: Record<string, string> = {
  'index.html': '',
  'privacy.html': 'privacy.html',
  'terms.html': 'terms.html',
};

/**
 * Canonical, Open Graph and Twitter tags.
 *
 * Pages only, on the same signal `siteRootFiles()` uses: every URL here is
 * absolute, so in the offline bundle a canonical would point a file:// copy at a
 * website it is not, and `og:image` would name a host it never contacts. The
 * bundle has no search presence to manage.
 *
 * The description itself is *not* injected: it belongs in the page source, where
 * it is useful to every copy of the app, and where a reader editing the page can
 * see it. This plugin only reads it, and fails the build if a page has none,
 * because the alternative is shipping a page whose search result has no summary
 * and finding out from Search Console weeks later.
 *
 * `og:image` is `og.png` from `site-root/`, which is why it is 1200x630 and why
 * it lives beside these pages rather than in `public/` (shared with the extension
 * build). Its dimensions are declared so a scraper can lay the card out before it
 * finishes downloading.
 */
function seoMeta(): Plugin {
  return {
    name: 'stegoshard-seo-meta',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (process.env.STEGOSHARD_WEB_BASE) return; // offline bundle, no public URL
        const page = ctx.path.replace(/^\//, '') || 'index.html';
        const pagePath = PAGE_PATHS[page];
        if (pagePath === undefined) return;

        // Attributes may sit on separate lines: these files are Prettier-formatted.
        const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1]?.trim();
        const description = /<meta\s+name="description"\s+content="([^"]*)"/.exec(html)?.[1];
        if (!title || !description) {
          throw new Error(
            `${page}: needs a <title> and a <meta name="description"> before it can be ` +
              'given canonical and Open Graph tags. Add one to the page source.',
          );
        }

        const url = `${SITE_ORIGIN}${base}${pagePath}`;
        const image = `${SITE_ORIGIN}${base}og.png`;
        const tag = (attrs: Record<string, string>) => ({
          tag: 'meta' as const,
          attrs,
          injectTo: 'head' as const,
        });

        return [
          { tag: 'link', attrs: { rel: 'canonical', href: url }, injectTo: 'head' as const },
          tag({ property: 'og:type', content: 'website' }),
          tag({ property: 'og:site_name', content: 'StegoShard' }),
          tag({ property: 'og:url', content: url }),
          tag({ property: 'og:title', content: title }),
          tag({ property: 'og:description', content: description }),
          tag({ property: 'og:image', content: image }),
          tag({ property: 'og:image:width', content: '1200' }),
          tag({ property: 'og:image:height', content: '630' }),
          tag({
            property: 'og:image:alt',
            content: 'The StegoShard wordmark and stegosaurus mark on a blue field.',
          }),
          tag({ name: 'twitter:card', content: 'summary_large_image' }),
          tag({ name: 'twitter:title', content: title }),
          tag({ name: 'twitter:description', content: description }),
          tag({ name: 'twitter:image', content: image }),
        ];
      },
    },
  };
}

export default defineConfig({
  plugins: [siteRootFiles(), seoMeta()],
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
