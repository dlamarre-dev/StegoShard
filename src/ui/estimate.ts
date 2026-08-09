/**
 * Per-destination availability + output-count estimates for a chosen file,
 * shared by the guided wizard and the expert UI so both grey out the same
 * destinations and show the same counts. Pure (localizer passed in), and it
 * compresses the file only once via `buildPayload`.
 *
 * Image destinations report a count per codec, not just for the selected one:
 * the point of offering the choice is that the user can see what it buys, and
 * the arithmetic is free once the envelope length is known.
 */

import {
  GALLERY_K_MAX,
  MAX_FILE_BYTES,
  MAX_FILE_BYTES_BINARY_UI,
  MAX_IMAGES,
  PROFILE_DISK,
  PROFILE_PAPER,
  buildPayload,
  galleryCoversForEnvelopeLen,
  imagesForEnvelopeLen,
} from '@core';
import { boundedBlobBytes } from './input-limits';
import type { KeyMode } from '@core';
import {
  CODEC_CHOICES,
  type CodecChoice,
  type Msg,
  type SaveDestination,
  codecApplies,
  codecIdFor,
} from './save-controller';

/** Per-destination availability + expected output count for the chosen file. */
export interface DestEstimate {
  /**
   * Whether this destination can hold the file **under at least one codec**.
   *
   * Availability is deliberately best-case: a codec that would blow the image
   * limit disqualifies the *codec*, not the destination. Greying out the codec
   * option is a local, obvious signal; silently moving the user's destination
   * because they toggled a codec is not.
   */
  available: boolean;
  /** Images (disk/paper), 1 (binary/sqlite), or needed photos (gallery). */
  count: number;
  /**
   * Image count per codec, for the destinations that offer the choice. Lets the
   * UI label both options at once ("Colour — 12 files" / "QR — 34 files"). Always
   * populated for those destinations, including when a codec does not fit — the
   * count next to the *other* codec is exactly what tells the user how to fix it.
   */
  counts?: Partial<Record<CodecChoice, number>>;
  /** Which codecs stay within the image limit here. */
  codecFits?: Partial<Record<CodecChoice, boolean>>;
  /** Gallery only: minimum cover photos needed. */
  needed?: number;
  /** Why unavailable, when `available` is false. */
  reason?: string;
}
export type Estimates = Partial<Record<SaveDestination, DestEstimate>>;

/** Human-readable byte size, e.g. "512 KB" / "1.4 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What the caller has selected, and which affects the counts. */
export interface EstimateContext {
  keyMode?: KeyMode | undefined;
  codec?: CodecChoice | undefined;
}

/** Availability + count for one destination, from the file's size + envelope length. */
export function estimateFor(
  dest: SaveDestination,
  size: number,
  envelopeLen: number,
  msg: Msg,
  ctx: EstimateContext = {},
): DestEstimate {
  if (dest === 'binary' || dest === 'sqlite') {
    return size <= MAX_FILE_BYTES_BINARY_UI
      ? { available: true, count: 1 }
      : { available: false, count: 0, reason: msg('wizTooLargeBinary') };
  }
  if (dest === 'gallery') {
    if (size > MAX_FILE_BYTES) return { available: false, count: 0, reason: msg('wizTooLarge') };
    const { k, needed } = galleryCoversForEnvelopeLen(envelopeLen, 'embedded');
    return k <= GALLERY_K_MAX
      ? { available: true, count: needed, needed }
      : { available: false, count: 0, reason: msg('wizTooLarge') };
  }
  // disk / paper
  if (size > MAX_FILE_BYTES) return { available: false, count: 0, reason: msg('wizTooLarge') };
  const profile = dest === 'paper' ? PROFILE_PAPER : PROFILE_DISK;
  const keyMode = ctx.keyMode ?? 'embedded';

  const imagesWith = (codec: CodecChoice | undefined): number =>
    imagesForEnvelopeLen(envelopeLen, { profile, keyMode, codecId: codecIdFor(dest, codec) })
      .images;

  const tooMany = msg('wizTooManyImages', String(MAX_IMAGES));

  if (!codecApplies(dest)) {
    // Paper always renders qr-grid, so there is one count and no choice.
    const images = imagesWith(undefined);
    return images <= MAX_IMAGES
      ? { available: true, count: images }
      : { available: false, count: 0, reason: tooMany };
  }

  const counts: Partial<Record<CodecChoice, number>> = {};
  const codecFits: Partial<Record<CodecChoice, boolean>> = {};
  for (const c of CODEC_CHOICES) {
    counts[c] = imagesWith(c);
    codecFits[c] = counts[c]! <= MAX_IMAGES;
  }

  const available = CODEC_CHOICES.some((c) => codecFits[c]);
  const selected = ctx.codec ?? 'color';
  return {
    available,
    // Callers snap away from a codec that does not fit (`firstCodecThatFits`),
    // so the headline count tracks a selection that is actually saveable.
    count: codecFits[selected] ? counts[selected]! : 0,
    counts,
    codecFits,
    ...(available ? {} : { reason: tooMany }),
  };
}

/**
 * The user's codec if it fits here, otherwise the first one that does.
 *
 * A codec that would exceed the image limit is disabled in the UI, so the
 * selection has to move off it — the destination stays put.
 */
export function firstCodecThatFits(
  estimate: DestEstimate | undefined,
  codec: CodecChoice,
): CodecChoice {
  if (!estimate?.codecFits || estimate.codecFits[codec]) return codec;
  return CODEC_CHOICES.find((c) => estimate.codecFits![c]) ?? codec;
}

/**
 * Compressed envelope length for a file — the one expensive step. Cache it per
 * file so the counts can be recomputed for free every time the user changes
 * codec or key mode.
 */
export async function envelopeLenFor(file: File): Promise<number> {
  const bytes = await boundedBlobBytes(file, MAX_FILE_BYTES_BINARY_UI);
  return (await buildPayload(file.name, bytes)).length;
}

/**
 * Envelope length for estimation, or 0 for a file past the binary ceiling.
 *
 * `envelopeLenFor` throws `FileTooLargeError` there, which would rob the UI of
 * the chance to say *why* every destination is unavailable. Every branch of
 * `estimateFor` rejects on `size` alone at that point and never reads the
 * envelope length, so the placeholder is never consulted.
 */
export async function envelopeLenForEstimate(file: File): Promise<number> {
  if (file.size > MAX_FILE_BYTES_BINARY_UI) return 0;
  return envelopeLenFor(file);
}

/** Availability for every destination, from an already-measured envelope. */
export function estimatesFrom(
  size: number,
  envelopeLen: number,
  dests: SaveDestination[],
  msg: Msg,
  ctx: EstimateContext = {},
): Estimates {
  const est: Estimates = {};
  for (const d of dests) est[d] = estimateFor(d, size, envelopeLen, msg, ctx);
  return est;
}

/** Compute availability for every destination, compressing the file only once. */
export async function computeEstimates(
  file: File,
  dests: SaveDestination[],
  msg: Msg,
  ctx: EstimateContext = {},
): Promise<Estimates> {
  return estimatesFrom(file.size, await envelopeLenForEstimate(file), dests, msg, ctx);
}
