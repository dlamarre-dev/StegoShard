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

const CONSTANTS = [
  ['src/core/header.ts', 'FORMAT_VERSION'],
  ['src/core/crypto.ts', 'KEY_BLOCK_VERSION'],
  ['src/core/binary-container.ts', 'BINARY_VERSION'],
  ['src/core/header.ts', 'CODEC_GALLERY'],
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

main();
