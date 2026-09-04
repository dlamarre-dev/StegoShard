/**
 * Format dispatch and malformed input in the Node image adapters.
 *
 * `image-io.test.ts` next door covers the path the CLI actually walks: our own
 * 8-bit RGBA PNGs, encoded and decoded again. That is the happy path, and it left
 * this file's branches at 52%, which set every `src/api` coverage floor.
 *
 * What was missing is mostly not malformed input at all: it is the *other* arm of
 * every PNG/JPEG decision. Six functions branch on cover format, and only the PNG
 * side of each was ever exercised, so a JPEG cover reached the stego layer nowhere
 * in the suite. The genuinely malformed paths (a truncated JPEG, bytes that are
 * neither format, a photo with no QR in it) are the smaller half.
 *
 * Two properties are worth stating because a test is the only place they are
 * written down:
 *
 * - **A cover keeps its format.** A JPEG cover comes back a JPEG carrying its
 *   coefficients, a PNG comes back a PNG. There is no transcoding, because
 *   re-encoding a JPEG would destroy the payload it is carrying.
 * - **"Not readable" and "not an image" are different answers.** The extract and
 *   decode paths return `null`, which erasure coding tolerates; only a *cover*
 *   that cannot carry anything raises, because that is a request that cannot be
 *   satisfied rather than a shard that can be missing.
 */

import { describe, it, expect } from 'vitest';
import { encode as encodePng } from 'fast-png';
import jpeg from 'jpeg-js';
import {
  DEFAULT_ARGON2,
  KEY_BLOCK_LEN,
  KEY_FACTOR_LEN,
  StegoCoverFormatError,
  serializeKeyBlock,
  type GalleryImage,
} from '../../core';
import {
  decodeImageToPayload,
  decodePixelsToPayload,
  embedKeyFactorImage,
  embedKeyImage,
  extractKeyFactorImage,
  extractKeyImage,
  fileToGalleryCover,
  fileToImageData,
  galleryImageToFile,
} from './image-io';

const PW = 'a cover password, unrelated to anything else';

/** A baseline JPEG with enough texture to carry a key block. */
function baselineJpeg(side = 96, quality = 92): Uint8Array {
  const data = new Uint8Array(side * side * 4);
  for (let i = 0; i < side * side; i++) {
    data[i * 4] = (i * 7) & 0xff;
    data[i * 4 + 1] = (i * 13) & 0xff;
    data[i * 4 + 2] = (i * 29) & 0xff;
    data[i * 4 + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data, width: side, height: side }, quality).data);
}

/** A noisy RGBA PNG, large enough for spatial LSB embedding. */
function noisyPng(side = 128): Uint8Array {
  const data = new Uint8Array(side * side * 4);
  let s = 12345;
  for (let i = 0; i < side * side; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i * 4] = (s >>> 24) & 0xff;
    data[i * 4 + 1] = (s >>> 16) & 0xff;
    data[i * 4 + 2] = (s >>> 8) & 0xff;
    data[i * 4 + 3] = 255;
  }
  return encodePng({ width: side, height: side, data, channels: 4, depth: 8 });
}

// fast-png's typings describe the 8-bit RGBA case the rest of the codebase uses;
// the gray/16-bit combinations below are valid PNG and decode correctly, they are
// just outside that overload.
function png(
  width: number,
  height: number,
  channels: number,
  depth: number,
  values: number[],
): Uint8Array {
  const data = depth === 16 ? new Uint16Array(values) : new Uint8Array(values);
  return encodePng({ width, height, data, channels, depth } as never);
}

/** Passes the JPEG magic check, then fails to parse. */
const TRUNCATED_JPEG = new Uint8Array([0xff, 0xd8, 0xff, ...Array<number>(200).fill(0x41)]);
/** Neither PNG nor JPEG: a GIF87a header. */
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 1, 2, 3, 4]);

describe('decoding a raster that is not 8-bit RGBA', () => {
  /**
   * fast-png hands back whatever the file declares, so every combination has to
   * be normalized. Only the 8-bit RGBA row was covered, which is the one shape
   * our own writer produces and therefore the one least likely to arrive from a
   * user's photo library.
   *
   * Two pixels per case, expectations written out rather than computed, so this
   * fails if the normalization changes rather than tracking it.
   */
  const cases: [string, number, number, number[], number[]][] = [
    ['grayscale 8-bit', 1, 8, [10, 200], [10, 10, 10, 255, 200, 200, 200, 255]],
    ['grayscale + alpha 8-bit', 2, 8, [10, 64, 200, 128], [10, 10, 10, 64, 200, 200, 200, 128]],
    ['RGB 8-bit, no alpha', 3, 8, [1, 2, 3, 4, 5, 6], [1, 2, 3, 255, 4, 5, 6, 255]],
    ['RGBA 8-bit', 4, 8, [1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 4, 5, 6, 7, 8]],
    // 16-bit keeps the high byte: 0x0100 → 1, 0xFFFF → 255.
    ['grayscale 16-bit', 1, 16, [4096, 65535], [16, 16, 16, 255, 255, 255, 255, 255]],
    [
      'grayscale + alpha 16-bit',
      2,
      16,
      [4096, 32768, 65535, 256],
      [16, 16, 16, 128, 255, 255, 255, 1],
    ],
    ['RGB 16-bit', 3, 16, [256, 512, 768, 1024, 1280, 1536], [1, 2, 3, 255, 4, 5, 6, 255]],
    ['RGBA 16-bit', 4, 16, [256, 512, 768, 1024, 1280, 1536, 1792, 2048], [1, 2, 3, 4, 5, 6, 7, 8]],
  ];

  for (const [label, channels, depth, values, expected] of cases) {
    it(`normalizes ${label} to RGBA`, () => {
      const img = fileToImageData(png(2, 1, channels, depth, values), 'photo.png');
      expect(img.width).toBe(2);
      expect(img.height).toBe(1);
      expect([...img.data]).toEqual(expected);
    });
  }
});

describe('choosing a decoder', () => {
  // The extension is a hint, not the answer: a file saved from a browser is
  // routinely named for the format the site served rather than the bytes on disk.
  it('trusts the PNG signature over a .jpg extension', () => {
    const img = fileToImageData(noisyPng(8), 'actually-a-png.jpg');
    expect(img.width).toBe(8);
  });

  it('sniffs a PNG with no extension at all', () => {
    const img = fileToImageData(noisyPng(8), 'clipboard-paste');
    expect(img.width).toBe(8);
  });

  it('decodes a baseline JPEG, by extension and unnamed alike', () => {
    const bytes = baselineJpeg(32);
    for (const name of ['photo.jpg', 'photo.jpeg', 'photo.JPG', 'no-extension']) {
      const img = fileToImageData(bytes, name);
      expect(img.width, name).toBe(32);
      expect(img.data.length, name).toBe(32 * 32 * 4);
    }
  });

  /**
   * The one case the sniffing does not rescue, and it is worth pinning rather
   * than leaving to be discovered: a `.png` name wins outright, so JPEG bytes
   * under that name go to the PNG decoder and surface fast-png's own error, not
   * a StegoShard one. Callers that tolerate junk (`decodeImageToPayload`,
   * below) turn it into `null` anyway; the ones that do not are handling a cover
   * the user chose, where a hard failure is the right answer.
   */
  it('refuses JPEG bytes named .png rather than sniffing back', () => {
    expect(() => fileToImageData(baselineJpeg(16), 'mislabelled.png')).toThrow();
  });

  it('refuses bytes that are neither format', () => {
    expect(() => fileToImageData(GIF, 'animation.gif')).toThrow();
  });
});

describe('decoding to a payload tolerates what it cannot read', () => {
  // Erasure coding is built on losing images, so an unreadable one is data, not
  // an error. Both reasons it can be unreadable return the same null.
  it('returns null for bytes that are not an image', () => {
    expect(decodeImageToPayload(GIF, 'animation.gif')).toBeNull();
  });

  it('returns null for a real image with no code in it', () => {
    const blank: Uint8Array = new Uint8Array(64 * 64 * 4).fill(255);
    expect(
      decodePixelsToPayload({ data: new Uint8ClampedArray(blank), width: 64, height: 64 }),
    ).toBeNull();
  });
});

describe('a stego cover keeps its format', () => {
  /**
   * A structurally valid key block, not 92 arbitrary bytes: extraction only
   * returns a candidate that passes `isSerializedKeyBlock`, since a wrong
   * password yields plausible-looking noise and the magic is what separates the
   * two. The wrapped field is filler of the right length (a real one is a
   * 32-byte DEK plus a 16-byte GCM tag) — nothing here unwraps it, and building
   * a real one would add an Argon2id derivation to a test about image I/O.
   */
  const block = serializeKeyBlock({
    salt: new Uint8Array(16).fill(9),
    iv: new Uint8Array(12).fill(5),
    params: DEFAULT_ARGON2,
    wrapped: Uint8Array.from({ length: 48 }, (_, i) => (i * 31) & 0xff),
  });

  const factor = Uint8Array.from({ length: KEY_FACTOR_LEN }, (_, i) => (i * 17) & 0xff);

  it('carries a key block through a JPEG cover and back', async () => {
    expect(block.length).toBe(KEY_BLOCK_LEN);
    const out = await embedKeyImage(baselineJpeg(), 'cover.jpg', block, PW);
    expect(out.ext).toBe('jpg');
    // Still a JPEG: the coefficients are the carrier, so re-encoding is not an
    // option and the magic must survive.
    expect([out.bytes[0], out.bytes[1]]).toEqual([0xff, 0xd8]);
    expect([...(await extractKeyImage(out.bytes, 'cover.jpg', PW))!]).toEqual([...block]);
  });

  it('carries a key block through a PNG cover and back', async () => {
    const out = await embedKeyImage(noisyPng(), 'cover.png', block, PW);
    expect(out.ext).toBe('png');
    expect([out.bytes[0], out.bytes[1]]).toEqual([0x89, 0x50]);
    expect([...(await extractKeyImage(out.bytes, 'cover.png', PW))!]).toEqual([...block]);
  });

  it('carries a key factor through a JPEG cover and back', async () => {
    const out = await embedKeyFactorImage(baselineJpeg(), 'cover.jpg', factor, PW);
    expect(out.ext).toBe('jpg');
    expect([...(await extractKeyFactorImage(out.bytes, 'cover.jpg', PW))!]).toEqual([...factor]);
  });

  it('carries a key factor through a PNG cover and back', async () => {
    const out = await embedKeyFactorImage(noisyPng(), 'cover.png', factor, PW);
    expect(out.ext).toBe('png');
    expect([...(await extractKeyFactorImage(out.bytes, 'cover.png', PW))!]).toEqual([...factor]);
  });

  /**
   * A cover that cannot carry the key is refused, and both reasons report the
   * same error, deliberately: from the caller's side "this JPEG is progressive"
   * and "this is a GIF" are one problem, pick another photo.
   */
  it.each([
    ['a JPEG it cannot parse', TRUNCATED_JPEG, 'cover.jpg'],
    ['bytes that are neither format', GIF, 'cover.gif'],
  ])('refuses %s as a cover', async (_label, bytes, name) => {
    await expect(embedKeyImage(bytes, name, block, PW)).rejects.toThrow(StegoCoverFormatError);
    await expect(embedKeyFactorImage(bytes, name, factor, PW)).rejects.toThrow(
      StegoCoverFormatError,
    );
  });

  // The other side of the same coin: extraction scans images the user pointed at,
  // which will include ones holding nothing, so it answers null instead.
  it('returns null when asked to extract from a non-image', async () => {
    expect(await extractKeyImage(GIF, 'animation.gif', PW)).toBeNull();
    expect(await extractKeyFactorImage(GIF, 'animation.gif', PW)).toBeNull();
  });
});

describe('gallery covers keep their format too', () => {
  it('carries a JPEG cover verbatim, and decodes anything else to RGBA', () => {
    const jpg = baselineJpeg(32);
    const cover = fileToGalleryCover(jpg, 'holiday.jpg');
    expect(cover.kind).toBe('jpeg');
    // Verbatim: the DCT coefficients are the carrier, so a decode/re-encode here
    // would quietly cost capacity before the embedding even starts.
    expect(cover.kind === 'jpeg' && cover.jpeg).toBe(jpg);

    const other = fileToGalleryCover(noisyPng(16), 'holiday.png');
    expect(other.kind).toBe('rgba');
    expect(other.kind === 'rgba' && other.width).toBe(16);
  });

  it('writes a produced JPEG back unchanged', () => {
    const jpg = baselineJpeg(16);
    const img: GalleryImage = { kind: 'jpeg', name: 'out.jpg', jpeg: jpg };
    expect(galleryImageToFile(img)).toEqual({ name: 'out.jpg', bytes: jpg });
  });

  /**
   * An RGBA result is written as PNG, so the name has to follow the bytes: a
   * `.jpg` file that is really a PNG is the failure this rename exists to
   * prevent, and it would only surface later, on restore.
   */
  it('renames an RGBA result to .png, and leaves an already-.png name alone', () => {
    const rgba = new Uint8Array(4 * 4 * 4).fill(200);
    const base = { kind: 'rgba', rgba, width: 4, height: 4 } as const;
    expect(galleryImageToFile({ ...base, name: 'holiday.jpg' }).name).toBe('holiday.png');
    expect(galleryImageToFile({ ...base, name: 'holiday.PNG' }).name).toBe('holiday.PNG');
    expect(galleryImageToFile({ ...base, name: 'no-extension' }).name).toBe('no-extension.png');

    // And the bytes really are a PNG, not just named one.
    const { bytes } = galleryImageToFile({ ...base, name: 'holiday.jpg' });
    expect([bytes[0], bytes[1]]).toEqual([0x89, 0x50]);
  });
});
