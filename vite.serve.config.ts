import { defineConfig, type Plugin } from 'vite';
import { chmodSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { builtinModules } from 'node:module';

/**
 * Build `serve.mjs`, the launcher shipped inside the downloadable offline web
 * bundle, and put its wrappers beside it. Same shape as `vite.cli.config.ts`
 * (single ESM file, Node target, only builtins external) because it has the same
 * job: run under whatever Node the user has, with nothing to install.
 *
 * It emits *into* `web-dist-offline`, which `vite.web.config.ts` empties, so this
 * must run after that build and must not empty the directory itself.
 */
const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

const OUT = resolve(import.meta.dirname, 'web-dist-offline');

/**
 * Copy the hand-written launchers next to the built one.
 *
 * Here rather than in `scripts/package-web-bundle.sh`, which used to own them:
 * that made `web-dist-offline/` an incomplete preview of the bundle, carrying
 * `serve.mjs` but not the `serve.cmd` a Windows user is told to double-click,
 * because the release script only assembles them on the way into the zip. Worse,
 * the web build empties this directory, so a copy from an earlier packaging run
 * silently disappeared on the next build. The build now owns the whole bundle and
 * the release script only checks it.
 */
function offlineLaunchers(): Plugin {
  const from = resolve(import.meta.dirname, 'src/web/offline');
  return {
    name: 'stegoshard-offline-launchers',
    // `writeBundle`, not `closeBundle`: it runs once the emitted files are on
    // disk, which is when the directory is complete enough to add to.
    writeBundle() {
      // Everything in the directory, rather than a list to keep in step: the
      // README exists in nine languages, and a tenth should need no edit here.
      for (const name of readdirSync(from)) {
        copyFileSync(resolve(from, name), resolve(OUT, name));
      }
      // The zip stores the mode, so this is what makes `./serve.sh` runnable for
      // whoever unpacks it. A no-op on Windows, where the release is not built.
      chmodSync(resolve(OUT, 'serve.sh'), 0o755);
    },
  };
}

export default defineConfig({
  plugins: [offlineLaunchers()],
  build: {
    outDir: OUT,
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
