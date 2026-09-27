/**
 * The nightly mutation shards must between them mutate everything, once.
 *
 * scripts/mutation-shards.ts cuts files into line ranges, and Stryker mutates
 * only the nodes wholly inside a range. A cut inside a function body would drop
 * every mutant that spans it, and the nightly would report a score over fewer
 * mutants without saying so: they are never generated, so they are not survivors
 * and not in the denominator. This is the check that the cuts sit between
 * top-level statements, asked of Stryker's own instrumenter rather than of the
 * anchor regex, so it holds whatever the regex gets wrong.
 *
 * It runs on every PR in `npm test`, so a rename of an anchor or an edit that
 * moves one inside something else fails here and not in a scheduled job.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import type { Logger } from '@stryker-mutator/api/logging';
import { anchorLine, cutRanges, GROUPS, resolveShards } from '../../scripts/mutation-shards';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf-8');

const silent = {
  isTraceEnabled: () => false,
  isDebugEnabled: () => false,
  isInfoEnabled: () => false,
  isWarnEnabled: () => false,
  isErrorEnabled: () => false,
  isFatalEnabled: () => false,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
} as unknown as Logger;

// What core's ProjectReader turns `file:start-end` into: 0-based lines, the
// whole of both end lines.
type Mutate =
  true | { start: { line: number; column: number }; end: { line: number; column: number } }[];

async function mutantKeys(file: string, mutate: Mutate): Promise<string[]> {
  const result = await new Instrumenter(silent).instrument(
    [{ name: file, content: read(file), mutate }],
    { plugins: null, excludedMutations: [], ignorers: [] },
  );
  return result.mutants.map(
    (m) =>
      `${m.location.start.line}:${m.location.start.column}-${m.location.end.line}:${m.location.end.column} ${m.mutatorName} ${m.replacement}`,
  );
}

function parseMutate(spec: string): { file: string; mutate: Mutate }[] {
  return spec.split(',').map((part) => {
    const m = /^(.*?):(\d+)-(\d+)$/.exec(part);
    if (!m) return { file: part, mutate: true };
    return {
      file: m[1]!,
      mutate: [
        {
          start: { line: Number(m[2]) - 1, column: 0 },
          end: { line: Number(m[3]) - 1, column: Number.MAX_SAFE_INTEGER },
        },
      ],
    };
  });
}

describe('mutation shards', () => {
  it('cover exactly the files stryker.config.mjs mutates', async () => {
    const configPath = join(ROOT, 'stryker.config.mjs');
    const config = (
      (await import(/* @vite-ignore */ configPath)) as { default: { mutate: string[] } }
    ).default;
    const sharded = resolveShards().flatMap((s) => parseMutate(s.mutate).map((p) => p.file));
    expect([...new Set(sharded)].sort()).toEqual([...config.mutate].sort());
  });

  it('have unique names, which are also their cache keys', () => {
    const names = resolveShards().map((s) => s.shard);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(GROUPS.filter((g) => 'file' in g).map((g) => [(g as { file: string }).file]))(
    'generate every mutant of %s exactly once across its ranges',
    async (file) => {
      const whole = await mutantKeys(file, true);
      const parts = resolveShards()
        .flatMap((s) => parseMutate(s.mutate))
        .filter((p) => p.file === file);
      expect(parts.length).toBeGreaterThan(1);

      const pieces: string[] = [];
      for (const p of parts) pieces.push(...(await mutantKeys(file, p.mutate)));

      expect(whole.length).toBeGreaterThan(0);
      expect(pieces.length).toBe(whole.length);
      expect([...pieces].sort()).toEqual([...whole].sort());
    },
    60_000,
  );
});

describe('anchorLine', () => {
  const src = [
    'const helper = 1;',
    '',
    'export async function first() {',
    '  function nested() {}',
    '}',
    'export function firstly() {}',
    'class Second {}',
  ].join('\n');

  it('finds top-level declarations by whole name', () => {
    expect(anchorLine(src, 'first')).toBe(3);
    expect(anchorLine(src, 'firstly')).toBe(6);
    expect(anchorLine(src, 'Second')).toBe(7);
  });

  it('refuses a nested declaration and a name that is not there', () => {
    expect(() => anchorLine(src, 'nested')).toThrow(/matches 0/);
    expect(() => anchorLine(src, 'missing')).toThrow(/matches 0/);
  });

  it('refuses a name declared twice', () => {
    expect(() => anchorLine(`${src}\nfunction first() {}`, 'first')).toThrow(/matches 2/);
  });
});

describe('cutRanges', () => {
  const src = ['a', 'function b() {}', 'c', 'function d() {}', 'e'].join('\n');

  it('tiles the file with no gap and no overlap', () => {
    expect(cutRanges('f.ts', src, ['b', 'd'])).toEqual([
      { file: 'f.ts', start: 1, end: 1 },
      { file: 'f.ts', start: 2, end: 3 },
      { file: 'f.ts', start: 4, end: 5 },
    ]);
  });

  it('refuses anchors out of file order', () => {
    expect(() => cutRanges('f.ts', src, ['d', 'b'])).toThrow(/file order/);
  });
});
