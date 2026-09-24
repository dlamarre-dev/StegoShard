/**
 * CLI command implementations, separated from argument parsing so they can be
 * unit-tested directly (save→restore round-trips) without spawning a process.
 * All file I/O is Node `fs`; all crypto/codec work is the shared `@core`.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { zipSync } from 'fflate';
import {
  type BinaryVariant,
  CODEC_COLOR_GRID,
  CODEC_QR_GRID,
  DEFAULT_ARGON2,
  MAX_FILE_BYTES_BINARY_UI,
  MissingKeyError,
  PROFILE_DISK,
  PROFILE_PAPER,
  WARN_FILE_BYTES,
  WrongPasswordError,
  binaryKeyName,
  binaryVaultName,
  codecName,
  decodeHeader,
  drawBrandBand,
  estimateImages,
  exportVault,
  exportVaultBinary,
  exportVaultBinaryDisguised,
  brandCaption,
  galleryDecode,
  estimateGalleryCovers,
  galleryEncode,
  GALLERY_KEYFILE_NAME,
  getCodec,
  importVault,
  importVaultBinary,
  looksLikeBinaryContainer,
  recoveryLines,
  toHex,
  unwrapBinary,
  verifyBinaryExport,
  verifyDisguisedExport,
  verifyGalleryExport,
  verifyImageExport,
  wrapBinary,
  photoExt,
  photoNames,
  type PhotoExt,
  buildDuressDbContainer,
  buildNonPossessionDbContainer,
  shareFileText,
  decodeShareText,
  shamirRecover,
  randomBytes,
  KEY_FACTOR_LEN,
  inspectCoverSet,
  inspectJpegCover,
  StegoCoverFormatError,
  isHeif,
  isJpeg as isJpegBytes,
  normalizeJpegCover,
  reencodeCover,
  type CoverKind,
  type CoverProfile,
  type CoverSetEntry,
  type CoverSetReport,
  type FilePurpose,
  type ImageDataLike,
  type KeyMode,
  type ManifestEntry,
  type GalleryCover,
  type OnProgress,
  type Stage,
  GalleryRestoreError,
  withStegoSeedCache,
  estimateImageCount,
  planSave,
  opaqueStage,
  report,
  type VaultIdentity,
  type StegoEmbedOptions,
  type CoverClaim,
} from '../../core';
import {
  asJpegName,
  decodeImageToPayload,
  embedKeyImage,
  embedKeyFactorImage,
  extractKeyImage,
  extractKeyFactorImage,
  fileToGalleryCover,
  fileToImageData,
  galleryImageToFile,
  imageDataToPng,
} from './image-io';
import { type PhotoInput, gatherImageFiles, gatherInputs, gatherPhotos, walk } from './inputs';
import { BUNDLE_NAME, packBundle, unpackBundle } from '../../ui/bundle';
import { StegoShardApiError } from '../errors';
import { createVaultKey } from '../keys';

export { WrongPasswordError, MissingKeyError };

function read(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

/**
 * Where a run writes, and whether it may clobber.
 *
 * Both travel together on purpose. This used to be a module-global
 * `allowOverwrite` set at the top of each `run*`, which was fine for a CLI that
 * runs one command per process and wrong for a library: two concurrent `save`
 * calls with different `force` would silently take each other's setting, and the
 * loser would either refuse a legitimate write or overwrite a file it was told to
 * protect. Every option type already carries both fields, so the whole `opts`
 * object is the target and nothing has to be threaded by hand.
 */
type WriteTarget = { outDir: string; force?: boolean | undefined };

/**
 * Write a file atomically: a temporary in the same directory, flushed, then
 * renamed over the target.
 *
 * The plain `writeFileSync` this replaces truncated the target and then filled
 * it, so a crash, a full disk, or a pulled USB stick mid-write left a truncated
 * file. On this format that is not a corrupted document you can partly read: a
 * vault missing its tail is a secret you no longer have. Post-save verification
 * does not catch it either, because it verifies the bytes in memory, not the
 * file that reached the disk.
 *
 * `rename` is atomic only within a filesystem, hence the temporary alongside the
 * target rather than in the system temp directory. The rename itself is durable
 * only once the *directory* entry is flushed, so the containing directory is
 * fsynced after it; without that a crash can leave the target missing entirely
 * even though the data was flushed.
 *
 * The temporary is created `0600`, so the artifact ends up `0600` rather than
 * the `0644` a plain `writeFileSync` would have produced. That is deliberate:
 * these files are vaults and restored plaintext, and neither wants group or
 * world read.
 *
 * The overwrite guard is still a check-then-act and still racy in principle. It
 * is kept because the alternative — an exclusive create of the target itself —
 * cannot be combined with rename-over semantics, and the race here is between a
 * user and themselves. What is now impossible is the failure that actually
 * happens: a partial file where a whole one used to be.
 */
function writeOut(target: WriteTarget, name: string, bytes: Uint8Array): string {
  mkdirSync(target.outDir, { recursive: true });
  const path = join(target.outDir, name);
  if (!target.force && existsSync(path)) {
    throw new StegoShardApiError('OUTPUT_EXISTS', `refusing to overwrite ${path}`, { path });
  }

  // A unique name so two concurrent writes cannot collide on the temporary, and
  // 'wx' so an existing one is never silently reused.
  const tmp = `${path}.${process.pid.toString(36)}${Date.now().toString(36)}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    // `writeSync` is allowed to write fewer bytes than it was given, so the
    // return value has to drive a loop. Issuing it once and trusting it is the
    // partial write this whole function exists to prevent, moved one layer down:
    // a short write here produces a truncated temporary that the fsync and
    // rename below then install as the finished vault.
    for (let off = 0; off < bytes.length;) {
      const n = writeSync(fd, bytes, off, bytes.length - off);
      if (n <= 0) throw new Error(`write stalled at ${off} of ${bytes.length} bytes`);
      off += n;
    }
    // Flush before the rename: without it the rename can land while the data is
    // still only in the page cache, which is the same lost write one directory
    // entry further on.
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Windows refuses rename onto an existing path, so clear it first. This is
    // the one window where the target is gone and the new file is not yet in
    // place; it exists only under --force, where the user asked for a replace.
    if (process.platform === 'win32' && existsSync(path)) unlinkSync(path);
    renameSync(tmp, path);
    // Make the new directory entry durable too. Best-effort: some platforms
    // (Windows) refuse to open a directory for fsync, and a file that is on disk
    // but whose rename is not yet flushed is still better than failing a save
    // that worked.
    try {
      const dirFd = openSync(target.outDir, 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Directory fsync is unsupported here; the data itself is already flushed.
    }
  } catch (e) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed, or never opened cleanly
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // the temporary may not exist; the original error is the one to report
    }
    throw e;
  }
  return path;
}

/**
 * One written file plus what it is for.
 *
 * Recorded at the point of writing rather than inferred from the name later:
 * the deniable destinations name their artifacts `cache.db` / `recovery-1.txt`
 * precisely so the name says nothing, which makes after-the-fact classification
 * both unreliable and self-defeating.
 */
type OutFile = { path: string; purpose: FilePurpose };

/** Write a file and record its purpose. */
function emit(target: WriteTarget, name: string, bytes: Uint8Array, purpose: FilePurpose): OutFile {
  return { path: writeOut(target, name, bytes), purpose };
}

/**
 * Shape the written files for `SaveResult`. `files` is derived from `manifest`
 * rather than tracked alongside it, so the two cannot fall out of step.
 */
const asFiles = (outs: readonly OutFile[]) => ({
  files: outs.map((o) => o.path),
  manifest: outs.map((o) => ({ name: o.path, purpose: o.purpose })),
});

/** Write the external key artifact, copying the cover's timestamps when stego. */
/** The names already in `dir`, which a drawn `IMG_nnnn` must not reuse. */
function namesIn(dir: string): Set<string> {
  try {
    return new Set(readdirSync(dir));
  } catch {
    return new Set(); // not created yet: nothing to collide with
  }
}

function writeExternalKey(target: WriteTarget, ext: KeyArtifact): OutFile {
  const name = ext.name || photoNames([ext.photoExt ?? 'jpg'], namesIn(target.outDir))[0]!;
  const path = writeOut(target, name, ext.bytes);
  // The artifact exists from here on, so the cover claim is real regardless of
  // what else the save does afterwards -- and other writes DO follow on some
  // paths (recovery-N.txt on the non-possession and gallery paths).
  ext.onLanded?.();
  if (ext.mimicPath) {
    try {
      const s = statSync(ext.mimicPath);
      utimesSync(path, s.atime, s.mtime); // make the key image look untouched
    } catch {
      // timestamp mimicry is best-effort
    }
  }
  return { path, purpose: ext.photoExt ? 'stegoCover' : 'keyfile' };
}

/**
 * Default ceiling on the binary path, for callers that do not choose one.
 *
 * The core's own default is `MAX_FILE_BYTES_BINARY`, which aliases the **1 GiB**
 * terminal budget, and nothing here used to override it. That is the right number
 * for a headless command bounded only by the machine's RAM, and the wrong one for
 * a library embedded in someone else's process, where a 1 GiB in-memory buffer an
 * untrusted caller can request is a denial-of-service surface. So the
 * conservative browser figure is the default and the CLI opts back up to 1 GiB
 * explicitly, which leaves terminal behaviour unchanged and makes the larger
 * budget a visible decision rather than an inherited one.
 */
export const DEFAULT_MAX_BINARY_BYTES = MAX_FILE_BYTES_BINARY_UI;

// `makeKey` lived here and did the same createKeyBlock + serializeKeyBlock pair
// the public surface needs, so it moved to ../keys.ts and both use it.
const makeKey = createVaultKey;

/** §10 access mode for the supported paths (.db, gallery). */
export type AccessMode = 'plain' | 'duress' | 'nonpossession';

/**
 * Which image codec to render with (SPEC §2). 'color' packs ~3x the bytes per
 * image; 'qr' is readable by any phone. Paper output is always 'qr'.
 */
export type CodecChoice = 'color' | 'qr';

/** The codecs `--codec` accepts, in the order the help text lists them. */
export const CODEC_CHOICES: readonly CodecChoice[] = ['color', 'qr'];

export interface SaveOptions {
  /** Files and/or directories. Several inputs are zipped into one bundle. */
  inputs: string[];
  outDir: string;
  password: string;
  paper: boolean;
  zip: boolean;
  /** When set, output a single binary container file instead of images/PDF. */
  binary?: BinaryVariant | undefined;
  /** Access mode (.db path). 'duress' needs decoyFile + duressPassword;
   *  'nonpossession' needs threshold. Defaults to 'plain'. */
  mode?: AccessMode;
  duressPassword?: string | undefined;
  decoyFile?: string | undefined;
  threshold?: { k: number; n: number } | undefined;
  keyMode: KeyMode;
  /** Image codec for the disk destination. Paper always uses qr-grid. */
  codec?: CodecChoice | undefined;
  cover?: string | undefined; // stego cover image path
  title?: string | undefined;
  date?: string | undefined;
  locale?: string | undefined;
  instructions?: boolean | undefined;
  passwordHint?: string | undefined;
  keyLocation?: string | undefined;
  fontPath?: string | undefined;
  /** Overwrite existing output files instead of refusing. */
  force?: boolean | undefined;
  /**
   * Embed into a cover that already carried a different payload under this
   * password in this realm.
   *
   * Separate from `force` on purpose: `force` overwrites an output file, this
   * waives a cryptographic constraint (SPEC §5.3), and one should never imply the
   * other. See src/core/stego-guard.ts.
   */
  allowCoverReuse?: boolean | undefined;
  /**
   * Ceiling on the binary path's payload, and on its decompression (a gzip-bomb
   * guard). Defaults to {@link DEFAULT_MAX_BINARY_BYTES}; pass
   * `MAX_FILE_BYTES_BINARY_CLI` for the 1 GiB terminal budget. Ignored on the
   * image and paper paths, which are hard-capped at `MAX_FILE_BYTES` (1 MiB),
   * and on the duress / non-possession `.db` paths, which the §10.4 bucket ladder
   * already caps at 64 MiB per region.
   */
  maxBytes?: number | undefined;
  /**
   * Rollback identity to embed (SPEC §4 FLAGS bit2). Accepted only on the open
   * destinations — images, PDF and branded `.ssbn`. The gallery and disguised
   * `.db` paths ignore no such option because they have none: their builders
   * take no identity at all, so a deniable save cannot carry one.
   */
  identity?: VaultIdentity | undefined;
}

export interface SaveResult {
  /** Written paths, in write order. Derived from `manifest`. */
  files: string[];
  /** The same files, each tagged with what it is for. */
  manifest: ManifestEntry[];
  imageCount: number;
  setId: string;
  keyMode: KeyMode;
  /** Set when the vault was written as a single binary container. */
  binary?: BinaryVariant;
  effectiveLocale?: string;
  fontWarning?: string;
  /** A soft warning to surface (e.g. a large image count). */
  sizeWarning?: string;
}

/**
 * Produce the external key artifact for non-embedded modes.
 *
 * A stego key photo is never named after its cover: the cover's name is the
 * device's, and says which phone took it and when. It is named `IMG_nnnn` where
 * it is written (see `deniable-names.ts`). An as-is key photo still copies its
 * cover's timestamps, which agree with the EXIF it keeps; a profile key photo
 * does not, because it is delivered beside a gallery written today, and one
 * file dated years ago among them would be the one to look at.
 */
/**
 * Run `make` as a progress stage when it derives a key: a stego key photo costs
 * one Argon2 derivation for its keystream, a `.key` file costs nothing.
 */
function keyStage<T>(
  keyMode: KeyMode,
  on: OnProgress | undefined,
  make: () => Promise<T>,
): Promise<T> {
  return keyMode === 'stego' ? opaqueStage(on, 'derive', make) : make();
}

/**
 * Lift the caller's cover-reuse decision into the shape the stego layer takes.
 *
 * Kept as a helper rather than inlined so there is one place asserting that this
 * is the ONLY thing forwarded: `force` must never end up here. `--force` means
 * "overwrite an existing output file", and letting a file-overwrite convenience
 * waive a cryptographic constraint would be a category error.
 */
function reuseOpt(o: { allowCoverReuse?: boolean | undefined }): StegoEmbedOptions {
  return { allowCoverReuse: o.allowCoverReuse };
}

/**
 * The external key artifact, and the hook that says it reached disk.
 *
 * `writeExternalKey` is NOT the last write on every save path -- the
 * non-possession and gallery paths write recovery-N.txt after it -- so a save can
 * fail with the cover artifact already written. That case must KEEP its claim:
 * there is a real artifact out there, and releasing would let a retry mint a
 * second one from the same cover under one password, which is the leak SPEC §5.3
 * forbids. An earlier version of this comment asserted the opposite invariant and
 * was simply wrong.
 *
 * `onLanded` is why the design does not depend on that ordering at all: the write
 * itself reports, rather than the outcome being inferred from where an exception
 * surfaced.
 */
interface KeyArtifact {
  /**
   * The file name, or `''` for a stego key photo, which is named where it is
   * written: `IMG_nnnn`, drawn so as not to collide with what is already in the
   * output folder (see `deniable-names.ts`).
   */
  name: string;
  bytes: Uint8Array;
  /** Set for a stego key photo: the extension its bytes call for. */
  photoExt?: PhotoExt;
  /** An as-is key photo copies its cover's timestamps; see `externalKey`. */
  mimicPath?: string | undefined;
  /** Set by `externalKey`; called by `writeExternalKey` once the bytes are on disk. */
  onLanded?: (() => void) | undefined;
}

/**
 * How much provenance a stego key cover is carrying, before the embed removes it.
 *
 * Asked separately rather than reported out of the stego layer. `embedKeyImage`
 * normalizes the cover itself (SPEC §9.7, via `stego.ts`), but what it returns
 * is a key image; threading a report back out through four adapters and six
 * `SaveResult` return sites would be a great deal of plumbing for one number.
 * Walking the marker segments is a linear pass over the header, next to an
 * Argon2 and a full JPEG decode.
 *
 * Answers undefined for anything it cannot read rather than throwing: the embed
 * that follows refuses a bad cover with a proper error, and a warning counter
 * must never be the thing that fails a save.
 */
export function coverManifest(path: string): { segments: number; bytes: number } | undefined {
  try {
    const bytes = read(path);
    if (!isJpegBytes(bytes)) return undefined;
    return inspectJpegCover(bytes).jumbf;
  } catch {
    return undefined;
  }
}

async function externalKey(
  keyMode: KeyMode,
  keyBlock: Uint8Array,
  /**
   * What to call the `.key` file, when the mode produces one. Defaults to the
   * branded, set-identified name the overt destinations want; a deniable
   * destination passes `GALLERY_KEYFILE_NAME` instead, because
   * `stegoshard-18265a84.key` sitting beside a gallery names both the project
   * and the set those particular photos belong to.
   */
  keyfileName: string,
  password: string,
  cover: string | undefined,
  /**
   * What to do with the stego cover's container before hiding anything in it.
   *
   * `'as-is'` is §5.4: the cover keeps the tables, the metadata and the format
   * the device wrote, because a key photo on an overt path sits in a library of
   * device files and transcoding it would make it the one that does not match.
   *
   * `'profile'` is Gallery Mode. There the key photo is delivered **with** the
   * set, so "matches its neighbours" means the profile every other photo in that
   * set was re-encoded into (§9.8). Left as-is it would be the single file in the
   * delivery carrying a device's own quantization tables, which is to say the
   * carriers would be uniform and the key would not.
   *
   * Required rather than defaulted: this is a security property of a delivery,
   * and a new call site should have to say which one it is.
   */
  coverContainer: 'as-is' | 'profile',
  // Single-region paths (branded .ssbn, disk, paper) hide a 92-byte key block;
  // multi-region paths (gallery, disguised .db) hide the 32-byte key factor.
  variant: 'block' | 'factor' = 'block',
  opts?: StegoEmbedOptions,
  hold?: (claim: CoverClaim) => void,
  landed?: () => void,
): Promise<KeyArtifact | undefined> {
  if (keyMode === 'stego') {
    if (!cover) {
      throw new StegoShardApiError(
        'STEGO_NEEDS_COVER',
        'stego key mode needs a cover image to hide the key in',
      );
    }
    // `onClaim` forwards straight to the holder, so the claim is registered before
    // anything else in this function can throw.
    const embedOpts: StegoEmbedOptions = { ...opts, onClaim: hold };
    const raw = read(cover);
    // The profile path decodes the cover, and the decoder here reads PNG and JPEG
    // only. Anything else (HEIC above all, which StegoShard never ingests, SPEC
    // §5.4) is refused by name, as the as-is path and the covers already are,
    // rather than surfacing as a jpeg-js "SOI not found".
    const decodable = isJpegBytes(raw) || (raw[0] === 0x89 && raw[1] === 0x50);
    if (coverContainer === 'profile' && !decodable) throw new StegoCoverFormatError();
    // Into the profile first, where the delivery asks for it, so the embed writes
    // into the coefficients that will actually be delivered. A re-encode after
    // the embed would destroy the payload; this is the only order that works,
    // and it is the same order §9.8 requires of the covers: normalize, then hide.
    const source =
      coverContainer === 'profile'
        ? reencodeCover(
            fileToImageData(raw, basename(cover)),
            isJpegBytes(raw) ? raw : undefined,
            basename(cover),
          )
        : raw;
    // This name only picks the decoder for the embed: a PNG key cover re-encoded
    // into the profile is a JPEG. The delivered name is drawn at write time.
    const decodeAs = coverContainer === 'profile' ? asJpegName(basename(cover)) : basename(cover);
    const key =
      variant === 'factor'
        ? await embedKeyFactorImage(source, decodeAs, keyBlock, password, embedOpts)
        : await embedKeyImage(source, decodeAs, keyBlock, password, embedOpts);
    return {
      name: '',
      bytes: key.bytes,
      photoExt: key.ext,
      mimicPath: coverContainer === 'as-is' ? cover : undefined,
      onLanded: landed,
    };
  }
  if (keyMode !== 'embedded') {
    return { name: keyfileName, bytes: keyBlock };
  }
  return undefined;
}

/**
 * Run a save, and drop the stego cover claim if the artifact never reached disk.
 *
 * `hold` is called from `onClaim`, the instant the guard makes the claim -- not
 * when the embed returns. That distinction is load-bearing: `embedKeyImage`
 * re-encodes the PNG after the embed succeeds, so a throw there would otherwise
 * leave a claim nothing could release, which is the burned cover this exists to
 * prevent.
 *
 * `landed` is set by `writeExternalKey` itself. It is NOT inferred from where an
 * exception was caught, because the stego image is not always the last write: the
 * non-possession path writes recovery-N.txt afterwards, and so does
 * `runGallerySaveImpl`. A failure in those must keep the claim -- a real artifact
 * is on disk by then, and releasing would let a retry mint a second one from the
 * same cover.
 *
 * Threaded as a parameter rather than kept in module scope, so two saves running
 * concurrently in one realm cannot touch each other's claims.
 */
async function withKeyClaim<T>(
  run: (hold: (claim: CoverClaim) => void, landed: () => void) => Promise<T>,
): Promise<T> {
  let claim: CoverClaim | undefined;
  let written = false;
  try {
    return await run(
      (c) => {
        claim = c;
      },
      () => {
        written = true;
      },
    );
  } catch (err) {
    if (!written) claim?.release();
    throw err;
  }
}

async function runSaveDisguisedImpl(
  opts: SaveOptions,
  input: { name: string; content: Uint8Array; bundle: boolean },
  onProgress: OnProgress | undefined,
  hold: (claim: CoverClaim) => void,
  landed: () => void,
): Promise<SaveResult> {
  const content = input.content;
  const mode = opts.mode ?? 'plain';
  const name = input.name;
  const outName = binaryVaultName('disguised');
  const keyMode = opts.keyMode ?? 'embedded';
  // keyfile/stego mint a 32-byte external key factor (§10.3); it composes with any
  // access mode (an extra layer on top of the password / duress / shares).
  const keyFactor = keyMode === 'embedded' ? null : randomBytes(KEY_FACTOR_LEN);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BINARY_BYTES;

  /** Deliver the minted key factor as a .key container (keyfile) or hidden in a
   *  cover photo (stego), keyed by the per-save password. */
  async function deliverFactor(): Promise<OutFile[]> {
    if (!keyFactor) return [];
    if (keyMode === 'keyfile') {
      return [
        emit(opts, binaryKeyName('disguised'), wrapBinary(keyFactor, 'disguised'), 'keyfile'),
      ];
    }
    const ext = await keyStage('stego', onProgress, () =>
      externalKey(
        'stego',
        keyFactor,
        binaryKeyName('disguised'),
        opts.password,
        opts.cover,
        'as-is',
        'factor',
        reuseOpt(opts),
        hold,
        landed,
      ),
    );
    return ext ? [writeExternalKey(opts, ext)] : [];
  }

  if (mode === 'duress') {
    if (!opts.decoyFile) {
      throw new StegoShardApiError(
        'DURESS_DECOY_REQUIRED',
        'duress mode needs a decoy payload to open under the second password',
      );
    }
    if (!opts.duressPassword) {
      throw new StegoShardApiError(
        'DURESS_PASSWORD_REQUIRED',
        'duress mode needs a second, independent password',
      );
    }
    const decoyContent = read(opts.decoyFile);
    const decoyName = basename(opts.decoyFile);
    // Core builds + self-verifies both regions and wraps the container.
    const { container } = await buildDuressDbContainer(
      name,
      content,
      decoyName,
      decoyContent,
      opts.password,
      opts.duressPassword,
      keyFactor,
      DEFAULT_ARGON2,
      onProgress,
      undefined,
      input.bundle,
    );
    const outs = [emit(opts, outName, container, 'vault'), ...(await deliverFactor())];
    return { ...asFiles(outs), imageCount: 0, setId: '', keyMode, binary: 'disguised' };
  }

  if (mode === 'nonpossession') {
    if (!opts.threshold) {
      throw new StegoShardApiError(
        'THRESHOLD_REQUIRED',
        'non-possession mode needs a k-of-n threshold',
      );
    }
    const { k, n } = opts.threshold;
    const { container, shares } = await buildNonPossessionDbContainer(
      name,
      content,
      opts.password,
      k,
      n,
      keyFactor,
      DEFAULT_ARGON2,
      onProgress,
      undefined,
      input.bundle,
    );
    const outs = [emit(opts, outName, container, 'vault'), ...(await deliverFactor())];
    shares.forEach((share, i) => {
      // Deniable path: neutral filename and a neutral heading inside the file.
      const body = shareFileText(
        share,
        i + 1,
        n,
        k,
        'and load them at restore with --share <file>.',
        'neutral',
      );
      outs.push(emit(opts, `recovery-${i + 1}.txt`, new TextEncoder().encode(body), 'share'));
    });
    return { ...asFiles(outs), imageCount: 0, setId: '', keyMode, binary: 'disguised' };
  }

  // plain
  const { container, keyBlock, regionIndex, dek } = await exportVaultBinaryDisguised(
    name,
    content,
    opts.password,
    { keyMode, bundle: input.bundle, maxBytes },
    onProgress,
  );
  await verifyDisguisedExport(container, dek, regionIndex, name, content, onProgress);
  const outs = [emit(opts, outName, container, 'vault')];
  if (keyMode === 'keyfile') {
    outs.push(emit(opts, binaryKeyName('disguised'), wrapBinary(keyBlock, 'disguised'), 'keyfile'));
  } else if (keyMode === 'stego') {
    // The .db is a multi-region path → hide the 32-byte key factor (SSKF) in the
    // cover, keyed by the same per-save password that derives the slot KEK.
    const ext = await keyStage('stego', onProgress, () =>
      externalKey(
        'stego',
        keyBlock,
        binaryKeyName('disguised'),
        opts.password,
        opts.cover,
        'as-is',
        'factor',
        reuseOpt(opts),
        hold,
        landed,
      ),
    );
    if (ext) outs.push(writeExternalKey(opts, ext));
  }
  return { ...asFiles(outs), imageCount: 0, setId: '', keyMode, binary: 'disguised' };
}

/**
 * Resolve the save inputs (files, directories, or a mix) into the single
 * (name, content) pair the envelope carries.
 *
 * One input stays exactly as it always was: same name, same bytes, no bundle
 * flag, so the commonest save is unchanged. Several inputs (or a directory) are
 * zipped and marked with SPEC §4 FLAGS bit1, which restore reverses.
 */
function readSaveInputs(paths: string[]): {
  name: string;
  content: Uint8Array;
  bundle: boolean;
  count: number;
} {
  const files: string[] = [];
  for (const path of paths) {
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  if (files.length === 0) {
    throw new StegoShardApiError('NO_INPUT_FILES', 'no input files to save');
  }
  if (files.length === 1) {
    const only = files[0]!;
    return { name: basename(only), content: read(only), bundle: false, count: 1 };
  }
  const packed = packBundle(files.map((f) => ({ name: basename(f), bytes: read(f) })));
  return { name: BUNDLE_NAME, content: packed, bundle: true, count: files.length };
}

async function runSaveImpl(
  opts: SaveOptions,
  onProgress: OnProgress | undefined,
  hold: (claim: CoverClaim) => void,
  landed: () => void,
): Promise<SaveResult> {
  const input = readSaveInputs(opts.inputs);
  const content = input.content;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BINARY_BYTES;

  // Disguised .db output: a §10 multi-region container keyed by the PASSWORD (each
  // region gets its own DEK; the managed key is not used on this supported path).
  if (opts.binary === 'disguised') {
    return runSaveDisguisedImpl(opts, input, onProgress, hold, landed);
  }
  // A non-plain access mode is only meaningful on the supported .db path.
  if (opts.mode && opts.mode !== 'plain') {
    throw new StegoShardApiError(
      'MODE_NEEDS_DISGUISE',
      `access mode "${String(opts.mode)}" needs the disguised binary path`,
      { mode: String(opts.mode) },
    );
  }

  const key = await makeKey(opts.password);

  // Branded .ssbn output (excluded path): single-region, managed DEK, unchanged.
  if (opts.binary) {
    const variant = opts.binary;
    const { container, keyBlock, keyMode } = await exportVaultBinary(
      input.name,
      content,
      key,
      { keyMode: opts.keyMode, variant, bundle: input.bundle, maxBytes, identity: opts.identity },
      onProgress,
    );
    await verifyBinaryExport(container, key.dek, input.name, content, onProgress);
    const outs = [emit(opts, binaryVaultName(variant), container, 'vault')];
    if (keyMode === 'stego') {
      const ext = await keyStage('stego', onProgress, () =>
        externalKey(
          'stego',
          keyBlock,
          binaryKeyName(variant),
          opts.password,
          opts.cover,
          'as-is',
          'block',
          reuseOpt(opts),
          hold,
          landed,
        ),
      );
      if (ext) outs.push(writeExternalKey(opts, ext));
    } else if (keyMode === 'keyfile') {
      outs.push(emit(opts, binaryKeyName(variant), wrapBinary(keyBlock, variant), 'keyfile'));
    }
    return { ...asFiles(outs), imageCount: 0, setId: '', keyMode, binary: variant };
  }

  const profile = opts.paper ? PROFILE_PAPER : PROFILE_DISK;
  const codecId = codecIdForSave(opts.paper, opts.codec);

  const { imagePayloads, setId, keyBlock, keyMode } = await opaqueStage(onProgress, 'encrypt', () =>
    exportVault(input.name, content, key, {
      profile,
      codecId,
      keyMode: opts.keyMode,
      bundle: input.bundle,
      identity: opts.identity,
    }),
  );
  // Read it back from the header rather than trusting the request, so the
  // rendered pixels and the recovery line can never disagree with the payload.
  const codec = getCodec(decodeHeader(imagePayloads[0]!).codecId);
  await opaqueStage(onProgress, 'verify', () =>
    verifyImageExport(imagePayloads, key.dek, input.name, content),
  );
  const setHex = toHex(setId);
  const outs: OutFile[] = [];
  const ext = await keyStage(keyMode, onProgress, () =>
    externalKey(
      keyMode,
      keyBlock,
      // Disk and paper are overt destinations: the brand in the name is the point.
      `stegoshard-${setHex}.key`,
      opts.password,
      opts.cover,
      'as-is',
      'block',
      reuseOpt(opts),
      hold,
      landed,
    ),
  );
  // Large secrets sprawl into many images; nudge toward --binary before writing.
  const sizeWarning =
    content.length > WARN_FILE_BYTES
      ? `Large secret (${Math.round(content.length / 1024)} KiB) → ${imagePayloads.length} image(s). ` +
        `Consider --binary for a single file.`
      : undefined;

  if (opts.paper) {
    // Loaded here rather than at the top of the module: the PDF path pulls in
    // fontkit, about a megabyte of font machinery, and most callers never render
    // paper. The CLI bundle is unaffected, since `vite.cli.config.ts` inlines
    // dynamic imports into its single file.
    const { buildCliPaperPdf } = await import('./paper');
    const encodeQr = (p: Uint8Array): ImageDataLike => codec.encode(p, PROFILE_PAPER);
    const built = await buildCliPaperPdf(imagePayloads, encodeQr, imageDataToPng, {
      onProgress,
      title: opts.title,
      date: opts.date,
      locale: opts.locale,
      includeInstructions: opts.instructions,
      passwordHint: opts.passwordHint,
      keyLocation: opts.keyLocation,
      fontPath: opts.fontPath,
    });
    outs.push(emit(opts, `stegoshard-${setHex}.pdf`, built.pdf, 'document'));
    if (ext) outs.push(writeExternalKey(opts, ext));
    return {
      ...asFiles(outs),
      imageCount: imagePayloads.length,
      setId: setHex,
      keyMode,
      effectiveLocale: built.effectiveLocale,
      ...(built.fontWarning ? { fontWarning: built.fontWarning } : {}),
      ...(sizeWarning ? { sizeWarning } : {}),
    };
  }

  // Disk: one PNG per image, or a single .zip. Each carries the same brand strip
  // the browser stamps (shared renderer in @core), so the two agree pixel for
  // pixel. --title/--date land here too.
  const recovery = recoveryLines(codecName(codecId));
  const pngs: { name: string; bytes: Uint8Array }[] = [];
  for (const [i, payload] of imagePayloads.entries()) {
    await report(onProgress, { phase: 'render', done: i, total: imagePayloads.length });
    // Composed in @core, so the CLI and the browser stamp the same lines. A
    // title the ASCII font cannot draw is folded first (`--title "Sauvegarde
    // clé"` used to be dropped whole over the accent) and skipped if it still
    // cannot be drawn; the browser has a canvas and shows it another way.
    const { lines } = brandCaption({
      title: opts.title,
      date: opts.date,
      index: i + 1,
      total: imagePayloads.length,
    });
    const img = drawBrandBand(codec.encode(payload, PROFILE_DISK), { recovery, lines });
    pngs.push({
      name: `stegoshard-${setHex}-${String(i + 1).padStart(2, '0')}.png`,
      bytes: imageDataToPng(img),
    });
  }
  await report(onProgress, {
    phase: 'render',
    done: imagePayloads.length,
    total: imagePayloads.length,
  });

  if (opts.zip) {
    const entries: Record<string, Uint8Array> = {};
    for (const p of pngs) entries[p.name] = p.bytes;
    if (ext && keyMode === 'keyfile') entries[ext.name] = ext.bytes;
    outs.push(emit(opts, `stegoshard-${setHex}.zip`, zipSync(entries, { level: 0 }), 'archive'));
    // The stego image is always delivered on its own (an innocuous photo).
    if (ext && keyMode === 'stego') outs.push(writeExternalKey(opts, ext));
  } else {
    for (const p of pngs) outs.push(emit(opts, p.name, p.bytes, 'vault'));
    if (ext) outs.push(writeExternalKey(opts, ext));
  }

  return {
    ...asFiles(outs),
    imageCount: imagePayloads.length,
    setId: setHex,
    keyMode,
    ...(sizeWarning ? { sizeWarning } : {}),
  };
}

export interface RestoreOptions {
  inputs: string[];
  outDir: string;
  password: string;
  keyPath?: string | undefined;
  /** Threshold share files for a Mode B (non-possession) .db vault (§10.6). */
  sharePaths?: string[] | undefined;
  /** Overwrite an existing output file instead of refusing. */
  force?: boolean | undefined;
  /**
   * Ceiling on a binary container's decrypted payload, and on its decompression
   * (a gzip-bomb guard on bytes an adversary may have written). Defaults to
   * {@link DEFAULT_MAX_BINARY_BYTES}; pass `MAX_FILE_BYTES_BINARY_CLI` for the
   * 1 GiB terminal budget.
   */
  maxBytes?: number | undefined;
}

/** The dash-grouped base32 share token, so instruction prose in the file is ignored. */
const SHARE_TOKEN = /[0-9A-Za-z]{5}(?:-[0-9A-Za-z]{1,5})+/;

/** Recover the Shamir secret S from the supplied share files, or undefined if none. */
function recoverSecret(sharePaths: string[] | undefined): Promise<Uint8Array> | undefined {
  if (!sharePaths || sharePaths.length === 0) return undefined;
  const shares = sharePaths.map((p) => {
    const text = readFileSync(p, 'utf8');
    const match = SHARE_TOKEN.exec(text);
    return decodeShareText(match ? match[0] : text);
  });
  return shamirRecover(shares);
}

export interface RestoreResult {
  /** First file written; the only one unless the vault held a bundle. */
  outPath: string;
  /** Every file written, in bundle order. */
  files: string[];
  filename: string;
  seen: number;
  decoded: number;
  /**
   * The rollback identity the vault carried, when it carried one. Only the open
   * paths ever write one, so a deniable restore always leaves this undefined —
   * which is also why it can be surfaced at all: on those paths there is nothing
   * for it to distinguish.
   */
  identity?: VaultIdentity | undefined;
}

const isKeyFile = (n: string) => /\.key$/i.test(n);

/** Peek a file's first bytes to see whether it is a binary container (SPEC §8). */
function isBinaryContainerFile(path: string): boolean {
  // Open once and inspect the descriptor (fstat), never re-resolving the path,
  // avoids a check-then-use (TOCTOU) race between "is it a file?" and the read.
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    if (!fstatSync(fd).isFile()) return false;
    // A head peek is enough to recognise the container (branded magic or the
    // SQLite header); full extraction happens later on the whole file.
    const buf = Buffer.alloc(128);
    const n = readSync(fd, buf, 0, 128, 0);
    return looksLikeBinaryContainer(new Uint8Array(buf.subarray(0, n)));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Resolve an external key block from a .key file, a stego image, or a binary
 * key container (branded/disguised). */
async function resolveKeyBlock(keyPath: string, password: string): Promise<Uint8Array | undefined> {
  const bytes = read(keyPath);
  const unwrapped = unwrapBinary(bytes); // branded/disguised key container
  if (unwrapped) return unwrapped.payload;
  if (isKeyFile(keyPath)) return bytes; // raw .key
  // A stego cover carries either a 92-byte key block (single-region) or the 32-byte
  // key factor (multi-region .db / gallery). The two self-distinguish by magic, so
  // try block then factor; only the one actually embedded returns non-null.
  const name = basename(keyPath);
  const recovered =
    (await extractKeyImage(bytes, name, password)) ??
    (await extractKeyFactorImage(bytes, name, password));
  return recovered ?? undefined;
}

/** Total size of files and directory trees, for a progress plan. Best-effort. */
function bytesOnDisk(paths: readonly string[]): number {
  let total = 0;
  for (const p of paths) {
    try {
      const st = statSync(p);
      total += st.isDirectory() ? bytesOnDisk(walk(p)) : st.size;
    } catch {
      // Missing here means the save itself will report it.
    }
  }
  return total;
}

/**
 * The stages `runSave` will go through, for a weighted progress display (see
 * `planSave`). Read from sizes on disk, before the save starts, so it costs a
 * few `stat` calls and nothing else.
 */
export function savePlan(opts: SaveOptions): Stage[] {
  const secretBytes = bytesOnDisk(opts.inputs);
  const dest =
    opts.binary === 'disguised' ? 'sqlite' : opts.binary ? 'binary' : opts.paper ? 'paper' : 'disk';
  const profile = opts.paper ? PROFILE_PAPER : PROFILE_DISK;
  return planSave({
    surface: 'cli',
    dest,
    keyMode: opts.keyMode,
    accessMode: opts.mode,
    secretBytes,
    imageCount: estimateImageCount(secretBytes, profile, codecIdForSave(opts.paper, opts.codec)),
    // `makeKey` derives the vault key from the password before anything is
    // reported, on every path but the password-keyed .db.
    mintsKey: dest !== 'sqlite',
  });
}

/** The stages `runGallerySave` will go through; see `savePlan`. */
export function gallerySavePlan(opts: GallerySaveOptions): Stage[] {
  let coverBytes: number[] = [];
  try {
    coverBytes = gatherImageFiles(opts.covers).map((p) => bytesOnDisk([p]));
  } catch {
    // The save reports an unreadable cover folder itself.
  }
  return planSave({
    surface: 'cli',
    dest: 'gallery',
    keyMode: opts.keyMode ?? 'embedded',
    accessMode: opts.mode,
    secretBytes: bytesOnDisk([opts.secretFile]),
    coverBytes,
    stegoCoverBytes: opts.keyCover ? bytesOnDisk([opts.keyCover]) : undefined,
    preserveContainer: opts.preserveContainer,
  });
}

/** Save a vault. See {@link SaveOptions}. */
export async function runSave(opts: SaveOptions, onProgress?: OnProgress): Promise<SaveResult> {
  return withKeyClaim((hold, landed) => runSaveImpl(opts, onProgress, hold, landed));
}

/** Save a gallery. See {@link GallerySaveOptions}. */
export async function runGallerySave(
  opts: GallerySaveOptions,
  onProgress?: OnProgress,
): Promise<GallerySaveResult> {
  return withKeyClaim((hold, landed) => runGallerySaveImpl(opts, onProgress, hold, landed));
}

/**
 * The key hidden in one of `paths`, or undefined when none holds one.
 *
 * For a stego key photo given with the vault instead of with `--key`. Delivered
 * photos are all named `IMG_nnnn`, so nothing about the name marks the key photo
 * out. Only image files are tried, and one key derivation covers all of them
 * (`withStegoSeedCache`).
 */
async function keyFromPhotos(
  paths: readonly string[],
  password: string,
): Promise<Uint8Array | undefined> {
  const photos: PhotoInput[] = [];
  for (const p of paths) {
    try {
      if (statSync(p).isFile()) photos.push({ name: basename(p), bytes: read(p) });
    } catch {
      // Unreadable here means the restore itself reports it.
    }
  }
  return keyInPhotos(photos, password);
}

/** `keyFromPhotos`, over photos already read (from disk or out of a .zip). */
async function keyInPhotos(
  photos: readonly PhotoInput[],
  password: string,
): Promise<Uint8Array | undefined> {
  return withStegoSeedCache(() => firstKeyIn(photos, password));
}

async function firstKeyIn(
  photos: readonly PhotoInput[],
  password: string,
): Promise<Uint8Array | undefined> {
  for (const { name, bytes } of photos) {
    if (!isJpegBytes(bytes) && !(bytes[0] === 0x89 && bytes[1] === 0x50)) continue;
    const key =
      (await extractKeyImage(bytes, name, password)) ??
      (await extractKeyFactorImage(bytes, name, password));
    if (key) return key;
  }
  return undefined;
}

export async function runRestore(
  opts: RestoreOptions,
  onProgress?: OnProgress,
): Promise<RestoreResult> {
  const binaryVaultPath = opts.inputs.find(isBinaryContainerFile);
  if (binaryVaultPath) {
    // With no --key, anything else on the command line beside the container can
    // only be its key photo: tried before decrypting, because a .db whose key
    // factor is missing answers "wrong password" (by design), not "missing key".
    const keyBlock = opts.keyPath
      ? await resolveKeyBlock(opts.keyPath, opts.password)
      : await keyFromPhotos(
          opts.inputs.filter((p) => p !== binaryVaultPath),
          opts.password,
        );
    // Threshold shares (Mode B) recover the secret that gates the .db slot.
    const secret = await recoverSecret(opts.sharePaths);
    const { filename, content, bundled, identity } = await importVaultBinary(
      read(binaryVaultPath),
      opts.password,
      { keyBlock, secret: secret ?? null, maxBytes: opts.maxBytes ?? DEFAULT_MAX_BINARY_BYTES },
      onProgress,
    );
    const written = writeRestored(opts, filename, content, bundled);
    return { outPath: written[0]!, files: written, filename, seen: 1, decoded: 1, identity };
  }

  const gathered = await gatherInputs(opts.inputs);
  let keyBlock = gathered.keyBlock;
  if (opts.keyPath) keyBlock = await resolveKeyBlock(opts.keyPath, opts.password);

  if (gathered.payloads.length === 0) {
    throw new StegoShardApiError('NO_READABLE_IMAGES', 'no readable vault images among the inputs');
  }

  let restored: Awaited<ReturnType<typeof importVault>>;
  try {
    restored = await importVault(gathered.payloads, opts.password, { keyBlock });
  } catch (err) {
    // A stego key photo given with the set instead of with --key is one of the
    // images that did not decode as a vault image. Only those are tried: each
    // attempt costs a key derivation.
    if (!(err instanceof MissingKeyError) || keyBlock) throw err;
    // Zipped images included: a whole delivery zipped up holds the key photo too.
    const unreadable = gatherPhotos(opts.inputs).photos.filter(
      (p) => decodeImageToPayload(p.bytes, p.name) === null,
    );
    const found = await keyInPhotos(unreadable, opts.password);
    if (!found) throw err;
    restored = await importVault(gathered.payloads, opts.password, { keyBlock: found });
  }
  const { filename, content, bundled, identity } = restored;
  const written = writeRestored(opts, filename, content, bundled);
  const outPath = written[0]!;
  return {
    outPath,
    files: written,
    filename,
    seen: gathered.seen,
    decoded: gathered.decoded,
    identity,
  };
}

// --- Gallery Mode (SPEC §9) --------------------------------------------------

export interface GallerySaveOptions {
  /**
   * Keep each cover in the container it arrived in, instead of re-encoding the
   * whole set into one profile (SPEC §9.8).
   *
   * The mode for a caller who knows what it costs: the source device's
   * quantization tables, its ICC profile, its makernote and its XMP dialect all
   * survive, so a set gathered from several devices stays as sortable as it was.
   * What it buys is the coefficients left exactly as the camera wrote them, and
   * an Ultra HDR gain map that still resolves.
   *
   * The one thing it does not keep is the GPS block, which is removed from every
   * cover either way. A coordinate is not a container quirk that makes a set
   * sortable; it is the location the photo was taken, and there is no reading of
   * "preserve the container" under which a caller wanted that published.
   */
  preserveContainer?: boolean | undefined;
  secretFile: string;
  /** Cover photo paths and/or directories to draw covers from. */
  covers: string[];
  outDir: string;
  password: string;
  /** 'embedded' (default), 'keyfile', or 'stego': how the key is delivered. */
  keyMode?: KeyMode;
  /** Cover photo for --key-mode stego (the key is hidden in it). */
  keyCover?: string | undefined;
  /** §10 access mode: 'plain' (default) or 'nonpossession' (Mode B). Duress is not
   *  available on gallery (winnowing key is password-derived, SPEC §10.11). */
  mode?: 'plain' | 'nonpossession';
  threshold?: { k: number; n: number } | undefined;
  /** Overwrite existing output files instead of refusing. */
  force?: boolean | undefined;
  /**
   * Embed into a cover that already carried a different payload under this
   * password in this realm.
   *
   * Separate from `force` on purpose: `force` overwrites an output file, this
   * waives a cryptographic constraint (SPEC §5.3), and one should never imply the
   * other. See src/core/stego-guard.ts.
   */
  allowCoverReuse?: boolean | undefined;
}

export interface GallerySaveResult {
  /** Written paths, in write order. Derived from `manifest`. */
  files: string[];
  /** The same files, each tagged with what it is for. */
  manifest: ManifestEntry[];
  k: number;
  m: number;
  decoys: number;
  setId: string;
  keyMode: KeyMode;
  /**
   * Cover normalization over the whole set, carriers and decoys alike
   * (SPEC §9.7). `uniform` false means the photos that were just written can
   * still be sorted by their metadata, which is the condition normalizing only
   * the carriers would have produced.
   *
   * `gpsScrubbed` counts the covers a coordinate came out of. It is zero on the
   * default path, where the re-encode leaves no metadata for one to sit in, and
   * non-zero only under `preserveContainer` (SPEC §9.8).
   */
  provenance: {
    covers: number;
    segments: number;
    bytes: number;
    gpsScrubbed: number;
    uniform: boolean;
  };
}

async function runGallerySaveImpl(
  opts: GallerySaveOptions,
  onProgress: OnProgress | undefined,
  hold: (claim: CoverClaim) => void,
  landed: () => void,
): Promise<GallerySaveResult> {
  const keyMode = opts.keyMode ?? 'embedded';
  const content = read(opts.secretFile);
  const coverPaths = gatherImageFiles(opts.covers);
  if (coverPaths.length === 0) {
    throw new StegoShardApiError('NO_COVERS_FOUND', 'no usable cover photos found');
  }
  // One `reencode` step per cover: decoding and re-encoding a phone photo in
  // pure JavaScript is the longest per-photo cost of a save.
  const covers: GalleryCover[] = [];
  for (const [i, p] of coverPaths.entries()) {
    await report(onProgress, { phase: 'reencode', done: i, total: coverPaths.length });
    covers.push(
      fileToGalleryCover(read(p), basename(p), { preserveContainer: opts.preserveContainer }),
    );
  }
  await report(onProgress, {
    phase: 'reencode',
    done: coverPaths.length,
    total: coverPaths.length,
  });

  const mode = opts.mode ?? 'plain';
  const secretName = basename(opts.secretFile);
  const res = await galleryEncode(secretName, content, opts.password, covers, {
    keyMode,
    mode,
    threshold: opts.threshold,
    onProgress,
  });
  if (mode === 'nonpossession') {
    // Verify by winnowing + recovering S from the freshly minted shares. A
    // keyfile/stego gallery gates the real region on the key factor AS WELL AS the
    // shares (§10.3), so the factor must be supplied to the verify too; otherwise
    // the gated slot can't be opened and the self-check would spuriously fail.
    const s = await shamirRecover(res.shares!);
    await verifyGalleryExport(
      res.images,
      opts.password,
      keyMode === 'embedded' ? undefined : res.keyBlock,
      secretName,
      content,
      s,
      onProgress,
    );
  } else {
    await verifyGalleryExport(
      res.images,
      opts.password,
      keyMode === 'embedded' ? undefined : res.keyBlock,
      secretName,
      content,
      undefined,
      onProgress,
    );
  }
  const setHex = toHex(res.setId);

  // The key photo, when there is one, is made before any name is drawn, so that
  // it can draw from the same set: `IMG_nnnn` like every photo beside it, at no
  // position that sets it apart (see `deniable-names.ts`). Its cover claim is
  // held from here, and released by `withKeyClaim` if nothing reaches disk.
  const ext = await keyStage(keyMode, onProgress, () =>
    externalKey(
      keyMode,
      res.keyBlock,
      GALLERY_KEYFILE_NAME,
      opts.password,
      opts.keyCover,
      // The key photo is delivered beside the gallery, so it takes the gallery's
      // container rule, not §5.4's. `--preserve-container` turns it off for the
      // whole delivery, key photo included: one flag, one set, one answer.
      opts.preserveContainer ? 'as-is' : 'profile',
      'factor',
      reuseOpt(opts),
      hold,
      landed,
    ),
  );
  const files = res.images.map((img) => galleryImageToFile(img));
  const exts: PhotoExt[] = files.map((f) => photoExt(f.bytes));
  if (ext?.photoExt) exts.push(ext.photoExt);
  const names = photoNames(exts, namesIn(opts.outDir));
  const outs: OutFile[] = files.map((f, i) => emit(opts, names[i]!, f.bytes, 'photos'));
  // Deliver the external key alongside the photos for keyfile/stego galleries.
  // Gallery is a multi-region path → the external artifact is the 32-byte factor.
  //
  // Never back-dated, whatever the container: the photos beside it are all
  // written today, so a key photo carrying its cover's old timestamps would be
  // the one file in the folder dated years ago. That holds under
  // `--preserve-container` too, which keeps the key photo's container as-is and
  // would otherwise take `externalKey`'s as-is rule of copying the dates.
  if (ext) {
    outs.push(
      writeExternalKey(
        opts,
        ext.photoExt ? { ...ext, name: names[files.length]!, mimicPath: undefined } : ext,
      ),
    );
  }
  // Non-possession: write the n threshold share files to hand to holders.
  if (res.shares && opts.threshold) {
    const { k, n } = opts.threshold;
    res.shares.forEach((share, i) => {
      // Gallery is a deniable destination: neutral filename, neutral heading.
      const body = shareFileText(
        share,
        i + 1,
        n,
        k,
        'and load them at restore with --share <file>.',
        'neutral',
      );
      outs.push(emit(opts, `recovery-${i + 1}.txt`, new TextEncoder().encode(body), 'share'));
    });
  }
  return {
    ...asFiles(outs),
    k: res.k,
    m: res.m,
    decoys: res.decoys,
    setId: setHex,
    keyMode,
    provenance: {
      ...res.normalization.removed,
      gpsScrubbed: res.normalization.gpsScrubbed,
      uniform: res.normalization.uniform,
    },
  };
}

export interface GalleryRestoreResult {
  outPath: string;
  /** Every path written, first one first. Always length 1: a gallery holds one secret. */
  files: string[];
  filename: string;
  seen: number;
}

export async function runGalleryRestore(opts: RestoreOptions): Promise<GalleryRestoreResult> {
  // Photos loose, in folders, or in a .zip (the whole delivery zipped up, key
  // photo and all, is the natural thing to hand over). A .key found among them,
  // loose or zipped, is the key.
  const { photos, keyBlock: foundKey } = gatherPhotos(opts.inputs);
  if (photos.length === 0) {
    throw new StegoShardApiError('NO_GALLERY_IMAGES', 'no images to scan for a gallery');
  }
  // `preserveContainer` on the way *in*: these photos carry a payload in their
  // coefficients, and re-encoding one would destroy what restore is here to read.
  const covers = photos.map((p) =>
    fileToGalleryCover(p.bytes, p.name, { preserveContainer: true }),
  );

  // A keyfile/stego gallery delivers its key separately: --key (a .key or the key
  // photo), or a .key that came in with the photos.
  const keyBlock = opts.keyPath ? await resolveKeyBlock(opts.keyPath, opts.password) : foundKey;
  // A non-possession gallery is gated on threshold shares (--share).
  const secret = await recoverSecret(opts.sharePaths);
  let restored: Awaited<ReturnType<typeof galleryDecode>>;
  try {
    restored = await galleryDecode(covers, opts.password, { keyBlock, secret });
  } catch (err) {
    // A stego gallery's key photo given among the photos instead of with --key:
    // the missing factor reads as a failed restore, so the photos are searched
    // for it, for one key derivation in all. Only on this failure path.
    if (!(err instanceof GalleryRestoreError) || keyBlock) throw err;
    const found = await keyInPhotos(photos, opts.password);
    if (!found) throw err;
    restored = await galleryDecode(covers, opts.password, { keyBlock: found, secret });
  }
  const { filename, content } = restored;
  const outName = basename(filename) || 'restored.bin';
  const outPath = writeOut(opts, outName, content);
  return { outPath, files: [outPath], filename, seen: covers.length };
}

/**
 * Write what a restore recovered. A bundle (SPEC §4 FLAGS bit1) is unpacked
 * back into its files; anything else is the single file it has always been.
 * Returns the paths written, first one first.
 */
function writeRestored(
  target: WriteTarget,
  filename: string,
  content: Uint8Array,
  bundled: boolean,
): string[] {
  if (!bundled) return [writeOut(target, basename(filename) || 'restored.bin', content)];
  // unpackBundle reduces every entry to a basename, so nothing can escape the dir.
  return unpackBundle(content).map((f) => writeOut(target, f.name, f.bytes));
}

export interface NormalizeOptions {
  /** Image files or directories. Directories are walked for image files. */
  inputs: string[];
  /** Where normalized copies go. Required unless `report` is set. */
  outDir?: string | undefined;
  /** Inspect only: compute everything, write nothing. */
  report?: boolean | undefined;
  /** Overwrite existing output files instead of refusing. */
  force?: boolean | undefined;
}

/** One input file's outcome. */
export interface NormalizeCoverRow {
  /** The path as given. */
  input: string;
  /** Its basename, which is also the output name. */
  name: string;
  kind: CoverKind;
  /**
   * The inventory taken **before** removal, so it still shows the manifest that
   * was taken out along with everything else the file declares. Null when the
   * file is not a JPEG, or is a JPEG whose structure did not parse.
   *
   * Present alongside `problem` when the inventory succeeded and the *removal*
   * then refused, which since SPEC §9.7.1 means an MPF index that could not be
   * kept correct rather than one the manifest merely sat behind. That photo is
   * exactly the one a user needs to see the inventory of, and discarding it
   * because the second step failed left the report silent about the file it had
   * most to say about.
   */
  profile: CoverProfile | null;
  /**
   * Why this file produced no normalized copy: it is a JPEG whose structure did
   * not parse, or one whose manifest could not be removed without invalidating
   * something else (see `normalizeJpegCover`). A PNG or a HEIC carries no
   * `problem`; it is named by `kind`, because being another format is not a
   * fault in the file.
   */
  problem?: string;
  removed: { segments: number; bytes: number };
  /** Where the normalized copy landed. Absent in report mode, and for skipped files. */
  output?: string;
}

export interface NormalizeCoversResult {
  /** Written paths, in write order. Empty in report mode. */
  files: string[];
  manifest: ManifestEntry[];
  /** Per-file inventory, in input order. */
  covers: NormalizeCoverRow[];
  /**
   * Set-level uniformity over every member, computed on the **normalized**
   * bytes for the JPEGs that normalized and on the originals for the rest.
   * Report mode therefore answers "what would I get", rather than restating
   * what the files already are, which the per-file profiles already say. A
   * member that produced no output still counts against `uniform`: a set an
   * adversary can sort by format is not one uniformity holds over.
   */
  set: CoverSetReport;
  removed: { covers: number; segments: number; bytes: number };
  /**
   * Members that produced no normalized bytes: a PNG, a HEIC, a JPEG that did
   * not parse, or one whose manifest could not be removed safely. Counted, not
   * derived from `profile === null`, because the last of those keeps its
   * inventory.
   */
  skipped: number;
  /**
   * True when this was `--report`: nothing was written, and `files` is empty
   * because of that rather than because every member was skipped. A presenter
   * cannot tell those apart from the result alone, and telling a user their
   * library has been normalized when it has not is the one wrong thing to say
   * here.
   */
  report: boolean;
}

/**
 * Strip provenance manifests from a set of photos, and report on what is left.
 *
 * WHY THIS IS A COMMAND AND NOT ONLY A PIPELINE STEP
 * The automatic step in `stego.ts` reaches exactly the photos handed to
 * StegoShard. Uniformity is a property of the whole library an adversary sees,
 * not of the nine photos that ended up carrying something: normalizing nine
 * photos inside a folder of three hundred *is* the discriminating condition the
 * feature exists to remove. So this runs over an arbitrary set, and it takes the
 * set rather than a file at a time, because `uniform` is not a property a single
 * photo can have.
 *
 * SCOPE
 * JPEG only. A PNG is copied by nothing here: its metadata lives in chunks this
 * module does not rewrite, so passing it through would quietly promise a
 * normalization that did not happen. (A PNG *cover* is normalized anyway on the
 * embed path, where the decode to pixels drops every chunk.) A HEIC is named and
 * skipped for the reason in `isHeif`. Both are reported, never silently dropped.
 *
 * A file that does not parse produces no output and a recorded `problem`; the
 * run continues. Failing the whole command because one photo in a library is
 * odd would make the tool useless on exactly the libraries it is for, and the
 * "never emit corrupt output" rule is satisfied by writing nothing for it.
 */
/**
 * Which files `normalize` looks at.
 *
 * Deliberately not `gatherImageFiles`, whose pattern is the one `restore` and
 * the gallery commands use and does **not** include HEIC. That is right for
 * them: a `.heic` sitting in a folder being restored from is not an input, and
 * silently ignoring it is correct. It is wrong here, where a HEIC among the
 * JPEGs is a finding, and the whole job is to report what a set is made of. So
 * this pattern is wider, and the extra formats are reported and skipped rather
 * than processed.
 */
const NORMALIZE_IMAGE_RE = /\.(jpe?g|png|hei[cf]|avif)$/i;

function gatherNormalizeFiles(paths: string[]): string[] {
  const files: string[] = [];
  for (const path of paths) {
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files.filter((p) => NORMALIZE_IMAGE_RE.test(basename(p)));
}

export async function runNormalize(opts: NormalizeOptions): Promise<NormalizeCoversResult> {
  const paths = gatherNormalizeFiles(opts.inputs);
  if (paths.length === 0) {
    throw new StegoShardApiError('NO_NORMALIZE_FILES', 'no image files found to normalize');
  }
  if (!opts.report && !opts.outDir) {
    throw new StegoShardApiError(
      'NORMALIZE_OUT_REQUIRED',
      'normalize needs --out: writing beside the originals is the opposite of the point',
    );
  }

  const covers: NormalizeCoverRow[] = [];
  // Every member of the set, JPEG or not, normalized where that was possible:
  // a HEIC among the JPEGs is precisely what the set sorts on (SPEC §9.7), so
  // leaving it out of the report would claim a uniformity the set does not have.
  const setEntries: CoverSetEntry[] = [];
  const outs: OutFile[] = [];
  let removedCovers = 0;
  let removedSegments = 0;
  let removedBytes = 0;
  let skipped = 0;
  const used = new Set<string>();

  for (const path of paths) {
    const name = basename(path);
    const bytes = read(path);
    const kind: CoverKind = isJpegBytes(bytes)
      ? 'jpeg'
      : isHeif(bytes)
        ? 'heif'
        : bytes[0] === 0x89 && bytes[1] === 0x50
          ? 'png'
          : 'other';

    if (kind !== 'jpeg') {
      covers.push({ input: path, name, kind, profile: null, removed: { segments: 0, bytes: 0 } });
      setEntries.push({ name, bytes });
      skipped++;
      continue;
    }

    // Two steps, two try blocks, because they fail for different reasons and one
    // of them fails with the inventory already in hand. Reading a profile and
    // removing a manifest used to share a block, so a photo that inventoried
    // fine and then refused removal was filed as "did not parse" with no profile
    // at all.
    let profile: CoverProfile;
    try {
      profile = inspectJpegCover(bytes);
    } catch (err) {
      covers.push({
        input: path,
        name,
        kind,
        profile: null,
        problem: err instanceof Error ? err.message : String(err),
        removed: { segments: 0, bytes: 0 },
      });
      setEntries.push({ name, bytes });
      skipped++;
      continue;
    }

    let normalized: Uint8Array;
    let removed: { segments: number; bytes: number };
    try {
      const res = normalizeJpegCover(bytes, name);
      normalized = res.bytes;
      removed = res.removed;
    } catch (err) {
      // Profile kept: it is what says which segments this photo carries and in
      // what order, which is the whole explanation of why the removal refused.
      covers.push({
        input: path,
        name,
        kind,
        profile,
        problem: err instanceof Error ? err.message : String(err),
        removed: { segments: 0, bytes: 0 },
      });
      setEntries.push({ name, bytes });
      skipped++;
      continue;
    }

    if (removed.segments > 0) {
      removedCovers++;
      removedSegments += removed.segments;
      removedBytes += removed.bytes;
    }
    setEntries.push({ name, bytes: normalized });

    const row: NormalizeCoverRow = { input: path, name, kind, profile, removed };
    if (!opts.report) {
      // Two inputs can share a basename; disambiguate so nothing is overwritten.
      let outName = name;
      for (let n = 2; used.has(outName); n++) outName = name.replace(/(\.[^.]+)?$/, `-${n}$1`);
      used.add(outName);
      const out = emit({ outDir: opts.outDir!, force: opts.force }, outName, normalized, 'photos');
      outs.push(out);
      row.output = out.path;
    }
    covers.push(row);
  }

  return {
    ...asFiles(outs),
    covers,
    set: inspectCoverSet(setEntries),
    removed: { covers: removedCovers, segments: removedSegments, bytes: removedBytes },
    // Counted as the loop goes: anything that produced no normalized bytes. A
    // PNG, a HEIC, a JPEG that did not parse, or a JPEG whose manifest could not
    // be removed safely, which keeps its profile and so cannot be found by
    // looking for a null one. They are in `set` too, where they are part of what
    // makes it non-uniform; this is the count, which means the same in both modes.
    skipped,
    report: Boolean(opts.report),
  };
}

export async function runEstimate(
  inputFile: string,
  paper: boolean,
  codec: CodecChoice = 'color',
  /**
   * Count photos for a gallery instead of images for a vault.
   *
   * A different arithmetic, not a different profile: a gallery pads the secret
   * into the §10.6 two-region blob, splits it at `SLOT_DATA` per photo, and adds
   * the minimum decoys, so the answer is a step function that starts at nine. It
   * costs one compression pass and no key derivation, which is the whole reason
   * a user should be able to ask before gathering the photos.
   */
  gallery = false,
): Promise<{ images: number; k: number; m: number }> {
  const content = read(inputFile);
  if (gallery) {
    const { k, m, needed } = await estimateGalleryCovers(basename(inputFile), content);
    return { images: needed, k, m };
  }
  return estimateImages(basename(inputFile), content, {
    profile: paper ? PROFILE_PAPER : PROFILE_DISK,
    codecId: codecIdForSave(paper, codec),
  });
}

/**
 * The codec a save will actually use. Paper always renders qr-grid, whatever was
 * asked for, so `estimate` and `save` must agree on that or their image counts
 * drift apart.
 */
export function codecIdForSave(paper: boolean, codec: CodecChoice | undefined): number {
  return !paper && codec !== 'qr' ? CODEC_COLOR_GRID : CODEC_QR_GRID;
}

// `codecArgError` / `entropyArgError` used to live here. They reject flag
// combinations by name and must stay localized, so they moved to
// `src/cli/argcheck.ts` when this module stopped depending on the CLI locale.

export { CODEC_COLOR_GRID, CODEC_QR_GRID };
