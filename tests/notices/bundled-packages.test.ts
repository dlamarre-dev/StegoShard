/**
 * The path extraction behind the notices, and the invariant it exists to hold.
 *
 * `generate-notices.ts` is a compliance gate, so the piece of it that decides
 * *which* packages we distribute is worth testing directly. The awkward case is
 * nesting: npm installs a conflicting version under its dependent, and a bare
 * package name then does not locate it on disk. That is not hypothetical, it is
 * `string-width` in this very lockfile, and getting it wrong made the first
 * version of the union crash.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { MANIFEST_DIR, packagePathOfModule } from '../../scripts/bundled-packages';

const ROOT = resolve(import.meta.dirname, '..', '..');
const R = '/repo';

describe('packagePathOfModule', () => {
  it('returns null for our own source', () => {
    expect(packagePathOfModule('/repo/src/core/vault.ts', R)).toBeNull();
    expect(packagePathOfModule('/repo/src/api/index.ts', R)).toBeNull();
  });

  it('finds a plain dependency', () => {
    expect(packagePathOfModule('/repo/node_modules/fflate/esm/browser.js', R)).toBe(
      'node_modules/fflate',
    );
  });

  it('keeps the scope of a scoped package', () => {
    expect(packagePathOfModule('/repo/node_modules/@pdf-lib/fontkit/dist/fontkit.js', R)).toBe(
      'node_modules/@pdf-lib/fontkit',
    );
  });

  /**
   * The case that matters. `string-width` really does live here in this
   * lockfile, and crediting it to `wrap-ansi` or reporting a bare name would both
   * be wrong: the first misattributes the licence, the second cannot find the
   * file to reproduce.
   */
  it('keeps the full path of a nested dependency', () => {
    expect(
      packagePathOfModule('/repo/node_modules/wrap-ansi/node_modules/string-width/index.js', R),
    ).toBe('node_modules/wrap-ansi/node_modules/string-width');
  });

  it('normalizes Windows separators', () => {
    expect(
      packagePathOfModule('C:\\repo\\node_modules\\jpeg-js\\lib\\decoder.js', 'C:\\repo'),
    ).toBe('node_modules/jpeg-js');
  });

  it('handles an id that is already repo-relative', () => {
    expect(packagePathOfModule('node_modules/pako/dist/pako.esm.mjs', R)).toBe('node_modules/pako');
  });

  it('returns null for a malformed id', () => {
    expect(packagePathOfModule('/repo/node_modules/', R)).toBeNull();
    expect(packagePathOfModule('', R)).toBeNull();
  });
});

describe('the committed build manifests', () => {
  const dir = join(ROOT, MANIFEST_DIR);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];

  it('exist, one per shipped build', () => {
    // Committed rather than generated on demand, because `ci:node` runs
    // `notices:check` before any build has happened.
    expect(files.sort()).toEqual([
      'cli.json',
      'extension-chrome.json',
      'extension-edge.json',
      'extension-firefox.json',
      'lib.json',
      'serve.json',
      'web.json',
    ]);
  });

  it('name packages that are actually installed, by path', () => {
    for (const file of files) {
      const paths = JSON.parse(readFileSync(join(dir, file), 'utf8')) as string[];
      for (const p of paths) {
        expect(p, `${file}: not a node_modules path`).toMatch(/^node_modules\//);
        expect(existsSync(join(ROOT, p, 'package.json')), `${file}: ${p} is not installed`).toBe(
          true,
        );
      }
    }
  });

  /**
   * The regression this whole change exists to prevent: something we inline into
   * a shipped artifact that the notices file does not mention.
   */
  it('are all covered by THIRD_PARTY_NOTICES.txt', () => {
    const notices = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
    for (const file of files) {
      for (const p of JSON.parse(readFileSync(join(dir, file), 'utf8')) as string[]) {
        const name = JSON.parse(readFileSync(join(ROOT, p, 'package.json'), 'utf8')).name as string;
        expect(notices, `${name} is bundled by ${file} but has no notice`).toContain(`- ${name} `);
      }
    }
  });

  // The four that were silently distributed before this was fixed.
  it('cover the packages the lockfile alone would have missed', () => {
    const notices = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
    for (const name of ['@pdf-lib/fontkit', 'fast-png', 'iobuffer', 'jpeg-js']) {
      expect(notices).toContain(`- ${name} `);
      expect(notices, `${name} should be marked as bundled`).toMatch(
        new RegExp(`- ${name.replace('/', '\\/')} [^\\n]*bundled into:`),
      );
    }
  });
});
