/**
 * The files in this directory are tokens, not source. Google Search Console
 * re-fetches its verification file and silently drops the property if the
 * contents ever change, so the failure mode is losing verification weeks later
 * with nothing in the build to show for it.
 *
 * A formatter is the likely culprit: the file is named `.html` and contains one
 * unterminated line, so Prettier rewrites it given the chance. `.prettierignore`
 * covers that; this pins the bytes regardless of what did the rewriting.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const HERE = resolve(__dirname);

/** Each token file, with the exact bytes the issuer gave us. */
const TOKENS: Record<string, string> = {
  'google07799b2e3b937a1e.html': 'google-site-verification: google07799b2e3b937a1e.html',
};

describe('site-root tokens', () => {
  it('carries exactly the files it is meant to', () => {
    const present = readdirSync(HERE).filter((n) => !n.endsWith('.test.ts'));
    expect(present.sort()).toEqual(Object.keys(TOKENS).sort());
  });

  for (const [name, content] of Object.entries(TOKENS)) {
    it(`${name} is byte-exact, with no trailing newline`, () => {
      const raw = readFileSync(resolve(HERE, name), 'utf8');
      expect(raw).toBe(content);
      // Stated separately: a trailing newline is the edit a text editor makes on
      // its own, and it is enough to fail verification.
      expect(raw.endsWith('\n')).toBe(false);
    });
  }
});
