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
  CODEC_QR_GRID,
  DEFAULT_ARGON2,
  MissingKeyError,
  PROFILE_DISK,
  PROFILE_PAPER,
  WARN_FILE_BYTES,
  WrongPasswordError,
  binaryKeyName,
  binaryVaultName,
  createKeyBlock,
  decodeHeader,
  estimateImages,
  exportVault,
  exportVaultBinary,
  galleryDecode,
  galleryEncode,
  getCodec,
  importVault,
  importVaultBinary,
  serializeKeyBlock,
  toHex,
  unwrapBinary,
  wrapBinary,
  type ImageDataLike,
  type KeyMode,
  type VaultKey,
} from '@core';
import {
  embedKeyImage,
  extractKeyImage,
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

/** Write the external key artifact, copying the cover's timestamps when stego. */
function writeExternalKey(
  dir: string,
  ext: { name: string; bytes: Uint8Array; mimicPath?: string },
): string {
  const path = writeOut(dir, ext.name, ext.bytes);
  if (ext.mimicPath) {
    try {
      const s = statSync(ext.mimicPath);
      utimesSync(path, s.atime, s.mtime); // make the key image look untouched
    } catch {
      // timestamp mimicry is best-effort
    }
  }
  return path;
}

async function makeKey(password: string): Promise<VaultKey> {
  const { dek, block } = await createKeyBlock(password, DEFAULT_ARGON2);
  return { dek, keyBlock: serializeKeyBlock(block) };
}

export interface SaveOptions {
  inputFile: string;
  outDir: string;
  password: string;
  paper: boolean;
  zip: boolean;
  /** When set, output a single binary container file instead of images/PDF. */
  binary?: BinaryVariant | undefined;
  keyMode: KeyMode;
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
  files: string[];
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
): Promise<{ name: string; bytes: Uint8Array; mimicPath?: string } | undefined> {
  if (keyMode === 'stego') {
    if (!cover) throw new Error('stego mode requires a --cover image');
    const key = await embedKeyImage(read(cover), basename(cover), keyBlock, password);
    return { name: basename(cover), bytes: key.bytes, mimicPath: cover };
  }
  if (keyMode !== 'embedded') {
    return { name: `stegoshard-${setHex}.key`, bytes: keyBlock };
  }
  return undefined;
}

export async function runSave(opts: SaveOptions): Promise<SaveResult> {
  allowOverwrite = Boolean(opts.force);
  const content = read(opts.inputFile);
  const key = await makeKey(opts.password);

  // Binary (non-image) output: a single container file, no image-count ceiling.
  if (opts.binary) {
    const variant = opts.binary;
    const { container, keyBlock, keyMode } = await exportVaultBinary(
      basename(opts.inputFile),
      content,
      key,
      { keyMode: opts.keyMode, variant },
    );
    const files = [writeOut(opts.outDir, binaryVaultName(variant), container)];
    if (keyMode === 'stego') {
      const ext = await externalKey('stego', keyBlock, '', opts.password, opts.cover);
      if (ext) files.push(writeExternalKey(opts.outDir, ext));
    } else if (keyMode === 'keyfile') {
      files.push(writeOut(opts.outDir, binaryKeyName(variant), wrapBinary(keyBlock, variant)));
    }
    return { files, imageCount: 0, setId: '', keyMode, binary: variant };
  }

  const profile = opts.paper ? PROFILE_PAPER : PROFILE_DISK;

  const { imagePayloads, setId, keyBlock, keyMode } = await exportVault(
    basename(opts.inputFile),
    content,
    key,
    { profile, keyMode: opts.keyMode },
  );
  const codec = getCodec(decodeHeader(imagePayloads[0]!).codecId);
  const setHex = toHex(setId);
  const files: string[] = [];
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
    files.push(writeOut(opts.outDir, `stegoshard-${setHex}.pdf`, built.pdf));
    if (ext) files.push(writeExternalKey(opts.outDir, ext));
    return {
      files,
      imageCount: imagePayloads.length,
      setId: setHex,
      keyMode,
      effectiveLocale: built.effectiveLocale,
      ...(built.fontWarning ? { fontWarning: built.fontWarning } : {}),
      ...(sizeWarning ? { sizeWarning } : {}),
    };
  }

  // Disk: one PNG per image, or a single .zip.
  const pngs = imagePayloads.map((payload, i) => ({
    name: `stegoshard-${setHex}-${String(i + 1).padStart(2, '0')}.png`,
    bytes: imageDataToPng(codec.encode(payload, PROFILE_DISK)),
  }));

  if (opts.zip) {
    const entries: Record<string, Uint8Array> = {};
    for (const p of pngs) entries[p.name] = p.bytes;
    if (ext && keyMode === 'keyfile') entries[ext.name] = ext.bytes;
    files.push(writeOut(opts.outDir, `stegoshard-${setHex}.zip`, zipSync(entries, { level: 0 })));
    // The stego image is always delivered on its own (an innocuous photo).
    if (ext && keyMode === 'stego') files.push(writeExternalKey(opts.outDir, ext));
  } else {
    for (const p of pngs) files.push(writeOut(opts.outDir, p.name, p.bytes));
    if (ext) files.push(writeExternalKey(opts.outDir, ext));
  }

  return {
    files,
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
  /** Overwrite an existing output file instead of refusing. */
  force?: boolean | undefined;
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
    // Enough to cover the disguised variant's 100-byte SQLite header.
    const buf = Buffer.alloc(128);
    const n = readSync(fd, buf, 0, 128, 0);
    return unwrapBinary(new Uint8Array(buf.subarray(0, n))) !== null;
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
  if (isKeyFile(keyPath)) return bytes; // raw .key (92 bytes)
  return (await extractKeyImage(bytes, basename(keyPath), password)) ?? undefined; // stego image
}

export async function runRestore(opts: RestoreOptions): Promise<RestoreResult> {
  allowOverwrite = Boolean(opts.force);
  const binaryVaultPath = opts.inputs.find(isBinaryContainerFile);
  if (binaryVaultPath) {
    const keyBlock = opts.keyPath ? await resolveKeyBlock(opts.keyPath, opts.password) : undefined;
    const { filename, content } = await importVaultBinary(read(binaryVaultPath), opts.password, {
      keyBlock,
    });
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
  /** Overwrite existing output files instead of refusing. */
  force?: boolean | undefined;
}

export interface GallerySaveResult {
  files: string[];
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

  const res = await galleryEncode(basename(opts.secretFile), content, opts.password, covers, {
    keyMode,
  });
  const setHex = toHex(res.setId);

  const used = new Set<string>();
  const files = res.images.map((img) => {
    const f = galleryImageToFile(img);
    let name = f.name;
    // Two covers can share a basename; disambiguate so nothing is overwritten.
    for (let n = 2; used.has(name); n++) name = f.name.replace(/(\.[^.]+)?$/, `-${n}$1`);
    used.add(name);
    return writeOut(opts.outDir, name, f.bytes);
  });
  // Deliver the external key alongside the photos for keyfile/stego galleries.
  const ext = await externalKey(keyMode, res.keyBlock, setHex, opts.password, opts.keyCover);
  if (ext) files.push(writeExternalKey(opts.outDir, ext));
  return { files, k: res.k, m: res.m, decoys: res.decoys, setId: setHex, keyMode };
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
  const { filename, content } = await galleryDecode(covers, opts.password, { keyBlock });
  const outName = basename(filename) || 'restored.bin';
  const outPath = writeOut(opts.outDir, outName, content);
  return { outPath, filename, seen: covers.length };
}

export async function runEstimate(
  inputFile: string,
  paper: boolean,
): Promise<{ images: number; k: number; m: number }> {
  const content = read(inputFile);
  return estimateImages(basename(inputFile), content, {
    profile: paper ? PROFILE_PAPER : PROFILE_DISK,
  });
}

// Re-export so main.ts can reference the codec id if needed.
export { CODEC_QR_GRID };
