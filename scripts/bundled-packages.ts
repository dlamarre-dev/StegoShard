/**
 * Record which npm packages each build actually bundles.
 *
 * `THIRD_PARTY_NOTICES.txt` used to be generated from `package-lock.json`, taking
 * every entry not marked `dev`. That answers "what does npm install for a
 * consumer", which is the wrong question: what a licence obligation attaches to
 * is what we **distribute**. The two differ here, because `vite.cli.config.ts`
 * and `vite.lib.config.ts` inline their dependencies, so three `devDependencies`
 * ride inside artifacts we publish while npm never installs them for anyone.
 *
 * Scanning the output instead is not an option: every shipped bundle but the
 * library is minified, and minification removes the module-origin comments a scan
 * would need. The bundler is the only thing that knows, so it is asked directly.
 * Each build writes its own manifest and `generate-notices.ts` reads the union.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';

/** Where the manifests live. Generated, gitignored, read by the notices script. */
export const MANIFEST_DIR = '.bundled';

/**
 * The install path of the package a module id belongs to, or null for our own
 * source. Repo-relative and `/`-separated, for example
 * `node_modules/wrap-ansi/node_modules/string-width`.
 *
 * A **path**, not a bare name, because npm nests a package under its dependent
 * whenever versions conflict, and a bare name then does not locate it on disk.
 * This is also how `package-lock.json` keys its entries, so the two sources the
 * notices script unions are directly comparable.
 */
export function packagePathOfModule(id: string, root: string): string | null {
  const norm = id.replaceAll('\\', '/');
  const base = root.replaceAll('\\', '/').replace(/\/$/, '');
  const rel = norm.startsWith(`${base}/`) ? norm.slice(base.length + 1) : norm;
  const marker = rel.lastIndexOf('node_modules/');
  if (marker === -1) return null;
  const head = rel.slice(0, marker);
  const tail = rel.slice(marker + 'node_modules/'.length).split('/');
  if (!tail[0]) return null;
  const name = tail[0].startsWith('@') && tail[1] ? `${tail[0]}/${tail[1]}` : tail[0];
  return `${head}node_modules/${name}`;
}

/**
 * A Vite plugin that writes `.bundled/<name>.json` listing the packages this
 * build included.
 *
 * Reads the module ids Rollup reports for the chunks it emitted, which is the
 * authoritative answer and survives minification, tree-shaking and code
 * splitting alike. Externalized packages are absent by construction: they have no
 * module in the output, which is exactly right, since npm installs those and the
 * lockfile already accounts for them.
 */
export function recordBundledPackages(buildName: string): Plugin {
  return {
    name: 'stegoshard:bundled-packages',
    apply: 'build',
    generateBundle(_options, bundle) {
      const root = process.cwd();
      const packages = new Set<string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of chunk.moduleIds ?? []) {
          const path = packagePathOfModule(id, root);
          if (path) packages.add(path);
        }
      }
      const out = resolve(process.cwd(), MANIFEST_DIR, `${buildName}.json`);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify([...packages].sort(), null, 2)}\n`);
    },
  };
}
