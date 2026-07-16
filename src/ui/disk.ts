/**
 * Disk destination flow (plan §6): the offline default, needing no network
 * permission. Save renders the vault's image set to PNG files — either as
 * individual downloads or bundled into one .zip; restore reads image files (or
 * a .zip) back and reconstructs the original file.
 */

import {
  getCodec,
  exportVault,
  importVault,
  MAX_IMAGES,
  PROFILE_DISK,
  decodeHeader,
  toHex,
  type KeyMode,
  type VaultKey,
} from '@core';
import { unzipSync, zipSync } from 'fflate';
import {
  decodeImageBytes,
  downloadBlob,
  imageWithLabelToPngBlob,
  type LabelBand,
} from './image-io';

export interface SaveOptions {
  keyMode: KeyMode;
  /** When set, a readable title band is drawn above each image. */
  label?: { title?: string; date?: string } | undefined;
  /** Bundle all images (+ .key) into a single .zip instead of many files. */
  asZip?: boolean;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Encode a file into a set of PNG images and download them (or a .zip). */
export async function saveFileToDisk(
  file: File,
  key: VaultKey,
  options: SaveOptions,
): Promise<{ imageCount: number; setId: string; keyMode: KeyMode }> {
  const content = new Uint8Array(await file.arrayBuffer());
  const { imagePayloads, setId, keyBlock, keyMode } = await exportVault(file.name, content, key, {
    profile: PROFILE_DISK,
    keyMode: options.keyMode,
  });
  const codec = getCodec(decodeHeader(imagePayloads[0]!).codecId);
  const setHex = toHex(setId);
  const total = imagePayloads.length;

  const pngs: { name: string; bytes: Uint8Array }[] = [];
  for (let i = 0; i < total; i++) {
    const img = codec.encode(imagePayloads[i]!, PROFILE_DISK);
    const band: LabelBand | undefined = options.label
      ? { ...options.label, index: i + 1, total }
      : undefined;
    const index = String(i + 1).padStart(2, '0');
    pngs.push({
      name: `imagevault-${setHex}-${index}.png`,
      bytes: await blobBytes(await imageWithLabelToPngBlob(img, band)),
    });
  }
  // Key block is external for keyfile/stego modes.
  const keyName = `imagevault-${setHex}.key`;
  const hasKeyFile = keyMode !== 'embedded';

  if (options.asZip) {
    const entries: Record<string, Uint8Array> = {};
    for (const p of pngs) entries[p.name] = p.bytes;
    if (hasKeyFile) entries[keyName] = keyBlock;
    const zipped = zipSync(entries, { level: 0 }); // PNGs are already compressed
    downloadBlob(new Blob([zipped as BufferSource]), `imagevault-${setHex}.zip`);
  } else {
    for (const p of pngs) {
      downloadBlob(new Blob([p.bytes as BufferSource], { type: 'image/png' }), p.name);
      await new Promise((r) => setTimeout(r, 150)); // avoid batch-blocking
    }
    if (hasKeyFile) downloadBlob(new Blob([keyBlock as BufferSource]), keyName);
  }

  return { imageCount: total, setId: setHex, keyMode };
}

const isZip = (name: string) => name.toLowerCase().endsWith('.zip');
const isKey = (name: string) => name.toLowerCase().endsWith('.key');
const isPdf = (name: string) => name.toLowerCase().endsWith('.pdf');
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

// Bounds for restoring from an untrusted .zip (zip-bomb / resource guard).
// Generous enough for real photo sets, tight enough to reject an archive that
// claims gigabytes.
const MAX_ZIP_ENTRIES = MAX_IMAGES + 4; // images + a stray .key or two
const MAX_ENTRY_BYTES = 25 * 1024 * 1024; // 25 MB per image (a large photo)
const MAX_TOTAL_BYTES = 300 * 1024 * 1024; // cumulative uncompressed

/** Extract only image/.key entries from a zip, within the size/count budgets. */
export function extractZip(zipBytes: Uint8Array): { images: Uint8Array[]; keyBlock?: Uint8Array } {
  let count = 0;
  let total = 0;
  const entries = unzipSync(zipBytes, {
    filter: (f) => {
      if (!(IMAGE_RE.test(f.name) || isKey(f.name))) return false;
      if (f.originalSize > MAX_ENTRY_BYTES) throw new Error('restore: a .zip entry is too large');
      count += 1;
      total += f.originalSize;
      if (count > MAX_ZIP_ENTRIES) throw new Error('restore: too many entries in the .zip');
      if (total > MAX_TOTAL_BYTES) throw new Error('restore: .zip contents are too large');
      return true;
    },
  });
  const images: Uint8Array[] = [];
  let keyBlock: Uint8Array | undefined;
  for (const [name, bytes] of Object.entries(entries)) {
    if (isKey(name)) keyBlock = bytes;
    else if (IMAGE_RE.test(name)) images.push(bytes);
  }
  return keyBlock ? { images, keyBlock } : { images };
}

/**
 * Reconstruct the original file from image files, a .zip of them, a printed
 * PDF (paper mode), or a mix. A `.key` file (loose or inside the zip) is used
 * when present. `extraPayloads` lets callers add already-decoded payloads
 * (e.g. live camera captures).
 */
export async function restoreFileFromDisk(
  files: File[],
  password: string,
  keyFile?: File,
  extraPayloads: Uint8Array[] = [],
): Promise<{ filename: string }> {
  const images: Uint8Array[] = [];
  const payloads: Uint8Array[] = [...extraPayloads];
  let keyBlock: Uint8Array | undefined = keyFile ? await blobBytes(keyFile) : undefined;

  for (const file of files) {
    if (isZip(file.name)) {
      const extracted = extractZip(await blobBytes(file));
      images.push(...extracted.images);
      if (extracted.keyBlock) keyBlock = extracted.keyBlock;
    } else if (isKey(file.name)) {
      keyBlock = await blobBytes(file);
    } else if (isPdf(file.name)) {
      // Lazy: keeps pdf-lib out of the initial bundle (only paper users pay).
      const { extractPdfPayloads } = await import('./pdf-restore');
      payloads.push(...(await extractPdfPayloads(await blobBytes(file))));
    } else {
      images.push(await blobBytes(file));
    }
  }

  for (const bytes of images) {
    const payload = await decodeImageBytes(bytes);
    // A single unreadable image is fine — erasure coding tolerates losses.
    if (payload) payloads.push(payload);
  }
  if (payloads.length === 0) throw new Error('restore: no readable images found');

  const { filename, content } = await importVault(payloads, password, { keyBlock });
  downloadBlob(new Blob([content as BufferSource]), filename);
  return { filename };
}
