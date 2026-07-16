/**
 * Gather CLI restore inputs — the headless counterpart to `restoreFileFromDisk`
 * in `src/ui/disk.ts` and the Python decoder's `_gather` (decode.py).
 *
 * Expands a list of paths (image files, directories, `.zip`, `.pdf`) into decoded
 * codec payloads plus an optional key blob. A `.key` file is a raw key block; an
 * image passed via the key slot is treated as a stego carrier by the caller.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { unzipSync } from 'fflate';
import { MAX_IMAGES } from '@core';
import { extractPdfImages } from '../ui/pdf-restore';
import { decodeImageToPayload, decodePixelsToPayload } from './node-image-io';

const isZip = (n: string) => /\.zip$/i.test(n);
const isKey = (n: string) => /\.key$/i.test(n);
const isPdf = (n: string) => /\.pdf$/i.test(n);
const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i;

// Bounds for an untrusted .zip (mirror src/ui/disk.ts).
const MAX_ZIP_ENTRIES = MAX_IMAGES + 4;
const MAX_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;

export interface GatheredInputs {
  payloads: Uint8Array[];
  keyBlock?: Uint8Array;
  /** How many image/PDF-page rasters were seen vs. successfully decoded. */
  seen: number;
  decoded: number;
}

/** Extract image/.key entries from a zip within the size/count budgets. */
function extractZip(zipBytes: Uint8Array): { images: Uint8Array[]; keyBlock?: Uint8Array } {
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

/** Recursively collect file paths from a directory. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Expand input paths into decoded payloads plus an optional key block. */
export async function gatherInputs(paths: string[]): Promise<GatheredInputs> {
  const files: string[] = [];
  for (const path of paths) {
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }

  const payloads: Uint8Array[] = [];
  let keyBlock: Uint8Array | undefined;
  let seen = 0;
  let decoded = 0;

  for (const path of files) {
    const name = basename(path);
    if (isKey(name)) {
      keyBlock = read(path);
    } else if (isZip(name)) {
      const { images, keyBlock: kb } = extractZip(read(path));
      if (kb) keyBlock = kb;
      for (const img of images) {
        seen++;
        const p = decodeImageToPayload(img, 'zipped.png');
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

  return keyBlock ? { payloads, keyBlock, seen, decoded } : { payloads, seen, decoded };
}
