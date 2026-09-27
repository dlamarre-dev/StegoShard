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
 *
 * A file can span several shards since scripts/mutation-shards.ts cuts the large
 * ones into line ranges, so rows are summed per file before they are scored. The
 * number of shards to expect comes from that plan through `EXPECTED_SHARDS`.
 */

import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import strykerConfig from '../stryker.config.mjs';

// Set by the workflow from the shard plan. Without it the missing-shard warning
// cannot be computed, and saying nothing would read as "none missing".
const EXPECTED_SHARDS = Number(process.env.EXPECTED_SHARDS) || null;

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

// What each shard was asked to mutate, from the plan job: `{ include: [{ shard,
// mutate }] }`. A shard's report cannot be taken at its word. Stryker's
// incremental mode carries every result of the stored file into the new report,
// including files and lines outside this run's `--mutate`, so a shard whose
// range moved reports its old range too, with verdicts nobody re-measured. The
// first branch run showed both: `codes` restored a stored file from when it
// still held reed-solomon.ts and reported all 177 of those mutants again, and a
// crypto range reported lines 293-1015 when it had been given 289-774.
const PLAN = process.env.MUTATION_SHARDS
  ? new Map(JSON.parse(process.env.MUTATION_SHARDS).include.map((s) => [s.shard, s.mutate]))
  : null;

/** The files and 1-based line ranges a `--mutate` value names. */
function scopeOf(mutate) {
  return mutate.split(',').map((part) => {
    const m = /^(.*?):(\d+)-(\d+)$/.exec(part);
    return m ? { file: m[1], start: Number(m[2]), end: Number(m[3]) } : { file: part };
  });
}

/**
 * Whether a reported mutant lies wholly inside the shard's scope, which is the
 * test Stryker itself applies when it decides what a range mutates.
 */
function inScope(scope, file, m) {
  return scope.some(
    (s) =>
      s.file === file &&
      (s.start === undefined || (m.location.start.line >= s.start && m.location.end.line <= s.end)),
  );
}

/** The shard a report belongs to, from its artifact directory. */
function shardOf(path) {
  return /mutation-report-([^/\\]+)[/\\]/.exec(path)?.[1];
}

function rowsFrom(paths) {
  const byFile = new Map();
  let killed = 0;
  let total = 0;
  const unscored = new Map();
  const outOfScope = new Map();
  for (const path of paths) {
    const report = JSON.parse(readFileSync(path, 'utf-8'));
    const mutate = PLAN?.get(shardOf(path) ?? '');
    const scope = mutate ? scopeOf(mutate) : null;
    if (PLAN && !scope) {
      outOfScope.set(`no plan entry for ${path}`, 0);
      continue;
    }
    for (const [file, raw] of Object.entries(report.files ?? {})) {
      const name = String(file).replace(/^.*src\//, 'src/');
      const mutants = scope ? raw.mutants.filter((m) => inScope(scope, name, m)) : raw.mutants;
      if (mutants.length < raw.mutants.length) {
        outOfScope.set(name, (outOfScope.get(name) ?? 0) + raw.mutants.length - mutants.length);
      }
      const entry = { mutants };
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
      const row = byFile.get(name) ?? { file: name, killed: 0, mutants: 0, noCoverage: 0 };
      row.killed += k;
      row.mutants += live.length;
      row.noCoverage += nc;
      byFile.set(name, row);
    }
  }
  const rows = [...byFile.values()].map((r) => ({ ...r, pct: (100 * r.killed) / r.mutants }));
  rows.sort((a, b) => a.pct - b.pct);
  return { rows, killed, total, unscored, outOfScope };
}

function render(paths) {
  const { rows, killed, total, unscored, outOfScope } = rowsFrom(paths);
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
    EXPECTED_SHARDS
      ? `${paths.length} of ${EXPECTED_SHARDS} shards reported.`
      : `${paths.length} shards reported; EXPECTED_SHARDS was not set, so a missing one would not show.`,
  ];
  // A missing shard makes the total meaningless, and a total printed without
  // that caveat is worse than no total: it reads as a drop in quality rather
  // than as a job that did not finish.
  if (EXPECTED_SHARDS && paths.length < EXPECTED_SHARDS) {
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
  // Said out loud because a range that moved leaves these behind every time, and
  // a count that keeps growing would mean a stored file that should be retired.
  if (outOfScope.size > 0) {
    const detail = [...outOfScope].map(([file, n]) => (n ? `${n} in ${file}` : file)).join(', ');
    out.push(
      '',
      `**Left out as outside their shard's range: ${detail}.** These are carried over`,
      'from a stored incremental file and were not measured in this run.',
    );
  }
  if (!PLAN) {
    out.push('', 'MUTATION_SHARDS was not set, so reports were taken as they are, unfiltered.');
  }
  out.push(
    '',
    `A file below the break threshold of ${strykerConfig.thresholds.break} fails this job. A score`,
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

// The break threshold, applied per file now that a file spans several shards.
// Each shard runs with it switched off (see `thresholds` in stryker.config.mjs),
// so this is the only place a score drop turns the nightly red. The config is
// imported without STRYKER_NO_BREAK set, so it reads the value a local run uses.
const breakAt = strykerConfig.thresholds.break;
const below = rowsFrom(paths).rows.filter((r) => breakAt != null && r.pct < breakAt);
if (below.length > 0) {
  console.error(
    below
      .map((r) => `${r.file}: ${r.pct.toFixed(2)}% is below the break threshold of ${breakAt}.`)
      .join('\n'),
  );
  process.exit(1);
}
