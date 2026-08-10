/**
 * CLI command implementations, separated from argument parsing so they can be
 * unit-tested directly (save→restore round-trips) without spawning a process.
 * All file I/O is Node `fs`; all crypto/codec work is the shared `@core`.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { zipSync } from 'fflate';
import {
  type BinaryVariant,
  CODEC_COLOR_GRID,
  CODEC_QR_GRID,
  DEFAULT_ARGON2,
  MissingKeyError,
  PROFILE_DISK,
  PROFILE_PAPER,
  WARN_FILE_BYTES,
  WrongPasswordError,
  binaryKeyName,
  binaryVaultName,
  codecName,
  createKeyBlock,
  decodeHeader,
  drawBrandBand,
  estimateImages,
  exportVault,
  exportVaultBinary,
  exportVaultBinaryDisguised,
  galleryDecode,
  galleryEncode,
  getCodec,
  importVault,
  importVaultBinary,
  isRenderableAscii,
  looksLikeBinaryContainer,
  recoveryLines,
  serializeKeyBlock,
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
  type VaultKey,
} from '@core';
import {
  embedKeyImage,
  embedKeyFactorImage,
  extractKeyImage,
  extractKeyFactorImage,
  fileToGalleryCover,
  galleryImageToFile,
  imageDataToPng,
} from './node-image-io';
import { gatherImageFiles, gatherInputs } from './inputs';
import { buildCliPaperPdf } from './paper';

export { WrongPasswordError, MissingKeyError };

function read(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

// Set per run from the command's --force flag; guards writeOut against clobbering
// existing files (a mistyped --out, or restoring a name that already exists).
let allowOverwrite = false;

function writeOut(dir: string, name: string, bytes: Uint8Array): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  if (!allowOverwrite && existsSync(path)) {
    throw new Error(`refusing to overwrite existing file: ${path} (use --force to overwrite)`);
  }
  writeFileSync(path, bytes);
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
function emit(dir: string, name: string, bytes: Uint8Array, purpose: FilePurpose): OutFile {
  return { path: writeOut(dir, name, bytes), purpose };
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
function writeExternalKey(
  dir: string,
  ext: { name: string; bytes: Uint8Array; mimicPath?: string },
): OutFile {
  const path = writeOut(dir, ext.name, ext.bytes);
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

async function makeKey(password: string): Promise<VaultKey> {
  const { dek, block } = await createKeyBlock(password, DEFAULT_ARGON2);
  return { dek, keyBlock: serializeKeyBlock(block) };
}

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
  inputFile: string;
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
async function externalKey(
  keyMode: KeyMode,
  keyBlock: Uint8Array,
  setHex: string,
  password: string,
  cover: string | undefined,
  // Single-region paths (branded .ssbn, disk, paper) hide a 92-byte key block;
  // multi-region paths (gallery, disguised .db) hide the 32-byte key factor.
  variant: 'block' | 'factor' = 'block',
): Promise<{ name: string; bytes: Uint8Array; mimicPath?: string } | undefined> {
  if (keyMode === 'stego') {
    if (!cover) throw new Error('stego mode requires a --cover image');
    const key =
      variant === 'factor'
        ? await embedKeyFactorImage(read(cover), basename(cover), keyBlock, password)
        : await embedKeyImage(read(cover), basename(cover), keyBlock, password);
    return { name: basename(cover), bytes: key.bytes, mimicPath: cover };
  }
  if (keyMode !== 'embedded') {
    return { name: `stegoshard-${setHex}.key`, bytes: keyBlock };
  }
  return undefined;
}

/** Save the disguised .db vault in the requested access mode (§10). */
async function runSaveDisguised(
  opts: SaveOptions,
  content: Uint8Array,
  onProgress?: OnProgress,
): Promise<SaveResult> {
  const mode = opts.mode ?? 'plain';
  const name = basename(opts.inputFile);
  const outName = binaryVaultName('disguised');
  const keyMode = opts.keyMode ?? 'embedded';
  // keyfile/stego mint a 32-byte external key factor (§10.3); it composes with any
  // access mode (an extra layer on top of the password / duress / shares).
  const keyFactor = keyMode === 'embedded' ? null : randomBytes(KEY_FACTOR_LEN);

  /** Deliver the minted key factor as a .key container (keyfile) or hidden in a
   *  cover photo (stego), keyed by the per-save password. */
  async function deliverFactor(): Promise<OutFile[]> {
    if (!keyFactor) return [];
    if (keyMode === 'keyfile') {
      return [
        emit(
          opts.outDir,
          binaryKeyName('disguised'),
          wrapBinary(keyFactor, 'disguised'),
          'keyfile',
        ),
      ];
    }
    const ext = await externalKey('stego', keyFactor, '', opts.password, opts.cover, 'factor');
    return ext ? [writeExternalKey(opts.outDir, ext)] : [];
  }

  if (mode === 'duress') {
    if (!opts.decoyFile) throw new Error('save: --mode duress requires --decoy <file>');
    if (!opts.duressPassword) throw new Error('save: --mode duress requires a duress password');
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
    );
    const outs = [emit(opts.outDir, outName, container, 'vault'), ...(await deliverFactor())];
    return { ...asFiles(outs), imageCount: 0, setId: '', keyMode, binary: 'disguised' };
  }

  if (mode === 'nonpossession') {
    if (!opts.threshold) throw new Error('save: --mode nonpossession requires --threshold k-of-n');
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
    );
    const outs = [emit(opts.outDir, outName, container, 'vault'), ...(await deliverFactor())];
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
      outs.push(
        emit(opts.outDir, `recovery-${i + 1}.txt`, new TextEncoder().encode(body), 'share'),
      );
    });
    return { ...asFiles(outs), imageCount: 0, setId: '', keyMode, binary: 'disguised' };
  }

  // plain
  const { container, keyBlock, regionIndex, dek } = await exportVaultBinaryDisguised(
    name,
    content,
    opts.password,
    { keyMode },
    onProgress,
  );
  await verifyDisguisedExport(container, dek, regionIndex, name, content, onProgress);
  const outs = [emit(opts.outDir, outName, container, 'vault')];
  if (keyMode === 'keyfile') {
    outs.push(
      emit(opts.outDir, binaryKeyName('disguised'), wrapBinary(keyBlock, 'disguised'), 'keyfile'),
    );
  } else if (keyMode === 'stego') {
    // The .db is a multi-region path → hide the 32-byte key factor (SSKF) in the
    // cover, keyed by the same per-save password that derives the slot KEK.
    const ext = await externalKey('stego', keyBlock, '', opts.password, opts.cover, 'factor');
    if (ext) outs.push(writeExternalKey(opts.outDir, ext));
  }
  return { ...asFiles(outs), imageCount: 0, setId: '', keyMode, binary: 'disguised' };
}

export async function runSave(opts: SaveOptions, onProgress?: OnProgress): Promise<SaveResult> {
  allowOverwrite = Boolean(opts.force);
  const content = read(opts.inputFile);

  // Disguised .db output: a §10 multi-region container keyed by the PASSWORD (each
  // region gets its own DEK — the managed key is not used on this supported path).
  if (opts.binary === 'disguised') {
    return runSaveDisguised(opts, content, onProgress);
  }
  // A non-plain access mode is only meaningful on the supported .db path.
  if (opts.mode && opts.mode !== 'plain') {
    throw new Error(`save: --mode ${opts.mode} is only supported with --binary --disguise`);
  }

  const key = await makeKey(opts.password);

  // Branded .ssbn output (excluded path): single-region, managed DEK, unchanged.
  if (opts.binary) {
    const variant = opts.binary;
    const { container, keyBlock, keyMode } = await exportVaultBinary(
      basename(opts.inputFile),
      content,
      key,
      { keyMode: opts.keyMode, variant },
      onProgress,
    );
    await verifyBinaryExport(container, key.dek, basename(opts.inputFile), content, onProgress);
    const outs = [emit(opts.outDir, binaryVaultName(variant), container, 'vault')];
    if (keyMode === 'stego') {
      const ext = await externalKey('stego', keyBlock, '', opts.password, opts.cover);
      if (ext) outs.push(writeExternalKey(opts.outDir, ext));
    } else if (keyMode === 'keyfile') {
      outs.push(
        emit(opts.outDir, binaryKeyName(variant), wrapBinary(keyBlock, variant), 'keyfile'),
      );
    }
    return { ...asFiles(outs), imageCount: 0, setId: '', keyMode, binary: variant };
  }

  const profile = opts.paper ? PROFILE_PAPER : PROFILE_DISK;
  const codecId = codecIdForSave(opts.paper, opts.codec);

  const { imagePayloads, setId, keyBlock, keyMode } = await exportVault(
    basename(opts.inputFile),
    content,
    key,
    { profile, codecId, keyMode: opts.keyMode },
  );
  // Read it back from the header rather than trusting the request, so the
  // rendered pixels and the recovery line can never disagree with the payload.
  const codec = getCodec(decodeHeader(imagePayloads[0]!).codecId);
  await verifyImageExport(imagePayloads, key.dek, basename(opts.inputFile), content);
  const setHex = toHex(setId);
  const outs: OutFile[] = [];
  const ext = await externalKey(keyMode, keyBlock, setHex, opts.password, opts.cover);
  // Large secrets sprawl into many images; nudge toward --binary before writing.
  const sizeWarning =
    content.length > WARN_FILE_BYTES
      ? `Large secret (${Math.round(content.length / 1024)} KiB) → ${imagePayloads.length} image(s). ` +
        `Consider --binary for a single file.`
      : undefined;

  if (opts.paper) {
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
    outs.push(emit(opts.outDir, `stegoshard-${setHex}.pdf`, built.pdf, 'document'));
    if (ext) outs.push(writeExternalKey(opts.outDir, ext));
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
  // pixel. --title/--date land here too; the core font is ASCII-only, so a title
  // it cannot render is dropped rather than mangled.
  const recovery = recoveryLines(codecName(codecId));
  const pngs = imagePayloads.map((payload, i) => {
    const caption = [opts.title, opts.date, `${i + 1} / ${imagePayloads.length}`]
      .filter((s): s is string => Boolean(s))
      .filter(isRenderableAscii);
    const img = drawBrandBand(codec.encode(payload, PROFILE_DISK), { recovery, lines: caption });
    return {
      name: `stegoshard-${setHex}-${String(i + 1).padStart(2, '0')}.png`,
      bytes: imageDataToPng(img),
    };
  });

  if (opts.zip) {
    const entries: Record<string, Uint8Array> = {};
    for (const p of pngs) entries[p.name] = p.bytes;
    if (ext && keyMode === 'keyfile') entries[ext.name] = ext.bytes;
    outs.push(
      emit(opts.outDir, `stegoshard-${setHex}.zip`, zipSync(entries, { level: 0 }), 'archive'),
    );
    // The stego image is always delivered on its own (an innocuous photo).
    if (ext && keyMode === 'stego') outs.push(writeExternalKey(opts.outDir, ext));
  } else {
    for (const p of pngs) outs.push(emit(opts.outDir, p.name, p.bytes, 'vault'));
    if (ext) outs.push(writeExternalKey(opts.outDir, ext));
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
  outPath: string;
  filename: string;
  seen: number;
  decoded: number;
}

const isKeyFile = (n: string) => /\.key$/i.test(n);

/** Peek a file's first bytes to see whether it is a binary container (SPEC §8). */
function isBinaryContainerFile(path: string): boolean {
  // Open once and inspect the descriptor (fstat), never re-resolving the path —
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

export async function runRestore(
  opts: RestoreOptions,
  onProgress?: OnProgress,
): Promise<RestoreResult> {
  allowOverwrite = Boolean(opts.force);
  const binaryVaultPath = opts.inputs.find(isBinaryContainerFile);
  if (binaryVaultPath) {
    const keyBlock = opts.keyPath ? await resolveKeyBlock(opts.keyPath, opts.password) : undefined;
    // Threshold shares (Mode B) recover the secret that gates the .db slot.
    const secret = await recoverSecret(opts.sharePaths);
    const { filename, content } = await importVaultBinary(
      read(binaryVaultPath),
      opts.password,
      { keyBlock, secret: secret ?? null },
      onProgress,
    );
    const outName = basename(filename) || 'restored.bin';
    const outPath = writeOut(opts.outDir, outName, content);
    return { outPath, filename, seen: 1, decoded: 1 };
  }

  const gathered = await gatherInputs(opts.inputs);
  let keyBlock = gathered.keyBlock;
  if (opts.keyPath) keyBlock = await resolveKeyBlock(opts.keyPath, opts.password);

  if (gathered.payloads.length === 0) {
    throw new Error('no readable StegoShard images found in the inputs');
  }

  const { filename, content } = await importVault(gathered.payloads, opts.password, { keyBlock });
  const outName = basename(filename) || 'restored.bin';
  const outPath = writeOut(opts.outDir, outName, content);
  return { outPath, filename, seen: gathered.seen, decoded: gathered.decoded };
}

// --- Gallery Mode (SPEC §9) --------------------------------------------------

export interface GallerySaveOptions {
  secretFile: string;
  /** Cover photo paths and/or directories to draw covers from. */
  covers: string[];
  outDir: string;
  password: string;
  /** 'embedded' (default), 'keyfile', or 'stego' — how the key is delivered. */
  keyMode?: KeyMode;
  /** Cover photo for --key-mode stego (the key is hidden in it). */
  keyCover?: string | undefined;
  /** §10 access mode: 'plain' (default) or 'nonpossession' (Mode B). Duress is not
   *  available on gallery (winnowing key is password-derived, SPEC §10.11). */
  mode?: 'plain' | 'nonpossession';
  threshold?: { k: number; n: number } | undefined;
  /** Overwrite existing output files instead of refusing. */
  force?: boolean | undefined;
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

export async function runGallerySave(opts: GallerySaveOptions): Promise<GallerySaveResult> {
  allowOverwrite = Boolean(opts.force);
  const keyMode = opts.keyMode ?? 'embedded';
  const content = read(opts.secretFile);
  const coverPaths = gatherImageFiles(opts.covers);
  if (coverPaths.length === 0) throw new Error('gallery: no cover images found in the given paths');
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
    // shares (§10.3), so the factor must be supplied to the verify too — otherwise
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
    return emit(opts.outDir, name, f.bytes, 'photos');
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
  );
  if (ext) outs.push(writeExternalKey(opts.outDir, ext));
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
      outs.push(
        emit(opts.outDir, `recovery-${i + 1}.txt`, new TextEncoder().encode(body), 'share'),
      );
    });
  }
  return { ...asFiles(outs), k: res.k, m: res.m, decoys: res.decoys, setId: setHex, keyMode };
}

export interface GalleryRestoreResult {
  outPath: string;
  filename: string;
  seen: number;
}

export async function runGalleryRestore(opts: RestoreOptions): Promise<GalleryRestoreResult> {
  allowOverwrite = Boolean(opts.force);
  const coverPaths = gatherImageFiles(opts.inputs);
  if (coverPaths.length === 0) throw new Error('gallery: no images found in the inputs');
  const covers = coverPaths.map((p) => fileToGalleryCover(read(p), basename(p)));

  // A keyfile/stego gallery delivers its key separately (--key: a .key or cover photo).
  const keyBlock = opts.keyPath ? await resolveKeyBlock(opts.keyPath, opts.password) : undefined;
  // A non-possession gallery is gated on threshold shares (--share).
  const secret = await recoverSecret(opts.sharePaths);
  const { filename, content } = await galleryDecode(covers, opts.password, { keyBlock, secret });
  const outName = basename(filename) || 'restored.bin';
  const outPath = writeOut(opts.outDir, outName, content);
  return { outPath, filename, seen: covers.length };
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

/**
 * Reject a `--codec` / `--paper` combination that cannot mean what it says, and
 * return the message to print. Null when the arguments are fine.
 *
 * `requested` is what the user actually typed, not the resolved default: plain
 * `--paper` must keep working, and only an *explicit* `--codec color --paper` is
 * a mistake worth naming.
 */
export function codecArgError(requested: string | undefined, paper: boolean): string | null {
  if (requested !== undefined && !CODEC_CHOICES.includes(requested as CodecChoice)) {
    return `invalid --codec "${requested}"`;
  }
  if (requested === 'color' && paper) {
    return '--codec color cannot be used with --paper (printed pages use QR)';
  }
  return null;
}

/** The ways the extra entropy layer can be supplied on the command line. */
export interface EntropySources {
  /** `--entropy <text>` */
  text?: string | undefined;
  /** `--entropy-file <path>` */
  file?: string | undefined;
  /** `--entropy-prompt` */
  prompt?: boolean | undefined;
}
// `STEGOSHARD_ENTROPY` is not listed: like STEGOSHARD_PASSWORD it is an ambient
// fallback that any typed flag simply outranks, so there is no combination of
// sources to reject.

/**
 * Reject an unusable `--entropy*` combination and return the message to print.
 * Null when the arguments are fine.
 *
 * Two rules. Combining sources is refused because it would be ambiguous which
 * one won — and silently ignoring the other is exactly the kind of surprise a
 * user reaching for this option cannot afford. An explicitly *empty* source is
 * refused for the same reason `resolvePassword` refuses an empty password: the
 * flag would have done nothing at all, and the user would never know.
 */
export function entropyArgError(src: EntropySources): string | null {
  const given = [
    src.text !== undefined && '--entropy',
    src.file !== undefined && '--entropy-file',
    src.prompt === true && '--entropy-prompt',
  ].filter((s): s is string => typeof s === 'string');
  if (given.length > 1) {
    return `${given.join(' and ')} are mutually exclusive (pick one entropy source)`;
  }
  if (src.text !== undefined && src.text === '') {
    return '--entropy was empty (omit the flag if you do not want extra entropy)';
  }
  return null;
}

export { CODEC_COLOR_GRID, CODEC_QR_GRID };
