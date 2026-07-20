/**
 * Disk destination flow (plan §6): the offline default, needing no network
 * permission. Save renders the vault's image set to PNG files — either as
 * individual downloads or bundled into one .zip; restore reads image files (or
 * a .zip) back and reconstructs the original file.
 */

import {
  type BinaryVariant,
  binaryKeyName,
  binaryVaultName,
  getCodec,
  exportVault,
  exportVaultBinary,
  galleryDecode,
  galleryEncode,
  importVault,
  importVaultBinary,
  MAX_IMAGES,
  PROFILE_DISK,
  decodeHeader,
  toHex,
  unwrapBinary,
  wrapBinary,
  type KeyMode,
  type VaultKey,
} from '@core';
import { Unzip, UnzipInflate, zipSync } from 'fflate';
import {
  decodeImageBytes,
  downloadBlob,
  embedKeyImage,
  extractKeyImage,
  fileToGalleryCover,
  galleryImageToBlob,
  imageWithLabelToPngBlob,
  stegoKeyName,
  type LabelBand,
} from './image-io';

export interface SaveOptions {
  keyMode: KeyMode;
  /** When set, a readable title band is drawn above each image. */
  label?: { title?: string; date?: string } | undefined;
  /** Bundle all images (+ .key) into a single .zip instead of many files. */
  asZip?: boolean;
  /**
   * For the 'stego' key mode: the cover photo to hide the key block in, and the
   * password that keys the embedding (the same one that unlocks the vault).
   */
  stego?: { cover: File; password: string } | undefined;
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
      name: `stegoshard-${setHex}-${index}.png`,
      bytes: await blobBytes(await imageWithLabelToPngBlob(img, band)),
    });
  }
  // The key block is external for keyfile/stego modes. In stego mode it is
  // hidden inside the user's cover photo (a lossless PNG); otherwise it is a
  // plain .key file. Bundled into the .zip only for the .key case — the stego
  // image is always delivered on its own so it can be stored as an innocuous
  // photo, separate from the obviously-StegoShard set.
  let externalKey: { name: string; bytes: Uint8Array; mime: string } | undefined;
  if (keyMode === 'stego') {
    if (!options.stego) throw new Error('stego mode requires a cover image and password');
    const key = await embedKeyImage(options.stego.cover, keyBlock, options.stego.password);
    externalKey = {
      name: stegoKeyName(options.stego.cover.name, key.ext, setHex),
      bytes: key.bytes,
      mime: key.mime,
    };
  } else if (keyMode !== 'embedded') {
    externalKey = {
      name: `stegoshard-${setHex}.key`,
      bytes: keyBlock,
      mime: 'application/octet-stream',
    };
  }

  if (options.asZip) {
    const entries: Record<string, Uint8Array> = {};
    for (const p of pngs) entries[p.name] = p.bytes;
    if (externalKey && keyMode === 'keyfile') entries[externalKey.name] = externalKey.bytes;
    const zipped = zipSync(entries, { level: 0 }); // PNGs are already compressed
    downloadBlob(new Blob([zipped as BufferSource]), `stegoshard-${setHex}.zip`);
    if (externalKey && keyMode === 'stego') {
      downloadBlob(
        new Blob([externalKey.bytes as BufferSource], { type: externalKey.mime }),
        externalKey.name,
      );
    }
  } else {
    for (const p of pngs) {
      downloadBlob(new Blob([p.bytes as BufferSource], { type: 'image/png' }), p.name);
      await new Promise((r) => setTimeout(r, 150)); // avoid batch-blocking
    }
    if (externalKey) {
      downloadBlob(
        new Blob([externalKey.bytes as BufferSource], { type: externalKey.mime }),
        externalKey.name,
      );
    }
  }

  return { imageCount: total, setId: setHex, keyMode };
}

/**
 * Save the vault as a single binary container file (SPEC §8) instead of images.
 * In keyfile mode the key is delivered as a matching container; in stego mode it
 * stays a cover image. No image-count ceiling applies (up to 100 MiB).
 */
export async function saveFileToBinary(
  file: File,
  key: VaultKey,
  options: { keyMode: KeyMode; variant: BinaryVariant; stego?: SaveOptions['stego'] },
): Promise<{ keyMode: KeyMode; variant: BinaryVariant }> {
  const content = new Uint8Array(await file.arrayBuffer());
  const { container, keyBlock, keyMode } = await exportVaultBinary(file.name, content, key, {
    keyMode: options.keyMode,
    variant: options.variant,
  });
  downloadBlob(
    new Blob([container as BufferSource], { type: 'application/octet-stream' }),
    binaryVaultName(options.variant),
  );

  if (keyMode === 'stego') {
    if (!options.stego) throw new Error('stego mode requires a cover image and password');
    const stegoKey = await embedKeyImage(options.stego.cover, keyBlock, options.stego.password);
    downloadBlob(
      new Blob([stegoKey.bytes as BufferSource], { type: stegoKey.mime }),
      stegoKeyName(options.stego.cover.name, stegoKey.ext, ''),
    );
  } else if (keyMode === 'keyfile') {
    downloadBlob(
      new Blob([wrapBinary(keyBlock, options.variant) as BufferSource], {
        type: 'application/octet-stream',
      }),
      binaryKeyName(options.variant),
    );
  }
  return { keyMode, variant: options.variant };
}

export interface GallerySaveResult {
  imageCount: number;
  k: number;
  m: number;
  decoys: number;
  setId: string;
}

/**
 * Gallery Mode (SPEC §9): hide a secret fragmented across the given cover photos
 * plus decoys, then download every (modified) photo individually — keeping each
 * cover's own filename so the set blends into a photo library (no telltale zip).
 */
export async function saveGalleryToDisk(
  secret: File,
  covers: File[],
  password: string,
): Promise<GallerySaveResult> {
  const content = new Uint8Array(await secret.arrayBuffer());
  const galleryCovers = await Promise.all(covers.map(fileToGalleryCover));
  const res = await galleryEncode(secret.name, content, password, galleryCovers);

  // Two covers can share a basename, and gallery reuses cover names — disambiguate.
  const used = new Set<string>();
  for (const img of res.images) {
    const { name, blob } = await galleryImageToBlob(img);
    let unique = name;
    for (let n = 2; used.has(unique); n++) unique = name.replace(/(\.[^.]+)?$/, `-${n}$1`);
    used.add(unique);
    downloadBlob(blob, unique);
    await new Promise((r) => setTimeout(r, 150)); // avoid batch-blocking downloads
  }
  return {
    imageCount: res.images.length,
    k: res.k,
    m: res.m,
    decoys: res.decoys,
    setId: toHex(res.setId),
  };
}

/** Restore a secret from a set of gallery photos (blind winnowing) and download it. */
export async function restoreGalleryFromDisk(
  files: File[],
  password: string,
): Promise<{ filename: string }> {
  const covers = await Promise.all(files.map(fileToGalleryCover));
  const { filename, content } = await galleryDecode(covers, password);
  downloadBlob(new Blob([content as BufferSource]), filename);
  return { filename };
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

/**
 * Extract only image/.key entries from a zip, within the size/count budgets.
 * Streams each entry and enforces the caps on the *actual* inflated bytes (not
 * the attacker-declarable header size), aborting before a zip bomb can grow
 * unbounded. Runs synchronously: fflate's `Unzip` + `UnzipInflate` deliver all
 * data during the single `push` below.
 */
export function extractZip(zipBytes: Uint8Array): { images: Uint8Array[]; keyBlock?: Uint8Array } {
  const images: Uint8Array[] = [];
  let keyBlock: Uint8Array | undefined;
  let count = 0;
  let total = 0;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    const name = file.name;
    if (!(IMAGE_RE.test(name) || isKey(name))) return; // never decompressed
    count += 1;
    if (count > MAX_ZIP_ENTRIES) throw new Error('restore: too many entries in the .zip');

    const parts: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, chunk, final) => {
      if (err) throw err;
      size += chunk.length;
      total += chunk.length;
      if (size > MAX_ENTRY_BYTES) throw new Error('restore: a .zip entry is too large');
      if (total > MAX_TOTAL_BYTES) throw new Error('restore: .zip contents are too large');
      parts.push(chunk.slice()); // fflate may reuse the buffer — copy it
      if (final) {
        const bytes = parts.length === 1 ? parts[0]! : concatChunks(parts, size);
        if (isKey(name)) keyBlock = bytes;
        else images.push(bytes);
      }
    };
    file.start();
  };
  unzip.push(zipBytes, true);

  return keyBlock ? { images, keyBlock } : { images };
}

function concatChunks(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Reconstruct the original file from image files, a .zip of them, a printed
 * PDF (paper mode), or a mix. The separate key, when needed, may be a `.key`
 * file (loose or inside the zip) or a **stego cover image** that hides the key
 * block — the latter is de-embedded with the restore password. `extraPayloads`
 * lets callers add already-decoded payloads (e.g. live camera captures).
 */
export async function restoreFileFromDisk(
  files: File[],
  password: string,
  keyFile?: File,
  extraPayloads: Uint8Array[] = [],
): Promise<{ filename: string }> {
  const images: Uint8Array[] = [];
  const payloads: Uint8Array[] = [...extraPayloads];
  // A key input can be a raw .key, a binary key container (branded/disguised),
  // or a stego cover image (de-embedded with the restore password).
  let keyBlock: Uint8Array | undefined;
  if (keyFile) {
    const bytes = await blobBytes(keyFile);
    const unwrapped = unwrapBinary(bytes);
    keyBlock = unwrapped
      ? unwrapped.payload
      : isKey(keyFile.name)
        ? bytes
        : ((await extractKeyImage(keyFile, password)) ?? undefined);
  }

  // A single binary vault container short-circuits the image pipeline. (Camera
  // captures arrive as extraPayloads and are always images, so skip the probe.)
  if (extraPayloads.length === 0) {
    for (const file of files) {
      const bytes = await blobBytes(file);
      if (unwrapBinary(bytes)) {
        const { filename, content } = await importVaultBinary(bytes, password, { keyBlock });
        downloadBlob(new Blob([content as BufferSource]), filename);
        return { filename };
      }
    }
  }

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
