/**
 * Browser-side image I/O adapters for the disk destination. These bridge the
 * codec's environment-neutral ImageDataLike to real PNG files, using
 * OffscreenCanvas. The disk profile is lossless (PNG), so this bridge does not
 * degrade the encoded bytes.
 */

import {
  JpegUnsupportedError,
  StegoCoverFormatError,
  codecName,
  decodeWithAnyCodec,
  drawBrandBand,
  embedKeyBlockStego,
  embedKeyBlockStegoJpeg,
  embedKeyFactorStego,
  embedKeyFactorStegoJpeg,
  extractKeyBlockStego,
  extractKeyBlockStegoJpeg,
  extractKeyFactorStego,
  extractKeyFactorStegoJpeg,
  isJpeg,
  recoveryLines,
  type GalleryCover,
  type GalleryImage,
  type ImageDataLike,
} from '@core';
import { MAX_BROWSER_MEDIA_BYTES, assertBlobSize, boundedBlobBytes } from './input-limits';

/** A produced stego key image: raw bytes plus how to name/serve it. */
export interface StegoKeyImage {
  bytes: Uint8Array;
  mime: string;
  ext: 'jpg' | 'png';
}

const isPngBytes = (b: Uint8Array): boolean => b[0] === 0x89 && b[1] === 0x50;

/**
 * Default filename for a stego key image. To blend into a camera roll it reuses
 * the cover's own filename; a synthetic fallback is used only when the cover has
 * no usable name. (Restore takes the key image explicitly, so the name is free.)
 */
export function stegoKeyName(coverName: string | undefined, ext: string, setHex: string): string {
  const trimmed = coverName?.trim();
  // The cover's own filename is the deniable choice — it is an ordinary photo
  // the user already had. The fallback only runs when the picked file has no
  // usable name, so it must not announce the project either.
  return trimmed ? trimmed : `image-${setHex}.${ext}`;
}

/** Optional human-readable label band drawn above the QR (cleartext — plan §1). */
export interface LabelBand {
  title?: string | undefined;
  date?: string | undefined;
  index: number;
  total: number;
}

/** Height of the optional user-caption strip, above the brand strip. */
const BAND_HEIGHT = 70;

/** Render an ImageDataLike to a lossless PNG blob. */
export async function imageDataToPngBlob(img: ImageDataLike): Promise<Blob> {
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('image-io: 2D canvas context unavailable');
  // Copy into an ArrayBuffer-backed array (ImageData's constructor requires it).
  const pixels = new Uint8ClampedArray(img.data);
  ctx.putImageData(new ImageData(pixels, img.width, img.height), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

/**
 * Render a generated symbol as a PNG, stamped with the StegoShard mark and an
 * optional readable caption.
 *
 * Two strips sit above the symbol, both *outside* its area, so the quiet zone is
 * untouched and decoding is unaffected:
 *
 *  - The brand strip comes from `@core`, so the browser and the CLI stamp the
 *    same pixels. It carries the mark, the wordmark, and a recovery line naming
 *    the format version and codec — an image found years from now says what it
 *    is and where the spec lives.
 *  - The caption strip, when the user asked for a label, is drawn with canvas
 *    text so a title in any script renders (the core font is ASCII-only).
 *
 * Everything in both strips is cleartext, by design.
 *
 * Callers that must stay unbranded for deniability — gallery covers, stego key
 * covers, disguised binaries — use `imageDataToPngBlob` instead.
 */
export async function imageWithLabelToPngBlob(
  img: ImageDataLike,
  band: LabelBand | undefined,
  codecId: number,
): Promise<Blob> {
  const branded = drawBrandBand(img, { recovery: recoveryLines(codecName(codecId)) });
  if (!band) return imageDataToPngBlob(branded);

  const canvas = new OffscreenCanvas(branded.width, branded.height + BAND_HEIGHT);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('image-io: 2D canvas context unavailable');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'top';
  const pad = 12;
  const maxW = branded.width - pad * 2;
  if (band.title) {
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(band.title, pad, 10, maxW);
  }
  const sub = [band.date, `${band.index} / ${band.total}`].filter(Boolean).join('    ');
  ctx.font = '16px sans-serif';
  ctx.fillText(sub, pad, 42, maxW);

  const pixels = new Uint8ClampedArray(branded.data);
  ctx.putImageData(new ImageData(pixels, branded.width, branded.height), 0, BAND_HEIGHT);
  return canvas.convertToBlob({ type: 'image/png' });
}

/**
 * Decode an image file (PNG/JPEG/…) into pixels for the codec to read,
 * optionally downscaling so the longer side is at most `maxSide`.
 *
 * Downscaling matters for photos of printed pages: the QR decoder fails on
 * full-resolution phone photos (~9 MP) but succeeds once the image is reduced
 * to ~1000–1400 px. Rendered PNGs are already small, so the cap is a no-op for
 * them (it never upscales).
 *
 * On the two guards: `assertBlobSize` is what bounds the *decode*, because it
 * runs before `createImageBitmap` — a compressed image above the cap is never
 * handed to the decoder. The megapixel check below runs after the decode has
 * already happened, so it bounds only what comes next: the canvas allocation
 * and the `getImageData` copy, both several bytes per pixel. Reading the source
 * dimensions ahead of the decode would take a PNG/JPEG header parser, which is
 * not worth it while the compressed cap stands at 25 MiB.
 */
export async function fileToImageData(
  file: Blob,
  maxSide: number = Infinity,
): Promise<ImageDataLike> {
  assertBlobSize(file, MAX_BROWSER_MEDIA_BYTES);
  const bitmap = await createImageBitmap(file);
  try {
    // Bounds the canvas + getImageData allocations below, not the decode above.
    if (bitmap.width * bitmap.height > 40_000_000) {
      throw new Error('image dimensions are too large (40 megapixel limit)');
    }
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('image-io: 2D canvas context unavailable');
    ctx.drawImage(bitmap, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    return { data: data.data, width: data.width, height: data.height };
  } finally {
    bitmap.close();
  }
}

// Sizes to try when decoding an image. Natural size comes first so our own
// rendered PNGs are read without any resampling — that matters most for the
// color grid, whose modules are only a few pixels wide at the disk profile.
// Photos of printed pages need to be downscaled from multiple megapixels before
// the QR decoder can locate the code.
const DECODE_MAX_SIDES = [Infinity, 1400, 1000, 1800];

/**
 * Decode one image's bytes to a codec payload, trying a few downscales. Returns
 * null when no symbol is readable (a lost image is tolerated by erasure coding).
 */
export async function decodeImageBytes(bytes: Uint8Array): Promise<Uint8Array | null> {
  const blob = new Blob([bytes as BufferSource]);
  for (const maxSide of DECODE_MAX_SIDES) {
    try {
      return decodeWithAnyCodec(await fileToImageData(blob, maxSide));
    } catch {
      // Try the next scale.
    }
  }
  return null;
}

/**
 * Hide a serialized key block inside a cover photo (deniable stego key mode),
 * **keeping the cover's format**: a baseline JPEG stays a JPEG of ~the same size
 * (embedded in DCT coefficients); a PNG stays a PNG (spatial LSB). Any other
 * cover (progressive/HEIC/WebP…) is refused with StegoCoverFormatError — we
 * never transcode, which would change the file's size/appearance.
 */
export async function embedKeyImage(
  cover: Blob,
  keyBlock: Uint8Array,
  password: string,
): Promise<StegoKeyImage> {
  const bytes = await boundedBlobBytes(cover, MAX_BROWSER_MEDIA_BYTES);
  if (isJpeg(bytes)) {
    try {
      const out = await embedKeyBlockStegoJpeg(bytes, keyBlock, password);
      return { bytes: out, mime: 'image/jpeg', ext: 'jpg' };
    } catch (err) {
      if (err instanceof JpegUnsupportedError) throw new StegoCoverFormatError();
      throw err;
    }
  }
  if (isPngBytes(bytes)) {
    const img = await fileToImageData(cover); // full resolution (no cap)
    await embedKeyBlockStego(img.data, img.width, img.height, keyBlock, password);
    const blob = await imageDataToPngBlob(img);
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', ext: 'png' };
  }
  throw new StegoCoverFormatError();
}

/**
 * Recover a key block hidden in a stego cover image (JPEG or PNG). Returns null
 * when the password is wrong or the image carries no key (indistinguishable),
 * or when the format is unsupported.
 */
export async function extractKeyImage(file: Blob, password: string): Promise<Uint8Array | null> {
  const bytes = await boundedBlobBytes(file, MAX_BROWSER_MEDIA_BYTES);
  if (isJpeg(bytes)) return extractKeyBlockStegoJpeg(bytes, password);
  if (isPngBytes(bytes)) {
    const img = await fileToImageData(file); // full resolution (no cap)
    return extractKeyBlockStego(img.data, img.width, img.height, password);
  }
  return null;
}

/**
 * Hide the 32-byte external key factor (§10.3) in a cover photo, keeping the
 * cover's format — the stego-delivery counterpart of a raw `.key` file on the
 * multi-region paths (gallery, disguised `.db`). Same format rules as
 * embedKeyImage.
 */
export async function embedKeyFactorImage(
  cover: Blob,
  factor: Uint8Array,
  password: string,
): Promise<StegoKeyImage> {
  const bytes = await boundedBlobBytes(cover, MAX_BROWSER_MEDIA_BYTES);
  if (isJpeg(bytes)) {
    try {
      const out = await embedKeyFactorStegoJpeg(bytes, factor, password);
      return { bytes: out, mime: 'image/jpeg', ext: 'jpg' };
    } catch (err) {
      if (err instanceof JpegUnsupportedError) throw new StegoCoverFormatError();
      throw err;
    }
  }
  if (isPngBytes(bytes)) {
    const img = await fileToImageData(cover); // full resolution (no cap)
    await embedKeyFactorStego(img.data, img.width, img.height, factor, password);
    const blob = await imageDataToPngBlob(img);
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', ext: 'png' };
  }
  throw new StegoCoverFormatError();
}

/**
 * Recover the 32-byte key factor from a stego cover (JPEG or PNG). Returns null
 * when the password is wrong / the image carries no factor / the format is
 * unsupported (all indistinguishable).
 */
export async function extractKeyFactorImage(
  file: Blob,
  password: string,
): Promise<Uint8Array | null> {
  const bytes = await boundedBlobBytes(file, MAX_BROWSER_MEDIA_BYTES);
  if (isJpeg(bytes)) return extractKeyFactorStegoJpeg(bytes, password);
  if (isPngBytes(bytes)) {
    const img = await fileToImageData(file); // full resolution (no cap)
    return extractKeyFactorStego(img.data, img.width, img.height, password);
  }
  return null;
}

// --- Gallery Mode cover I/O (SPEC §9) ----------------------------------------

/**
 * Turn a picked file into a gallery cover. A baseline JPEG is kept as raw bytes
 * (its DCT coefficients are the carrier and must not be re-encoded); anything
 * else is decoded to full-resolution RGBA (a cover is never downscaled — gallery
 * embedding is position-sensitive).
 */
export async function fileToGalleryCover(file: File): Promise<GalleryCover> {
  const bytes = await boundedBlobBytes(file, MAX_BROWSER_MEDIA_BYTES);
  if (isJpeg(bytes)) return { kind: 'jpeg', name: file.name, jpeg: bytes };
  const img = await fileToImageData(file);
  return { kind: 'rgba', name: file.name, rgba: img.data, width: img.width, height: img.height };
}

/** Serialize a produced gallery image to a download blob, keeping its format. */
export async function galleryImageToBlob(img: GalleryImage): Promise<{ name: string; blob: Blob }> {
  if (img.kind === 'jpeg') {
    return { name: img.name, blob: new Blob([img.jpeg as BufferSource], { type: 'image/jpeg' }) };
  }
  const data = new Uint8ClampedArray(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength);
  const blob = await imageDataToPngBlob({ data, width: img.width, height: img.height });
  const name = /\.png$/i.test(img.name) ? img.name : `${img.name.replace(/\.[^.]+$/, '')}.png`;
  return { name, blob };
}

/**
 * Trigger a browser download for a blob. When `subdir` is given, the file is
 * placed in that folder under the browser's download directory — Chromium
 * honors a relative path in the `download` attribute (Firefox/Safari flatten to
 * the basename, so it degrades gracefully).
 */
export function downloadBlob(blob: Blob, filename: string, subdir?: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = subdir ? `${subdir}/${filename}` : filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
