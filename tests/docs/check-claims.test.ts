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
 */

import { describe, it, expect } from 'vitest';
import { parseSubjectPaths, covers } from '../../scripts/check-claims';

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
