/**
 * Browser-side image I/O adapters for the disk destination. These bridge the
 * codec's environment-neutral ImageDataLike to real PNG files, using
 * OffscreenCanvas. The disk profile is lossless (PNG), so this bridge does not
 * degrade the encoded bytes.
 */

import {
  CODEC_QR_GRID,
  JpegUnsupportedError,
  StegoCoverFormatError,
  embedKeyBlockStego,
  embedKeyBlockStegoJpeg,
  extractKeyBlockStego,
  extractKeyBlockStegoJpeg,
  getCodec,
  isJpeg,
  type GalleryCover,
  type GalleryImage,
  type ImageDataLike,
} from '@core';

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
  return trimmed ? trimmed : `stegoshard-${setHex}-key.${ext}`;
}

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
  const bytes = new Uint8Array(await cover.arrayBuffer());
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
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isJpeg(bytes)) return extractKeyBlockStegoJpeg(bytes, password);
  if (isPngBytes(bytes)) {
    const img = await fileToImageData(file); // full resolution (no cap)
    return extractKeyBlockStego(img.data, img.width, img.height, password);
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
  const bytes = new Uint8Array(await file.arrayBuffer());
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
