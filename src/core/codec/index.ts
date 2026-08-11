import { CODEC_COLOR_GRID, CODEC_GALLERY, CODEC_QR_GRID } from '../header';
import type { Codec, ImageDataLike } from './types';
import { qrGridCodec } from './qr-grid';
import { colorGridCodec } from './color-grid';

export * from './types';
export { qrGridCodec } from './qr-grid';
export { colorGridCodec } from './color-grid';

/** Resolve a codec by its CODEC_ID (as stored in the image header). */
export function getCodec(id: number): Codec {
  switch (id) {
    case CODEC_QR_GRID:
      return qrGridCodec;
    case CODEC_COLOR_GRID:
      return colorGridCodec;
    default:
      throw new Error(`unknown codec id ${id}`);
  }
}

/** Spec name for a CODEC_ID, as printed on the recovery line of an image. */
export function codecName(id: number): string {
  switch (id) {
    case CODEC_QR_GRID:
      return 'qr-grid';
    case CODEC_COLOR_GRID:
      return 'color-grid';
    case CODEC_GALLERY:
      return 'gallery';
    default:
      return `codec-${id}`;
  }
}

/**
 * Mean chroma of a sparse sample of the image, on a 0..255 scale.
 *
 * The per-image header lives *inside* the payload, so CODEC_ID cannot tell a
 * decoder which codec to use; it has to guess from the pixels. A qr-grid symbol
 * is pure greyscale; a color-grid symbol is mostly saturated. One cheap number
 * separates them, and `decodeWithAnyCodec` still falls back either way, so a
 * wrong guess only costs a second attempt.
 */
function meanChroma(image: ImageDataLike): number {
  const { data, width, height } = image;
  const step = Math.max(1, Math.floor((width * height) / 4096));
  let total = 0;
  let count = 0;
  for (let i = 0; i < width * height; i += step) {
    const p = i * 4;
    const r = data[p]!;
    const g = data[p + 1]!;
    const b = data[p + 2]!;
    total += Math.max(r, g, b) - Math.min(r, g, b);
    count++;
  }
  return count === 0 ? 0 : total / count;
}

/** Colour separation above which an image is more likely a color grid than a QR. */
const CHROMA_HINT = 24;

/**
 * Decode an image payload with whichever image codec actually matches, trying
 * the more likely one first. Throws only if both fail.
 */
export function decodeWithAnyCodec(image: ImageDataLike): Uint8Array {
  const order =
    meanChroma(image) >= CHROMA_HINT
      ? [colorGridCodec, qrGridCodec]
      : [qrGridCodec, colorGridCodec];
  let firstError: unknown;
  for (const codec of order) {
    try {
      return codec.decode(image);
    } catch (err) {
      firstError ??= err;
    }
  }
  throw firstError instanceof Error ? firstError : new Error('codec: no readable symbol in image');
}
