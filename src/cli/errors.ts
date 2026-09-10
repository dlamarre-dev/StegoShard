/**
 * Command-line failures, and how every error becomes something to print.
 *
 * `run()` used to call a `fail()` that wrote to stderr and called
 * `process.exit`, which meant no test could drive the argument layer: the first
 * bad flag took the test runner down with it. `fail()` now throws a `CliError`
 * and the bootstrap in `main.ts` is the only thing that exits.
 *
 * `toCliFailure` is the single place that turns any thrown value into a message
 * and an exit code. It is shared rather than inlined in the bootstrap because
 * the `--json` envelope needs exactly the same classification, differing only in
 * how it renders the result.
 */

import {
  CredentialsNotIndependentError,
  GalleryRestoreError,
  MissingKeyError,
  WrongPasswordError,
} from '../core';
import { type ApiErrorCode, StegoShardApiError } from '../api/errors';
import { t, type CliKey } from './i18n';

/**
 * Why a command could not run. Coarser than the core's codes on purpose: these
 * describe the *invocation*, and most of them are the same class of mistake, a
 * flag combination that cannot mean anything.
 */
export type CliErrorCode =
  /** A malformed, missing, or contradictory argument. */
  | 'USAGE'
  /** No password from any source, or an empty one. */
  | 'PASSWORD_REQUIRED'
  /** Below the hard length floor, which no flag can waive. */
  | 'PASSWORD_TOO_SHORT'
  /** Above the floor but weak, and not acknowledged. */
  | 'PASSWORD_WEAK'
  /** An unusable `--entropy*` combination or an unreadable entropy file. */
  | 'ENTROPY_ARG'
  /** `stegoshard ui` has no web bundle to serve. */
  | 'UI_UNAVAILABLE'
  /**
   * `--track` was combined with a deniable destination. Refused loudly rather
   * than ignored: silently doing nothing would leave the user believing they had
   * rollback protection on the one path where believing anything extra is the
   * mistake.
   */
  | 'TRACKING_NOT_DENIABLE'
  /**
   * `--track` was asked for but cannot be honoured: an empty label, a command
   * that does not record anything, or a known-vaults file that could not be
   * read. Same reasoning as above — the one thing not to do is proceed quietly
   * and let the user believe the numbering happened.
   */
  | 'TRACKING_UNAVAILABLE'
  /** Anything not classified above. */
  | 'INTERNAL';

/** A failure the command line raised itself, carrying its localized message. */
export class CliError extends Error {
  constructor(
    readonly code: CliErrorCode,
    message: string,
    /** Process exit code. 1 unless a caller has a reason to differ. */
    readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/**
 * Catalog key per orchestration error code.
 *
 * The orchestration layer throws stable English so a library or MCP caller gets
 * a locale-free `code`; the terminal is the one surface that should answer in the
 * user's language, so the translation happens here, at the edge. `Record` over
 * `ApiErrorCode` makes a new code without a message a build error, and every key
 * below is the one that code's `throw` used to pass to `t()` directly, so the
 * printed text is unchanged in all nine languages.
 */
const API_ERROR_KEY: Record<ApiErrorCode, CliKey> = {
  OUTPUT_EXISTS: 'errOverwrite',
  STEGO_NEEDS_COVER: 'errStegoNeedsCover',
  DURESS_DECOY_REQUIRED: 'errSaveDuressDecoy',
  DURESS_PASSWORD_REQUIRED: 'errDuressNeedsPassword',
  THRESHOLD_REQUIRED: 'errSaveThreshold',
  MODE_NEEDS_DISGUISE: 'errModeNeedsDisguise',
  NO_INPUT_FILES: 'errNoInputFiles',
  NO_READABLE_IMAGES: 'errNoReadableImages',
  NO_COVERS_FOUND: 'errNoCoversFound',
  NO_GALLERY_IMAGES: 'errNoGalleryImages',
};

/** What to print for a thrown value, and what to exit with. */
export interface CliFailure {
  message: string;
  exitCode: number;
}

/**
 * Classify anything thrown out of `run()`.
 *
 * The order matters only in that `CliError` carries its own exit code; the rest
 * are disjoint types. `GalleryRestoreError` keeps one message covering both
 * "wrong password" and "no gallery here", because the format deliberately cannot
 * tell them apart and the CLI must not appear to.
 */
export function toCliFailure(err: unknown): CliFailure {
  if (err instanceof CliError) return { message: err.message, exitCode: err.exitCode };
  if (err instanceof StegoShardApiError) {
    return { message: t(API_ERROR_KEY[err.code], err.params ?? {}), exitCode: 1 };
  }
  if (err instanceof WrongPasswordError) return { message: t('errWrongPassword'), exitCode: 1 };
  if (err instanceof GalleryRestoreError) return { message: t('errNoGallery'), exitCode: 1 };
  if (err instanceof MissingKeyError) return { message: t('errNeedsKey'), exitCode: 1 };
  if (err instanceof CredentialsNotIndependentError) {
    return { message: t('errDuressTooSimilar', { reason: err.reason }), exitCode: 1 };
  }
  return { message: err instanceof Error ? err.message : String(err), exitCode: 1 };
}
