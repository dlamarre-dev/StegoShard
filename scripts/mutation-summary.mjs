/**
 * Fold the sharded mutation reports into one table.
 *
 * This lived inline in the workflow as `node -e '...'` and failed on its first
 * run: a backtick escaped through YAML, then bash, then node, arrived as `\\`
 * and broke a template literal. Nothing could have caught that short of running
 * it, which happened 69 minutes into a nightly.
 *
 * A file instead. It lints, it typechecks nothing but it parses, and it can be
 * pointed at a directory of downloaded artifacts to check by hand:
 *
 *   node scripts/mutation-summary.mjs <dir>
 *
 * The directory holds one subdirectory per shard, each with the `mutation.json`
 * that stryker.config.mjs names. The incremental files sit beside them and must
 * not be parsed as reports: they have a different shape.
 */

import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const EXPECTED_SHARDS = 4;

function reportPaths(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter((f) => /(^|[/\\])mutation\.json$/.test(f))
    .map((f) => join(root, f));
}

// The four statuses that make up a mutation score, matching how Stryker computes
// its own. Everything else is excluded rather than merely `Ignored`: this used to
// filter `Ignored` alone, which quietly swept `RuntimeError`, `CompileError` and
// `Pending` into the denominator as though they were survivors. That deflates the
// score, and worse, it does so silently, so a shard that died halfway reads as a
// complete run whose quality dropped rather than as a run that did not finish.
const SCORED = new Set(['Killed', 'Timeout', 'Survived', 'NoCoverage']);

function rowsFrom(paths) {
  const rows = [];
  let killed = 0;
  let total = 0;
  const unscored = new Map();
  for (const path of paths) {
    const report = JSON.parse(readFileSync(path, 'utf-8'));
    for (const [file, entry] of Object.entries(report.files ?? {})) {
      for (const m of entry.mutants) {
        if (!SCORED.has(m.status) && m.status !== 'Ignored') {
          unscored.set(m.status, (unscored.get(m.status) ?? 0) + 1);
        }
      }
      const live = entry.mutants.filter((m) => SCORED.has(m.status));
      if (live.length === 0) continue;
      const k = live.filter((m) => m.status === 'Killed' || m.status === 'Timeout').length;
      const nc = live.filter((m) => m.status === 'NoCoverage').length;
      killed += k;
      total += live.length;
      rows.push({
        file: String(file).replace(/^.*src\//, 'src/'),
        pct: (100 * k) / live.length,
        killed: k,
        mutants: live.length,
        noCoverage: nc,
      });
    }
  }
  rows.sort((a, b) => a.pct - b.pct);
  return { rows, killed, total, unscored };
}

function render(paths) {
  const { rows, killed, total, unscored } = rowsFrom(paths);
  const score = total > 0 ? `${((100 * killed) / total).toFixed(2)}%` : 'no report';
  const out = [
    `## Mutation score: ${score}`,
    '',
    '| file | score | killed | mutants | no coverage |',
    '|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| \`${r.file}\` | ${r.pct.toFixed(1)}% | ${r.killed} | ${r.mutants} | ${r.noCoverage} |`,
    ),
    '',
    `${paths.length} of ${EXPECTED_SHARDS} shards reported.`,
  ];
  // A missing shard makes the total meaningless, and a total printed without
  // that caveat is worse than no total: it reads as a drop in quality rather
  // than as a job that did not finish.
  if (paths.length < EXPECTED_SHARDS) {
    out.push('', '**A shard is missing, so the score above covers only part of the scope.**');
  }
  // Reported rather than folded into the score. A mutant that failed to compile
  // or never ran says something about the run, not about the tests, and the two
  // must not be averaged together.
  if (unscored.size > 0) {
    const detail = [...unscored].map(([status, n]) => `${n} ${status}`).join(', ');
    out.push(
      '',
      `**${detail}.** These are excluded from the score above, as Stryker excludes them`,
      'from its own. They mean the run had trouble, not that a test got weaker.',
    );
  }
  out.push(
    '',
    'No threshold is set: these runs measure before anything is gated on them. A score',
    'below 100% is not by itself a gap, since some mutants are equivalent and no test can',
    'kill them. Only the Sunday rebuild is a measurement; the other nights re-test just',
    'what changed.',
  );
  return out.join('\n');
}

const root = process.argv[2] ?? 'reports';
const paths = reportPaths(root);
const summary = render(paths);
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
