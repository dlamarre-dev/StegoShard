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
  galleryEncode,
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
  buildDuressDbContainer,
  buildNonPossessionDbContainer,
  shareFileText,
  decodeShareText,
  shamirRecover,
  randomBytes,
  KEY_FACTOR_LEN,
  type FilePurpose,
  type ImageDataLike,
  type KeyMode,
  type ManifestEntry,
  type OnProgress,
  type VaultIdentity,
  type StegoEmbedOptions,
  type CoverClaim,
} from '../../core';
import {
  embedKeyImage,
  embedKeyFactorImage,
  extractKeyImage,
  extractKeyFactorImage,
  fileToGalleryCover,
  galleryImageToFile,
  imageDataToPng,
} from './image-io';
import { gatherImageFiles, gatherInputs, walk } from './inputs';
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
function writeExternalKey(target: WriteTarget, ext: KeyArtifact): OutFile {
  const path = writeOut(target, ext.name, ext.bytes);
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
  // `mimicPath` is set only when the key rode inside the user's cover photo.
  return { path, purpose: ext.mimicPath ? 'stegoCover' : 'keyfile' };
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
 * Produce the external key artifact for non-embedded modes. Stego keeps the
 * cover's format and reuses its **filename** (to blend into a photo library);
 * `mimicPath` is the cover whose mtime/atime the output should copy.
 */
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
 * A stego claim riding along with the artifact it belongs to.
 *
 * `writeExternalKey` is the LAST write on every save path, which is what makes
 * this tractable: if a save throws, the stego key image did not reach disk and the
 * claim must go. If it DID land, the claim stands even when something later fails
 * -- there is a real artifact out there, and releasing would let a retry mint a
 * second one from the same cover under one password, which is the leak SPEC §5.3
 * forbids. `landed` is what tells those two apart, and it is set by the write
 * rather than inferred from where an exception was caught.
 */
interface KeyArtifact {
  name: string;
  bytes: Uint8Array;
  mimicPath?: string;
  /** Set by `externalKey`; called by `writeExternalKey` once the bytes are on disk. */
  onLanded?: (() => void) | undefined;
}

async function externalKey(
  keyMode: KeyMode,
  keyBlock: Uint8Array,
  setHex: string,
  password: string,
  cover: string | undefined,
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
    const key =
      variant === 'factor'
        ? await embedKeyFactorImage(read(cover), basename(cover), keyBlock, password, embedOpts)
        : await embedKeyImage(read(cover), basename(cover), keyBlock, password, embedOpts);
    return { name: basename(cover), bytes: key.bytes, mimicPath: cover, onLanded: landed };
  }
  if (keyMode !== 'embedded') {
    return { name: `stegoshard-${setHex}.key`, bytes: keyBlock };
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
    const ext = await externalKey(
      'stego',
      keyFactor,
      '',
      opts.password,
      opts.cover,
      'factor',
      reuseOpt(opts),
      hold,
      landed,
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
    const ext = await externalKey(
      'stego',
      keyBlock,
      '',
      opts.password,
      opts.cover,
      'factor',
      reuseOpt(opts),
      hold,
      landed,
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
      const ext = await externalKey(
        'stego',
        keyBlock,
        '',
        opts.password,
        opts.cover,
        'block',
        reuseOpt(opts),
        hold,
        landed,
      );
      if (ext) outs.push(writeExternalKey(opts, ext));
    } else if (keyMode === 'keyfile') {
      outs.push(emit(opts, binaryKeyName(variant), wrapBinary(keyBlock, variant), 'keyfile'));
    }
    return { ...asFiles(outs), imageCount: 0, setId: '', keyMode, binary: variant };
  }

  const profile = opts.paper ? PROFILE_PAPER : PROFILE_DISK;
  const codecId = codecIdForSave(opts.paper, opts.codec);

  const { imagePayloads, setId, keyBlock, keyMode } = await exportVault(input.name, content, key, {
    profile,
    codecId,
    keyMode: opts.keyMode,
    bundle: input.bundle,
    identity: opts.identity,
  });
  // Read it back from the header rather than trusting the request, so the
  // rendered pixels and the recovery line can never disagree with the payload.
  const codec = getCodec(decodeHeader(imagePayloads[0]!).codecId);
  await verifyImageExport(imagePayloads, key.dek, input.name, content);
  const setHex = toHex(setId);
  const outs: OutFile[] = [];
  const ext = await externalKey(
    keyMode,
    keyBlock,
    setHex,
    opts.password,
    opts.cover,
    'block',
    reuseOpt(opts),
    hold,
    landed,
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
  const pngs = imagePayloads.map((payload, i) => {
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
    return {
      name: `stegoshard-${setHex}-${String(i + 1).padStart(2, '0')}.png`,
      bytes: imageDataToPng(img),
    };
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

/** Save a vault. See {@link SaveOptions}. */
export async function runSave(opts: SaveOptions, onProgress?: OnProgress): Promise<SaveResult> {
  return withKeyClaim((hold, landed) => runSaveImpl(opts, onProgress, hold, landed));
}

/** Save a gallery. See {@link GallerySaveOptions}. */
export async function runGallerySave(opts: GallerySaveOptions): Promise<GallerySaveResult> {
  return withKeyClaim((hold, landed) => runGallerySaveImpl(opts, hold, landed));
}

export async function runRestore(
  opts: RestoreOptions,
  onProgress?: OnProgress,
): Promise<RestoreResult> {
  const binaryVaultPath = opts.inputs.find(isBinaryContainerFile);
  if (binaryVaultPath) {
    const keyBlock = opts.keyPath ? await resolveKeyBlock(opts.keyPath, opts.password) : undefined;
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

  const { filename, content, bundled, identity } = await importVault(
    gathered.payloads,
    opts.password,
    { keyBlock },
  );
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
}

async function runGallerySaveImpl(
  opts: GallerySaveOptions,
  hold: (claim: CoverClaim) => void,
  landed: () => void,
): Promise<GallerySaveResult> {
  const keyMode = opts.keyMode ?? 'embedded';
  const content = read(opts.secretFile);
  const coverPaths = gatherImageFiles(opts.covers);
  if (coverPaths.length === 0) {
    throw new StegoShardApiError('NO_COVERS_FOUND', 'no usable cover photos found');
  }
  const covers = coverPaths.map((p) => fileToGalleryCover(read(p), basename(p)));

  const mode = opts.mode ?? 'plain';
  const secretName = basename(opts.secretFile);
  const res = await galleryEncode(secretName, content, opts.password, covers, {
    keyMode,
    mode,
    threshold: opts.threshold,
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
    );
  } else {
    await verifyGalleryExport(
      res.images,
      opts.password,
      keyMode === 'embedded' ? undefined : res.keyBlock,
      secretName,
      content,
    );
  }
  const setHex = toHex(res.setId);

  const used = new Set<string>();
  const outs: OutFile[] = res.images.map((img) => {
    const f = galleryImageToFile(img);
    let name = f.name;
    // Two covers can share a basename; disambiguate so nothing is overwritten.
    for (let n = 2; used.has(name); n++) name = f.name.replace(/(\.[^.]+)?$/, `-${n}$1`);
    used.add(name);
    return emit(opts, name, f.bytes, 'photos');
  });
  // Deliver the external key alongside the photos for keyfile/stego galleries.
  // Gallery is a multi-region path → the external artifact is the 32-byte factor.
  const ext = await externalKey(
    keyMode,
    res.keyBlock,
    setHex,
    opts.password,
    opts.keyCover,
    'factor',
    reuseOpt(opts),
    hold,
    landed,
  );
  if (ext) outs.push(writeExternalKey(opts, ext));
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
  return { ...asFiles(outs), k: res.k, m: res.m, decoys: res.decoys, setId: setHex, keyMode };
}

export interface GalleryRestoreResult {
  outPath: string;
  /** Every path written, first one first. Always length 1: a gallery holds one secret. */
  files: string[];
  filename: string;
  seen: number;
}

export async function runGalleryRestore(opts: RestoreOptions): Promise<GalleryRestoreResult> {
  const coverPaths = gatherImageFiles(opts.inputs);
  if (coverPaths.length === 0) {
    throw new StegoShardApiError('NO_GALLERY_IMAGES', 'no images to scan for a gallery');
  }
  const covers = coverPaths.map((p) => fileToGalleryCover(read(p), basename(p)));

  // A keyfile/stego gallery delivers its key separately (--key: a .key or cover photo).
  const keyBlock = opts.keyPath ? await resolveKeyBlock(opts.keyPath, opts.password) : undefined;
  // A non-possession gallery is gated on threshold shares (--share).
  const secret = await recoverSecret(opts.sharePaths);
  const { filename, content } = await galleryDecode(covers, opts.password, { keyBlock, secret });
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

export async function runEstimate(
  inputFile: string,
  paper: boolean,
  codec: CodecChoice = 'color',
): Promise<{ images: number; k: number; m: number }> {
  const content = read(inputFile);
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
