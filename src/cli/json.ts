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
import {
  DEFAULT_CALIBRATION,
  ProgressTracker,
  stegoErrorCode,
  stegoErrorDetails,
  toHex,
  type OnProgress,
} from '@core';
import { CliError, type CliFailure } from './errors';
import { StegoShardApiError } from '../api/errors';
import type { CliIo } from './io';
import { cliLocale } from './i18n';
import type { CliWarning, EstimateResult, Presenter } from './present';
import type {
  GalleryRestoreResult,
  GallerySaveResult,
  NormalizeCoversResult,
  RestoreResult,
  SaveResult,
} from '../api/node/commands';

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
 * reported, plus at most one update per interval within a phase, plus the event
 * that completes a phase. That last one is what carries `done === total` and,
 * with a plan, `fraction: 1`; dropping it because it landed within the interval
 * of the previous update left the stream ending at 0.969 whenever the last
 * images rendered quickly, which is a matter of timing, not of the save.
 */
const PROGRESS_INTERVAL_MS = 100;

// ---------------------------------------------------------------------------
// Result shapes
//
// Exported as pure functions rather than inlined into the presenter, because the
// MCP server returns the same objects over a different transport. One contract,
// two transports: a caller that has learned to read a `save` result off `--json`
// reads the identical thing out of `stegoshard_save`, and there is no second
// place for the shape to drift.
// ---------------------------------------------------------------------------

export function saveResultJson(res: SaveResult): Record<string, unknown> {
  return {
    files: abs(res.files),
    manifest: res.manifest.map((m) => ({ name: resolve(m.name), purpose: m.purpose })),
    imageCount: res.imageCount,
    // Empty on the binary paths, which mint no image set. Always present, so a
    // caller reads one shape rather than testing for the key.
    setId: res.setId,
    keyMode: res.keyMode,
    ...(res.binary ? { binary: res.binary } : {}),
    ...(res.effectiveLocale ? { effectiveLocale: res.effectiveLocale } : {}),
  };
}

export function restoreResultJson(res: RestoreResult): Record<string, unknown> {
  return {
    files: abs(res.files),
    outPath: resolve(res.outPath),
    filename: res.filename,
    seen: res.seen,
    decoded: res.decoded,
    // Present only when the vault was saved with `--export-number`. The human
    // surface prints this as `tag 3f8a1c02 · export #4`, and a scripted caller
    // had to scrape that line out of `notes[]` to get at it. Since nothing
    // compares the number for you, a caller that wants to act on it needs it as
    // a value. Additive, so the `stegoshard.cli/1` schema does not move.
    //
    // `tag` rather than `vaultId`: it is fresh per export and identifies this
    // artifact, not the vault. A consumer that correlates on it is reading it
    // wrong, and the field name is the cheapest place to say so.
    ...(res.identity ? { export: res.identity.sequence, tag: toHex(res.identity.vaultId) } : {}),
  };
}

export function gallerySaveResultJson(res: GallerySaveResult): Record<string, unknown> {
  return {
    files: abs(res.files),
    manifest: res.manifest.map((m) => ({ name: resolve(m.name), purpose: m.purpose })),
    k: res.k,
    m: res.m,
    decoys: res.decoys,
    setId: res.setId,
    keyMode: res.keyMode,
    // Uniformity is the security property of the set (SPEC §9.7), and a caller
    // driving gallery-save from a script has no other way to see whether the
    // photos it just wrote achieved it.
    provenance: res.provenance,
  };
}

/**
 * The normalization document.
 *
 * Carries the whole inventory, because the point of `--report --json` is to be
 * the input to a policy decision that has not been made yet (SPEC §9.7 removes
 * manifests; what to do about XMP and EXIF identifiers is answered by reading
 * this over real photos). `uniform` is the one field a script should branch on.
 *
 * `profile.exif` deliberately carries make/model/software/timestamp as values
 * and the serial numbers only as flags: see `ExifFindings` in
 * `src/core/normalize.ts` for why a report must not copy an identifier out of
 * the file it is warning about.
 */
export function normalizeResultJson(res: NormalizeCoversResult): Record<string, unknown> {
  return {
    files: abs(res.files),
    manifest: res.manifest.map((m) => ({ name: resolve(m.name), purpose: m.purpose })),
    uniform: res.set.uniform,
    report: res.report,
    removed: res.removed,
    skipped: res.skipped,
    covers: res.covers.map((c) => ({
      input: resolve(c.input),
      name: c.name,
      kind: c.kind,
      removed: c.removed,
      ...(c.output ? { output: resolve(c.output) } : {}),
      ...(c.problem ? { problem: c.problem } : {}),
      ...(c.profile ? { profile: c.profile } : {}),
    })),
    set: {
      common: res.set.common,
      divergent: res.set.divergent,
      withManifest: res.set.withManifest,
      trailerKinds: res.set.trailerKinds,
      unparsed: res.set.unparsed,
    },
  };
}

export function galleryRestoreResultJson(res: GalleryRestoreResult): Record<string, unknown> {
  return {
    files: abs(res.files),
    outPath: resolve(res.outPath),
    filename: res.filename,
    seen: res.seen,
  };
}

export function estimateResultJson(res: EstimateResult): Record<string, unknown> {
  return { images: res.images, k: res.k, m: res.m };
}

/** Build the JSON presenter for one invocation of `command`. */
export function jsonPresenter(io: CliIo, command: string | null): Presenter {
  const warnings: ReturnType<typeof warningJson>[] = [];
  const notes: string[] = [];
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
      result: {
        ...result,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(notes.length > 0 ? { notes } : {}),
      },
    });
  };

  return {
    warn(warning) {
      const w = warningJson(warning);
      warnings.push(w);
      event({ event: 'warning', ...w });
    },

    note(text) {
      notes.push(text);
      event({ event: 'note', text });
    },

    progress(quiet, stages) {
      if (quiet) return { done: () => {} };
      // With a plan, each event also carries `fraction` (0..1, of the whole
      // operation, weighted by time and never decreasing) and `stage` (the stage's
      // label). Additive: the fields `stegoshard.cli/1` always had are unchanged.
      const tracker =
        stages && stages.length > 0
          ? new ProgressTracker(stages, DEFAULT_CALIBRATION, () => Date.now())
          : undefined;
      let lastKey = '';
      let lastAt = 0;
      const onProgress: OnProgress = (p) => {
        const view = tracker?.onEvent(p);
        const key = view ? `${p.phase}:${view.label}` : p.phase;
        const now = Date.now();
        const completes = p.total > 0 && p.done >= p.total;
        if (!completes && key === lastKey && now - lastAt < PROGRESS_INTERVAL_MS) return;
        lastKey = key;
        lastAt = now;
        // The raw phase name, not a localized label: this is the machine channel.
        const base = { event: 'progress', phase: p.phase, done: p.done, total: p.total };
        event(
          view
            ? { ...base, fraction: Math.round(view.fraction * 1000) / 1000, stage: view.label }
            : base,
        );
      };
      return { onProgress, done: () => {} };
    },

    save(res) {
      ok(saveResultJson(res));
    },

    restore(res) {
      ok(restoreResultJson(res));
    },

    gallerySave(res) {
      ok(gallerySaveResultJson(res));
    },

    galleryRestore(res) {
      ok(galleryRestoreResultJson(res));
    },

    estimate(res) {
      ok(estimateResultJson(res));
    },

    normalize(res) {
      ok(normalizeResultJson(res));
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
