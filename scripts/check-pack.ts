/**
 * Validate the npm tarball before it can ever be published.
 *
 * `npm pack --dry-run` reports exactly what `files` in package.json resolves to,
 * which is the only thing that decides what a consumer downloads. The `files`
 * list is easy to widen by accident and the mistake is invisible until someone
 * unpacks the result, so this asserts the entry set rather than trusting it.
 *
 * Runs against a package that is still `private: true`, which is deliberate:
 * `npm pack` works on a private package while `npm publish --dry-run` refuses,
 * so the tarball is verifiable long before publishing is a decision anyone has
 * taken, and an accidental publish stays impossible in the meantime.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface PackEntry {
  path: string;
  size: number;
}
interface PackResult {
  files: PackEntry[];
  entryCount: number;
  unpackedSize: number;
}

/** Top-level names the tarball may contain. Anything else is a bug. */
const ALLOWED_ROOTS = new Set([
  'dist-cli',
  'dist-lib',
  'docs',
  'SPEC.md',
  'THIRD_PARTY_NOTICES.txt',
  // npm always includes these three, whatever `files` says.
  'package.json',
  'README.md',
  'LICENSE',
]);

/**
 * Nothing here may ship. `src/` and `tests/` would publish the whole project;
 * `local/` and `.env` are working files; `python/` and `packages/` are separate
 * artifacts; a stray `*.pem` / `*.key` would be a credential leak.
 */
const FORBIDDEN = [
  /^src\//,
  /^tests\//,
  /^local\//,
  /^python\//,
  /^packages\//,
  /^coverage\//,
  /^scripts\//,
  /^\.env/,
  /\.pem$/,
  /\.key$/,
];

/** Must be present, or the package is broken for one of its two entry points. */
const REQUIRED = [
  'dist-cli/stegoshard.js',
  'dist-lib/index.js',
  'dist-lib/index.d.ts',
  'dist-lib/node.js',
  'dist-lib/node.d.ts',
  'docs/API.md',
];

// A fixture or a stray build artifact sneaking into `files` shows up as size
// long before anyone notices the file. Generous, but far below "we shipped the
// golden corpus".
const MAX_UNPACKED_MB = 40;

const root = process.cwd();
// One literal command string rather than a program plus an argument array.
// `execFile` cannot launch `npm` on Windows, where it is a `.cmd` that Node 24
// refuses to spawn without a shell, and passing an argument array *through* a
// shell is what Node's DEP0190 warns about, since the parts are concatenated
// rather than escaped. There is nothing to escape here: the command is a fixed
// literal with no interpolation.
const raw = execSync('npm pack --dry-run --json', {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
const [result] = JSON.parse(raw) as PackResult[];
if (!result) throw new Error('check-pack: npm pack produced no result');

const paths = result.files.map((f) => f.path.replaceAll('\\', '/')).sort();
const problems: string[] = [];

for (const p of paths) {
  const top = p.split('/')[0]!;
  if (!ALLOWED_ROOTS.has(top)) problems.push(`unexpected top-level entry: ${p}`);
  for (const bad of FORBIDDEN) {
    if (bad.test(p)) problems.push(`forbidden entry: ${p}`);
  }
}

// `docs/` is allowed as a root only because `files` names one file inside it.
for (const p of paths) {
  if (p.startsWith('docs/') && p !== 'docs/API.md') {
    problems.push(`only docs/API.md may ship, got: ${p}`);
  }
}

for (const required of REQUIRED) {
  if (!paths.includes(required)) problems.push(`missing required entry: ${required}`);
}

// The CLI bundle ships without source maps (it is minified and shipped to run);
// the library ships with them, because it is code people audit and step through.
for (const p of paths) {
  if (p.startsWith('dist-cli/') && p.endsWith('.map')) {
    problems.push(`dist-cli must not ship source maps: ${p}`);
  }
}
// `index.js` is a pure re-export facade with no original source lines, so the
// bundler emits no map for it; the substantive output is what must be mappable.
if (!paths.some((p) => p === 'dist-lib/node.js.map')) {
  problems.push('dist-lib must ship source maps (node.js.map missing)');
}

/**
 * Nothing but build output inside the two dist trees.
 *
 * Checking top-level roots alone is not enough: Vite copies `public/` into
 * `outDir` by default, which quietly put the browser extension's `_locales/` and
 * `icons/` inside both bundles' directories. They were dead weight nobody reads,
 * and the roots check could not see them because their top level is `dist-*`.
 */
const DIST_ALLOWED = /^dist-(cli|lib)\/(web-ui\/|chunks\/)?[^/]+$|^dist-cli\/web-ui\/.+$/;
for (const p of paths) {
  if (!p.startsWith('dist-')) continue;
  if (!DIST_ALLOWED.test(p)) problems.push(`unexpected file inside a dist tree: ${p}`);
  if (/^dist-[^/]+\/(_locales|icons)\//.test(p)) {
    problems.push(`extension asset leaked into the package (set publicDir: false): ${p}`);
  }
}

const unpackedMb = result.unpackedSize / (1024 * 1024);
if (unpackedMb > MAX_UNPACKED_MB) {
  problems.push(`unpacked size ${unpackedMb.toFixed(1)} MiB exceeds ${MAX_UNPACKED_MB} MiB`);
}

// The bundled-vs-external split must match `dependencies`: an import of a
// package that npm will not install is a package that breaks on first use.
const declared = new Set(
  Object.keys(
    (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { dependencies?: object })
      .dependencies ?? {},
  ),
);
for (const entry of ['dist-lib/index.js', 'dist-lib/node.js']) {
  let code: string;
  try {
    code = readFileSync(resolve(root, entry), 'utf8');
  } catch {
    continue; // absence is already reported above
  }
  for (const m of code.matchAll(/^\s*(?:import|export)[^'"]*from\s*["']([^"']+)["']/gm)) {
    const spec = m[1]!;
    if (spec.startsWith('.') || spec.startsWith('node:')) continue;
    const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
    if (!declared.has(pkg)) {
      problems.push(`${entry} imports "${pkg}", which is not in dependencies`);
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`  ${p}`);
  throw new Error(`check-pack: ${problems.length} problem(s) with the npm tarball`);
}

console.log(
  `pack OK: ${result.entryCount} entries, ${unpackedMb.toFixed(1)} MiB unpacked, ` +
    `roots ${[...new Set(paths.map((p) => p.split('/')[0]))].sort().join(', ')}`,
);
