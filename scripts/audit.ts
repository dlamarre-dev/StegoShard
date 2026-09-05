/**
 * `npm audit`, with a registry outage told apart from a vulnerability.
 *
 * THE PROBLEM
 * `npm audit` exits 1 for two unrelated reasons: it found advisories, or it
 * could not reach the advisory endpoint. Over two days this gate failed six
 * times across four pull requests, twice with `400 Bad Request` and four times
 * with `503 Service Unavailable`, every one of them on
 * `/-/npm/v1/security/audits/quick`, and every one green on a plain re-run. It
 * also started failing pushes to `main`, which leaves a red badge on the default
 * branch, and a gate that is red for the usual reason is a gate people stop
 * reading.
 *
 * WHAT THIS DOES NOT DO
 * It does not let the build pass when the registry is unreachable. That would
 * trade a noisy gate for a silent one, which is the wrong direction for a
 * security check: an outage would quietly stop auditing anything for as long as
 * it lasted. Exhausting the retries still fails the build, just with a message
 * that names the real reason.
 *
 * Retrying is enough on the evidence: all six failures cleared on the next
 * attempt. What was missing was the retry, not permission to ignore the result.
 *
 * HOW IT TELLS THEM APART
 * `--json` is the discriminator rather than the exit code. A real audit answers
 * with `metadata.vulnerabilities`, counts included, whatever they are. A
 * transport failure answers with an object carrying `message` and no `metadata`
 * at all. So a report with counts is always evaluated strictly, and only the
 * absence of a report is treated as an outage: an advisory can never be mistaken
 * for a network problem, because an advisory comes with the counts attached.
 *
 * WHAT IT IS NOT
 * Not a diagnosis. The failures could not be reproduced locally on npm 10.9.4 or
 * 11.17.0, with a dirty tree or a clean `npm ci`, and both of those versions call
 * the *bulk* endpoint that npm's own deprecation notice points at, while CI's
 * npm 10.9.8 was calling the retiring one. Three explanations were tested and
 * none held. This handles the symptom honestly rather than guessing at a cause.
 */

import { spawnSync } from 'node:child_process';

/** Severities that fail the build, matching the old `--audit-level=moderate`. */
const BLOCKING = ['moderate', 'high', 'critical'] as const;

const ATTEMPTS = 3;
/** Backoff between attempts. The observed outages cleared within minutes. */
const BACKOFF_MS = [5_000, 20_000];

interface AuditReport {
  metadata?: { vulnerabilities?: Record<string, number> };
}

type Outcome =
  { kind: 'report'; counts: Record<string, number> } | { kind: 'unreachable'; detail: string };

/**
 * npm settings that say how to reach a registry, which the child must keep.
 *
 * Anything scoped to a host (`//registry.example/:_authToken`) is kept too, by
 * the `//` test below.
 */
const REGISTRY_CONFIG = new Set([
  'registry',
  'cache',
  'proxy',
  'https_proxy',
  'noproxy',
  'ca',
  'cafile',
  'strict_ssl',
  'userconfig',
  'globalconfig',
  'prefix',
]);

/**
 * The parent environment, minus the npm settings that describe how npm was
 * invoked rather than how to reach the registry.
 *
 * This runs under `npm run`, which exports the entire npm configuration as
 * `npm_config_*`, and a child `npm` reads those back as though they had been
 * given on its own command line. Some are not valid for `audit`: without this
 * the child died with `EALLOWSCRIPTS`, which this script then reported as the
 * registry not answering, correctly by its own rules and completely misleadingly.
 *
 * Dropping every `npm_config_*` was the first version and was too blunt: it also
 * removes the registry URL, proxy settings and auth tokens, so a private registry
 * or a corporate proxy would have turned into "the endpoint never answered".
 * Reaching the registry is exactly what this needs to keep working.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => {
      const lower = k.toLowerCase();
      if (!lower.startsWith('npm_config_')) return true;
      const setting = lower.slice('npm_config_'.length);
      return REGISTRY_CONFIG.has(setting) || setting.includes('//');
    }),
  );
}

function runAudit(args: string[]): Outcome {
  // `npm audit` exits non-zero for both outcomes, so the exit code is ignored on
  // purpose and the payload decides.
  // Windows needs a shell to run `npm.cmd` at all, and Node warns that a shell
  // concatenates arguments unescaped. Every argument here is a literal in this
  // file, so there is nothing to escape; CI is Linux and takes the direct path.
  const r = spawnSync('npm', ['audit', '--json', ...args], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
    env: cleanEnv(),
    cwd: process.env.STEGOSHARD_AUDIT_CWD ?? process.cwd(),
  });

  // A spawn that never started leaves stdout and stderr null rather than empty,
  // and an unguarded read of them turns a missing npm into a stack trace instead
  // of a diagnosis.
  if (r.error) return { kind: 'unreachable', detail: `could not run npm: ${r.error.message}` };

  let parsed: AuditReport | null;
  try {
    parsed = JSON.parse(r.stdout ?? '') as AuditReport;
  } catch {
    parsed = null;
  }

  const counts = parsed?.metadata?.vulnerabilities;
  if (counts) return { kind: 'report', counts };

  const fromStderr = (r.stderr ?? '').trim().split('\n').slice(-3).join(' ');
  const detail = (parsed as { message?: string } | null)?.message || fromStderr || 'no output';
  return { kind: 'unreachable', detail };
}

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Audit one dependency scope, retrying only an unreachable registry. */
function auditScope(label: string, args: string[]): void {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const out = runAudit(args);

    if (out.kind === 'report') {
      const blocking = BLOCKING.filter((s) => (out.counts[s] ?? 0) > 0);
      if (blocking.length === 0) {
        const total = out.counts.total ?? 0;
        console.log(`  ${label}: clean (${total} advisories, none at moderate or above)`);
        return;
      }
      const summary = blocking.map((s) => `${out.counts[s]} ${s}`).join(', ');
      console.error(`\n  ${label}: VULNERABLE (${summary})`);
      console.error('  Run `npm audit` for the detail. This is a real finding, not an outage.');
      process.exit(1);
    }

    console.error(`  ${label}: registry did not answer (attempt ${attempt}/${ATTEMPTS})`);
    console.error(`    ${out.detail.slice(0, 200)}`);
    if (attempt < ATTEMPTS) sleep(BACKOFF_MS[attempt - 1] ?? 20_000);
  }

  // Still fail. The point of the retries is to survive a blip, not to make the
  // absence of an answer acceptable.
  console.error(
    `\n  ${label}: the advisory endpoint never answered in ${ATTEMPTS} attempts.\n` +
      '  Nothing was audited, so this fails closed. If npm is having an incident,\n' +
      '  re-run once it passes rather than removing this gate.',
  );
  process.exit(1);
}

console.log('Auditing dependencies (advisories at moderate and above fail the build)');
auditScope('all dependencies', []);
auditScope('production only', ['--omit=dev']);
console.log('Audit clean.');
