/**
 * Gallery restore's handling of a zipped delivery, in the browser module.
 *
 * Two review findings on #197: a zip of a whole set was held to the per-photo
 * 25 MiB ceiling, which a dozen phone photos zipped together exceed; and a zip
 * made by macOS carries `__MACOSX/._IMG_…` entries named like photos that are
 * not photos.
 */

import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { FileTooLargeError } from '@core';
import { extractZip, restoreGalleryFromDisk } from './disk';

const MiB = 1024 * 1024;

/** A stand-in for a large File: its size is what the checks read. */
function bigFile(name: string, size: number): File {
  return {
    name,
    size,
    arrayBuffer: async () => new ArrayBuffer(16),
    slice: () => new Blob([new Uint8Array(16)]),
  } as unknown as File;
}

describe('restoreGalleryFromDisk size ceilings', () => {
  it('lets a zipped set past the per-photo ceiling', async () => {
    const err = await restoreGalleryFromDisk([bigFile('album.zip', 30 * MiB)], 'pw').catch(
      (e: unknown) => e,
    );
    // It fails later, on the stand-in's bytes, but not on its size.
    expect(err).not.toBeInstanceOf(FileTooLargeError);
  });

  it('still holds a loose photo to the per-photo ceiling', async () => {
    const err = await restoreGalleryFromDisk([bigFile('IMG_0001.jpg', 30 * MiB)], 'pw').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FileTooLargeError);
  });
});

describe('extractZip', () => {
  it('skips the metadata entries macOS adds, which are named like photos', () => {
    const photo = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
    const junk = new Uint8Array([0, 5, 22, 7, 0, 2, 0, 0]);
    const { images } = extractZip(
      zipSync({
        'album/IMG_0001.jpg': photo,
        '__MACOSX/album/._IMG_0001.jpg': junk,
        'album/._IMG_0002.png': junk,
      }),
    );
    expect(images).toHaveLength(1);
    expect([...images[0]!]).toEqual([...photo]);
  });
});
