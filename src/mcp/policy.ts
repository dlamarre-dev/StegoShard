/**
 * What an agent is allowed to touch.
 *
 * Two rules, both enforced here rather than only advertised in a tool schema. A
 * hand-rolled server must not trust its own published schema: the schema is a
 * hint to a well-behaved client, and this is the part that holds when the client
 * is not.
 *
 * **Paths stay inside a declared root.** Resolve first, then compare, and
 * `realpath` both sides so a symlink pointing out is caught. Never string-match
 * `..` before resolution: `a/../../b` and a symlinked directory both defeat that,
 * and it gives a false sense of having checked.
 *
 * **Only `STEGOSHARD_*` environment variables are readable.** Without that, an
 * agent could name `AWS_SECRET_ACCESS_KEY` as its "password source". The value is
 * never echoed back, so nothing leaks directly, but handing a model an
 * arbitrary-environment-read primitive is not something to do by omission.
 *
 * Stated plainly, and repeated in docs/API.md: this is a policy in a server, not
 * a sandbox. `deno compile` bakes in blanket `--allow-read --allow-write`, so a
 * bug here is not backstopped by the runtime. The runtime-enforced version is to
 * narrow the permissions when launching it, which the network-free design makes
 * possible:
 *
 *     deno run --allow-read=/vault --allow-write=/vault --allow-env \
 *       dist-cli/stegoshard.js mcp --root /vault
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

/** Why a request was refused. Machine-stable, like every other code. */
export type PolicyErrorCode =
  /** The server was started without `--root`, so nothing is reachable. */
  | 'ROOT_NOT_CONFIGURED'
  /** A path argument resolved outside every declared root. */
  | 'PATH_OUTSIDE_ROOT'
  /** An environment variable outside the `STEGOSHARD_` namespace. */
  | 'ENV_NOT_ALLOWED'
  /** A password was passed inline without `--allow-inline-password`. */
  | 'INLINE_PASSWORD_REFUSED'
  /** No usable password source in the request. */
  | 'PASSWORD_REQUIRED'
  /** A SPEC §10 access mode, which this surface does not carry. */
  | 'MODE_NOT_AVAILABLE';

export class PolicyError extends Error {
  constructor(
    readonly code: PolicyErrorCode,
    message: string,
    readonly details?: Record<string, string | number>,
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

/** Environment variables a request may name. */
export const ENV_PREFIX = 'STEGOSHARD_';
const ENV_NAME = /^STEGOSHARD_[A-Z0-9_]*$/;

export interface Policy {
  /** Absolute, realpath-resolved roots. Empty means nothing is reachable. */
  readonly roots: readonly string[];
  /** Whether a request may carry a password as a literal string. */
  readonly allowInlinePassword: boolean;
  readonly env: NodeJS.ProcessEnv;
}

/** Resolve and canonicalize the `--root` arguments given at startup. */
export function makePolicy(
  roots: readonly string[],
  opts: { allowInlinePassword?: boolean; env?: NodeJS.ProcessEnv } = {},
): Policy {
  return {
    roots: roots.map((r) => canonical(resolve(r))),
    allowInlinePassword: opts.allowInlinePassword ?? false,
    env: opts.env ?? process.env,
  };
}

/**
 * The deepest existing ancestor of `path`, canonicalized.
 *
 * An output directory usually does not exist yet, so `realpath` on it would
 * throw. Walking up to the nearest real ancestor still resolves every symlink on
 * the way, which is the part that matters.
 */
function canonical(path: string): string {
  let current = resolve(path);
  for (;;) {
    if (existsSync(current)) {
      try {
        return realpathSync(current);
      } catch {
        return current;
      }
    }
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function contains(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  // The separator matters: without it, `/vault-secrets` passes a `/vault` check.
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Resolve one path argument, or refuse it.
 *
 * Returns the resolved (non-canonical) path, because that is what the
 * orchestration layer should act on; canonicalization is for the comparison, not
 * for rewriting the caller's request.
 */
export function resolveInRoot(policy: Policy, argName: string, value: string): string {
  if (policy.roots.length === 0) {
    throw new PolicyError(
      'ROOT_NOT_CONFIGURED',
      'this server was started without --root, so no path is reachable; restart it with --root <dir>',
    );
  }
  const resolved = isAbsolute(value) ? resolve(value) : resolve(policy.roots[0]!, value);
  const probe = canonical(resolved);
  if (!policy.roots.some((root) => contains(root, probe))) {
    throw new PolicyError('PATH_OUTSIDE_ROOT', `${argName} resolves outside every --root`, {
      argument: argName,
      roots: policy.roots.join(', '),
    });
  }
  return resolved;
}

/** Where a tool call says its password lives. Never the password itself. */
export interface PasswordSource {
  file?: string;
  env?: string;
}

/**
 * Read the password a request pointed at.
 *
 * `inline` is accepted only when the operator started the server with
 * `--allow-inline-password`, and refused loudly otherwise rather than ignored:
 * silently dropping it would surface one step later as a baffling
 * `PASSWORD_REQUIRED` on a request that plainly supplied one.
 */
export function readPassword(
  policy: Policy,
  source: PasswordSource | undefined,
  inline: string | undefined,
): string {
  if (inline !== undefined) {
    if (!policy.allowInlinePassword) {
      throw new PolicyError(
        'INLINE_PASSWORD_REFUSED',
        'passing a password inline is refused; use password_source, or restart the server with --allow-inline-password',
      );
    }
    if (inline === '') throw new PolicyError('PASSWORD_REQUIRED', 'the inline password is empty');
    return inline;
  }

  if (source?.env !== undefined) {
    if (!ENV_NAME.test(source.env)) {
      throw new PolicyError(
        'ENV_NOT_ALLOWED',
        `only ${ENV_PREFIX}* environment variables are readable, not "${source.env}"`,
        { name: source.env },
      );
    }
    const value = policy.env[source.env];
    if (!value) {
      throw new PolicyError('PASSWORD_REQUIRED', `${source.env} is unset or empty`, {
        name: source.env,
      });
    }
    return value;
  }

  if (source?.file !== undefined) {
    // Confined like every other path: a password file outside the root is a way
    // to make the server read an arbitrary file's first line.
    const path = resolveInRoot(policy, 'password_source.file', source.file);
    let first: string;
    try {
      first = readFileSync(path, 'utf8').split(/\r?\n/)[0] ?? '';
    } catch {
      throw new PolicyError('PASSWORD_REQUIRED', 'the password file could not be read');
    }
    if (!first) throw new PolicyError('PASSWORD_REQUIRED', 'the password file is empty');
    return first;
  }

  throw new PolicyError(
    'PASSWORD_REQUIRED',
    'no password_source was given; supply { "env": "STEGOSHARD_..." } or { "file": "..." }',
  );
}
