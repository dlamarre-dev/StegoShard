/**
 * Machine-stable codes for the core's typed errors.
 *
 * Every surface that has to describe a failure to something other than a human
 * needs one name for it that never changes: the CLI's `--json` envelope, the MCP
 * tool results, and the published library. Localized message text cannot serve
 * that purpose, and neither can the class name, which is a refactoring hazard.
 *
 * Two invariants this file deliberately preserves:
 *
 *  - `GalleryRestoreError` gets ONE code. "Wrong password" and "these photos hold
 *    no gallery" are indistinguishable by design (see gallery.ts), and splitting
 *    the code would rebuild the oracle the format removes.
 *  - The SPEC §10 deniable paths surface `WRONG_PASSWORD`, never anything
 *    mode-specific or region-specific. A code that revealed which region or which
 *    credential matched would defeat the access structures.
 *
 * The `details` a code carries are only ever values already present verbatim in
 * that class's English `Error.message`, so adding codes discloses nothing the CLI
 * does not already print.
 */

import { WrongPasswordError } from './crypto';
import {
  GalleryCoverCapacityError,
  GalleryFileTooLargeError,
  GalleryRestoreError,
  GalleryTooFewImagesError,
  GalleryTooManyImagesError,
} from './gallery';
import { CredentialsNotIndependentError, type CredentialRelation } from './access';
import { BucketTooLargeError } from './buckets';
import { JpegUnsupportedError } from './jpeg-coeff';
import { SegmentedFormatError } from './segmented';
import { ShareChecksumError, ShareSetError } from './shamir';
import { StegoCapacityError, StegoCoverFormatError } from './stego';
import {
  FileTooLargeError,
  MissingKeyError,
  TooManyFilesError,
  TooManyImagesError,
  VerificationError,
} from './vault';

/** Machine-stable failure identifier. Never localized, never reused. */
export type StegoErrorCode =
  | 'BUCKET_TOO_LARGE'
  | 'CREDENTIALS_NOT_INDEPENDENT'
  | 'FILE_TOO_LARGE'
  | 'GALLERY_COVER_CAPACITY'
  | 'GALLERY_FILE_TOO_LARGE'
  | 'GALLERY_RESTORE_FAILED'
  | 'GALLERY_TOO_FEW_IMAGES'
  | 'GALLERY_TOO_MANY_IMAGES'
  | 'JPEG_UNSUPPORTED'
  | 'MISSING_KEY'
  | 'SEGMENTED_FORMAT'
  | 'SHARE_CHECKSUM'
  | 'SHARE_SET'
  | 'STEGO_CAPACITY'
  | 'STEGO_COVER_FORMAT'
  | 'TOO_MANY_FILES'
  | 'TOO_MANY_IMAGES'
  | 'VERIFICATION_FAILED'
  | 'WRONG_PASSWORD';

interface CodeRow {
  /** The class itself, for an in-realm `instanceof` match. */
  readonly ctor: new (...args: never[]) => Error;
  /**
   * The literal each constructor assigns to `this.name`. Kept beside the class
   * rather than read off `ctor.name` so minification cannot break the lookup,
   * and so the pair can be asserted in a test.
   */
  readonly name: string;
  readonly code: StegoErrorCode;
  /**
   * Readonly fields to surface as `details`, in order. Read defensively: an
   * error that crossed a Worker boundary may arrive without them.
   */
  readonly fields: readonly string[];
  /**
   * Rebuild this error from a serialized form. See {@link stegoErrorFromWire}.
   *
   * Returns null when the payload cannot produce a faithful instance, so the
   * caller degrades to a plain named `Error` rather than fabricating one with
   * zeroes where the numbers should be.
   */
  readonly revive: (message: string, details: WireDetails) => Error | null;
}

type WireDetails = Record<string, string | number> | undefined;

/** A `details` entry as a number, or undefined when it is missing or not one. */
const num = (d: WireDetails, key: string): number | undefined =>
  typeof d?.[key] === 'number' ? (d[key] as number) : undefined;

/** A `details` entry as a string, likewise. */
const str = (d: WireDetails, key: string): string | undefined =>
  typeof d?.[key] === 'string' ? (d[key] as string) : undefined;

/**
 * Strip a constructor's own prefix back off a message.
 *
 * Three classes take a free-form string their constructor then wraps
 * (`segmented vault: …`). The wrapped form is what crosses the wire, so the
 * argument has to be recovered to rebuild an instance whose message matches the
 * original exactly. A round-trip test over every class holds that.
 */
const unprefix = (message: string, prefix: string): string =>
  message.startsWith(prefix) ? message.slice(prefix.length) : message;

/** Row builder: keeps each table entry to one readable line. */
function row(
  ctor: CodeRow['ctor'],
  name: string,
  code: StegoErrorCode,
  revive: CodeRow['revive'],
  ...fields: string[]
): CodeRow {
  return { ctor, name, code, revive, fields };
}

/** For the nine classes whose constructor takes nothing. */
const nullary = (make: () => Error) => (): Error => make();

/**
 * One row per exported core error class. None of them subclass each other (they
 * all extend Error directly), so the `instanceof` scan below needs no ordering
 * rule; `errors.test.ts` asserts that stays true, and that every core error class
 * reachable from the barrel appears here.
 */
const TABLE: readonly CodeRow[] = [
  row(
    BucketTooLargeError,
    'BucketTooLargeError',
    'BUCKET_TOO_LARGE',
    (_m, d) => {
      const x = num(d, 'needed');
      const y = num(d, 'limit');
      return x === undefined || y === undefined ? null : new BucketTooLargeError(x, y);
    },
    'needed',
    'limit',
  ),
  row(
    CredentialsNotIndependentError,
    'CredentialsNotIndependentError',
    'CREDENTIALS_NOT_INDEPENDENT',
    (_m, d) => {
      const reason = str(d, 'reason');
      return reason === undefined
        ? null
        : new CredentialsNotIndependentError(reason as CredentialRelation);
    },
    'reason',
  ),
  row(
    FileTooLargeError,
    'FileTooLargeError',
    'FILE_TOO_LARGE',
    (_m, d) => {
      const x = num(d, 'size');
      const y = num(d, 'limit');
      return x === undefined || y === undefined ? null : new FileTooLargeError(x, y);
    },
    'size',
    'limit',
  ),
  row(
    GalleryCoverCapacityError,
    'GalleryCoverCapacityError',
    'GALLERY_COVER_CAPACITY',
    (_m, d) => {
      const name = str(d, 'coverName');
      const capacity = num(d, 'capacityBits');
      const needed = num(d, 'neededBits');
      return name === undefined || capacity === undefined || needed === undefined
        ? null
        : new GalleryCoverCapacityError(name, capacity, needed);
    },
    'coverName',
    'capacityBits',
    'neededBits',
  ),
  row(
    GalleryFileTooLargeError,
    'GalleryFileTooLargeError',
    'GALLERY_FILE_TOO_LARGE',
    (_m, d) => {
      const x = num(d, 'size');
      const y = num(d, 'limit');
      return x === undefined || y === undefined ? null : new GalleryFileTooLargeError(x, y);
    },
    'size',
    'limit',
  ),
  row(
    GalleryRestoreError,
    'GalleryRestoreError',
    'GALLERY_RESTORE_FAILED',
    nullary(() => new GalleryRestoreError()),
  ),
  row(
    GalleryTooFewImagesError,
    'GalleryTooFewImagesError',
    'GALLERY_TOO_FEW_IMAGES',
    (_m, d) => {
      const x = num(d, 'provided');
      const y = num(d, 'needed');
      return x === undefined || y === undefined ? null : new GalleryTooFewImagesError(x, y);
    },
    'provided',
    'needed',
  ),
  row(
    GalleryTooManyImagesError,
    'GalleryTooManyImagesError',
    'GALLERY_TOO_MANY_IMAGES',
    (_m, d) => {
      const x = num(d, 'provided');
      const y = num(d, 'limit');
      return x === undefined || y === undefined ? null : new GalleryTooManyImagesError(x, y);
    },
    'provided',
    'limit',
  ),
  // The constructor wraps its argument, so the argument is recovered from the
  // wrapped message rather than carried separately.
  row(
    JpegUnsupportedError,
    'JpegUnsupportedError',
    'JPEG_UNSUPPORTED',
    (m) => new JpegUnsupportedError(unprefix(m, 'unsupported JPEG: ')),
  ),
  row(
    MissingKeyError,
    'MissingKeyError',
    'MISSING_KEY',
    nullary(() => new MissingKeyError()),
  ),
  row(
    SegmentedFormatError,
    'SegmentedFormatError',
    'SEGMENTED_FORMAT',
    (m) => new SegmentedFormatError(unprefix(m, 'segmented vault: ')),
  ),
  row(
    ShareChecksumError,
    'ShareChecksumError',
    'SHARE_CHECKSUM',
    nullary(() => new ShareChecksumError()),
  ),
  // Passes its argument through unwrapped, so the message *is* the argument.
  row(ShareSetError, 'ShareSetError', 'SHARE_SET', (m) => new ShareSetError(m)),
  row(
    StegoCapacityError,
    'StegoCapacityError',
    'STEGO_CAPACITY',
    (_m, d) => {
      const bits = num(d, 'capacityBits');
      return bits === undefined ? null : new StegoCapacityError(bits);
    },
    'capacityBits',
  ),
  row(
    StegoCoverFormatError,
    'StegoCoverFormatError',
    'STEGO_COVER_FORMAT',
    nullary(() => new StegoCoverFormatError()),
  ),
  row(
    TooManyFilesError,
    'TooManyFilesError',
    'TOO_MANY_FILES',
    (_m, d) => {
      const x = num(d, 'count');
      const y = num(d, 'limit');
      return x === undefined || y === undefined ? null : new TooManyFilesError(x, y);
    },
    'count',
    'limit',
  ),
  row(
    TooManyImagesError,
    'TooManyImagesError',
    'TOO_MANY_IMAGES',
    (_m, d) => {
      const x = num(d, 'count');
      const y = num(d, 'limit');
      return x === undefined || y === undefined ? null : new TooManyImagesError(x, y);
    },
    'count',
    'limit',
  ),
  row(
    VerificationError,
    'VerificationError',
    'VERIFICATION_FAILED',
    nullary(() => new VerificationError()),
  ),
  row(
    WrongPasswordError,
    'WrongPasswordError',
    'WRONG_PASSWORD',
    nullary(() => new WrongPasswordError()),
  ),
];

/** Every code this module can return, sorted. Lets a caller enumerate them. */
export const STEGO_ERROR_CODES: readonly StegoErrorCode[] = TABLE.map((r) => r.code)
  .slice()
  .sort();

function rowFor(err: Error): CodeRow | null {
  // `instanceof` first: exact, and unaffected by a subclass adding its own name.
  for (const row of TABLE) if (err instanceof row.ctor) return row;
  // Then the assigned name. `src/ui/run-in-worker.ts` rebuilds only five of these
  // classes for real and hands back a plain Error carrying the right name for the
  // rest, so without this fallback a Worker-crossed failure would be uncodeable.
  for (const row of TABLE) if (err.name === row.name) return row;
  return null;
}

/**
 * The stable code for a core error, or null for anything this module does not
 * classify (a bare Error, a TypeError, a non-Error throw). A caller maps null to
 * its own generic code rather than inventing one here.
 */
export function stegoErrorCode(err: unknown): StegoErrorCode | null {
  if (!(err instanceof Error)) return null;
  return rowFor(err)?.code ?? null;
}

/**
 * The numbers and names a core error carries, for a machine reader that should
 * not have to parse the message. Returns undefined when there are none, so an
 * envelope can omit the key rather than carry an empty object.
 */
export function stegoErrorDetails(err: unknown): Record<string, string | number> | undefined {
  if (!(err instanceof Error)) return undefined;
  const row = rowFor(err);
  if (!row || row.fields.length === 0) return undefined;
  const bag = err as unknown as Record<string, unknown>;
  const out: Record<string, string | number> = {};
  for (const field of row.fields) {
    const value = bag[field];
    if (typeof value === 'string' || typeof value === 'number') out[field] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Crossing a structured-clone boundary
//
// An `Error` does not survive `postMessage` as itself: the browser clones the
// name and message and drops the class, so `instanceof` fails on the far side.
// The pipeline worker used to hand back a payload the main thread rebuilt with a
// switch over five of the nineteen classes, which meant the other fourteen
// arrived as plain `Error`s carrying only the right `name`. Tolerable, because
// `stegoErrorCode` falls back to that name, but it meant a `catch (e) { if (e
// instanceof GalleryRestoreError) }` on the main thread silently never matched.
//
// The class, its name and its fields are already described by TABLE, so the
// serialization belongs here too rather than in the UI layer, where it would be a
// second list to keep in step.
// ---------------------------------------------------------------------------

/** A core error, flattened into something `structuredClone` can carry. */
export interface StegoErrorWire {
  name: string;
  message: string;
  details?: Record<string, string | number>;
}

/** Flatten any thrown value for transport. */
export function stegoErrorToWire(err: unknown): StegoErrorWire {
  const e = err instanceof Error ? err : new Error(String(err));
  const details = stegoErrorDetails(e);
  return details
    ? { name: e.name, message: e.message, details }
    : { name: e.name, message: e.message };
}

/**
 * Rebuild an error from {@link stegoErrorToWire}, restoring its class.
 *
 * Falls back to a plain `Error` carrying the original `name` for anything this
 * module does not know, and for a known name whose payload cannot produce a
 * faithful instance. That is the same shape the old hand-written path produced,
 * so a truncated or hostile payload degrades rather than yielding an error whose
 * fields are quietly wrong.
 */
export function stegoErrorFromWire(wire: unknown): Error {
  const w = (typeof wire === 'object' && wire !== null ? wire : {}) as Partial<StegoErrorWire>;
  const name = typeof w.name === 'string' ? w.name : 'Error';
  const message = typeof w.message === 'string' ? w.message : 'unknown error';
  const details =
    typeof w.details === 'object' && w.details !== null
      ? (w.details as Record<string, string | number>)
      : undefined;

  const row = TABLE.find((r) => r.name === name);
  const revived = row?.revive(message, details) ?? null;
  if (revived) return revived;
  return Object.assign(new Error(message), { name });
}
