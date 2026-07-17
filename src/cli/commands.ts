/**
 * CLI command implementations, separated from argument parsing so they can be
 * unit-tested directly (save→restore round-trips) without spawning a process.
 * All file I/O is Node `fs`; all crypto/codec work is the shared `@core`.
 */

import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { zipSync } from 'fflate';
import {
  CODEC_QR_GRID,
  DEFAULT_ARGON2,
  MissingKeyError,
  PROFILE_DISK,
  PROFILE_PAPER,
  WrongPasswordError,
  createKeyBlock,
  decodeHeader,
  estimateImages,
  exportVault,
  getCodec,
  importVault,
  serializeKeyBlock,
  toHex,
  type ImageDataLike,
  type KeyMode,
  type VaultKey,
} from '@core';
import { embedKeyImage, extractKeyImage, imageDataToPng } from './node-image-io';
import { gatherInputs } from './inputs';
import { buildCliPaperPdf } from './paper';

export { WrongPasswordError, MissingKeyError };

function read(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

function writeOut(dir: string, name: string, bytes: Uint8Array): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
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
  keyMode: KeyMode;
  cover?: string | undefined; // stego cover image path
  title?: string | undefined;
  date?: string | undefined;
  locale?: string | undefined;
  instructions?: boolean | undefined;
  passwordHint?: string | undefined;
  keyLocation?: string | undefined;
  fontPath?: string | undefined;
}

export interface SaveResult {
  files: string[];
  imageCount: number;
  setId: string;
  keyMode: KeyMode;
  effectiveLocale?: string;
  fontWarning?: string;
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
    return { name: `imagevault-${setHex}.key`, bytes: keyBlock };
  }
  return undefined;
}

export async function runSave(opts: SaveOptions): Promise<SaveResult> {
  const content = read(opts.inputFile);
  const key = await makeKey(opts.password);
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
    files.push(writeOut(opts.outDir, `imagevault-${setHex}.pdf`, built.pdf));
    if (ext) files.push(writeExternalKey(opts.outDir, ext));
    return {
      files,
      imageCount: imagePayloads.length,
      setId: setHex,
      keyMode,
      effectiveLocale: built.effectiveLocale,
      ...(built.fontWarning ? { fontWarning: built.fontWarning } : {}),
    };
  }

  // Disk: one PNG per image, or a single .zip.
  const pngs = imagePayloads.map((payload, i) => ({
    name: `imagevault-${setHex}-${String(i + 1).padStart(2, '0')}.png`,
    bytes: imageDataToPng(codec.encode(payload, PROFILE_DISK)),
  }));

  if (opts.zip) {
    const entries: Record<string, Uint8Array> = {};
    for (const p of pngs) entries[p.name] = p.bytes;
    if (ext && keyMode === 'keyfile') entries[ext.name] = ext.bytes;
    files.push(writeOut(opts.outDir, `imagevault-${setHex}.zip`, zipSync(entries, { level: 0 })));
    // The stego image is always delivered on its own (an innocuous photo).
    if (ext && keyMode === 'stego') files.push(writeExternalKey(opts.outDir, ext));
  } else {
    for (const p of pngs) files.push(writeOut(opts.outDir, p.name, p.bytes));
    if (ext) files.push(writeExternalKey(opts.outDir, ext));
  }

  return { files, imageCount: imagePayloads.length, setId: setHex, keyMode };
}

export interface RestoreOptions {
  inputs: string[];
  outDir: string;
  password: string;
  keyPath?: string | undefined;
}

export interface RestoreResult {
  outPath: string;
  filename: string;
  seen: number;
  decoded: number;
}

const isKeyFile = (n: string) => /\.key$/i.test(n);

export async function runRestore(opts: RestoreOptions): Promise<RestoreResult> {
  const gathered = await gatherInputs(opts.inputs);
  let keyBlock = gathered.keyBlock;

  if (opts.keyPath) {
    const bytes = read(opts.keyPath);
    keyBlock = isKeyFile(opts.keyPath)
      ? bytes
      : ((await extractKeyImage(bytes, basename(opts.keyPath), opts.password)) ?? undefined);
  }

  if (gathered.payloads.length === 0) {
    throw new Error('no readable ImageVault images found in the inputs');
  }

  const { filename, content } = await importVault(gathered.payloads, opts.password, { keyBlock });
  const outName = basename(filename) || 'restored.bin';
  const outPath = writeOut(opts.outDir, outName, content);
  return { outPath, filename, seen: gathered.seen, decoded: gathered.decoded };
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
