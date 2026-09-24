/**
 * Gather CLI restore inputs: the headless counterpart to `restoreFileFromDisk`
 * in `src/ui/disk.ts` and the Python decoder's `_gather` (decode.py).
 *
 * Expands a list of paths (image files, directories, `.zip`, `.pdf`) into decoded
 * codec payloads plus an optional key blob. A `.key` file is a raw key block; an
 * image passed via the key slot is treated as a stego carrier by the caller.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { unzipSync } from 'fflate';
import { MAX_IMAGES, type OnProgress, report } from '../../core';
import { extractPdfImages } from '../../ui/pdf-restore';
import { decodeImageToPayload, decodePixelsToPayload } from './image-io';

const isZip = (n: string) => /\.zip$/i.test(n);
const isKey = (n: string) => /\.key$/i.test(n);
const isPdf = (n: string) => /\.pdf$/i.test(n);
const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i;

// Bounds for an untrusted .zip (mirror src/ui/disk.ts).
const MAX_ZIP_ENTRIES = MAX_IMAGES + 4;
const MAX_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;

/** What `gatherInputs` found: decoded payloads, a key block if one came with them, and counts. */
export interface GatheredInputs {
  payloads: Uint8Array[];
  keyBlock?: Uint8Array;
  /** How many image/PDF-page rasters were seen vs. successfully decoded. */
  seen: number;
  decoded: number;
}

/** A photo read from disk or out of a .zip, with the name it had there. */
export interface PhotoInput {
  name: string;
  bytes: Uint8Array;
}

/**
 * An entry macOS adds when it zips a folder: `__MACOSX/…` and `._name` files
 * hold Finder metadata, not the file they are named after. `._IMG_0001.jpg`
 * matches the photo pattern and is a few hundred bytes of something else.
 */
function isArchiveMetadata(path: string): boolean {
  return /(^|\/)__MACOSX\//.test(path) || /(^|\/)\._[^/]*$/.test(path);
}

/** Extract image/.key entries from a zip within the size/count budgets. */
function extractZip(zipBytes: Uint8Array): { images: PhotoInput[]; keyBlock?: Uint8Array } {
  let count = 0;
  let total = 0;
  const entries = unzipSync(zipBytes, {
    filter: (f) => {
      if (!(IMAGE_RE.test(f.name) || isKey(f.name))) return false;
      if (isArchiveMetadata(f.name)) return false; // macOS resource forks, named like photos
      if (f.originalSize > MAX_ENTRY_BYTES) throw new Error('restore: a .zip entry is too large');
      count += 1;
      total += f.originalSize;
      if (count > MAX_ZIP_ENTRIES) throw new Error('restore: too many entries in the .zip');
      if (total > MAX_TOTAL_BYTES) throw new Error('restore: .zip contents are too large');
      return true;
    },
  });
  const images: PhotoInput[] = [];
  let keyBlock: Uint8Array | undefined;
  for (const [name, bytes] of Object.entries(entries)) {
    if (isKey(name)) keyBlock = bytes;
    else if (IMAGE_RE.test(name)) images.push({ name: basename(name), bytes });
  }
  return keyBlock ? { images, keyBlock } : { images };
}

async function pdfPayloads(bytes: Uint8Array): Promise<{ seen: number; payloads: Uint8Array[] }> {
  const payloads: Uint8Array[] = [];
  const images = await extractPdfImages(bytes);
  for (const image of images) {
    const p =
      image.kind === 'jpeg'
        ? decodeImageToPayload(image.bytes, 'page.jpg')
        : decodePixelsToPayload(image.img);
    if (p) payloads.push(p);
  }
  return { seen: images.length, payloads };
}

function read(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

/**
 * Recursively collect file paths from a directory.
 *
 * Symlinks are followed, as they always were, but each real directory is
 * entered once: a link back to an ancestor used to recurse until the stack gave
 * out, so one careless `ln -s .. up` in a photo folder crashed every command
 * pointed at it.
 */
export function walk(dir: string, seen: Set<string> = new Set()): string[] {
  const real = realpathSync(dir);
  if (seen.has(real)) return [];
  seen.add(real);
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, seen));
    else out.push(p);
  }
  return out;
}

/** Expand paths (files or directories) into image file paths only (Gallery Mode). */
export function gatherImageFiles(paths: string[]): string[] {
  const files: string[] = [];
  for (const path of paths) {
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files.filter((p) => IMAGE_RE.test(basename(p)));
}

/**
 * Expand input paths into decoded payloads plus an optional key block.
 * `onProgress` gets one `extract` step per input file read.
 */
export async function gatherInputs(
  paths: string[],
  onProgress?: OnProgress,
): Promise<GatheredInputs> {
  const files: string[] = [];
  for (const path of paths) {
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }

  const payloads: Uint8Array[] = [];
  let keyBlock: Uint8Array | undefined;
  let seen = 0;
  let decoded = 0;

  for (const [i, path] of files.entries()) {
    await report(onProgress, { phase: 'extract', done: i, total: files.length });
    const name = basename(path);
    if (isKey(name)) {
      keyBlock = read(path);
    } else if (isZip(name)) {
      const { images, keyBlock: kb } = extractZip(read(path));
      if (kb) keyBlock = kb;
      for (const img of images) {
        seen++;
        const p = decodeImageToPayload(img.bytes, img.name);
        if (p) {
          payloads.push(p);
          decoded++;
        }
      }
    } else if (isPdf(name)) {
      const { seen: s, payloads: ps } = await pdfPayloads(read(path));
      seen += s;
      decoded += ps.length;
      payloads.push(...ps);
    } else if (IMAGE_RE.test(name)) {
      seen++;
      const p = decodeImageToPayload(read(path), name);
      if (p) {
        payloads.push(p);
        decoded++;
      }
    }
    // silently ignore anything else (a stray README, the input file itself)
  }
  if (files.length > 0) {
    await report(onProgress, { phase: 'extract', done: files.length, total: files.length });
  }

  return keyBlock ? { payloads, keyBlock, seen, decoded } : { payloads, seen, decoded };
}

/**
 * Every photo among `paths`, loose, in a directory or inside a `.zip`, plus a
 * `.key` if one rides along (loose or zipped).
 *
 * For the paths that want photos rather than decoded vault images: a gallery
 * restore, and the search for a stego key photo handed in with everything else.
 * Delivered photos are all named `IMG_nnnn`, so zipping a whole delivery, key
 * photo included, is the natural thing to do, and a zip has to be opened for
 * either of those to see what is in it.
 */
export function gatherPhotos(paths: readonly string[]): {
  photos: PhotoInput[];
  keyBlock?: Uint8Array;
} {
  const files: string[] = [];
  for (const path of paths) {
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  const photos: PhotoInput[] = [];
  let keyBlock: Uint8Array | undefined;
  for (const path of files) {
    const name = basename(path);
    if (isKey(name)) {
      keyBlock = read(path);
    } else if (isZip(name)) {
      const extracted = extractZip(read(path));
      photos.push(...extracted.images);
      if (extracted.keyBlock) keyBlock = extracted.keyBlock;
    } else if (IMAGE_RE.test(name)) {
      photos.push({ name, bytes: read(path) });
    }
  }
  return keyBlock ? { photos, keyBlock } : { photos };
}
