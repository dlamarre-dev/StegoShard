/**
 * Per-destination availability + output-count estimates for a chosen file,
 * shared by the guided wizard and the expert UI so both grey out the same
 * destinations and show the same counts. Pure (localizer passed in), and it
 * compresses the file only once via `buildPayload`.
 */

import {
  GALLERY_K_MAX,
  MAX_FILE_BYTES,
  MAX_FILE_BYTES_BINARY_UI,
  MAX_IMAGES,
  PROFILE_CLOUD,
  PROFILE_DISK,
  PROFILE_PAPER,
  buildPayload,
  galleryCoversForEnvelopeLen,
  imagesForEnvelopeLen,
} from '@core';
import type { Msg, SaveDestination } from './save-controller';

/** Per-destination availability + expected output count for the chosen file. */
export interface DestEstimate {
  available: boolean;
  /** Images (disk/paper/cloud), 1 (binary/sqlite), or needed photos (gallery). */
  count: number;
  /** Gallery only: minimum cover photos needed. */
  needed?: number;
  /** Why unavailable, when `available` is false. */
  reason?: string;
}
export type Estimates = Partial<Record<SaveDestination, DestEstimate>>;

/** Human-readable byte size, e.g. "512 KB" / "1.4 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Availability + count for one destination, from the file's size + envelope length. */
export function estimateFor(
  dest: SaveDestination,
  size: number,
  envelopeLen: number,
  msg: Msg,
): DestEstimate {
  if (dest === 'binary' || dest === 'sqlite') {
    return size <= MAX_FILE_BYTES_BINARY_UI
      ? { available: true, count: 1 }
      : { available: false, count: 0, reason: msg('wizTooLargeBinary') };
  }
  if (dest === 'gallery') {
    if (size > MAX_FILE_BYTES) return { available: false, count: 0, reason: msg('wizTooLarge') };
    const { k, needed } = galleryCoversForEnvelopeLen(envelopeLen, 'embedded');
    return k <= GALLERY_K_MAX
      ? { available: true, count: needed, needed }
      : { available: false, count: 0, reason: msg('wizTooLarge') };
  }
  // disk / paper / cloud
  if (size > MAX_FILE_BYTES) return { available: false, count: 0, reason: msg('wizTooLarge') };
  const profile = dest === 'paper' ? PROFILE_PAPER : dest === 'cloud' ? PROFILE_CLOUD : PROFILE_DISK;
  const { images } = imagesForEnvelopeLen(envelopeLen, { profile, keyMode: 'embedded' });
  return images <= MAX_IMAGES
    ? { available: true, count: images }
    : { available: false, count: 0, reason: msg('wizTooManyImages', String(MAX_IMAGES)) };
}

/** Compute availability for every destination, compressing the file only once. */
export async function computeEstimates(
  file: File,
  dests: SaveDestination[],
  msg: Msg,
): Promise<Estimates> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const envelopeLen = (await buildPayload(file.name, bytes)).length;
  const est: Estimates = {};
  for (const d of dests) est[d] = estimateFor(d, file.size, envelopeLen, msg);
  return est;
}
