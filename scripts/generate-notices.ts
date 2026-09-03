/**
 * Generate the third-party notices for everything StegoShard distributes.
 *
 * The question this used to answer was "what does npm mark as production", taken
 * from `package-lock.json`. That is not the question a licence obligation asks,
 * which is "what do we hand to a user", and the two differ in both directions:
 *
 *  - `vite.cli.config.ts` and `vite.lib.config.ts` inline their dependencies, so
 *    `fast-png`, `iobuffer`, `jpeg-js` and `@pdf-lib/fontkit` ride inside the
 *    released binaries and the npm tarball while npm installs none of them. They
 *    were distributed with no notice at all.
 *  - `qrcode` pulls `yargs` and its 26 transitive packages, which npm installs on
 *    a consumer's disk but which never reach a bundle.
 *
 * Both are distribution, so the source is the **union**: every non-dev entry in
 * the lockfile, plus every package a build reports having inlined. The build side
 * cannot be recovered by scanning the output, because every shipped bundle but
 * the library is minified and minification removes the module-origin comments a
 * scan would need; `scripts/bundled-packages.ts` asks the bundler instead and
 * writes `.bundled/<build>.json`, which is committed.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MANIFEST_DIR } from './bundled-packages';

const root = process.cwd();
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { dev?: boolean }>;
};

interface Notice {
  name: string;
  version: string;
  license: string;
  source: string;
  text: string;
}

/**
 * Licences approved for anything we distribute.
 *
 * BSD-3-Clause was added on 2026-09-02, deliberately and not by inheritance:
 * `jpeg-js` is BSD-3-Clause and is inlined into the released binaries, and the
 * licence is OSI-approved, permissive and MIT-compatible, less demanding than the
 * Apache-2.0 and MPL-2.0 already on this list. Its clause 2 asks that the
 * copyright notice accompany a binary redistribution, which is exactly what this
 * file is for.
 */
const allowed = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  'MPL-2.0',
  'Zlib',
  '(MIT AND Zlib)',
]);

/**
 * The MIT permission text, without a copyright line.
 *
 * Used only by the exception below, for a package whose author states MIT but
 * publishes no notice to reproduce.
 */
const MIT_PERMISSION = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/**
 * Packages that publish no licence file, each with a written justification.
 *
 * Deliberately a named list rather than a wildcard: a package whose licence text
 * we cannot obtain from the package itself is a thing to look at once and record,
 * not a case to handle silently. Same posture as the three hand-verified
 * suppressions in `.cryptoscan.yaml`.
 */
const NO_LICENCE_FILE: Record<string, string> = {
  '@pdf-lib/fontkit': [
    'Upstream ships no licence file. The licence is declared MIT by the author in',
    'two places: the "license" field of the package\'s own package.json, and the',
    '"## License" section of its README, both at https://github.com/Hopding/fontkit.',
    '',
    'No copyright line is published upstream, so none is reproduced here rather',
    "than one being composed on the author's behalf. The MIT permission text the",
    'declaration refers to follows.',
    '',
    MIT_PERMISSION,
  ].join('\n'),
};

/**
 * Every package npm installs for a consumer, keyed by install path.
 *
 * A path rather than a name, because npm nests a package under its dependent
 * whenever versions conflict: `string-width` lives at
 * `node_modules/wrap-ansi/node_modules/string-width`, and a bare name would not
 * find it on disk.
 */
function installedForConsumers(): Set<string> {
  const paths = new Set<string>();
  for (const path of Object.keys(lock.packages)) {
    const meta = lock.packages[path]!;
    if (!path || meta.dev === true || !path.includes('node_modules/')) continue;
    paths.add(path);
  }
  return paths;
}

/** Every package a build reported inlining, keyed the same way. */
function inlinedIntoArtifacts(): Map<string, string[]> {
  const dir = resolve(root, MANIFEST_DIR);
  const byPath = new Map<string, string[]>();
  if (!existsSync(dir)) {
    throw new Error(
      `notices: ${MANIFEST_DIR}/ is missing. It is committed; run the builds to regenerate it.`,
    );
  }
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue;
    const build = file.replace(/\.json$/, '');
    for (const path of JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as string[]) {
      byPath.set(path, [...(byPath.get(path) ?? []), build]);
    }
  }
  return byPath;
}

const inlined = inlinedIntoArtifacts();
const paths = [...new Set([...installedForConsumers(), ...inlined.keys()])].sort();

const notices: (Notice & { path: string })[] = [];
for (const path of paths) {
  const dir = resolve(root, path);
  if (!existsSync(resolve(dir, 'package.json'))) {
    throw new Error(`notices: dependency is not installed: ${path}`);
  }
  const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    license?: string;
    homepage?: string;
    repository?: string | { url?: string };
  };
  const license = pkg.license ?? 'UNKNOWN';
  if (!allowed.has(license)) {
    throw new Error(`notices: review unapproved license ${license} (${pkg.name})`);
  }
  const licenseName = readdirSync(dir)
    .sort()
    .find((entry) => /^(?:licen[cs]e|copying)(?:[._-].*)?$/i.test(entry));

  let text: string;
  if (licenseName) {
    // Normalize CRLF: some upstream LICENSE files ship with Windows endings,
    // but .gitattributes stores this file as LF. Without this the committed
    // copy and a freshly generated one differ on every checkout, and the
    // byte-exact --check below fails in CI for a reason no one can see.
    text = readFileSync(resolve(dir, licenseName), 'utf8').replace(/\r\n/g, '\n').trim();
  } else if (NO_LICENCE_FILE[pkg.name]) {
    text = NO_LICENCE_FILE[pkg.name]!;
  } else {
    throw new Error(
      `notices: ${pkg.name} has no installed license text. Obtain it, or record a ` +
        `justified exception in NO_LICENCE_FILE.`,
    );
  }

  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const source = (pkg.homepage ?? repository ?? `https://www.npmjs.com/package/${pkg.name}`)
    .replace(/^git\+/, '')
    .replace(/\.git$/, '');
  notices.push({ path, name: pkg.name, version: pkg.version, license, source, text });
}
notices.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const groups = new Map<string, Notice[]>();
for (const notice of notices) {
  const key = `${notice.license}\n${notice.text}`;
  groups.set(key, [...(groups.get(key) ?? []), notice]);
}

/** How this package reaches a user: inlined into an artifact, or installed by npm. */
const how = (path: string): string => {
  const builds = inlined.get(path);
  return builds ? `bundled into: ${builds.join(', ')}` : 'installed by npm';
};

const inventory = notices
  .map((n) => `- ${n.name} ${n.version} — ${n.license} — ${n.source} — ${how(n.path)}`)
  .join('\n');
const texts = [...groups.entries()]
  .map(([key, members]) => {
    const text = key.slice(key.indexOf('\n') + 1);
    return `\n---\n\n${members[0]!.license}\nApplies to: ${members.map((m) => `${m.name} ${m.version}`).join(', ')}\n\n${text}`;
  })
  .join('\n');

const preamble = [
  'StegoShard third-party notices',
  '',
  'Generated. Do not edit by hand; run `npm run notices`.',
  '',
  'Covers everything StegoShard distributes, which is the union of two sets: the',
  'packages npm installs for a consumer (from package-lock.json), and the packages',
  'each build inlines into an artifact we hand out directly (from .bundled/, written',
  'by the bundler). Each entry below says which.',
  '',
].join('\n');

const output = `${preamble}${inventory}\n${texts}\n`;
const outPath = resolve(root, 'THIRD_PARTY_NOTICES.txt');

if (process.argv.includes('--check')) {
  if (!existsSync(outPath) || readFileSync(outPath, 'utf8') !== output) {
    throw new Error('THIRD_PARTY_NOTICES.txt is stale; run npm run notices');
  }
} else {
  writeFileSync(outPath, output);
  const bundledCount = notices.filter((n) => inlined.has(n.path)).length;
  console.log(
    `wrote THIRD_PARTY_NOTICES.txt (${notices.length} packages: ` +
      `${bundledCount} bundled into artifacts, ${notices.length - bundledCount} installed by npm)`,
  );
}
