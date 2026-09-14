/**
 * Refuse an architecture diagram that no longer describes this codebase.
 *
 * docs/images/architecture.png is the only picture of how the pieces reach each
 * other: four surfaces onto one shared byte core, and the resilient and deniable
 * forms splitting at the last step. It is rendered from
 * docs/architecture.archify.json, by hand, on somebody's machine. Nothing about
 * that process notices when the code moves underneath it, which is the failure
 * this script exists to make loud.
 *
 * WHY A DIAGRAM ROTS QUIETLY, WHICH IS THE POINT
 * A stale paragraph reads as wrong. A stale diagram reads as authoritative: boxes
 * and arrows carry no hedging, and a reader who opens one to orient themselves has
 * no way to tell a current map from a map of last spring. The diagram was added
 * carrying source links to twenty-eight files, so it makes twenty-eight checkable
 * promises about where things live. A rename breaks them silently, and the picture
 * keeps looking exactly as confident as it did the day it was true.
 *
 * WHAT THIS CHECKS, AND WHAT IT DELIBERATELY DOES NOT
 * Three rule families, all of them comparing the specification against something
 * the code or the tree already says:
 *
 *   1. Source liveness. Every path the specification cites must exist. This is the
 *      rename detector, and it is the rule that earns the script: `src/core/aad.ts`
 *      and `src/core/stego-guard.ts` arrived in one release and the diagram was
 *      updated by hand to name them. The next such move should not depend on
 *      somebody remembering.
 *   2. Claim agreement. Numbers the diagram restates from the code must still
 *      match it, compared against the imported constant rather than a second copy
 *      of it. Counts are pinned for the reason scripts/check-spec.ts pins them: a
 *      pattern that stops matching has stopped checking, so a reworded label fails
 *      loudly and asks to be updated rather than passing on zero matches.
 *   3. Render wiring. The rendered PNG must exist and README.md must link it. A
 *      docs table row pointing at a file nobody regenerated is worse than no row.
 *
 * What it cannot check is whether the diagram is still *true*. Every file it cites
 * can exist, every number can agree, and an arrow can still point the wrong way
 * because a module changed who calls it. This narrows drift to the cases a machine
 * can see; it does not retire the human read. Say so rather than letting a green
 * line imply more than it earned.
 *
 * WHY STALENESS IS NOT A FAILURE HERE
 * The specification pins the revision it was generated from, so "has any cited
 * file changed since?" is one `git diff` away, and failing on it was the first
 * design. It was wrong: touching `src/core/vault.ts` for an unrelated reason would
 * demand a diagram regeneration in the same pull request, and a guard that fires
 * on every core change gets routed around rather than obeyed. The pinned revision
 * is printed on success instead, so a reviewer can see how old the picture is and
 * judge for themselves.
 *
 * Run with: npm run architecture:check
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isEntryModule } from './entry-module';

import { FORMAT_VERSION } from '../src/core/header';
import { DEFAULT_ARGON2 } from '../src/core/crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SPEC = 'docs/architecture.archify.json';
const PNG = 'docs/images/architecture.png';
const README = 'README.md';
const LOCALES = 'public/_locales';

export interface Report {
  failures: string[];
  checked: number;
}

/** The slice of the Archify specification this script reads. Nothing else matters here. */
interface Spec {
  meta?: { repository?: { revision?: string } };
  components?: { id: string; sources?: { path: string }[] }[];
}

interface ClaimRule {
  /** Identifies the rule in a failure message, so a reader can find it here. */
  id: string;
  /** Capture group 1 is the number the diagram states. */
  pattern: RegExp;
  /** Exactly this many sites must match. See the header on why it is pinned. */
  count: number;
  expected: number;
  /** Where the truth lives, named in the failure message. */
  source: string;
}

/**
 * Numbers the diagram copies out of the code.
 *
 * `expected` is computed from the imported constant, never from a literal
 * restated here. A second copy of a constant is a second thing to forget, which
 * is the bug this whole file is about.
 */
export function claimRules(localeCount: number): ClaimRule[] {
  return [
    {
      id: 'format-version',
      // The `core` node tag and the Verification card both carry it.
      pattern: /FORMAT_VERSION (\d+)/g,
      count: 2,
      expected: FORMAT_VERSION,
      source: 'FORMAT_VERSION in src/core/header.ts',
    },
    {
      id: 'argon2-memory',
      // The `crypto` node tag and the Byte core card both carry it.
      pattern: /(\d+) MiB/g,
      count: 2,
      expected: DEFAULT_ARGON2.memoryKiB / 1024,
      source: 'DEFAULT_ARGON2.memoryKiB in src/core/crypto.ts',
    },
    {
      id: 'locale-count',
      // The `browser` node tag. The UI ships one directory per locale.
      pattern: /(\d+) locales/g,
      count: 1,
      expected: localeCount,
      source: `directories in ${LOCALES}`,
    },
  ];
}

/**
 * Every repository path the specification cites must resolve.
 *
 * `exists` is injected so the interesting case -- a citation whose file is gone --
 * can be tested without staging a rename in the working tree.
 */
export function checkSources(spec: Spec, exists: (path: string) => boolean): Report {
  const failures: string[] = [];
  let checked = 0;

  for (const component of spec.components ?? []) {
    for (const { path } of component.sources ?? []) {
      checked++;
      if (exists(path)) continue;
      failures.push(
        `  [source] node "${component.id}" cites ${path}, which does not exist.\n` +
          `      The diagram promises a reader they can open that file and see the thing\n` +
          `      the box names. If it moved, update ${SPEC} and re-render;\n` +
          `      if it went away, the box needs a different source or no longer belongs.`,
      );
    }
  }
  return { failures, checked };
}

/**
 * Numeric claims must agree with the constants, and must still be found at all.
 *
 * Read off the serialized specification rather than walked field by field, so a
 * claim moved from a node tag into a card is still checked where it lands.
 */
export function checkClaims(specText: string, rules: ClaimRule[]): Report {
  const failures: string[] = [];
  let checked = 0;

  for (const rule of rules) {
    const found = [...specText.matchAll(rule.pattern)];
    if (found.length !== rule.count) {
      failures.push(
        `  [${rule.id}] expected ${rule.count} site(s) stating this, found ${found.length}.\n` +
          `      Matched: ${String(rule.pattern)}\n` +
          `      A rule that stops matching has stopped checking. If the wording moved on\n` +
          `      purpose, update the count here; do not delete the rule.`,
      );
      continue;
    }
    for (const match of found) {
      checked++;
      const stated = Number(match[1]);
      if (stated === rule.expected) continue;
      failures.push(
        `  [${rule.id}] the diagram says ${stated}, the code says ${rule.expected}.\n` +
          `      Truth: ${rule.source}\n` +
          `      Update ${SPEC}, re-render ${PNG} with the archify\n` +
          `      skill, and commit both.`,
      );
    }
  }
  return { failures, checked };
}

/** The rendered picture must exist, and the docs table must point at it. */
export function checkWiring(readme: string, exists: (path: string) => boolean): Report {
  const failures: string[] = [];
  let checked = 0;

  checked++;
  if (!exists(PNG)) {
    failures.push(
      `  [render] ${PNG} does not exist.\n` +
        `      The specification is the source, but the PNG is the only form a reader\n` +
        `      ever sees. Re-render it with the archify skill.`,
    );
  }

  checked++;
  if (!readme.includes(`(${PNG})`)) {
    failures.push(
      `  [wiring] ${README} does not link ${PNG}.\n` +
        `      The documentation table is how anyone finds the diagram. An unlinked\n` +
        `      picture is a file nobody opens.`,
    );
  }
  return { failures, checked };
}

// Only when run as a script. The helpers above are imported by
// tests/docs/check-architecture.test.ts, and without this guard that import would
// run the whole check -- including a `process.exit(1)` that would take the test run
// down with it. See scripts/entry-module.ts.
function main(): void {
  const specText = readFileSync(join(ROOT, SPEC), 'utf-8');
  const spec = JSON.parse(specText) as Spec;
  const locales = readdirSync(join(ROOT, LOCALES), { withFileTypes: true }).filter((e) =>
    e.isDirectory(),
  ).length;

  const sources = checkSources(spec, (path) => existsSync(join(ROOT, path)));
  const claims = checkClaims(specText, claimRules(locales));
  const wiring = checkWiring(readFileSync(join(ROOT, README), 'utf-8'), (path) =>
    existsSync(join(ROOT, path)),
  );
  const failures = [...sources.failures, ...claims.failures, ...wiring.failures];

  if (failures.length > 0) {
    console.error(
      [
        `architecture:check: ${failures.length} problem(s) in the architecture diagram.`,
        '',
        ...failures,
        '',
        'A diagram carries no hedging. A reader who opens one to orient themselves',
        'cannot tell a current map from a map of last spring, so it has to be kept',
        'current by something other than memory.',
      ].join('\n'),
    );
    process.exit(1);
  }

  const revision = spec.meta?.repository?.revision ?? 'unpinned';
  console.log(
    `architecture:check: ${sources.checked} source link(s) resolve, ` +
      `${claims.checked} claim(s) agree with the code, rendered form wired up. ` +
      `Diagram generated at ${revision.slice(0, 7)}.`,
  );
}

if (isEntryModule(import.meta)) {
  main();
}
