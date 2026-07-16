/**
 * Browser-side image I/O adapters for the disk destination. These bridge the
 * codec's environment-neutral ImageDataLike to real PNG files, using
 * OffscreenCanvas. The disk profile is lossless (PNG), so this bridge does not
 * degrade the encoded bytes.
 */

import {
  CODEC_QR_GRID,
  embedKeyBlockStego,
  extractKeyBlockStego,
  getCodec,
  type ImageDataLike,
} from '@core';

/** Optional human-readable label band drawn above the QR (cleartext — plan §1). */
export interface LabelBand {
  title?: string | undefined;
  date?: string | undefined;
  index: number;
  total: number;
}

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
 * Render the QR with an optional readable label band on top. The band lives
 * *outside* the QR area (its own white strip), so the QR's quiet zone is
 * untouched and decoding is unaffected. Everything in the band is cleartext.
 */
export async function imageWithLabelToPngBlob(img: ImageDataLike, band?: LabelBand): Promise<Blob> {
  if (!band) return imageDataToPngBlob(img);

  const canvas = new OffscreenCanvas(img.width, img.height + BAND_HEIGHT);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('image-io: 2D canvas context unavailable');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'top';
  const pad = 12;
  const maxW = img.width - pad * 2;
  if (band.title) {
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(band.title, pad, 10, maxW);
  }
  const sub = [band.date, `${band.index} / ${band.total}`].filter(Boolean).join('    ');
  ctx.font = '16px sans-serif';
  ctx.fillText(sub, pad, 42, maxW);

  const pixels = new Uint8ClampedArray(img.data);
  ctx.putImageData(new ImageData(pixels, img.width, img.height), 0, BAND_HEIGHT);
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
 */
export async function fileToImageData(
  file: Blob,
  maxSide: number = Infinity,
): Promise<ImageDataLike> {
  const bitmap = await createImageBitmap(file);
  try {
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

// Sizes to try when decoding an image. Rendered PNGs decode at the first (their
// natural size is already below the cap); photos of printed pages need to be
// downscaled from multiple megapixels before the QR decoder can locate the code.
const DECODE_MAX_SIDES = [1400, 1000, 1800];

/**
 * Decode one image's bytes to a codec payload, trying a few downscales. Returns
 * null when no QR is readable (a lost image is tolerated by erasure coding).
 */
export async function decodeImageBytes(bytes: Uint8Array): Promise<Uint8Array | null> {
  const codec = getCodec(CODEC_QR_GRID);
  const blob = new Blob([bytes as BufferSource]);
  for (const maxSide of DECODE_MAX_SIDES) {
    try {
      return codec.decode(await fileToImageData(blob, maxSide));
    } catch {
      // Try the next scale.
    }
  }
  return null;
}

/**
 * Hide a serialized key block inside a cover photo (deniable stego key mode).
 * The cover is decoded at full resolution — no downscaling — and re-emitted as
 * a lossless PNG so the carrier LSBs survive. Returns the PNG blob.
 */
export async function embedKeyImage(
  cover: Blob,
  keyBlock: Uint8Array,
  password: string,
): Promise<Blob> {
  const img = await fileToImageData(cover); // full resolution (no cap)
  await embedKeyBlockStego(img.data, img.width, img.height, keyBlock, password);
  return imageDataToPngBlob(img);
}

/**
 * Recover a key block hidden in a stego cover image. Returns null when the
 * password is wrong or the image carries no key (deliberately indistinguishable).
 */
export async function extractKeyImage(file: Blob, password: string): Promise<Uint8Array | null> {
  const img = await fileToImageData(file); // full resolution (no cap)
  return extractKeyBlockStego(img.data, img.width, img.height, password);
}

/** Trigger a browser download for a blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
