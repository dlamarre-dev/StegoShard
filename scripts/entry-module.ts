import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';

/**
 * Is this module the script the process was started with?
 *
 * Guards the top-level body of a check script so that a test importing one of its
 * helpers does not execute the whole check -- git subprocesses, and a
 * `process.exit(1)` that would take the test run down with it.
 *
 * Shared by scripts/check-golden.ts and scripts/check-claims.ts. It is one copy
 * deliberately: the logic below is subtle, it has been wrong twice in ways that
 * silently disabled a guard, and a second copy would have to be fixed twice.
 *
 * Compared through realpath on BOTH sides, which is the whole fix. The first
 * version compared `import.meta.url` against `pathToFileURL(process.argv[1])`, and
 * ESM resolves symlinks while argv does not -- so running a script through a
 * symlinked checkout matched nothing, skipped main(), and exited 0 having printed
 * and checked nothing at all. A guard that silently becomes a no-op is worse than
 * no guard.
 *
 * With realpath on both sides that case now matches and runs, so the non-matching
 * branch is only ever "something imported this module" -- a test, or a future
 * caller of an exported helper. Staying quiet there is correct; an earlier attempt
 * made it exit(1), which killed the test run on import, reintroducing the same
 * class of problem from the other direction.
 *
 * `meta` is the caller's own `import.meta`. It cannot be read from here: this
 * module's `import.meta.url` names THIS file, so a shared copy that consulted its
 * own would answer for the wrong module every time.
 */
export function isEntryModule(meta: ImportMeta): boolean {
  const invokedAs = process.argv[1];
  // No entry script at all: something imported this module.
  if (!invokedAs) return false;

  // When identity cannot be established, RUN. A guard that skips itself reports
  // green having checked nothing, which this file has already done once behind a
  // symlink; a guard that runs when it should not merely prints a line. The
  // earlier version wrapped both resolutions in one try and returned false on any
  // failure, so a non-`file:` `meta.url` -- the bundled-runner case cited
  // as the reason for the try -- silently disabled the whole check.
  // Taken off the URL string, never through `fileURLToPath`. The previous fallback
  // called that function again -- the very call whose throw put us in the catch --
  // so the bundled-runner case it existed for was never reachable, and the check
  // exited 0 having run nothing. A URL always has a last path segment, whatever
  // its scheme.
  //
  // This fix was described in a commit message one round before it was actually
  // made; the block was byte-identical to the version it claimed to change.
  const ownName = meta.url.split('/').pop() ?? '';
  const byName = (): boolean => basename(invokedAs) === ownName;

  let self: string;
  try {
    self = realpathSync(fileURLToPath(meta.url));
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
