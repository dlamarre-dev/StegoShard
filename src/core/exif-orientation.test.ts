/**
 * EXIF Orientation, read and applied.
 *
 * The browser applies it on decode and jpeg-js does not, so without this the CLI
 * delivered a portrait phone photo sideways once the re-encode had dropped the
 * tag that explained it.
 */

import { describe, it, expect } from 'vitest';
import { exifOrientation, orientImage } from './exif-orientation';
import { baseJpeg, exifSegmentWithOrientation, spliceAfterSoi } from './jpeg-fixtures';
import type { ImageDataLike } from './codec/types';

/** A 3x2 image whose red channel numbers its pixels 0..5 in row order. */
function numbered(): ImageDataLike {
  const data = new Uint8ClampedArray(3 * 2 * 4);
  for (let i = 0; i < 6; i++) {
    data[i * 4] = i;
    data[i * 4 + 3] = 255;
  }
  return { data, width: 3, height: 2 };
}

/** The red channel, row by row. */
function rows(img: ImageDataLike): number[][] {
  const out: number[][] = [];
  for (let y = 0; y < img.height; y++) {
    const row: number[] = [];
    for (let x = 0; x < img.width; x++) row.push(img.data[(y * img.width + x) * 4]!);
    out.push(row);
  }
  return out;
}

describe('exifOrientation', () => {
  it.each([false, true])('reads the tag (little-endian: %s)', (le) => {
    const photo = spliceAfterSoi(baseJpeg(32, 16), exifSegmentWithOrientation(6, le));
    expect(exifOrientation(photo)).toBe(6);
  });

  it('reads 1 when there is no EXIF, or no JPEG at all', () => {
    expect(exifOrientation(baseJpeg(32, 16))).toBe(1);
    expect(exifOrientation(new Uint8Array([1, 2, 3, 4]))).toBe(1);
  });

  it('reads an out-of-range value as 1', () => {
    const photo = spliceAfterSoi(baseJpeg(32, 16), exifSegmentWithOrientation(9));
    expect(exifOrientation(photo)).toBe(1);
  });
});

describe('orientImage', () => {
  // Stored:  0 1 2
  //          3 4 5
  // prettier-ignore
  it.each([
    [1, [[0, 1, 2], [3, 4, 5]]],
    [2, [[2, 1, 0], [5, 4, 3]]],
    [3, [[5, 4, 3], [2, 1, 0]]],
    [4, [[3, 4, 5], [0, 1, 2]]],
    [5, [[0, 3], [1, 4], [2, 5]]],
    [6, [[3, 0], [4, 1], [5, 2]]],
    [7, [[5, 2], [4, 1], [3, 0]]],
    [8, [[2, 5], [1, 4], [0, 3]]],
  ])('orientation %i', (orientation, expected) => {
    expect(rows(orientImage(numbered(), orientation))).toEqual(expected);
  });

  it('returns the image itself when there is nothing to do', () => {
    const img = numbered();
    expect(orientImage(img, 1)).toBe(img);
    expect(orientImage(img, 0)).toBe(img);
  });
});
