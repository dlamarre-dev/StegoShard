/**
 * Refuse a claims register that disagrees with what the release actually does.
 *
 * docs/CLAIMS.md is the project's court of last resort on security claims:
 * docs/ELI15.md ends with "if a claim anywhere else in this project sounds
 * stronger than what CLAIMS.md says, the claims register is right and the other
 * document is wrong." That rule only works while the register is current, and on
 * 13 September it was not. The release-integrity row still ended
 * "`SHA256SUMS.txt` is itself neither signed nor attested" a day after
 * `release-cli.yml` started attesting it and `docs/CLI.md` and the changelog had
 * both been updated to say so.
 *
 * WHY THAT DIRECTION OF DRIFT IS THE DANGEROUS ONE HERE, which is not obvious.
 * The ELI15 rule is written against *overclaiming* -- copy that sounds stronger
 * than the evidence. This drift went the other way: the register understated a
 * posture that had genuinely improved. A reader applying the rule as written
 * would have believed the weaker sentence and skipped the attestation step on the
 * checksum file, which is precisely the check that makes the cheap hash
 * comparison worth anything. An understated register is not a harmless lag; it
 * tells people not to use a control that exists.
 *
 * WHAT THIS CHECKS, AND WHAT scripts/check-spec.ts CHECKS
 * check-spec asks "does SPEC.md agree with the constants the code writes" -- doc
 * against code, and every rule there compares a number. This asks "does the
 * claims register agree with the release configuration" -- doc against YAML, and
 * every rule here compares a *posture*: attested or not. The truth source is the
 * `subject-path` list in the release workflows, read rather than restated, so
 * adding or removing a subject flips the expectation here automatically and the
 * docs must move with it. Neither script subsumes the other and they share no
 * rule engine, because a numeric comparison and a polarity comparison are not the
 * same check wearing different clothes.
 *
 * WHY CHANGELOG.md IS NOT IN THE DOC SET
 * A changelog entry is a record of what was true when it was written, and
 * rewriting shipped entries to match today would destroy the only history of when
 * a control arrived. The cost is real: an `[Unreleased]` section can contradict
 * itself, and this one did -- one bullet announcing the attestation fix, another
 * further down still calling the file unattested. That was fixed by hand, by
 * dating the older sentence rather than deleting it. A guard cannot tell those two
 * cases apart, so it stays out of the changelog entirely rather than guessing.
 *
 * THE TWO RULE FAMILIES
 *   1. Posture. Per released artifact, the phrasings the docs must carry and the
 *      phrasings they must not, chosen by whether the workflow attests it.
 *   2. Citation liveness. Every repository path the register cites as evidence
 *      must exist. A claim whose evidence is a dead pointer is an unevidenced
 *      claim, and a rename is the ordinary way that happens.
 *
 * Every posture rule pins its expectation the way check-spec.ts pins occurrence
 * counts, and for the same reason: a `mustMatch` pattern that stops matching
 * because someone reworded a sentence has stopped checking anything, so it fails
 * loudly and asks to be updated rather than deleted.
 *
 * Run with: npm run claims:check
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isEntryModule } from './entry-module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CLAIMS = 'docs/CLAIMS.md';
const RELEASE_CLI = '.github/workflows/release-cli.yml';
const PAGES = '.github/workflows/pages.yml';

/**
 * The documents that describe the project as it is today.
 *
 * CHANGELOG.md is deliberately absent; see the header.
 */
const DOCS = [CLAIMS, 'docs/CLI.md', 'README.md'];

/**
 * Read the `subject-path:` block scalars out of a workflow.
 *
 * Deliberately not a YAML parse. The dependency would be new, the block is a
 * literal scalar either way, and a hand-rolled reader fails visibly on a shape it
 * does not understand (zero subjects -> every attested artifact reports as
 * unattested -> loud failure) rather than quietly returning something plausible.
 */
function subjectsOf(workflow: string): string[] {
  return parseSubjectPaths(readFileSync(join(ROOT, workflow), 'utf-8'));
}

/** The parsing half, separated so it can be tested on shapes no workflow has yet. */
export function parseSubjectPaths(text: string): string[] {
  const out: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const key = /^(\s*)subject-path:\s*\|/.exec(line);
    if (!key) continue;
    const indent = key[1]!.length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (next.trim() === '') continue;
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent <= indent) break;
      out.push(next.trim());
    }
  }
  return out;
}

/**
 * Does any subject glob cover this filename?
 *
 * Compared on the basename: `release/stegoshard-*` and `SHA256SUMS-web.txt` are
 * written with different amounts of path because the two workflows assemble their
 * releases in different directories, and the directory is not what either claim is
 * about. A subject this cannot resolve -- `${{ env.WEB_ARCHIVE }}` -- simply never
 * matches, which is the safe direction: it can only make an artifact look
 * unattested, never attested.
 */
export function covers(subjects: string[], filename: string): boolean {
  return subjects.some((s) => {
    const base = s.split('/').pop() ?? s;
    if (base.includes('${{')) return false;
    const rx = new RegExp(`^${base.split('*').map(escapeRx).join('.*')}$`);
    return rx.test(filename);
  });
}

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Artifact {
  id: string;
  /** The file as it appears on the release page. */
  filename: string;
  /** The workflow whose `subject-path` decides this artifact's posture. */
  workflow: string;
  /**
   * Phrasings asserting that this artifact IS attested.
   *
   * Required when the workflow attests it -- silence is the drift that started
   * this, a register that simply never mentioned a control it had gained --
   * and forbidden when it does not.
   *
   * Empty for an artifact the register is not expected to have an opinion about.
   */
  affirms: RegExp[];
  /**
   * Phrasings asserting that it is NOT attested. Forbidden while it is.
   *
   * Never *required* in the other direction, which an earlier version had it
   * doing: removing the attestation then demanded the docs write both denial
   * phrasings back, one of which is a turn of phrase docs/CLI.md happened to use
   * once. Silence about a control that does not exist is fine; it is claiming one
   * that does not exist, or omitting one that does, that misleads.
   */
  denies: RegExp[];
}

/**
 * Both lists are written from the *attested* point of view, and which one applies
 * is decided by the workflow rather than restated here: an attested artifact must
 * carry its affirmations and none of its denials; an unattested one must merely
 * not claim otherwise. That is what makes removing a subject from `subject-path`
 * fail here instead of quietly leaving the docs overclaiming.
 */
const ARTIFACTS: Artifact[] = [
  {
    id: 'sha256sums',
    filename: 'SHA256SUMS.txt',
    workflow: RELEASE_CLI,
    affirms: [
      // docs/CLAIMS.md, the release-integrity row.
      /`SHA256SUMS\.txt` and\s+`SHA256SUMS-web\.txt` \*\*are\*\* attested/,
      // docs/CLI.md, the verification walkthrough.
      /\*\*`SHA256SUMS\.txt`\*\* are attested on the same\s+terms/,
    ],
    denies: [
      /`?SHA256SUMS(?:-web)?\.txt`?[^.]{0,60}?(?:is|are) (?:itself )?(?:neither signed nor attested|not attested|unattested)/,
      /nothing vouches for it/,
    ],
  },
  {
    id: 'sha256sums-web',
    filename: 'SHA256SUMS-web.txt',
    workflow: PAGES,
    // Covered by the row above, which names both files in one sentence; a second
    // required phrasing would only pin the same sentence twice.
    affirms: [],
    denies: [],
  },
  {
    id: 'sbom',
    filename: 'stegoshard-npm.cdx.json',
    workflow: RELEASE_CLI,
    affirms: [
      /The SBOM\s+\(`stegoshard-npm\.cdx\.json`\) and \*\*`SHA256SUMS\.txt`\*\* are attested/,
    ],
    denies: [],
  },
  {
    // Not attested, on purpose: they carry no integrity claim about anything, so
    // attesting them would blur what an attestation means. The pattern sits in
    // `affirms` because it states attestation, which is the polarity this whole
    // table is written in -- so today it must match nowhere, and the day someone
    // adds these to `subject-path` it must match somewhere. Nothing is *required*
    // of the docs while they stay out: the register is entitled to be silent about
    // an artifact that makes no claim.
    id: 'license',
    filename: 'LICENSE',
    workflow: RELEASE_CLI,
    affirms: [/`LICENSE`[^.]{0,80}?(?:is|are) attested/],
    denies: [],
  },
  {
    id: 'third-party-notices',
    filename: 'THIRD_PARTY_NOTICES.txt',
    workflow: RELEASE_CLI,
    affirms: [/`THIRD_PARTY_NOTICES\.txt`[^.]{0,80}?(?:is|are) attested/],
    denies: [],
  },
];

/**
 * The artifacts the posture family covers, for a test that needs to know how many
 * there are without asking the function under test.
 */
export const ARTIFACT_IDS: readonly string[] = ARTIFACTS.map((a) => a.id);

/** What a rule family found: messages, and how many assertions it actually made. */
export interface Report {
  failures: string[];
  /**
   * Assertions performed. Reported so a green run says how much it checked, which
   * is the difference between "agrees" and "had nothing to compare".
   */
  checked: number;
}

/**
 * The posture family, with its two reads injected.
 *
 * Split out from `main` so a test can hand it a workflow that does not exist on
 * disk. The behaviour that most needs pinning cannot be reached any other way: a
 * `subject-path` block this cannot parse yields no subjects, and every artifact
 * then reads as unattested. Left to fall through, that is the worst kind of
 * failure -- a guard reporting confidently on a posture it never established, and
 * blaming the docs for it. So zero subjects is its own hard failure naming
 * `parseSubjectPaths`, and this is where that is tested.
 *
 * @param subjectsFor  the `subject-path` entries of a named workflow
 * @param docs         doc path -> text, whitespace already flattened
 */
export function checkPostures(
  subjectsFor: (workflow: string) => string[],
  docs: Map<string, string>,
): Report {
  const failures: string[] = [];
  let checked = 0;

  const matchesAnywhere = (pattern: RegExp): string[] => {
    const hits: string[] = [];
    for (const [doc, text] of docs) if (pattern.test(text)) hits.push(doc);
    return hits;
  };

  for (const artifact of ARTIFACTS) {
    const subjects = subjectsFor(artifact.workflow);
    if (subjects.length === 0) {
      failures.push(
        `  [${artifact.id}] found no subject-path entries in ${artifact.workflow}.\n` +
          `      The block this reads was restructured. Fix parseSubjectPaths() in\n` +
          `      scripts/check-claims.ts -- with no subjects every artifact reads as\n` +
          `      unattested, so this would otherwise fail in a way that looks like a\n` +
          `      docs problem.`,
      );
      continue;
    }
    const attested = covers(subjects, artifact.filename);
    const required = attested ? artifact.affirms : [];
    const forbidden = attested ? artifact.denies : artifact.affirms;
    const posture = attested ? 'attested' : 'NOT attested';

    for (const pattern of required) {
      checked++;
      if (matchesAnywhere(pattern).length > 0) continue;
      failures.push(
        `  [${artifact.id}] ${artifact.workflow} leaves ${artifact.filename} ${posture},\n` +
          `      and no document in the register set says so.\n` +
          `      Expected to match: ${String(pattern)}\n` +
          `      Either the docs are stale, or the sentence was reworded -- in which case\n` +
          `      update the pattern in scripts/check-claims.ts, do not delete it. A pattern\n` +
          `      that matches nothing passes forever while checking nothing.`,
      );
    }
    for (const pattern of forbidden) {
      checked++;
      const hits = matchesAnywhere(pattern);
      if (hits.length === 0) continue;
      failures.push(
        `  [${artifact.id}] ${artifact.workflow} leaves ${artifact.filename} ${posture},\n` +
          `      but ${hits.join(', ')} still says otherwise.\n` +
          `      Matched: ${String(pattern)}\n` +
          `      docs/ELI15.md makes the claims register authoritative over every other\n` +
          `      document. That only holds while it is current.`,
      );
    }
  }
  return { failures, checked };
}

/**
 * Backticked tokens in CLAIMS.md that look like repository paths must resolve.
 *
 * `exists` is injected for the same reason as above: the interesting case is a
 * citation whose file is gone, and the register cites no such file today.
 *
 * Release artifacts that live only on a release page -- SHA256SUMS.txt and its web
 * twin -- are listed rather than caught by a heuristic that would have to guess
 * which backticked filenames are repository paths and which are not.
 */
export function checkCitations(claims: string, exists: (path: string) => boolean): Report {
  const NOT_IN_REPO = new Set(['SHA256SUMS.txt', 'SHA256SUMS-web.txt']);
  const failures: string[] = [];
  let checked = 0;

  for (const token of new Set(claims.match(/`[^`]+`/g) ?? [])) {
    const path = token.slice(1, -1);
    if (!/\.(ts|tsx|js|py|sh|yml|yaml|md|json|txt)$/.test(path)) continue;
    if (NOT_IN_REPO.has(path)) continue;
    checked++;
    if (exists(path)) continue;
    failures.push(
      `  [citation] ${CLAIMS} cites \`${path}\`, which does not exist.\n` +
        `      A claim whose evidence is a dead pointer is an unevidenced claim. If the\n` +
        `      file moved, update the citation; if it went away, the claim needs new\n` +
        `      evidence or a changed status.`,
    );
  }
  return { failures, checked };
}

/**
 * A bare filename in the register means the file wherever it lives; these are the
 * directories it is cited from, so a rename still fails even though the citation
 * carries no path.
 */
const SEARCH = ['', 'docs', '.github/workflows', 'scripts', 'python/stegoshard'];

// Only when run as a script. The helpers above are imported by
// tests/docs/check-claims.test.ts, and without this guard that import would run the
// whole check -- including a `process.exit(1)` that would take the test run down
// with it. See scripts/entry-module.ts.
function main(): void {
  // Doc text is flattened so a pattern survives prettier's 100-column wrap.
  const docs = new Map<string, string>();
  for (const doc of DOCS)
    docs.set(doc, readFileSync(join(ROOT, doc), 'utf-8').replace(/\s+/g, ' '));

  const posture = checkPostures(subjectsOf, docs);
  const citations = checkCitations(readFileSync(join(ROOT, CLAIMS), 'utf-8'), (path) =>
    SEARCH.some((dir) => existsSync(join(ROOT, dir, path))),
  );
  const failures = [...posture.failures, ...citations.failures];

  if (failures.length > 0) {
    console.error(
      [
        `claims:check: ${failures.length} problem(s) in the claims register.`,
        '',
        ...failures,
        '',
        'docs/CLAIMS.md is what every other document defers to. A register that lags',
        'behind the release configuration misleads in both directions: overclaiming',
        'promises a control that is not there, and understating one tells a reader to',
        'skip a check that is.',
      ].join('\n'),
    );
    process.exit(1);
  }

  console.log(
    `claims:check: ${posture.checked + citations.checked} register claim(s) agree with the release configuration.`,
  );
}

if (isEntryModule(import.meta)) {
  main();
}
