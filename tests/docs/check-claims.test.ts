/**
 * The two parsing halves of `claims:check`.
 *
 * Both are the kind of code that rots silently. The script runs green on every
 * PR, which exercises its rules against the real files but never its failure
 * paths — and a `subject-path` block it cannot read, or a glob it matches too
 * loosely, does not announce itself: it just reports a posture that is not the
 * one the release implements, in whichever direction happens to be convenient.
 * That is the same reason `readArgon2` got a test
 * (tests/docs/check-golden-argon2.test.ts) after a review found it had never once
 * been called in CI.
 *
 * The cases below are the shapes that decide whether the guard is honest, not a
 * sweep of YAML.
 *
 * An earlier version of this file stopped at `parseSubjectPaths` returning an
 * empty array for a block it could not read. That pinned the input half and
 * nothing else: it said what the parser returns, not what the guard then DOES
 * with it -- and what it does is the whole question, because no subjects means
 * every artifact reads as unattested. A guard that let that fall through would
 * report confidently on a posture it had never established, and blame the docs
 * for it. `refuses to check anything when it cannot read the workflow` below is
 * that missing assertion.
 */

import { describe, it, expect } from 'vitest';
import {
  parseSubjectPaths,
  covers,
  checkPostures,
  checkCitations,
  ARTIFACT_IDS,
} from '../../scripts/check-claims';

describe('reading subject-path out of a workflow', () => {
  it('reads a block scalar and stops at the next key', () => {
    expect(
      parseSubjectPaths(`
      - name: Attest
        uses: actions/attest-build-provenance@v4
        with:
          subject-path: |
            release/stegoshard-*
            release/SHA256SUMS.txt
      - name: Publish
        uses: softprops/action-gh-release@v3
`),
    ).toEqual(['release/stegoshard-*', 'release/SHA256SUMS.txt']);
  });

  it('reads both blocks when a workflow attests twice', () => {
    // Not hypothetical in shape: a workflow that attests a CLI archive and a web
    // bundle in one job would have two. Taking only the first would report the
    // second set unattested, and the docs would be told to weaken a true claim.
    expect(
      parseSubjectPaths(`
        with:
          subject-path: |
            a.txt
        with:
          subject-path: |
            b.txt
`),
    ).toEqual(['a.txt', 'b.txt']);
  });

  it('returns nothing for a block shape it does not understand', () => {
    // The important one. An empty result makes every artifact read as unattested,
    // which would fail the docs rather than the parser -- so the script treats
    // "no subjects at all" as a parser failure with its own message. This test
    // pins the input half of that arrangement.
    expect(parseSubjectPaths('          subject-path: > \n            a.txt\n')).toEqual([]);
    expect(parseSubjectPaths('no attestation here at all\n')).toEqual([]);
  });

  it('is not fooled by a blank line inside the block', () => {
    expect(parseSubjectPaths('  subject-path: |\n    a.txt\n\n    b.txt\n  next: 1\n')).toEqual([
      'a.txt',
      'b.txt',
    ]);
  });
});

describe('deciding whether a subject covers a file', () => {
  it('matches a glob and an exact name', () => {
    expect(covers(['release/stegoshard-*'], 'stegoshard-npm.cdx.json')).toBe(true);
    expect(covers(['release/SHA256SUMS.txt'], 'SHA256SUMS.txt')).toBe(true);
  });

  it('does not match a file the glob leaves out', () => {
    // The exact pair the exclusion is about: `stegoshard-*` covers the SBOM and
    // the archives and nothing else, which is why SHA256SUMS.txt needed its own
    // line and why LICENSE still has none.
    expect(covers(['release/stegoshard-*'], 'SHA256SUMS.txt')).toBe(false);
    expect(covers(['release/stegoshard-*'], 'LICENSE')).toBe(false);
    expect(covers(['release/stegoshard-*'], 'THIRD_PARTY_NOTICES.txt')).toBe(false);
  });

  it('anchors at both ends', () => {
    // A substring match would make `SHA256SUMS.txt` look attested the moment
    // `SHA256SUMS-web.txt` appeared in some other workflow's list.
    expect(covers(['SHA256SUMS-web.txt'], 'SHA256SUMS.txt')).toBe(false);
    expect(covers(['SUMS.txt'], 'SHA256SUMS.txt')).toBe(false);
  });

  it('treats the dot as a literal', () => {
    expect(covers(['SHA256SUMSXtxt'], 'SHA256SUMS.txt')).toBe(false);
  });

  it('never resolves an unexpanded workflow expression', () => {
    // `${{ env.WEB_ARCHIVE }}` is a real subject in pages.yml. Guessing what it
    // expands to could only ever make an artifact look attested when this script
    // cannot actually tell, so it matches nothing -- the safe direction, since the
    // failure it produces is a demand for evidence rather than a silent pass.
    expect(covers(['${{ env.WEB_ARCHIVE }}'], 'stegoshard-web-offline.zip')).toBe(false);
  });
});

describe('what the guard does when it cannot read the workflow', () => {
  const DOCS = new Map([['docs/CLAIMS.md', 'anything at all']]);
  /**
   * One failure per artifact in the table, which is what "refuses to check
   * anything" has to mean: not one complaint, but no artifact silently skipped.
   *
   * Taken from the TABLE, not from `checkPostures`. The first attempt read it off
   * the function under test, so with the fail-closed guard deleted the expected
   * count became 0 and the assertion passed against zero failures -- the vacuity
   * dressed up as a derived constant. An expectation must not come from the thing
   * it is checking.
   */
  const ARTIFACT_COUNT = ARTIFACT_IDS.length;

  it('refuses to check anything, and says the parser is what broke', () => {
    // The failure mode this exists to prevent, stated as an assertion: no
    // subjects must not quietly become "nothing is attested, so the docs are
    // wrong". It fails, it fails for every artifact, it names parseSubjectPaths
    // rather than the documents, and -- the part that makes it fail CLOSED --
    // `checked` is 0, so it cannot report agreement it never established.
    const report = checkPostures(() => [], DOCS);
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.checked).toBe(0);
    for (const f of report.failures) {
      expect(f).toMatch(/found no subject-path entries/);
      expect(f).toMatch(/parseSubjectPaths/);
    }
  });

  it('does not mistake it for a documentation problem', () => {
    // The docs here say nothing about attestation at all. If zero subjects were
    // treated as a real posture, this would produce "the docs do not say so"
    // failures pointing a contributor at CLAIMS.md, which is the wrong file.
    //
    // The length assertion is not decoration. Written as a bare loop over
    // `failures`, this test passed with the fail-closed guard deleted -- no
    // guard, no failures, nothing to iterate, green. That is the vacuous shape
    // this whole file exists to avoid, and it got in anyway on the first draft.
    const { failures } = checkPostures(() => [], DOCS);
    expect(failures.length).toBe(ARTIFACT_COUNT);
    for (const f of failures) {
      expect(f).not.toMatch(/no document in the register set says so/);
      expect(f).not.toMatch(/still says otherwise/);
    }
  });

  it('checks normally once the workflow parses again', () => {
    // The other side of the line, so the test above cannot be satisfied by a
    // guard that simply always fails.
    const subjects = ['release/stegoshard-*', 'release/SHA256SUMS.txt', 'SHA256SUMS-web.txt'];
    const report = checkPostures(() => subjects, DOCS);
    expect(report.checked).toBeGreaterThan(0);
    expect(report.failures.some((f) => /no document in the register set says so/.test(f))).toBe(
      true,
    );
  });
});

describe('citations', () => {
  it('fails on a cited file that is gone, and names it', () => {
    const report = checkCitations('evidence: `scripts/gone.ts`', () => false);
    expect(report.checked).toBe(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatch(/cites `scripts\/gone\.ts`, which does not exist/);
  });

  it('ignores backticked text that is not a path', () => {
    // `DEFAULT_ARGON2`, `--allow-cover-reuse` and the like are cited constantly.
    // Treating them as paths would make the family fire on every row.
    const report = checkCitations('`DEFAULT_ARGON2` and `--force` and `k-of-n`', () => false);
    expect(report.checked).toBe(0);
    expect(report.failures).toEqual([]);
  });

  it('does not ask the repository for a release-page artifact', () => {
    // SHA256SUMS.txt is produced by the release workflow and exists in no
    // checkout. Checking for it would fail permanently.
    const report = checkCitations('`SHA256SUMS.txt` and `SHA256SUMS-web.txt`', () => false);
    expect(report.checked).toBe(0);
    expect(report.failures).toEqual([]);
  });
});
