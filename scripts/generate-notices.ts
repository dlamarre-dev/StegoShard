/** Generate deterministic notices for every production package in package-lock.json. */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

const allowed = new Set(['0BSD', 'Apache-2.0', 'ISC', 'MIT', 'MPL-2.0', 'Zlib', '(MIT AND Zlib)']);
const notices: Notice[] = [];
for (const [path, meta] of Object.entries(lock.packages)) {
  if (!path || meta.dev === true || !path.includes('node_modules/')) continue;
  const dir = resolve(root, path);
  const pkgPath = resolve(dir, 'package.json');
  if (!existsSync(pkgPath)) throw new Error(`notices: dependency is not installed: ${path}`);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    name: string;
    version: string;
    license?: string;
    homepage?: string;
    repository?: string | { url?: string };
  };
  const license = pkg.license ?? 'UNKNOWN';
  if (!allowed.has(license))
    throw new Error(`notices: review unapproved license ${license} (${pkg.name})`);
  const licenseName = readdirSync(dir)
    .sort()
    .find((name) => /^(?:licen[cs]e|copying)(?:[._-].*)?$/i.test(name));
  if (!licenseName) throw new Error(`notices: ${pkg.name} has no installed license text`);
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const source = (pkg.homepage ?? repository ?? `https://www.npmjs.com/package/${pkg.name}`)
    .replace(/^git\+/, '')
    .replace(/\.git$/, '');
  notices.push({
    name: pkg.name,
    version: pkg.version,
    license,
    source,
    // Normalize CRLF: some upstream LICENSE files ship with Windows endings,
    // but .gitattributes stores this file as LF. Without this the committed
    // copy and a freshly generated one differ on every checkout, and the
    // byte-exact --check below fails in CI for a reason no one can see.
    text: readFileSync(resolve(dir, licenseName), 'utf8').replace(/\r\n/g, '\n').trim(),
  });
}
notices.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const groups = new Map<string, Notice[]>();
for (const notice of notices) {
  const key = `${notice.license}\n${notice.text}`;
  groups.set(key, [...(groups.get(key) ?? []), notice]);
}

const inventory = notices
  .map((n) => `- ${n.name} ${n.version} — ${n.license} — ${n.source}`)
  .join('\n');
const texts = [...groups.entries()]
  .map(([key, members]) => {
    const text = key.slice(key.indexOf('\n') + 1);
    return `\n---\n\n${members[0]!.license}\nApplies to: ${members.map((m) => `${m.name} ${m.version}`).join(', ')}\n\n${text}`;
  })
  .join('\n');
const output = `StegoShard third-party notices\n\nGenerated from package-lock.json. Do not edit by hand.\n\n${inventory}\n${texts}\n`;
const outPath = resolve(root, 'THIRD_PARTY_NOTICES.txt');

if (process.argv.includes('--check')) {
  if (!existsSync(outPath) || readFileSync(outPath, 'utf8') !== output) {
    throw new Error('THIRD_PARTY_NOTICES.txt is stale; run npm run notices');
  }
} else {
  writeFileSync(outPath, output);
  console.log(`wrote THIRD_PARTY_NOTICES.txt (${notices.length} production packages)`);
}
