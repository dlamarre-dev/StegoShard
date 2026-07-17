/**
 * Headless image I/O for the CLI — the Node/Deno counterpart to the browser
 * canvas adapters in `src/ui/image-io.ts`.
 *
 * Everything here is pure JS (fast-png + jpeg-js, both pako-based, no `node:zlib`
 * and no canvas), so the same code runs under `tsx`, Vitest, and a
 * `deno compile` binary without a Node-compat surface for image handling.
 */

import { decode as decodePng, encode as encodePng } from 'fast-png';
import jpeg from 'jpeg-js';
import {
  CODEC_QR_GRID,
  JpegUnsupportedError,
  StegoCoverFormatError,
  type ImageDataLike,
  embedKeyBlockStego,
  embedKeyBlockStegoJpeg,
  extractKeyBlockStego,
  extractKeyBlockStegoJpeg,
  getCodec,
  isJpeg as isJpegBytes,
} from '@core';

/** A produced stego key image: raw bytes plus how to name it. */
export interface StegoKeyImage {
  bytes: Uint8Array;
  ext: 'jpg' | 'png';
}

/** Encode RGBA pixels to lossless PNG bytes. */
export function imageDataToPng(img: ImageDataLike): Uint8Array {
  return encodePng({
    width: img.width,
    height: img.height,
    data: Uint8Array.from(img.data),
    channels: 4,
    depth: 8,
  });
}

/** Normalize any decoded raster (gray/RGB/RGBA, 8/16-bit) to RGBA 8-bit. */
function toRgba(
  data: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
  depth: number,
): ImageDataLike {
  const out = new Uint8ClampedArray(width * height * 4);
  const shift = depth === 16 ? 8 : 0; // 16-bit → take the high byte
  for (let p = 0; p < width * height; p++) {
    const s = p * channels;
    const d = p * 4;
    const r = data[s]! >> shift;
    if (channels >= 3) {
      out[d] = r;
      out[d + 1] = data[s + 1]! >> shift;
      out[d + 2] = data[s + 2]! >> shift;
      out[d + 3] = channels === 4 ? data[s + 3]! >> shift : 255;
    } else {
      // grayscale (+ optional alpha)
      out[d] = r;
      out[d + 1] = r;
      out[d + 2] = r;
      out[d + 3] = channels === 2 ? data[s + 1]! >> shift : 255;
    }
  }
  return { data: out, width, height };
}

const isPng = (name: string) => /\.png$/i.test(name);
const isJpeg = (name: string) => /\.jpe?g$/i.test(name);

/** Decode PNG/JPEG file bytes into RGBA pixels. Throws on an unsupported format. */
export function fileToImageData(bytes: Uint8Array, filename: string): ImageDataLike {
  // Prefer the extension, but fall back to signature sniffing (PNG magic).
  const looksPng = isPng(filename) || (bytes[0] === 0x89 && bytes[1] === 0x50);
  if (looksPng || (!isJpeg(filename) && bytes[0] === 0x89)) {
    const d = decodePng(bytes);
    return toRgba(d.data, d.width, d.height, d.channels, d.depth);
  }
  const d = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  return { data: new Uint8ClampedArray(d.data), width: d.width, height: d.height };
}

/**
 * Area-average (box) downscale to fit `maxSide` on the longer edge. Averaging
 * (not nearest) suppresses the aliasing/moiré that would otherwise corrupt a
 * QR grid when a high-res photo of a printed page is reduced. Never upscales.
 */
export function downscale(img: ImageDataLike, maxSide: number): ImageDataLike {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (scale >= 1) return img;
  const dw = Math.max(1, Math.round(img.width * scale));
  const dh = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8ClampedArray(dw * dh * 4);
  const sx = img.width / dw;
  const sy = img.height / dh;

  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const s = (yy * img.width + xx) * 4;
          r += img.data[s]!;
          g += img.data[s + 1]!;
          b += img.data[s + 2]!;
          a += img.data[s + 3]!;
          n++;
        }
      }
      const d = (y * dw + x) * 4;
      out[d] = r / n;
      out[d + 1] = g / n;
      out[d + 2] = b / n;
      out[d + 3] = a / n;
    }
  }
  return { data: out, width: dw, height: dh };
}

// Sizes to try when decoding, mirroring the browser's DECODE_MAX_SIDES: the
// natural size first (our own PNGs decode immediately), then progressively
// smaller for photos of printed pages.
const DECODE_MAX_SIDES = [Infinity, 1400, 1000, 1800];

/**
 * Decode one image's bytes to a codec payload, trying a few downscales. Returns
 * null when no QR is readable (a lost image is tolerated by erasure coding).
 */
export function decodeImageToPayload(bytes: Uint8Array, filename: string): Uint8Array | null {
  const codec = getCodec(CODEC_QR_GRID);
  let base: ImageDataLike;
  try {
    base = fileToImageData(bytes, filename);
  } catch {
    return null; // not a decodable image
  }
  for (const maxSide of DECODE_MAX_SIDES) {
    try {
      return codec.decode(maxSide === Infinity ? base : downscale(base, maxSide));
    } catch {
      // try the next scale
    }
  }
  return null;
}

/** Decode already-RGBA pixels (e.g. a PDF raster) to a payload, with downscales. */
export function decodePixelsToPayload(img: ImageDataLike): Uint8Array | null {
  const codec = getCodec(CODEC_QR_GRID);
  for (const maxSide of DECODE_MAX_SIDES) {
    try {
      return codec.decode(maxSide === Infinity ? img : downscale(img, maxSide));
    } catch {
      // try the next scale
    }
  }
  return null;
}

const isPngBytes = (b: Uint8Array): boolean => b[0] === 0x89 && b[1] === 0x50;

/**
 * Hide a key block in a cover photo, keeping its format: a baseline JPEG stays a
 * JPEG (DCT coefficients, ~same size), a PNG stays a PNG (spatial LSB). Any other
 * cover is refused with StegoCoverFormatError (no transcoding).
 */
export async function embedKeyImage(
  coverBytes: Uint8Array,
  coverName: string,
  keyBlock: Uint8Array,
  password: string,
): Promise<StegoKeyImage> {
  if (isJpegBytes(coverBytes)) {
    try {
      const out = await embedKeyBlockStegoJpeg(coverBytes, keyBlock, password);
      return { bytes: out, ext: 'jpg' };
    } catch (err) {
      if (err instanceof JpegUnsupportedError) throw new StegoCoverFormatError();
      throw err;
    }
  }
  if (isPngBytes(coverBytes)) {
    const img = fileToImageData(coverBytes, coverName);
    await embedKeyBlockStego(img.data, img.width, img.height, keyBlock, password);
    return { bytes: imageDataToPng(img), ext: 'png' };
  }
  throw new StegoCoverFormatError();
}

/** Recover a key block hidden in a stego cover image (JPEG or PNG), or null. */
export async function extractKeyImage(
  bytes: Uint8Array,
  filename: string,
  password: string,
): Promise<Uint8Array | null> {
  if (isJpegBytes(bytes)) return extractKeyBlockStegoJpeg(bytes, password);
  if (isPngBytes(bytes)) {
    const img = fileToImageData(bytes, filename);
    return extractKeyBlockStego(img.data, img.width, img.height, password);
  }
  return null;
}
