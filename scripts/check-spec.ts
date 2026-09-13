/**
 * Refuse a SPEC.md that disagrees with the constants the code actually writes.
 *
 * SPEC.md is not documentation about the code; it is the artifact an independent
 * implementer decodes from, and it ships in `package.json#files`. So a stale
 * version number in it is not a typo, it is an interop bug: on 11 September all
 * three of `SPEC.md:204` (the §3 header table), `:319` (the §5.1 key block) and
 * `:653` (the §8.1 segmented blob) still read `1` while the code had moved to
 * `2`. Anyone writing a second implementation from those lines would have
 * produced containers this one rejects, and would have had no way to know the
 * document was wrong.
 *
 * Worth noting how they survived: a prose sweep had already corrected the
 * version claims a week earlier and missed every one of these, because they live
 * in byte-layout tables and fenced diagrams rather than in sentences. A human
 * grep finds prose. This finds layouts.
 *
 * WHAT THIS CHECKS, AND WHAT check-golden.ts CHECKS
 * This one is static: "does the document agree with the code, right now". It has
 * no base ref and cannot see history, so it cannot tell a deliberate change from
 * an accidental one. `scripts/check-golden.ts` is the other half: "was this
 * change decided on", which needs a diff. Neither subsumes the other, and a
 * constant that matters belongs in both.
 *
 * WHY REGEXES AND NOT MARKERS IN SPEC.md
 * The obvious alternative is to annotate each claim in SPEC.md with a machine
 * readable marker. Rejected for two reasons. SPEC.md is read by people who are
 * not us, and markers tax every one of them to serve one script. More decisively,
 * markers only check the claims that carry them: the failure this exists to catch
 * is someone adding a *new* byte-layout diagram with a stale number in it, and an
 * unmarked new diagram is exactly as invisible to a marker scheme as it is to
 * nothing at all. The `prose-*` rules below are the answer to that case.
 *
 * THE THREE DIAGRAM CONVENTIONS, which is what makes this tractable
 * SPEC.md writes byte layouts three ways, and only two of them state values:
 *
 *   [ MAGIC 4 = "SSKY" = 53 53 4B 59 ][ VER 1 = 1 ]     name size = value
 *   [ MAGIC "SSCS" = 53 53 43 53 ][ VERSION u8 = 1 ]    name type = value
 *   [ "SSCS" 4 ][ SEG_VERSION 1 ][ FLAGS 1 ]            name width  <- NOT a value
 *
 * The third is a field-width convention: the `1` beside `SEG_VERSION` is one
 * byte, not version one, exactly as `FLAGS 1` and `vault_salt 16` are widths.
 * Nothing here may match it, and `SPEC.md:1016` is left deliberately unmatched.
 * The discriminator is simple and worth stating: a value carries `=` or `‖`; a
 * width never does.
 *
 * WHY THE CONSTANTS ARE IMPORTED RATHER THAN PARSED
 * check-golden.ts reads its constants with a regex because it reads *historical*
 * git blobs, where importing is impossible. This script reads the working tree,
 * so it imports — which means renaming or deleting a constant is a `tsc` error
 * here (scripts/ is in tsconfig's include) instead of a rule that silently finds
 * nothing and passes.
 *
 * WHY EVERY RULE PINS AN OCCURRENCE COUNT
 * A regex over prose fails in two directions, and they are not equally visible. A
 * rule that matches the wrong text fails loudly the first time it runs. A rule
 * that matches *nothing* — because a heading moved or a sentence was reworded —
 * passes forever while checking nothing. So every rule declares how many times it
 * must match, and a count mismatch is a hard failure telling you to fix the rule
 * rather than delete it. This is the same reasoning check-golden.ts applies to an
 * unreachable base ref: a check that compares nothing must not report green.
 *
 * Run with: npm run spec:check
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { FORMAT_VERSION } from '../src/core/header';
import { KEY_BLOCK_VERSION, KEY_FACTOR_BLOCK_VERSION } from '../src/core/crypto';
import { SEG_VERSION } from '../src/core/segmented';
import { BINARY_VERSION } from '../src/core/binary-container';
import { SHARE_VERSION } from '../src/core/shamir';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Rule {
  /** Identifies the rule in a failure message, so a reader can find it here. */
  id: string;
  /** Which file, relative to the repo root. */
  file: string;
  /**
   * `raw` keeps line breaks, so a match yields a real line number. Use it for
   * fenced diagrams (prettier never reflows them) and single-line table rows.
   *
   * `flat` collapses all whitespace first, so a rule spanning prettier's 100
   * column wrap still matches. The cost is that line numbers are gone, so those
   * failures quote the matched text instead. Borrowed from
   * tests/docs/crypto-review.test.ts, which solved the same problem first.
   */
  scope: 'raw' | 'flat';
  pattern: RegExp;
  /**
   * How many matches this rule must find.
   *
   * A number means exactly that many, and it is the discipline described in the
   * header: an anchored rule that stops matching has stopped checking, so it must
   * fail loudly rather than pass silently.
   *
   * `'any'` exempts a rule from that discipline, and only the catch-all
   * `prose-*` rules below may use it. They are anchored to nothing but a
   * constant's name, so zero matches is their ordinary state -- SPEC.md happens
   * to write `FORMAT_VERSION = 2` in prose and never mentions the other three
   * that way. Their job is not to check a site that exists; it is to be waiting
   * when someone adds one.
   */
  count: number | 'any';
  expected: number;
  /** Where the truth lives, named in the failure message. */
  source: string;
}

const SPEC = 'SPEC.md';
const PY_FORMAT = 'python/stegoshard/format.py';

const RULES: Rule[] = [
  // --- SPEC.md byte layouts and tables -------------------------------------
  {
    id: 'header-table',
    file: SPEC,
    scope: 'raw',
    pattern: /\|\s*4\s*\|\s*1\s*\|\s*`VERSION`\s*\|\s*format version, `(\d+)`\s*\|/g,
    count: 1,
    expected: FORMAT_VERSION,
    source: 'FORMAT_VERSION in src/core/header.ts',
  },
  {
    id: 'key-block-diagram',
    file: SPEC,
    scope: 'raw',
    pattern: /\[ MAGIC 4 = "SSKY"[^\]]*\]\[ VER 1 = (\d+) \]/g,
    count: 1,
    expected: KEY_BLOCK_VERSION,
    source: 'KEY_BLOCK_VERSION in src/core/crypto.ts',
  },
  {
    // The §6 vault blob carries FORMAT_VERSION, not a constant of its own
    // (src/core/vault.ts writes `head[0] = FORMAT_VERSION`). Stated here so the
    // next reader does not have to re-derive it from the writer.
    id: 'vault-blob-diagram',
    file: SPEC,
    scope: 'raw',
    pattern: /\[ MAGIC 4 = "SSVB"[^\]]*\]\[ VER 1 = (\d+) \]/g,
    count: 1,
    expected: FORMAT_VERSION,
    source: 'FORMAT_VERSION in src/core/header.ts (written by src/core/vault.ts)',
  },
  {
    id: 'segmented-diagram',
    file: SPEC,
    scope: 'raw',
    pattern: /\[ MAGIC "SSCS"[^\]]*\]\[ VERSION u8 = (\d+) \]/g,
    count: 1,
    expected: SEG_VERSION,
    source: 'SEG_VERSION in src/core/segmented.ts',
  },
  {
    // Genuinely 1, and the rule exists to keep it that way: the wrapper framing
    // never changed, so a future sweep that "fixes" it to match FORMAT_VERSION
    // would be introducing the bug, not removing one.
    id: 'branded-diagram',
    file: SPEC,
    scope: 'raw',
    pattern: /\[ MAGIC "SSBN"[^\]]*\]\[ VERSION u8 = (\d+) \]/g,
    count: 1,
    expected: BINARY_VERSION,
    source: 'BINARY_VERSION in src/core/binary-container.ts',
  },
  {
    id: 'sskf-envelope',
    file: SPEC,
    scope: 'raw',
    pattern: /"SSKF" \(4\) \|\| version (\d+) \(1\)/g,
    count: 1,
    expected: KEY_FACTOR_BLOCK_VERSION,
    source: 'KEY_FACTOR_BLOCK_VERSION in src/core/crypto.ts',
  },
  {
    id: 'sskf-constants-row',
    file: SPEC,
    scope: 'flat',
    pattern: /`"SSKF"` ‖ version (\d+) ‖ factor 32/g,
    count: 1,
    expected: KEY_FACTOR_BLOCK_VERSION,
    source: 'KEY_FACTOR_BLOCK_VERSION in src/core/crypto.ts',
  },
  {
    id: 'share-constants-row',
    file: SPEC,
    scope: 'flat',
    pattern: /38 B: version (\d+) ‖ index 1/g,
    count: 1,
    expected: SHARE_VERSION,
    source: 'SHARE_VERSION in src/core/shamir.ts',
  },

  // --- SPEC.md §11 constants table -----------------------------------------
  ...(
    [
      ['FORMAT_VERSION', FORMAT_VERSION, 'src/core/header.ts'],
      ['KEY_BLOCK_VERSION', KEY_BLOCK_VERSION, 'src/core/crypto.ts'],
      ['SEG_VERSION', SEG_VERSION, 'src/core/segmented.ts'],
      ['BINARY_VERSION', BINARY_VERSION, 'src/core/binary-container.ts'],
    ] as const
  ).map(([name, expected, file]): Rule => ({
    id: `constants-table-${name}`,
    file: SPEC,
    scope: 'raw',
    pattern: new RegExp(String.raw`\|\s*\`${name}\`\s*\|\s*(\d+)\s*\|`, 'g'),
    count: 1,
    expected,
    source: `${name} in ${file}`,
  })),

  // --- The rule that catches the NEXT one ----------------------------------
  //
  // Every other rule above is anchored to a layout that exists today. This set is
  // anchored to nothing but the constant's own name, so a sentence or diagram
  // added tomorrow that writes `FORMAT_VERSION = 1` anywhere in SPEC.md is caught
  // without anyone remembering to add a rule. They are `count: 'any'` because
  // matching nothing is their normal state -- see the note on `count` above. The
  // assertion is only that every match, if there is one, agrees.
  ...(
    [
      ['FORMAT_VERSION', FORMAT_VERSION, 'src/core/header.ts'],
      ['KEY_BLOCK_VERSION', KEY_BLOCK_VERSION, 'src/core/crypto.ts'],
      ['SEG_VERSION', SEG_VERSION, 'src/core/segmented.ts'],
      ['BINARY_VERSION', BINARY_VERSION, 'src/core/binary-container.ts'],
    ] as const
  ).map(([name, expected, file]): Rule => ({
    id: `prose-${name}`,
    file: SPEC,
    scope: 'flat',
    pattern: new RegExp(String.raw`\`?${name}\`? = (\d+)`, 'g'),
    count: 'any',
    expected,
    source: `${name} in ${file}`,
  })),

  // --- The Python reference decoder ----------------------------------------
  //
  // A mirror that drifts is worse than no mirror: the conformance suite would
  // still pass (it round-trips through one implementation at a time) while the
  // two disagreed about what the format is.
  {
    id: 'python-format-version',
    file: PY_FORMAT,
    scope: 'raw',
    pattern: /^FORMAT_VERSION = (\d+)$/gm,
    count: 1,
    expected: FORMAT_VERSION,
    source: 'FORMAT_VERSION in src/core/header.ts',
  },
  {
    id: 'python-key-block-version',
    file: PY_FORMAT,
    scope: 'raw',
    pattern: /^KEY_BLOCK_VERSION = (\d+)$/gm,
    count: 1,
    expected: KEY_BLOCK_VERSION,
    source: 'KEY_BLOCK_VERSION in src/core/crypto.ts',
  },
  {
    id: 'python-seg-version',
    file: 'python/stegoshard/segmented.py',
    scope: 'raw',
    pattern: /^SEG_VERSION = (\d+)$/gm,
    count: 1,
    expected: SEG_VERSION,
    source: 'SEG_VERSION in src/core/segmented.ts',
  },
];

/** 1-based line number of a character offset, for `raw` matches. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

const failures: string[] = [];
let checked = 0;

for (const rule of RULES) {
  const path = join(ROOT, rule.file);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    failures.push(`  [${rule.id}] cannot read ${rule.file}`);
    continue;
  }
  const hay = rule.scope === 'flat' ? raw.replace(/\s+/g, ' ') : raw;
  const matches = [...hay.matchAll(rule.pattern)];

  if (rule.count !== 'any' && matches.length !== rule.count) {
    failures.push(
      `  [${rule.id}] matched ${matches.length} time(s) in ${rule.file}, expected ` +
        `${rule.count}.\n` +
        `      The text it anchors to was reworded or removed. Update the rule in\n` +
        `      scripts/check-spec.ts -- do not delete it. A rule that matches nothing\n` +
        `      passes forever while checking nothing, which is the failure this count exists to catch.`,
    );
    continue;
  }

  for (const m of matches) {
    checked++;
    const found = Number(m[1]);
    if (found === rule.expected) continue;
    const where =
      rule.scope === 'raw'
        ? `${rule.file}:${lineOf(raw, m.index ?? 0)}`
        : `${rule.file} (near: ${m[0].slice(0, 60)})`;
    failures.push(
      `  [${rule.id}] ${where}\n` +
        `      spec says ${found}, code says ${rule.expected} (${rule.source})`,
    );
  }
}

if (failures.length > 0) {
  console.error(
    [
      `spec:check: ${failures.length} disagreement(s) between the spec and the code.`,
      '',
      ...failures,
      '',
      'SPEC.md is what an independent implementer decodes from, and it ships in the',
      'package. A stale version number there is not a typo: it is a container that',
      'this code will reject, written by someone who had no way to know.',
      '',
      'Either the spec is stale (fix the line), or a constant moved without the spec',
      'moving with it (see docs/VERSIONING.md for what a format change has to carry).',
    ].join('\n'),
  );
  process.exit(1);
}

console.log(`spec:check: ${checked} version claim(s) agree with the code.`);
