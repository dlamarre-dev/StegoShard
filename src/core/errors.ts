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
import { CredentialsNotIndependentError } from './access';
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
}

/** Row builder: keeps each table entry to one readable line. */
function row(
  ctor: CodeRow['ctor'],
  name: string,
  code: StegoErrorCode,
  ...fields: string[]
): CodeRow {
  return { ctor, name, code, fields };
}

/**
 * One row per exported core error class. None of them subclass each other (they
 * all extend Error directly), so the `instanceof` scan below needs no ordering
 * rule; `errors.test.ts` asserts that stays true, and that every core error class
 * reachable from the barrel appears here.
 */
const TABLE: readonly CodeRow[] = [
  row(BucketTooLargeError, 'BucketTooLargeError', 'BUCKET_TOO_LARGE', 'needed', 'limit'),
  row(
    CredentialsNotIndependentError,
    'CredentialsNotIndependentError',
    'CREDENTIALS_NOT_INDEPENDENT',
    'reason',
  ),
  row(FileTooLargeError, 'FileTooLargeError', 'FILE_TOO_LARGE', 'size', 'limit'),
  row(
    GalleryCoverCapacityError,
    'GalleryCoverCapacityError',
    'GALLERY_COVER_CAPACITY',
    'coverName',
    'capacityBits',
    'neededBits',
  ),
  row(
    GalleryFileTooLargeError,
    'GalleryFileTooLargeError',
    'GALLERY_FILE_TOO_LARGE',
    'size',
    'limit',
  ),
  row(GalleryRestoreError, 'GalleryRestoreError', 'GALLERY_RESTORE_FAILED'),
  row(
    GalleryTooFewImagesError,
    'GalleryTooFewImagesError',
    'GALLERY_TOO_FEW_IMAGES',
    'provided',
    'needed',
  ),
  row(
    GalleryTooManyImagesError,
    'GalleryTooManyImagesError',
    'GALLERY_TOO_MANY_IMAGES',
    'provided',
    'limit',
  ),
  row(JpegUnsupportedError, 'JpegUnsupportedError', 'JPEG_UNSUPPORTED'),
  row(MissingKeyError, 'MissingKeyError', 'MISSING_KEY'),
  row(SegmentedFormatError, 'SegmentedFormatError', 'SEGMENTED_FORMAT'),
  row(ShareChecksumError, 'ShareChecksumError', 'SHARE_CHECKSUM'),
  row(ShareSetError, 'ShareSetError', 'SHARE_SET'),
  row(StegoCapacityError, 'StegoCapacityError', 'STEGO_CAPACITY', 'capacityBits'),
  row(StegoCoverFormatError, 'StegoCoverFormatError', 'STEGO_COVER_FORMAT'),
  row(TooManyFilesError, 'TooManyFilesError', 'TOO_MANY_FILES', 'count', 'limit'),
  row(TooManyImagesError, 'TooManyImagesError', 'TOO_MANY_IMAGES', 'count', 'limit'),
  row(VerificationError, 'VerificationError', 'VERIFICATION_FAILED'),
  row(WrongPasswordError, 'WrongPasswordError', 'WRONG_PASSWORD'),
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
