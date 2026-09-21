/**
 * The edge where a coded failure becomes something to print.
 *
 * Two properties are worth pinning, and both had drifted.
 *
 * The orchestration layer throws a stable `code` and the terminal translates it
 * here, so a code with no row is a build error (the mapping is a `Record` over
 * the union). What the type checker cannot see is a code missing from
 * `API_ERROR_CODES`, because a short `readonly ApiErrorCode[]` is still a valid
 * one, and `NORMALIZE_OUT_REQUIRED` had been missing from it since it was added.
 * The `Record`'s keys are the union's runtime spelling, so they are what the list
 * is compared against.
 *
 * The other is a code sharing another command's sentence. `normalize` used to
 * raise the gallery's `NO_COVERS_FOUND` for an empty folder, so a user who
 * pointed it at a directory of nothing was told "gallery: no cover images found
 * in the given paths", about a command that hides no secret. A message naming
 * the wrong command is worse than a vague one: it sends the reader looking for a
 * mistake they did not make.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { STEGO_ERROR_CODES } from '../core/errors';
import { API_ERROR_CODES, StegoShardApiError, type ApiErrorCode } from '../api/errors';
import { API_ERROR_KEY, CLI_ERROR_CODES, CliError, toCliFailure } from './errors';
import { en } from './i18n/en';
import { useCatalog } from './i18n';

const ROOT = join(import.meta.dirname, '../..');

/** Every `.ts` file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

afterEach(() => useCatalog(null));

describe('the API error code registry', () => {
  it('lists exactly the codes the CLI maps, sorted', () => {
    const mapped = (Object.keys(API_ERROR_KEY) as ApiErrorCode[]).sort();
    expect([...API_ERROR_CODES]).toEqual(mapped);
  });

  it('points every code at a catalog key that exists and says something', () => {
    for (const code of API_ERROR_CODES) {
      const key = API_ERROR_KEY[code];
      expect(en[key], `${code} -> ${key}`).toBeTruthy();
    }
  });

  it('gives each code its own message, so none borrows another command sentence', () => {
    const keys = API_ERROR_CODES.map((code) => API_ERROR_KEY[code]);
    expect(new Set(keys).size, `shared catalog keys: ${keys.join(', ')}`).toBe(keys.length);
  });

  /**
   * The doc lists these codes in prose, which nothing else checks. The lists are
   * part of the published `--json` contract, so a reader who finds a code the
   * doc does not mention has no way to tell whether it is new or undocumented.
   * All three had fallen behind: the core one by three codes.
   */
  it('matches the three code lists documented in docs/API.md', () => {
    const doc = readFileSync(join(ROOT, 'docs/API.md'), 'utf8');
    /** The codes named between a bold heading and the end of its paragraph. */
    const documented = (section: RegExp, what: string): string[] => {
      const m = doc.match(section);
      expect(m, `docs/API.md no longer has its ${what} code list`).not.toBeNull();
      return [...m![1]!.matchAll(/`([A-Z_]+)`/g)].map((hit) => hit[1]!).sort();
    };

    expect(
      documented(/\*\*Unusable request\*\* \(`src\/api\/errors\.ts`\):([\s\S]*?)\n\n/, 'API'),
    ).toEqual([...API_ERROR_CODES].sort());
    expect(
      documented(/\*\*Format and crypto\*\* \(`src\/core\/errors\.ts`\):([\s\S]*?)\n\n/, 'core'),
    ).toEqual([...STEGO_ERROR_CODES].sort());
    expect(
      documented(/\*\*Invocation\*\* \(`src\/cli\/errors\.ts`\):([\s\S]*?)\n\n/, 'invocation'),
    ).toEqual([...CLI_ERROR_CODES].sort());
  });
});

describe('the invocation code registry', () => {
  it('is sorted, distinct, and not empty', () => {
    // Derived from a `satisfies Record<CliErrorCode, true>`, so what is left to
    // check is the shape the doc guard below compares against.
    expect(CLI_ERROR_CODES.length).toBeGreaterThan(5);
    expect([...CLI_ERROR_CODES]).toEqual([...new Set(CLI_ERROR_CODES)].sort());
  });

  /**
   * A code nothing raises is worse than an undocumented one: a caller writing a
   * branch per failure waits for something that cannot arrive. `UI_UNAVAILABLE`
   * was in that state, declared and documented while the only path to it wrote
   * the message to stderr and returned, so `stegoshard ui` never produced it.
   *
   * Textual, so it proves a mention rather than a throw. That is enough for the
   * failure it exists to catch, and a stricter check would need to run every
   * refusal path in the CLI.
   */
  it('raises every code it publishes', () => {
    const own = join('src', 'cli', 'errors.ts');
    const sources = sourceFiles(join(ROOT, 'src')).filter(
      (path) => !path.endsWith('.test.ts') && !path.endsWith(own),
    );
    expect(sources.length, 'source discovery found nothing, so this cannot pass').toBeGreaterThan(
      20,
    );
    const code = sources.map((path) => readFileSync(path, 'utf8')).join('\n');
    const unraised = [...CLI_ERROR_CODES, ...API_ERROR_CODES].filter(
      (name) => !code.includes(`'${name}'`),
    );
    expect(unraised, 'declared, documented, and impossible to produce').toEqual([]);
  });
});

describe('toCliFailure', () => {
  it('renders an orchestration code in the active language', () => {
    useCatalog('en');
    const failure = toCliFailure(
      new StegoShardApiError('NO_NORMALIZE_FILES', 'no image files found to normalize'),
    );
    expect(failure.exitCode).toBe(1);
    // Names the command that refused, and what it looked for.
    expect(failure.message).toContain('normalize');
    expect(failure.message).toContain('.heic');
    // And not the gallery's sentence, which this code used to borrow.
    expect(failure.message).not.toContain('cover');
  });

  it('keeps a CliError own exit code', () => {
    const failure = toCliFailure(new CliError('USAGE', 'bad flag', 2));
    expect(failure).toEqual({ message: 'bad flag', exitCode: 2 });
  });

  it('falls back to the message of anything it does not classify', () => {
    expect(toCliFailure(new Error('boom')).message).toBe('boom');
    expect(toCliFailure('a string').message).toBe('a string');
  });
});
