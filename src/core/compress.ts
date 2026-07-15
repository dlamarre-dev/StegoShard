/**
 * Opportunistic gzip compression using the platform streams API
 * (CompressionStream / DecompressionStream), available in modern browsers and
 * Node ≥ 18. The wire format is gzip (RFC 1952) so the Python reference decoder
 * can inflate with its standard library.
 */

import { concatBytes } from './bytes';

/**
 * Pump `data` through a transform stream, streaming the output so it can be
 * bounded — decompression of untrusted input must not be allowed to balloon
 * memory (a gzip bomb). Throws if the output exceeds `maxBytes`.
 */
async function pipeThrough(
  data: Uint8Array,
  stream: GenericTransformStream,
  maxBytes: number,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // Cancelling the reader (on overflow) errors the writable side; swallow those
  // rejections so they don't surface as unhandled.
  writer.write(data).catch(() => {});
  writer.close().catch(() => {});
  const reader = (stream.readable as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('decompressed data exceeds the allowed size');
    }
    chunks.push(value);
  }
  return concatBytes(...chunks);
}

export function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  return pipeThrough(data, new CompressionStream('gzip'), Infinity);
}

/** Inflate gzip data, refusing output larger than `maxBytes` (gzip-bomb guard). */
export function gzipDecompress(data: Uint8Array, maxBytes: number = Infinity): Promise<Uint8Array> {
  return pipeThrough(data, new DecompressionStream('gzip'), maxBytes);
}

/**
 * Compress `data`, but only keep the result if it is actually smaller.
 * Returns whether compression was applied so the caller can record a flag.
 */
export async function compressOpportunistic(
  data: Uint8Array,
): Promise<{ data: Uint8Array; compressed: boolean }> {
  const gz = await gzipCompress(data);
  return gz.length < data.length ? { data: gz, compressed: true } : { data, compressed: false };
}
