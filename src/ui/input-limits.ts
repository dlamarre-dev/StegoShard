/**
 * Browser-side resource limits for untrusted File/Blob inputs.
 *
 * Core parsers retain their own post-decode limits. These checks run before
 * `arrayBuffer()` so a rejected input never has to be copied into the tab's
 * heap first.
 */

import {
  FileTooLargeError,
  GALLERY_MAX_IMAGES,
  MAX_FILE_BYTES,
  MAX_FILE_BYTES_BINARY_UI,
  TooManyFilesError,
} from '@core';

const MiB = 1024 * 1024;

export const MAX_BROWSER_MEDIA_BYTES = 25 * MiB;
export const MAX_BROWSER_CONTAINER_BYTES = 300 * MiB;
export const MAX_BROWSER_TOTAL_INPUT_BYTES = 300 * MiB;
export const MAX_BROWSER_INPUT_FILES = GALLERY_MAX_IMAGES + 4;

export type BrowserInputKind = 'secret' | 'binary' | 'media' | 'archive';

export function inputLimit(kind: BrowserInputKind): number {
  switch (kind) {
    case 'secret':
      return MAX_FILE_BYTES;
    case 'binary':
      return MAX_FILE_BYTES_BINARY_UI;
    case 'archive':
      return MAX_BROWSER_CONTAINER_BYTES;
    case 'media':
      return MAX_BROWSER_MEDIA_BYTES;
  }
}

export function assertBlobSize(blob: Blob, limit: number): void {
  if (blob.size > limit) throw new FileTooLargeError(blob.size, limit);
}

export function assertBrowserInputs(
  blobs: readonly Blob[],
  options: { perFile?: number; total?: number; count?: number } = {},
): void {
  const perFile = options.perFile ?? MAX_BROWSER_MEDIA_BYTES;
  const totalLimit = options.total ?? MAX_BROWSER_TOTAL_INPUT_BYTES;
  const countLimit = options.count ?? MAX_BROWSER_INPUT_FILES;
  if (blobs.length > countLimit) throw new TooManyFilesError(blobs.length, countLimit);
  let total = 0;
  for (const blob of blobs) {
    assertBlobSize(blob, perFile);
    total += blob.size;
    if (total > totalLimit) throw new FileTooLargeError(total, totalLimit);
  }
}

export async function boundedBlobBytes(blob: Blob, limit: number): Promise<Uint8Array> {
  assertBlobSize(blob, limit);
  return new Uint8Array(await blob.arrayBuffer());
}
