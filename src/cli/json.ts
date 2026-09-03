/**
 * The machine-readable command line: `--json`.
 *
 * A script in any language should be able to drive StegoShard without parsing
 * prose that changes with the user's locale. So under `--json`:
 *
 *  - **stdout carries exactly one JSON document**, terminated by a newline, with
 *    nothing before or after it. `stegoshard estimate f --json | jq .` has to
 *    work with no framing library, which rules out NDJSON on stdout: it would
 *    force every consumer in every language to implement framing before reading
 *    one field.
 *  - **stderr carries newline-delimited events**: progress, and warnings. This is
 *    the split the CLI already had, results on stdout and chatter on stderr, so
 *    a human tailing the log still sees what is happening.
 *  - **a failure is also a document on stdout**, so a caller parses one stream
 *    rather than choosing between two depending on the outcome. The localized
 *    text still goes to stderr as an event.
 *
 * `code` is the contract and is never localized. `message` is the same human
 * string the terminal would have printed, and `locale` names its language, so a
 * caller never has to guess which one it got.
 *
 * The schema version moves independently of the on-disk format constants; see
 * docs/VERSIONING.md. Adding a field or a new code is additive and does not bump
 * it. Removing a field, retyping one, or changing what a code means bumps to /2.
 */

import { resolve } from 'node:path';
import { stegoErrorCode, stegoErrorDetails, type OnProgress } from '@core';
import { CliError, type CliFailure } from './errors';
import { StegoShardApiError } from '../api/errors';
import type { CliIo } from './io';
import { cliLocale } from './i18n';
// The result types are not imported: `Presenter` already declares each method's
// parameter, so they are inferred at the implementation and a second reference
// here would only be a second thing to keep in step.
import type { CliWarning, Presenter } from './present';

/** Envelope schema version. Not the on-disk format version (docs/VERSIONING.md). */
export const CLI_SCHEMA = 'stegoshard.cli/1';

/**
 * Stability of the whole machine interface, carried as a *value* rather than
 * implied by the schema version. Flipping it to 'stable' at 1.0 is then an
 * additive change a consumer can read, not a schema break.
 */
export type Stability = 'unstable' | 'stable';
const STABILITY: Stability = 'unstable';

export interface JsonError {
  /** Machine-stable. Union of the core, orchestration and CLI code spaces. */
  code: string;
  /** Localized, in `locale`. For humans reading a log, not for branching on. */
  message: string;
  details?: Record<string, string | number>;
}

export interface JsonEnvelope {
  schema: string;
  stability: Stability;
  ok: boolean;
  /** The subcommand, or null when there was not one (a bare or malformed call). */
  command: string | null;
  locale: string;
  result?: Record<string, unknown>;
  error?: JsonError;
}

/**
 * The code for anything thrown, across all three code spaces.
 *
 * Core errors describe the format and the crypto, `StegoShardApiError` describes
 * an unusable request, `CliError` describes the invocation. A caller sees one
 * `code` field; which space it came from is not something it should have to know.
 */
export function jsonErrorCode(err: unknown): string {
  return (
    stegoErrorCode(err) ??
    (err instanceof StegoShardApiError ? err.code : null) ??
    (err instanceof CliError ? err.code : null) ??
    'INTERNAL'
  );
}

function jsonErrorDetails(err: unknown): Record<string, string | number> | undefined {
  const core = stegoErrorDetails(err);
  if (core) return core;
  if (err instanceof StegoShardApiError) return err.params;
  return undefined;
}

/** Absolute paths in the envelope: a caller should not have to know our cwd. */
const abs = (paths: readonly string[]) => paths.map((p) => resolve(p));

function warningJson(w: CliWarning) {
  return w.details
    ? { code: w.code, message: w.message, details: w.details }
    : { code: w.code, message: w.message };
}

/**
 * Progress events, throttled.
 *
 * `OnProgress` fires per chunk on encrypt and decrypt, so a large binary save
 * would otherwise emit tens of thousands of stderr lines. Every phase change is
 * reported, plus at most one update per interval within a phase.
 */
const PROGRESS_INTERVAL_MS = 100;

/** Build the JSON presenter for one invocation of `command`. */
export function jsonPresenter(io: CliIo, command: string | null): Presenter {
  const warnings: ReturnType<typeof warningJson>[] = [];
  const locale = cliLocale(io.env);

  const event = (obj: Record<string, unknown>) => {
    io.err(`${JSON.stringify({ schema: CLI_SCHEMA, ...obj })}\n`);
  };

  const emit = (envelope: JsonEnvelope) => {
    io.out(`${JSON.stringify(envelope)}\n`);
  };

  const ok = (result: Record<string, unknown>) => {
    emit({
      schema: CLI_SCHEMA,
      stability: STABILITY,
      ok: true,
      command,
      locale,
      result: warnings.length > 0 ? { ...result, warnings } : result,
    });
  };

  return {
    warn(warning) {
      const w = warningJson(warning);
      warnings.push(w);
      event({ event: 'warning', ...w });
    },

    progress(quiet) {
      if (quiet) return { done: () => {} };
      let lastPhase = '';
      let lastAt = 0;
      const onProgress: OnProgress = (p) => {
        const now = Date.now();
        if (p.phase === lastPhase && now - lastAt < PROGRESS_INTERVAL_MS) return;
        lastPhase = p.phase;
        lastAt = now;
        // The raw phase name, not a localized label: this is the machine channel.
        event({ event: 'progress', phase: p.phase, done: p.done, total: p.total });
      };
      return { onProgress, done: () => {} };
    },

    save(res) {
      ok({
        files: abs(res.files),
        manifest: res.manifest.map((m) => ({ name: resolve(m.name), purpose: m.purpose })),
        imageCount: res.imageCount,
        // Empty on the binary paths, which mint no image set. Always present, so
        // a caller reads one shape rather than testing for the key.
        setId: res.setId,
        keyMode: res.keyMode,
        ...(res.binary ? { binary: res.binary } : {}),
        ...(res.effectiveLocale ? { effectiveLocale: res.effectiveLocale } : {}),
      });
    },

    restore(res) {
      ok({
        files: abs(res.files),
        outPath: resolve(res.outPath),
        filename: res.filename,
        seen: res.seen,
        decoded: res.decoded,
      });
    },

    gallerySave(res) {
      ok({
        files: abs(res.files),
        manifest: res.manifest.map((m) => ({ name: resolve(m.name), purpose: m.purpose })),
        k: res.k,
        m: res.m,
        decoys: res.decoys,
        setId: res.setId,
        keyMode: res.keyMode,
      });
    },

    galleryRestore(res) {
      ok({
        files: abs(res.files),
        outPath: resolve(res.outPath),
        filename: res.filename,
        seen: res.seen,
      });
    },

    estimate(res) {
      ok({ images: res.images, k: res.k, m: res.m });
    },

    failure(failure: CliFailure, err: unknown) {
      const code = jsonErrorCode(err);
      const details = jsonErrorDetails(err);
      // On stderr too, so a human tailing the log sees the same sentence the
      // terminal would have printed.
      event({ event: 'error', code, message: failure.message });
      emit({
        schema: CLI_SCHEMA,
        stability: STABILITY,
        ok: false,
        command,
        locale,
        error: details
          ? { code, message: failure.message, details }
          : { code, message: failure.message },
      });
    },
  };
}
