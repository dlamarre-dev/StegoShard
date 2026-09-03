/**
 * Path confinement and the password-source rules.
 *
 * This is the part of the MCP surface that decides what an agent can reach, so
 * the tests are about the ways a check like this is usually wrong: a sibling
 * directory sharing a prefix, a `..` that resolves inside, a symlink pointing
 * out, and an output path that does not exist yet.
 */

import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { PolicyError, makePolicy, readPassword, resolveInRoot } from './policy';

const tmp = (prefix = 'ss-policy-') => mkdtempSync(join(tmpdir(), prefix));

/** `expect(fn).toThrow(code)` for a PolicyError, checking the code not the prose. */
function expectPolicy(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err, String(err)).toBeInstanceOf(PolicyError);
    expect((err as PolicyError).code).toBe(code);
    return;
  }
  throw new Error(`expected a PolicyError(${code})`);
}

describe('path confinement', () => {
  it('accepts a path inside the root', () => {
    const root = tmp();
    writeFileSync(join(root, 'a.txt'), 'x');
    const p = makePolicy([root]);
    expect(resolveInRoot(p, 'input', join(root, 'a.txt'))).toBe(resolve(root, 'a.txt'));
  });

  it('accepts an output path that does not exist yet', () => {
    const root = tmp();
    const p = makePolicy([root]);
    // Canonicalization has to walk up to the nearest real ancestor, or every
    // fresh out_dir would be refused.
    expect(() => resolveInRoot(p, 'out_dir', join(root, 'new', 'deeper'))).not.toThrow();
  });

  it('resolves a relative path against the first root', () => {
    const root = tmp();
    const p = makePolicy([root]);
    expect(resolveInRoot(p, 'input', 'a.txt')).toBe(resolve(root, 'a.txt'));
  });

  it('refuses an absolute path elsewhere', () => {
    const root = tmp();
    const other = tmp();
    const p = makePolicy([root]);
    expectPolicy(() => resolveInRoot(p, 'input', join(other, 'a.txt')), 'PATH_OUTSIDE_ROOT');
  });

  it('refuses an escape through ..', () => {
    const root = tmp();
    const p = makePolicy([root]);
    expectPolicy(
      () => resolveInRoot(p, 'input', join(root, '..', 'elsewhere.txt')),
      'PATH_OUTSIDE_ROOT',
    );
  });

  it('accepts a .. that lands back inside', () => {
    const root = tmp();
    mkdirSync(join(root, 'sub'));
    const p = makePolicy([root]);
    expect(() => resolveInRoot(p, 'input', join(root, 'sub', '..', 'a.txt'))).not.toThrow();
  });

  /**
   * The prefix trap. Without a separator in the comparison, a root of
   * `/data/vault` would also admit `/data/vault-backup`, which is a different
   * directory that merely starts with the same letters.
   */
  it('refuses a sibling whose name merely starts with the root', () => {
    const base = tmp();
    const root = join(base, 'vault');
    const sibling = join(base, 'vault-backup');
    mkdirSync(root);
    mkdirSync(sibling);
    const p = makePolicy([root]);
    expectPolicy(() => resolveInRoot(p, 'input', join(sibling, 'a.txt')), 'PATH_OUTSIDE_ROOT');
  });

  it('accepts the root itself', () => {
    const root = tmp();
    const p = makePolicy([root]);
    expect(() => resolveInRoot(p, 'out_dir', root)).not.toThrow();
  });

  it('honours several roots', () => {
    const a = tmp();
    const b = tmp();
    const p = makePolicy([a, b]);
    expect(() => resolveInRoot(p, 'input', join(a, 'x'))).not.toThrow();
    expect(() => resolveInRoot(p, 'input', join(b, 'x'))).not.toThrow();
    expectPolicy(() => resolveInRoot(p, 'input', join(tmp(), 'x')), 'PATH_OUTSIDE_ROOT');
  });

  // Fail closed: forgetting --root must reach nothing, not everything.
  it('refuses everything when no root was configured', () => {
    const p = makePolicy([]);
    expectPolicy(() => resolveInRoot(p, 'input', '/anywhere'), 'ROOT_NOT_CONFIGURED');
  });

  /**
   * A symlink inside the root pointing out is the case a string comparison
   * cannot catch, which is why both sides are realpath'd.
   *
   * Skipped where symlinks need a privilege the test runner may not have, which
   * is the default on Windows.
   */
  it('refuses a symlink that points outside the root', () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'secret.txt'), 'x');
    let linked = false;
    try {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
      linked = true;
    } catch {
      // No symlink privilege here; the assertion below is not reachable.
    }
    if (!linked) return;
    const p = makePolicy([root]);
    expectPolicy(() => resolveInRoot(p, 'input', join(root, 'link.txt')), 'PATH_OUTSIDE_ROOT');
  });
});

describe('password sources', () => {
  const root = tmp();
  const base = { roots: [root] };

  it('reads a STEGOSHARD_* environment variable', () => {
    const p = makePolicy(base.roots, { env: { STEGOSHARD_PASSWORD: 'from-env' } });
    expect(readPassword(p, { env: 'STEGOSHARD_PASSWORD' }, undefined)).toBe('from-env');
  });

  /**
   * Without this the request could name any variable in the process. The value
   * is never echoed back, so nothing leaks directly, but handing a model an
   * arbitrary-environment-read primitive by omission is not a thing to do.
   */
  it('refuses any variable outside the STEGOSHARD_ namespace', () => {
    const p = makePolicy(base.roots, { env: { AWS_SECRET_ACCESS_KEY: 'nope' } });
    expectPolicy(
      () => readPassword(p, { env: 'AWS_SECRET_ACCESS_KEY' }, undefined),
      'ENV_NOT_ALLOWED',
    );
    expectPolicy(() => readPassword(p, { env: 'PATH' }, undefined), 'ENV_NOT_ALLOWED');
    // Not fooled by a prefix that only looks right.
    expectPolicy(() => readPassword(p, { env: 'NOT_STEGOSHARD_X' }, undefined), 'ENV_NOT_ALLOWED');
  });

  it('reports an unset variable rather than proceeding with nothing', () => {
    const p = makePolicy(base.roots, { env: {} });
    expectPolicy(
      () => readPassword(p, { env: 'STEGOSHARD_PASSWORD' }, undefined),
      'PASSWORD_REQUIRED',
    );
  });

  it('reads the first line of a file inside the root', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'pw.txt'), 'from-file\nignored second line\n');
    const p = makePolicy([dir]);
    expect(readPassword(p, { file: join(dir, 'pw.txt') }, undefined)).toBe('from-file');
  });

  // Otherwise a password file is a way to make the server read any file's
  // first line and use it, which is a read primitive by another name.
  it('confines the password file to the root', () => {
    const dir = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'pw.txt'), 'secret');
    const p = makePolicy([dir]);
    expectPolicy(
      () => readPassword(p, { file: join(outside, 'pw.txt') }, undefined),
      'PATH_OUTSIDE_ROOT',
    );
  });

  it('refuses an empty password file', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'empty.txt'), '\n');
    const p = makePolicy([dir]);
    expectPolicy(
      () => readPassword(p, { file: join(dir, 'empty.txt') }, undefined),
      'PASSWORD_REQUIRED',
    );
  });

  it('requires some source at all', () => {
    const p = makePolicy(base.roots, { env: {} });
    expectPolicy(() => readPassword(p, undefined, undefined), 'PASSWORD_REQUIRED');
  });
});

describe('inline passwords', () => {
  const root = tmp();

  /**
   * Refused, not ignored. Dropping it silently would surface one step later as a
   * baffling PASSWORD_REQUIRED on a request that plainly supplied one.
   */
  it('are refused by default', () => {
    const p = makePolicy([root]);
    expectPolicy(() => readPassword(p, undefined, 'hunter2hunter2'), 'INLINE_PASSWORD_REFUSED');
  });

  it('are accepted only with the opt-in', () => {
    const p = makePolicy([root], { allowInlinePassword: true });
    expect(readPassword(p, undefined, 'hunter2hunter2')).toBe('hunter2hunter2');
  });

  it('outrank a password_source when allowed', () => {
    const p = makePolicy([root], {
      allowInlinePassword: true,
      env: { STEGOSHARD_PASSWORD: 'from-env' },
    });
    expect(readPassword(p, { env: 'STEGOSHARD_PASSWORD' }, 'inline-wins')).toBe('inline-wins');
  });

  it('are still refused when empty', () => {
    const p = makePolicy([root], { allowInlinePassword: true });
    expectPolicy(() => readPassword(p, undefined, ''), 'PASSWORD_REQUIRED');
  });
});
