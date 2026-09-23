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
  type StegoEmbedOptions,
  embedKeyFactorStego,
  embedKeyFactorStegoJpeg,
  extractKeyBlockStego,
  extractKeyBlockStegoJpeg,
  brandCaption,
  extractKeyFactorStego,
  extractKeyFactorStegoJpeg,
  isHeif,
  isJpeg,
  recoveryLines,
  reencodeCover,
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
  // The cover's own filename is the deniable choice; it is an ordinary photo
  // the user already had. The fallback only runs when the picked file has no
  // usable name, so it must not announce the project either.
  return trimmed ? trimmed : `image-${setHex}.${ext}`;
}

/** Optional human-readable label band drawn above the QR (cleartext; plan §1). */
export interface LabelBand {
  title?: string | undefined;
  date?: string | undefined;
  index: number;
  total: number;
}

/**
 * Height of the fallback title strip, used only for a title the brand font
 * cannot draw (see `imageWithLabelToPngBlob`). One line of 22px bold text.
 */
const FALLBACK_TITLE_HEIGHT = 40;

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
 * Render a generated symbol as a PNG, stamped with the StegoShard mark and the
 * readable caption.
 *
 * The caption (an optional title, then the date and "3 / 12") is part of the
 * brand strip that `@core` draws, in the same 5x7 font, under the recovery lines.
 * That is what makes an image saved here identical to one the CLI writes and to
 * the samples in the README; the browser used to draw its own sans-serif strip
 * *above* the mark instead, which looked like a different product.
 *
 * The date and the sequence number are always stamped. They used to appear only
 * when a title had been asked for, so an unlabelled set said nothing about when
 * it was made or how many pieces it had, which is exactly what someone holding
 * one printed page needs to know.
 *
 * The one thing the shared font cannot do is a script with no ASCII form, so a
 * title in Japanese or Cyrillic still gets a canvas-drawn strip of its own rather
 * than being dropped. Latin diacritics are folded (see `foldToBrandText`), so
 * European titles take the shared path.
 *
 * Everything here is cleartext, by design. Callers that must stay unbranded for
 * deniability (gallery covers, stego key covers, disguised binaries) use
 * `imageDataToPngBlob` instead.
 */
export async function imageWithLabelToPngBlob(
  img: ImageDataLike,
  band: LabelBand | undefined,
  codecId: number,
): Promise<Blob> {
  const { lines, unstampableTitle } = brandCaption(band ?? {});
  const branded = drawBrandBand(img, {
    recovery: recoveryLines(codecName(codecId)),
    lines,
  });
  // The common case: one strip, drawn entirely by the shared renderer.
  if (!unstampableTitle) return imageDataToPngBlob(branded);

  const canvas = new OffscreenCanvas(branded.width, branded.height + FALLBACK_TITLE_HEIGHT);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('image-io: 2D canvas context unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'top';
  const pad = 12;
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText(unstampableTitle, pad, 9, branded.width - pad * 2);

  const pixels = new Uint8ClampedArray(branded.data);
  ctx.putImageData(new ImageData(pixels, branded.width, branded.height), 0, FALLBACK_TITLE_HEIGHT);
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
 * runs before `createImageBitmap`, so a compressed image above the cap is never
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
// rendered PNGs are read without any resampling, which matters most for the
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
 * cover (progressive/HEIC/WebP…) is refused with StegoCoverFormatError; we
 * never transcode, which would change the file's size/appearance.
 */
export async function embedKeyImage(
  cover: Blob,
  keyBlock: Uint8Array,
  password: string,
  opts?: StegoEmbedOptions,
): Promise<StegoKeyImage> {
  const bytes = await boundedBlobBytes(cover, MAX_BROWSER_MEDIA_BYTES);
  if (isJpeg(bytes)) {
    try {
      const out = await embedKeyBlockStegoJpeg(bytes, keyBlock, password, undefined, opts);
      return { bytes: out, mime: 'image/jpeg', ext: 'jpg' };
    } catch (err) {
      if (err instanceof JpegUnsupportedError) throw new StegoCoverFormatError();
      throw err;
    }
  }
  if (isPngBytes(bytes)) {
    const img = await fileToImageData(cover); // full resolution (no cap)
    await embedKeyBlockStego(img.data, img.width, img.height, keyBlock, password, undefined, opts);
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
 * Hide the 32-byte external key factor (§10.3) in a cover photo, the
 * stego-delivery counterpart of a raw `.key` file on the multi-region paths
 * (gallery, disguised `.db`).
 *
 * `container` says what to do with the cover first, and the two answers belong
 * to two different deliveries. `'as-is'` keeps the cover's own format, which is
 * §5.4: a key photo delivered beside a `.db` sits in a library of device files,
 * and transcoding it would make it the one that does not match. `'profile'`
 * re-encodes it into the gallery profile, because a key photo delivered *with* a
 * gallery has to match that set instead, and a lone PNG among twelve profile
 * JPEGs is the most interesting file in the folder (SPEC §9.8).
 */
export async function embedKeyFactorImage(
  cover: Blob,
  factor: Uint8Array,
  password: string,
  container: 'as-is' | 'profile',
  opts?: StegoEmbedOptions,
): Promise<StegoKeyImage> {
  const bytes = await boundedBlobBytes(cover, MAX_BROWSER_MEDIA_BYTES);
  if (container === 'profile') {
    // Re-encode first, then embed: the payload lives in the coefficients, so a
    // re-encode after the embed would destroy it. Same order the covers take.
    const img = await fileToImageData(cover); // full resolution (no cap)
    try {
      // Named where a name exists, so a comb refusal says which photo to swap.
      const label = cover instanceof File ? cover.name : undefined;
      const profiled = reencodeCover(img, isJpeg(bytes) ? bytes : undefined, label);
      const out = await embedKeyFactorStegoJpeg(profiled, factor, password, undefined, opts);
      return { bytes: out, mime: 'image/jpeg', ext: 'jpg' };
    } catch (err) {
      if (err instanceof JpegUnsupportedError) throw new StegoCoverFormatError();
      throw err;
    }
  }
  if (isJpeg(bytes)) {
    try {
      const out = await embedKeyFactorStegoJpeg(bytes, factor, password, undefined, opts);
      return { bytes: out, mime: 'image/jpeg', ext: 'jpg' };
    } catch (err) {
      if (err instanceof JpegUnsupportedError) throw new StegoCoverFormatError();
      throw err;
    }
  }
  if (isPngBytes(bytes)) {
    const img = await fileToImageData(cover); // full resolution (no cap)
    await embedKeyFactorStego(img.data, img.width, img.height, factor, password, undefined, opts);
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
 * Turn image file bytes into a gallery cover.
 *
 * By default every cover, whatever it arrived as, is decoded to pixels and
 * re-encoded into the one profile (SPEC §9.8): that is what makes a set of
 * photos from three devices one kind of file instead of three. A PNG becomes a
 * JPEG, and its name follows, because a set that is JPEG except for the PNGs
 * sorts on exactly that.
 *
 * `preserveContainer` keeps the old behaviour — a baseline JPEG carried as-is,
 * anything else decoded to RGBA — for the caller who knows what it costs: the
 * source's quantization tables, its ICC profile, its makernote and its XMP
 * dialect all survive, and a mixed-device set stays mixed. It is a flag, never
 * the default.
 */
export async function fileToGalleryCover(
  file: File,
  opts: { preserveContainer?: boolean | undefined } = {},
): Promise<GalleryCover> {
  const bytes = await boundedBlobBytes(file, MAX_BROWSER_MEDIA_BYTES);
  // HEIC/HEIF/AVIF named before the decode attempt, mirroring the Node adapter:
  // StegoShard never ingests one (SPEC §5.4), and a browser that happens to
  // decode HEIC would otherwise silently transcode a carrier. See `isHeif`.
  if (isHeif(bytes)) throw new StegoCoverFormatError();
  if (opts.preserveContainer) {
    if (isJpeg(bytes)) return { kind: 'jpeg', name: file.name, jpeg: bytes };
    const raster = await fileToImageData(file);
    return {
      kind: 'rgba',
      name: file.name,
      rgba: raster.data,
      width: raster.width,
      height: raster.height,
    };
  }
  const img = await fileToImageData(file);
  const encoded = reencodeCover(img, isJpeg(bytes) ? bytes : undefined, file.name);
  return { kind: 'jpeg', name: asJpegName(file.name), jpeg: encoded };
}

/** A re-encoded cover is a JPEG whatever it arrived as, so its name says so. */
export function asJpegName(name: string): string {
  return /\.jpe?g$/i.test(name) ? name : `${name.replace(/\.[^.]+$/, '')}.jpg`;
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
 * Trigger a browser download for a blob.
 *
 * The filename is a **basename**, never a path. This used to accept a `subdir`
 * and write `subdir/filename` into the `download` attribute, on the belief that
 * Chromium would file the download in that folder. It does not: only
 * `chrome.downloads.download({filename})` honours a relative path, and this
 * extension does not even request that permission. Every browser sanitises the
 * separator instead, so a gallery photo landed as
 * `18265a84d89ddadf_IMG_2043.jpg` and a disguised database as
 * `app-data-3f9c1e20_cache.db` — the set id welded to the front of artifacts
 * whose whole purpose is to look like nothing in particular.
 */
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
