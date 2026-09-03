/**
 * StegoShard's public API: the Node half.
 *
 * Files in, files out. `save` and `restore` take paths, read and write them, and
 * hand back what they produced; this is the same orchestration the command line
 * drives, so a vault written here is byte-identical to one written by
 * `stegoshard save`.
 *
 * This entry does **not** re-export `stegoshard`. The two surfaces are disjoint
 * on purpose: a consumer imports the env-neutral core from `stegoshard` and the
 * filesystem layer from `stegoshard/node`, and which one they are using stays
 * visible at the import site instead of being decided by a resolver condition.
 *
 * **Status: unstable.** See docs/API.md.
 *
 * Two things worth knowing before wiring this into a service:
 *
 *  - **The binary path defaults to a 256 MiB ceiling**, not the command line's
 *    1 GiB. See {@link DEFAULT_MAX_BINARY_BYTES}; raise it per call with
 *    `maxBytes` if your caller is trusted.
 *  - **Input paths are trusted.** `save({ inputs })` walks directories with no
 *    symlink guard and no file-count cap, so do not hand it a path an untrusted
 *    party controls. (Output is safer: a restored bundle's entries are reduced to
 *    basenames, so a malicious archive cannot escape `outDir`.)
 */

export {
  /** Encrypt and write a vault. Always self-verifies before returning. */
  runSave as save,
  /** Recover a vault to disk. */
  runRestore as restore,
  /** Fragment a small secret across a folder of ordinary photos (SPEC §9). */
  runGallerySave as gallerySave,
  /** Recover a gallery, blindly: unrelated photos are ignored. */
  runGalleryRestore as galleryRestore,
  /** How many carrier images a file would need. Reads the file, writes nothing. */
  runEstimate as estimate,
  /** The conservative binary ceiling this layer defaults to. */
  DEFAULT_MAX_BINARY_BYTES,
  CODEC_CHOICES,
} from './node/commands';

export type {
  AccessMode,
  CodecChoice,
  GalleryRestoreResult,
  GallerySaveOptions,
  GallerySaveResult,
  RestoreOptions,
  RestoreResult,
  SaveOptions,
  SaveResult,
} from './node/commands';

/**
 * Image adapters, for a consumer assembling its own pipeline out of the
 * env-neutral entry rather than using `save`/`restore`.
 */
export {
  imageDataToPng,
  fileToImageData,
  decodeImageToPayload,
  decodePixelsToPayload,
  fileToGalleryCover,
  galleryImageToFile,
  embedKeyImage,
  extractKeyImage,
  embedKeyFactorImage,
  extractKeyFactorImage,
} from './node/image-io';

export type { StegoKeyImage } from './node/image-io';

/** Expand paths, folders, `.zip` and `.pdf` inputs into decodable payloads. */
export { gatherInputs } from './node/inputs';
export type { GatheredInputs } from './node/inputs';
