/**
 * The `exports` map, exercised against the built package.
 *
 * Every other test imports TypeScript sources through vitest's resolver, which
 * never touches `package.json`'s `exports`. So the one thing a consumer actually
 * depends on, that `import 'stegoshard'` and `import 'stegoshard/node'` resolve
 * to working JavaScript, is the one thing nothing else checks.
 *
 * These load `dist-lib` directly. They skip, loudly, when it has not been built,
 * because a guard that silently passes on a missing artifact is worse than none:
 * `npm run build:lib` first.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const DIST = join(ROOT, 'dist-lib');
const built = existsSync(join(DIST, 'index.js')) && existsSync(join(DIST, 'node.js'));

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  exports: Record<string, { types: string; default: string } | string>;
  files: string[];
  private?: boolean;
};

describe('the exports map', () => {
  it('declares both entry points plus package.json', () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './node', './package.json']);
  });

  /**
   * No `node` or `browser` *conditions*, deliberately. An environment condition
   * would silently hand a Node consumer the filesystem build when they imported
   * the environment-neutral one; an explicit subpath keeps that choice visible at
   * the import site.
   */
  it('resolves by subpath, not by environment condition', () => {
    for (const [key, value] of Object.entries(pkg.exports)) {
      if (typeof value === 'string') continue;
      expect(Object.keys(value).sort(), `${key} must offer only types + default`).toEqual([
        'default',
        'types',
      ]);
    }
  });

  it('points every target at a file that ships', () => {
    for (const value of Object.values(pkg.exports)) {
      const targets = typeof value === 'string' ? [value] : Object.values(value);
      for (const target of targets) {
        const rel = target.replace(/^\.\//, '');
        const top = rel.split('/')[0]!;
        expect(
          pkg.files.includes(top) || rel === 'package.json',
          `${target} is not covered by "files"`,
        ).toBe(true);
      }
    }
  });

  // Publishing is a separate, deliberate decision. Until it is taken, an
  // accidental `npm publish` must be impossible rather than merely unlikely.
  it('is still marked private', () => {
    expect(pkg.private).toBe(true);
  });
});

describe.skipIf(!built)('the built entry points', () => {
  it('load, and expose the documented surface', async () => {
    const api = (await import(pathToFileURL(join(DIST, 'index.js')).href)) as Record<
      string,
      unknown
    >;
    expect(typeof api.createVaultKey).toBe('function');
    expect(typeof api.exportVault).toBe('function');
    expect(typeof api.importVault).toBe('function');
    expect(typeof api.stegoErrorCode).toBe('function');
    expect(api.FORMAT_VERSION).toBe(1);
  });

  it('load the Node entry, which is disjoint from the other', async () => {
    const nodeApi = (await import(pathToFileURL(join(DIST, 'node.js')).href)) as Record<
      string,
      unknown
    >;
    expect(typeof nodeApi.save).toBe('function');
    expect(typeof nodeApi.restore).toBe('function');
    expect(typeof nodeApi.estimate).toBe('function');
    // The env-neutral surface is not re-exported here.
    expect(nodeApi.exportVault).toBeUndefined();
  });

  /**
   * The environment-neutral entry must stay that way.
   *
   * A stray `node:fs` import would make it unusable in a browser or a worker,
   * which is the entire distinction between the two entry points. Checked by
   * reading the emitted code rather than by importing it, because importing
   * succeeds under Node either way.
   */
  it('keeps the env-neutral entry free of node: builtins', () => {
    const files = [join(DIST, 'index.js')];
    // Follow its chunks: the imports that matter may live one level down.
    const entry = readFileSync(join(DIST, 'index.js'), 'utf8');
    for (const m of entry.matchAll(/from\s*["'](\.\/chunks\/[^"']+)["']/g)) {
      files.push(join(DIST, m[1]!));
    }
    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      const hits = [...code.matchAll(/from\s*["'](node:[^"']+)["']/g)].map((m) => m[1]);
      expect(hits, `${file} imports a Node builtin`).toEqual([]);
    }
  });

  it('emits declarations for both entry points', () => {
    for (const name of ['index.d.ts', 'node.d.ts']) {
      const dts = readFileSync(join(DIST, name), 'utf8');
      expect(dts.length).toBeGreaterThan(1000);
      // Rolled up flat: no unresolved alias, no extensionless relative specifier
      // that would break a consumer on node16/nodenext resolution.
      expect(dts, `${name} still references the @core alias`).not.toMatch(/from ["']@core/);
    }
  });
});
