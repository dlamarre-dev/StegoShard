/**
 * Coded errors for the orchestration layer.
 *
 * The save/restore orchestration used to throw `new Error(t('errSomething'))`,
 * which is correct for a terminal and wrong for anything else. `src/cli/i18n`
 * resolves the catalog from `STEGOSHARD_LANG` or the system locale into a
 * module-global on first use, so a library consumer on a fr-CA machine would get
 * French `Error.message` strings, and a machine reader would have to pattern-match
 * localized prose to find out what went wrong.
 *
 * So the orchestration throws `StegoShardApiError` with a stable `code` and a
 * stable English message, and the CLI translates on the way out: `main.ts` maps
 * `code` back to its catalog key, so terminal output stays localized with no
 * catalog changes at all.
 *
 * These codes sit beside `StegoErrorCode` from `src/core/errors.ts` rather than
 * inside it: core's codes describe format and crypto failures, these describe an
 * unusable combination of *request options*. Both are surfaced under one `code`
 * field by the CLI and MCP envelopes.
 */

/** Machine-stable identifier for an unusable save/restore request. */
export type ApiErrorCode =
  /** An output path exists and the caller did not pass `force`. */
  | 'OUTPUT_EXISTS'
  /** `keyMode: 'stego'` without a cover image to hide the key in. */
  | 'STEGO_NEEDS_COVER'
  /** Duress mode without the decoy payload that opens under the second password. */
  | 'DURESS_DECOY_REQUIRED'
  /** Duress mode without the second, independent password. */
  | 'DURESS_PASSWORD_REQUIRED'
  /** Non-possession mode without a `k`-of-`n` threshold. */
  | 'THRESHOLD_REQUIRED'
  /** An access mode was asked for on a path that cannot carry one. */
  | 'MODE_NEEDS_DISGUISE'
  /** A save was handed no readable input files. */
  | 'NO_INPUT_FILES'
  /** A restore found no image it could decode among its inputs. */
  | 'NO_READABLE_IMAGES'
  /** A gallery save found no usable cover photos. */
  | 'NO_COVERS_FOUND'
  /** A gallery restore was handed no images to scan. */
  | 'NO_GALLERY_IMAGES';

/** Substitutions the CLI needs to render this code in the user's language. */
export type ApiErrorParams = Record<string, string | number>;

/**
 * An unusable request, named by a code rather than by prose.
 *
 * `message` is deliberately English and deliberately terse: it is a developer-
 * facing fallback for whoever logs the raw error. Anything user-facing should key
 * on `code` and render its own text, which is what `src/cli/main.ts` does.
 */
export class StegoShardApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly params?: ApiErrorParams,
  ) {
    super(message);
    this.name = 'StegoShardApiError';
  }
}

/** Every code, sorted. Lets a caller enumerate them, and a test check coverage. */
export const API_ERROR_CODES: readonly ApiErrorCode[] = [
  'DURESS_DECOY_REQUIRED',
  'DURESS_PASSWORD_REQUIRED',
  'MODE_NEEDS_DISGUISE',
  'NO_COVERS_FOUND',
  'NO_GALLERY_IMAGES',
  'NO_INPUT_FILES',
  'NO_READABLE_IMAGES',
  'OUTPUT_EXISTS',
  'STEGO_NEEDS_COVER',
  'THRESHOLD_REQUIRED',
];
