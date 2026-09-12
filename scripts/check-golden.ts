/**
 * Refuse a change to the golden corpus that does not come with a format version
 * bump in the same change.
 *
 * The corpus in `tests/golden/` is only worth its bytes if regenerating it is
 * hard to do by reflex. Without this check, a contributor whose change broke the
 * format would see the golden tests fail, run `npm run golden`, watch them pass,
 * and ship a silent format break. That is precisely the failure the corpus
 * exists to prevent, so the corpus needs a guard of its own.
 *
 * The rule is a pairing, not a prohibition. A deliberate format change is
 * expected to bump a constant, update SPEC.md, and regenerate. What is refused
 * is regenerating *instead of* deciding.
 *
 * Run with: npm run golden:check   (CI passes --base=<ref>)
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Read `DEFAULT_ARGON2`'s three fields out of a source blob, using TypeScript's
 * own parser.
 *
 * THIS USED TO BE A REGEX, and it produced a fresh fail-open in every round of
 * review it survived: stripping comments after the capture (a brace inside a
 * comment truncated the body), then stripping the whole file (an unbalanced `/*`
 * in any earlier string swallowed the declaration), then anchoring on the first
 * mention of the name (a comment mentioning it was parsed instead of the
 * constant), then anchoring on the first *declaration* -- which still lost,
 * because the comment strip ran after the anchor, so a commented-out declaration
 * matched first. That last one is the ordinary shape of a cost edit: comment the
 * old line, write the new one. Both sides then parsed the old values and a real
 * change would have shipped with no version bump.
 *
 * Every one of those bugs was in locating the declaration and deciding what was a
 * comment. A lexer does both exactly, and `typescript` is already a dependency, so
 * there is no reason to keep approximating one. What remains here is a walk to a
 * named declaration and an evaluation of numeric literals -- no text scanning at
 * all.
 *
 * Three outcomes, and conflating the last two is how a guard switches itself off:
 * 'absent' means this blob DECLARES no such constant (a rename, a move, or a file
 * that merely mentions or re-exports the name), 'unparseable' means a declaration
 * is there in a shape this reader does not recognise. Only the second is a reason
 * to refuse to guess, and the caller's message has to say which one happened --
 * they send a contributor to different places, `COST_FILE` versus this function.
 */
export function readArgon2(blob: string): Record<string, number> | 'absent' | 'unparseable' {
  const source = ts.createSourceFile('crypto.ts', blob, ts.ScriptTarget.Latest, true);

  // The MODULE-LEVEL declaration, not the first one in pre-order. A walk over the
  // whole tree would take a `DEFAULT_ARGON2` inside a function body -- a test
  // helper above the real export, say -- and both sides of a diff would then read
  // the helper. That is the same shape as the commented-out declaration this file
  // has already been caught by, so it is excluded structurally rather than by
  // hoping the real one comes first.
  let initializer: ts.Expression | undefined;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === 'DEFAULT_ARGON2' && decl.initializer) {
        initializer ??= decl.initializer;
      }
    }
  }
  if (!initializer) return 'absent';

  // Unwrap `Object.freeze({...})`, `{...} as const`, and parentheses -- and
  // NOTHING else.
  //
  // Accepting any single-argument call was a fail-open: `tuneForHost({...})` or
  // `Object.freeze(scaleMemory({...}))` would have been read as the constant's
  // value, so changing the wrapper left both sides reading the same inner literal.
  // The regex this replaced required a literal `Object.freeze(`, and that was the
  // stricter behaviour.
  //
  // Refusing rather than evaluating is deliberate, and it is why this reads the
  // AST instead of importing the module and taking the value. On the §5.3, §9.1
  // and §10.2 paths this constant IS the format; it has to stay a plain literal
  // anyone can read off the page, in TypeScript and in the Python mirror. A
  // computed one should fail loudly here, not be quietly evaluated into agreement.
  const isObjectFreeze = (call: ts.CallExpression): boolean =>
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === 'Object' &&
    call.expression.name.text === 'freeze' &&
    call.arguments.length === 1;

  let expr = initializer;
  for (;;) {
    if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) expr = expr.expression;
    else if (ts.isParenthesizedExpression(expr)) expr = expr.expression;
    else if (ts.isCallExpression(expr) && isObjectFreeze(expr)) expr = expr.arguments[0]!;
    else break;
  }
  if (!ts.isObjectLiteralExpression(expr)) return 'unparseable';

  /** Numeric literals and the products the real constant is written with. */
  const value = (node: ts.Expression): number | undefined => {
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isParenthesizedExpression(node)) return value(node.expression);
    if (ts.isBinaryExpression(node)) {
      const l = value(node.left);
      const r = value(node.right);
      if (l === undefined || r === undefined) return undefined;
      if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return l * r;
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return l + r;
    }
    return undefined;
  };

  const out: Record<string, number> = {};
  for (const prop of expr.properties) {
    // Anything that is not a plain `name: <number>` -- a spread, a computed key, a
    // shorthand, a method -- means this reader has not understood the literal, and
    // saying so is the whole point of the 'unparseable' outcome.
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) return 'unparseable';
    const v = value(prop.initializer);
    if (v === undefined) return 'unparseable';
    out[prop.name.text] = v;
  }
  // Exactly the three fields, no more and no fewer. The regex this replaced
  // required the full set and the first AST version did not, so
  // `Object.freeze({ iterations: 4 })` parsed confidently -- and if a field were
  // ever extracted into its own constant, later changes to it would compare equal
  // forever.
  const EXPECTED = ['iterations', 'memoryKiB', 'parallelism'];
  const found = Object.keys(out).sort();
  return EXPECTED.every((k) => found.includes(k)) && found.length === EXPECTED.length
    ? out
    : 'unparseable';
}

const CONSTANTS = [
  ['src/core/header.ts', 'FORMAT_VERSION'],
  ['src/core/crypto.ts', 'KEY_BLOCK_VERSION'],
  ['src/core/binary-container.ts', 'BINARY_VERSION'],
  // Absent until the AAD work added it. Without this row a break in the
  // segmented .db format could regenerate the corpus with no bump at all,
  // which is the exact failure the guard exists to prevent.
  ['src/core/segmented.ts', 'SEG_VERSION'],
  ['src/core/header.ts', 'CODEC_GALLERY'],
  // Added with check-spec.ts, and absent for the same reason SEG_VERSION was:
  // nobody added them when they were introduced. docs/VERSIONING.md already
  // records that lesson once; this is it happening twice more.
  ['src/core/shamir.ts', 'SHARE_VERSION'],
  ['src/core/crypto.ts', 'KEY_FACTOR_BLOCK_VERSION'],
] as const;

function arg(name: string): string | undefined {
  return process.argv
    .slice(2)
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')[1];
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf-8' });
}

function main(): void {
  const base = arg('base') ?? 'origin/main';
  let status: string[];
  try {
    status = git('diff', '--name-status', `${base}...HEAD`).split('\n').filter(Boolean);
  } catch (e) {
    // Locally this is ordinary: a contributor may not have the base ref. Under
    // CI it means the check compared nothing, and a check that compares nothing
    // reports green while verifying green. Same rule as the Python suites.
    const message = `golden:check: cannot diff against ${base}: ${(e as Error).message}`;
    if (process.env.CI === 'true') {
      console.error(
        `${message}\nA shallow checkout is the usual cause; the job needs fetch-depth: 0.`,
      );
      process.exit(1);
    }
    console.log(`${message} (skipping locally)`);
    return;
  }
  const changed = status.map((l) => l.split('\t').slice(1).join('\t'));

  // Read the constant's value on both sides and require it to have gone up.
  //
  // The first version looked for a changed diff line mentioning the constant,
  // which a reformat, a type annotation, or a *decrement* all satisfy. It would
  // have accepted `FORMAT_VERSION = 0`. Detecting that a line was touched is not
  // the same as detecting that a decision was made, and this guard exists only to
  // force the decision.
  const readVersion = (blob: string, name: string): number | null => {
    const m = new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(blob);
    return m ? Number(m[1]) : null;
  };

  // --- The Argon2 cost, which is a format constant without looking like one ----
  //
  // `DEFAULT_ARGON2` is not in CONSTANTS below, because the rule it needs is a
  // different one. On the §5.3 stego, §9.1 gallery and §10.2 slot-KEK paths the
  // parameters are NOT stored in the container, so a decoder can only assume the
  // cost its encoder used. Change the default and an old vault does not report an
  // unsupported version -- it derives a different seed and fails exactly like a
  // wrong password, because deniability requires those two to be indistinguishable.
  // See "Argon2 cost is a format constant" in docs/VERSIONING.md.
  //
  // THIS RUNS BEFORE THE CORPUS EARLY-RETURNS BELOW, and that ordering is the
  // whole point. The rest of this script asks "the corpus moved, was that
  // decided?"; a cost change that did *not* regenerate the corpus would take the
  // `touched.length === 0` exit and never be looked at, which is precisely the
  // change most worth catching.
  const COST_FILE = 'src/core/crypto.ts';
  const VERSION_FILE = 'src/core/header.ts';
  if (changed.includes(COST_FILE)) {
    // Two different reasons the base side can be absent, and only one of them is
    // benign. `git show` throwing means the file is new on this branch, so there
    // is genuinely nothing to compare against. `readArgon2` returning null means
    // the literal was there and could not be parsed -- and treating THAT as
    // "nothing to compare" is the same silent bypass the costNow check below
    // refuses. Hardening one side and not the other left the hole open.
    const unreadable = (where: string, why: 'absent' | 'unparseable'): never => {
      console.error(
        [
          `golden:check: cannot read DEFAULT_ARGON2 from ${where}.`,
          '',
          why === 'absent'
            ? 'The constant is not declared there at all. If it was renamed or moved,'
            : 'The literal is there but is not a shape this guard can parse, so it',
          why === 'absent'
            ? 'update COST_FILE and readArgon2 in this file -- do not remove the rule.'
            : 'cannot tell whether the cost changed. Update readArgon2 -- do not remove it.',
          '',
          'On the stego, gallery and slot-KEK paths the cost IS the format; see',
          'docs/VERSIONING.md.',
        ].join('\n'),
      );
      process.exit(1);
    };

    /** Narrow the reader's three outcomes down to a value, exiting on the rest. */
    const costAt = (where: string, blob: string): Record<string, number> => {
      const read = readArgon2(blob);
      if (read === 'absent' || read === 'unparseable') unreadable(where, read);
      return read as Record<string, number>;
    };

    let costBefore: Record<string, number> | undefined;
    try {
      const blob = git('show', `${base}:${COST_FILE}`);
      costBefore = costAt(`${base}:${COST_FILE}`, blob);
    } catch {
      costBefore = undefined; // new file on this branch; nothing to compare against
    }
    const costNow = costAt(COST_FILE, git('show', `HEAD:${COST_FILE}`));
    // An unreadable literal is a hard failure, not a skip (see `costAt` above).
    // `readArgon2` refuses to guess at a shape it does not recognise, and treating
    // that as "nothing changed" would turn the refusal into a silent bypass -- the
    // check would switch itself off for exactly the edit most likely to have
    // rewritten the literal. A `git show` that THROWS is different and legitimate:
    // the file is new on this branch, so there is nothing to compare against.
    // Compared field by field. `JSON.stringify` preserves insertion order and `out`
    // is built in AST property order, so reordering the three keys with no value
    // change would have failed CI as a cost change. (The messages below still use
    // stringify, which is fine: they are for a human to read.)
    const sameCost = (a: Record<string, number>, b: Record<string, number>): boolean => {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
      return keys.every((k) => a[k] === b[k]);
    };
    if (costBefore !== undefined && !sameCost(costBefore, costNow)) {
      let versionBumped: boolean;
      try {
        const was = readVersion(git('show', `${base}:${VERSION_FILE}`), 'FORMAT_VERSION');
        const now = readVersion(git('show', `HEAD:${VERSION_FILE}`), 'FORMAT_VERSION');
        versionBumped = was !== null && now !== null && now > was;
      } catch {
        // No base blob to compare: treat as un-bumped rather than assume a decision.
        versionBumped = false;
      }
      if (!versionBumped) {
        console.error(
          [
            'golden:check: DEFAULT_ARGON2 changed with no FORMAT_VERSION bump.',
            '',
            `  was: ${JSON.stringify(costBefore)}`,
            `  now: ${JSON.stringify(costNow)}`,
            '',
            'On the stego (SPEC §5.3), gallery (§9.1) and slot-KEK (§10.2) paths the',
            'Argon2 parameters are not stored in the container, so this is a format',
            'change whether or not it looks like one. An existing vault on those paths',
            'will not report an unsupported version: it will derive a different seed and',
            'fail exactly like a wrong password, with nothing able to tell the user why.',
            '',
            'If the cost change is deliberate: bump FORMAT_VERSION, update SPEC §5.1,',
            '§5.3, §9.1, §10.2 and the §11 constants table, update the Python defaults in',
            'format.py, stego.py and gallery.py (and their ARGON2_LIMITS ceilings, which',
            'currently sit exactly at the defaults), then regenerate. See the "Argon2 cost',
            'is a format constant" section of docs/VERSIONING.md.',
          ].join('\n'),
        );
        process.exit(1);
      }
    }
  }

  // Added files are fine: pinning a new output path invalidates nothing that was
  // pinned before, and refusing it would make the corpus impossible to grow, or
  // to introduce. What needs a decision is changing or deleting an artifact that
  // a released decoder may already have to read.
  const touched = status
    .filter((l) => !l.startsWith('A'))
    .map((l) => l.split('\t').slice(1).join('\t'))
    .filter((f) => f.startsWith('tests/golden/'));

  if (touched.length === 0) {
    const added = changed.filter((f) => f.startsWith('tests/golden/')).length;
    console.log(
      added > 0
        ? `golden:check: ${added} artifact(s) added, none changed`
        : 'golden:check: corpus unchanged',
    );
    return;
  }

  // PROVENANCE.md records the constants, so it moves with every regeneration and
  // cannot itself be the evidence that a decision was made.
  const artifacts = touched.filter((f) => f !== 'tests/golden/PROVENANCE.md');
  if (artifacts.length === 0) {
    console.log('golden:check: only PROVENANCE.md changed');
    return;
  }

  const bumped: string[] = [];
  for (const [file, name] of CONSTANTS) {
    if (!changed.includes(file)) continue;
    let before: string;
    try {
      before = git('show', `${base}:${file}`);
    } catch {
      // New file: everything in it is new, so any constant it declares counts.
      bumped.push(name);
      continue;
    }
    const was = readVersion(before, name);
    const now = readVersion(git('show', `HEAD:${file}`), name);
    if (was !== null && now !== null && now > was) bumped.push(`${name} ${was} -> ${now}`);
  }

  if (bumped.length > 0) {
    console.log(`golden:check: corpus changed alongside ${bumped.join(', ')}`);
    return;
  }

  console.error(
    [
      `golden:check: ${artifacts.length} golden artifact(s) changed with no format version bump.`,
      '',
      ...artifacts.slice(0, 10).map((f) => `  ${f}`),
      artifacts.length > 10 ? `  ... and ${artifacts.length - 10} more` : '',
      '',
      'These bytes are what proves the format has not drifted. Regenerating them to',
      'make a test pass removes the only check that would have caught the drift.',
      '',
      'If the format changed on purpose: bump the relevant constant',
      `(${CONSTANTS.map(([, n]) => n).join(', ')}), update SPEC.md and the Python`,
      'decoder, then regenerate with `npm run golden`. See docs/VERSIONING.md.',
      '',
      'If it did not: the change altered the format by accident, which is what this',
      'is here to tell you.',
    ]
      .filter((l) => l !== '')
      .join('\n'),
  );
  process.exit(1);
}

// Only when run as a script. `readArgon2` is imported by
// tests/docs/check-golden-argon2.test.ts, and without this guard that import would
// execute the whole check -- git subprocesses, and a `process.exit(1)` that would
// take the test run down with it.
//
// Compared through realpath on BOTH sides, which is the whole fix. The first
// version compared `import.meta.url` against `pathToFileURL(process.argv[1])`, and
// ESM resolves symlinks while argv does not -- so running the script through a
// symlinked checkout matched nothing, skipped main(), and exited 0 having printed
// and checked nothing at all. A guard that silently becomes a no-op is worse than
// no guard.
//
// With realpath on both sides that case now matches and runs, so the non-matching
// branch is only ever "something imported this module" -- a test, or a future
// caller of `readArgon2`. Staying quiet there is correct; an earlier attempt made
// it exit(1), which killed the test run on import, reintroducing the same class of
// problem from the other direction.
function isEntryModule(): boolean {
  const invokedAs = process.argv[1];
  // No entry script at all: something imported this module.
  if (!invokedAs) return false;

  // When identity cannot be established, RUN. A guard that skips itself reports
  // green having checked nothing, which this file has already done once behind a
  // symlink; a guard that runs when it should not merely prints a line. The
  // earlier version wrapped both resolutions in one try and returned false on any
  // failure, so a non-`file:` `import.meta.url` -- the bundled-runner case cited
  // as the reason for the try -- silently disabled the whole check.
  const byName = (): boolean => basename(invokedAs) === basename(fileURLToPath(import.meta.url));

  let self: string;
  try {
    self = realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // Our own location is unresolvable: a non-`file:` URL, or a permissions
    // failure. Nothing to compare against, so fall back to the entry's name.
    try {
      return byName();
    } catch {
      return false;
    }
  }
  try {
    return realpathSync(invokedAs) === self;
  } catch {
    // The entry path itself does not resolve -- a loader that rewrites it, or a
    // deleted file. `realpathSync` throws rather than returning, which is why this
    // is caught at all.
    return basename(invokedAs) === basename(self);
  }
}

if (isEntryModule()) {
  main();
}
