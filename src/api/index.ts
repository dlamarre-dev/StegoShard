/**
 * StegoShard's public API: the environment-neutral half.
 *
 * Everything here runs anywhere WebCrypto does, in Node or a browser or a
 * worker. It takes and returns bytes, never touches the filesystem, and models
 * an image as {@link ImageDataLike} rather than the DOM's `ImageData`. Node
 * consumers who want files handled for them import `stegoshard/node` instead;
 * the two entry points are disjoint on purpose, so which one you get is visible
 * in the import rather than decided by a resolver condition.
 *
 * **This is a curated facade, not the internal barrel.** `src/core/index.ts`
 * re-exports 255 names, including the erasure-coding matrices, the Galois field,
 * the SPEC §10 slot layer, the region geometry, and a bare `decode`/`encode` pair
 * that means "JPEG coefficient model". Publishing that would freeze all of it and
 * make every internal rename a breaking change. What is here is what a consumer
 * needs to save and restore a vault; what is not is listed in docs/API.md so
 * nobody reaches for a deep import expecting support.
 *
 * **Status: unstable.** See docs/API.md. Any 0.9.z may reshape this; pin an exact
 * version. Exposing it makes no new security claim: the properties and their
 * limits are exactly those in docs/THREAT-MODEL.md and docs/CLAIMS.md.
 *
 * Three things a consumer should read before building on it:
 *
 *  - **Post-save verification is not optional.** `save()` in the Node entry always
 *    decrypts what it wrote and compares it to the original before returning. If
 *    you build a pipeline out of `exportVault` instead, you must call the matching
 *    `verify*Export` yourself; a vault that never round-tripped is a vault you
 *    cannot know is recoverable.
 *  - **The user-entropy layer is process-global.** See {@link installUserEntropy}.
 *  - **Passwords are ordinary JavaScript strings** and cannot be wiped from
 *    memory. That limitation is documented in SECURITY.md and applies here too.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  /** Argon2id cost parameters. */
  Argon2Params,
  /** `'branded'` (.ssbn) or `'disguised'` (.db). */
  BinaryVariant,
  BrandBandInput,
  BrandCaptionInput,
  /** An image codec: capacity, encode, decode. */
  Codec,
  /** How independent a duress credential is from the real one. */
  CredentialCheck,
  CredentialRelation,
  ExportOptions,
  ExportResult,
  /** What each produced file is for. */
  FilePurpose,
  GalleryCover,
  GalleryDecodeOptions,
  GalleryEncodeOptions,
  GalleryEncodeResult,
  GalleryImage,
  /** The self-describing per-image header (SPEC §3). */
  Header,
  /** An image as plain bytes: no DOM required. */
  ImageDataLike,
  /** A parsed key block. Serialize it before it travels. */
  KeyBlock,
  /** `'embedded'` | `'keyfile'` | `'stego'`. */
  KeyMode,
  ManifestEntry,
  OnProgress,
  Progress,
  ShareTextStyle,
  /** Machine-stable failure identifier; see {@link stegoErrorCode}. */
  StegoErrorCode,
  /** A DEK plus the serialized key block that unlocks it. */
  VaultKey,
} from '../core';

export type { ApiErrorCode, ApiErrorParams } from './errors';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export {
  // Key derivation. Frozen: see the note on the constant itself.
  DEFAULT_ARGON2,
  KEY_BLOCK_LEN,
  KEY_FACTOR_LEN,
  // Rendering profiles and codecs (SPEC §2).
  PROFILE_DISK,
  PROFILE_CLOUD,
  PROFILE_PAPER,
  CODEC_QR_GRID,
  CODEC_COLOR_GRID,
  // Format versions (docs/VERSIONING.md).
  FORMAT_VERSION,
  BINARY_VERSION,
  // Size ceilings. The image path is hard-capped at MAX_FILE_BYTES and is not
  // configurable; the binary path's ceiling is the caller's choice.
  MAX_FILE_BYTES,
  WARN_FILE_BYTES,
  MAX_IMAGES,
  MAX_FILE_BYTES_BINARY_CLI,
  MAX_FILE_BYTES_BINARY_UI,
  // Gallery Mode (SPEC §9).
  GALLERY_MIN_IMAGES,
  GALLERY_MAX_IMAGES,
  GALLERY_MIN_DECOYS,
  // Threshold shares (SPEC §10.6).
  SHARE_LEN,
  SECRET_LEN,
} from '../core';

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export { createVaultKey } from './keys';
export {
  createKeyBlock,
  serializeKeyBlock,
  parseKeyBlock,
  isSerializedKeyBlock,
  unlockKeyBlock,
  normalizePassword,
} from '../core';

// ---------------------------------------------------------------------------
// Optional user entropy (generation-side only)
// ---------------------------------------------------------------------------

/**
 * These three are **process-global**, not per-call: `installUserEntropy` first
 * clears any existing layer, so a second install silently replaces the first and
 * the earlier caller's draws fall back to the plain CSPRNG with nothing thrown.
 *
 * Install once at startup if at all. Never per request, and never in a
 * multi-tenant or concurrent server. There is deliberately no
 * `withUserEntropy(text, fn)` helper here: it would advertise a scoping guarantee
 * the module-global cannot actually provide.
 */
export { installUserEntropy, clearUserEntropy, hasUserEntropy } from '../core';

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

export { estimateImages, estimateGalleryCovers } from '../core';

// ---------------------------------------------------------------------------
// The image path
// ---------------------------------------------------------------------------

export {
  exportVault,
  importVault,
  /** Mandatory if you build a pipeline out of `exportVault` yourself. */
  verifyImageExport,
  getCodec,
  codecName,
  decodeWithAnyCodec,
  decodeHeader,
  drawBrandBand,
  brandCaption,
  recoveryLines,
} from '../core';

// ---------------------------------------------------------------------------
// Binary containers (SPEC §8)
// ---------------------------------------------------------------------------

export {
  exportVaultBinary,
  exportVaultBinaryDisguised,
  importVaultBinary,
  verifyBinaryExport,
  verifyDisguisedExport,
  wrapBinary,
  unwrapBinary,
  looksLikeBinaryContainer,
  binaryVaultName,
  binaryKeyName,
  binaryExtension,
} from '../core';

// ---------------------------------------------------------------------------
// Gallery Mode (SPEC §9)
// ---------------------------------------------------------------------------

export { galleryEncode, galleryDecode, verifyGalleryExport } from '../core';

// ---------------------------------------------------------------------------
// Access structures (SPEC §10)
// ---------------------------------------------------------------------------

/**
 * Only the two container builders are public. They build the multi-region blob,
 * self-verify both regions, and wrap the result, so a caller cannot accidentally
 * ship a container whose decoy or real region does not open. The blob-level
 * builders underneath them stay internal: using them correctly means knowing the
 * §10 geometry, and publishing that geometry as API would freeze it.
 */
export {
  buildDuressDbContainer,
  buildNonPossessionDbContainer,
  credentialsIndependent,
} from '../core';

// ---------------------------------------------------------------------------
// Threshold shares (SPEC §10.6)
// ---------------------------------------------------------------------------

export {
  shamirSplit,
  shamirRecover,
  encodeShareText,
  decodeShareText,
  shareFileText,
} from '../core';

// ---------------------------------------------------------------------------
// Deniable stego (SPEC §5.3)
// ---------------------------------------------------------------------------

export {
  embedKeyBlockStego,
  extractKeyBlockStego,
  embedKeyFactorStego,
  extractKeyFactorStego,
  embedKeyBlockStegoJpeg,
  extractKeyBlockStegoJpeg,
  embedKeyFactorStegoJpeg,
  extractKeyFactorStegoJpeg,
  jpegStegoCapacityBits,
  isJpeg,
} from '../core';

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

export { toHex, toBase64, fromBase64 } from '../core';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * `stegoErrorCode` maps any of these to a machine-stable string, so a caller can
 * branch on a code rather than on a class or on message text. Two deliberate
 * non-distinctions survive into the public surface: `GalleryRestoreError` covers
 * both "wrong password" and "no gallery here", and the §10 access structures
 * raise `WrongPasswordError`, never anything naming a mode or a region.
 */
export {
  STEGO_ERROR_CODES,
  stegoErrorCode,
  stegoErrorDetails,
  BucketTooLargeError,
  CredentialsNotIndependentError,
  FileTooLargeError,
  GalleryCoverCapacityError,
  GalleryFileTooLargeError,
  GalleryRestoreError,
  GalleryTooFewImagesError,
  GalleryTooManyImagesError,
  JpegUnsupportedError,
  MissingKeyError,
  SegmentedFormatError,
  ShareChecksumError,
  ShareSetError,
  StegoCapacityError,
  StegoCoverFormatError,
  TooManyFilesError,
  TooManyImagesError,
  VerificationError,
  WrongPasswordError,
} from '../core';

export { StegoShardApiError } from './errors';
