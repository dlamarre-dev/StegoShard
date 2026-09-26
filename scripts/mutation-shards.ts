/**
 * The nightly mutation run's shards, as line ranges resolved from named anchors.
 *
 * WHY RANGES AND NOT ONE SHARD PER FILE
 * Until 26 September the nightly ran four shards, one per group of files. The
 * stego shard was cancelled at the 120-minute limit that night at 158 of 159
 * mutants, two nights after taking 116 of the 120 minutes. crypto took 106 for
 * 148 mutants that same night. Neither file had grown enough to explain that.
 * The tests covering them had got slower: the gallery round trips re-encode every
 * cover since SPEC §9.8 and price every carrier with UERD since §9.3.1, and
 * `src/api/node/gallery.test.ts` alone now takes minutes. A survivor runs every
 * test that covers it and a timeout waits 1.5 times that, so the per-mutant cost
 * went up about fivefold in a week while the mutant counts barely moved.
 *
 * Dropping those tests from the selection would have been cheaper and would also
 * have changed what the score measures, which this repository has paid for twice
 * already (see vitest.mutation.config.ts). The runner minutes are free on a public
 * repository and the matrix is parallel, so the files are cut into ranges instead
 * and the measurement stays the same one.
 *
 * WHY ANCHORS AND NOT LINE NUMBERS
 * Stryker's `--mutate file:start-end` mutates only the nodes *wholly inside* the
 * range. A cut that lands inside a function loses every mutant that spans it,
 * the function's own BlockStatement first, and the run says nothing: those
 * mutants are simply never generated, so they are not counted as survivors and
 * not counted at all. Line numbers move with every edit above them, so a
 * hard-coded cut would drift into a function body within a few PRs.
 *
 * Each cut is instead the name of a top-level declaration, and the range starts
 * on the line where that declaration does. Every mutant lives inside a single
 * top-level statement, so a cut between two statements cannot split one.
 * `tests/mutation/shards.test.ts` checks that claim with Stryker's own
 * instrumenter on every PR: the ranges together must produce every mutant of the
 * file, each exactly once. A renamed anchor fails there too, and not at 3 a.m.
 *
 * WHERE THE CUTS ARE, and how to move them
 * Chosen on 26 September against a cost model built from the stored reports:
 * killed mutants cost their killing test, survivors all covering tests, timeouts
 * 1.5 times that plus Stryker's 60 s. crypto's last range is 18 mutants and holds
 * about a third of the file's cost on its own: `randomIntBelow` is reached by
 * every test that saves, and 8 of those 18 time out. No finer cut exists there.
 * If a shard nears the job limit again, split its file further here. The shard
 * names are the cache keys, so renaming or adding one starts that shard cold.
 *
 * Run with: npx tsx scripts/mutation-shards.ts
 * It prints the matrix and, under GitHub Actions, writes `matrix` and `count` to
 * the step outputs.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isEntryModule } from './entry-module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** One file cut at the named top-level declarations, or several files whole. */
export type ShardGroup =
  | { readonly shard: string; readonly file: string; readonly cutBefore: readonly string[] }
  | { readonly shard: string; readonly files: readonly string[] };

export const GROUPS: readonly ShardGroup[] = [
  { shard: 'crypto', file: 'src/core/crypto.ts', cutBefore: ['gateKek', 'randomIntBelow'] },
  {
    shard: 'stego',
    file: 'src/core/stego.ts',
    cutBefore: ['pickPositions', 'embedKeyBlockStegoJpeg'],
  },
  { shard: 'vault', file: 'src/core/vault.ts', cutBefore: ['multiRegionBlobLen'] },
  { shard: 'reed-solomon', file: 'src/core/reed-solomon.ts', cutBefore: ['invertMatrix'] },
  { shard: 'codes', files: ['src/core/access.ts', 'src/core/gf256.ts', 'src/core/erasure.ts'] },
];

export interface Shard {
  /** Matrix and cache-key name. */
  readonly shard: string;
  /** Value for `stryker run --mutate`: comma-separated files or `file:start-end`. */
  readonly mutate: string;
}

/** A 1-based inclusive line range of one file. */
export interface LineRange {
  readonly file: string;
  readonly start: number;
  readonly end: number;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The 1-based line where the top-level declaration `name` starts.
 *
 * Column 0 is what makes it top level: prettier indents everything nested. It
 * must match exactly once, since an anchor that could mean two places is not an
 * anchor.
 */
export function anchorLine(source: string, name: string): number {
  const decl = new RegExp(
    `^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\*?|class|const|let)\\s+${escape(name)}\\b`,
  );
  const hits: number[] = [];
  source.split('\n').forEach((line, i) => {
    if (decl.test(line)) hits.push(i + 1);
  });
  if (hits.length !== 1) {
    throw new Error(
      `mutation shard anchor \`${name}\` matches ${hits.length} top-level declaration(s), expected exactly 1`,
    );
  }
  return hits[0]!;
}

/** Contiguous ranges covering every line of `source`, cut before each anchor. */
export function cutRanges(file: string, source: string, cutBefore: readonly string[]): LineRange[] {
  const lastLine = source.split('\n').length;
  const cuts = cutBefore.map((name) => anchorLine(source, name));
  cuts.forEach((line, i) => {
    if (line <= 1 || (i > 0 && line <= cuts[i - 1]!)) {
      throw new Error(
        `mutation shard anchors for ${file} must be in file order and after line 1: ${cutBefore.join(', ')}`,
      );
    }
  });
  const starts = [1, ...cuts];
  return starts.map((start, i) => ({
    file,
    start,
    end: i + 1 < starts.length ? starts[i + 1]! - 1 : lastLine,
  }));
}

export function resolveShards(
  read: (file: string) => string = (f) => readFileSync(join(ROOT, f), 'utf-8'),
): Shard[] {
  const shards: Shard[] = [];
  for (const group of GROUPS) {
    if ('files' in group) {
      shards.push({ shard: group.shard, mutate: group.files.join(',') });
      continue;
    }
    cutRanges(group.file, read(group.file), group.cutBefore).forEach((r, i) => {
      shards.push({ shard: `${group.shard}-${i + 1}`, mutate: `${r.file}:${r.start}-${r.end}` });
    });
  }
  return shards;
}

function main(): void {
  const shards = resolveShards();
  const matrix = JSON.stringify({ include: shards });
  for (const s of shards) console.log(`${s.shard.padEnd(16)} ${s.mutate}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\ncount=${shards.length}\n`);
  }
}

if (isEntryModule(import.meta)) {
  main();
}
