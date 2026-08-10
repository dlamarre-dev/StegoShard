/**
 * Internal content envelope (plan §4), the plaintext that gets encrypted:
 *
 *   [ FLAGS 1 ][ NAME_LEN 2 ][ FILENAME (UTF-8) ][ CONTENT ]
 *
 * FLAGS bit0 = CONTENT is gzip-compressed.
 * FLAGS bit1 = CONTENT is a .zip holding several files (SPEC §4).
 *
 * The filename is carried *inside* the encrypted envelope, so neither the name
 * nor the file type ever leaks.
 *
 * Zipping itself is left to the callers: this module reaches only for the
 * platform streams API, which is what lets the Python reference decoder inflate
 * a payload with its standard library. A decoder written before bit1 existed
 * ignores it and hands back the .zip — degraded, never wrong.
 */

import { compressOpportunistic, gzipDecompress } from './compress';
import { concatBytes, readU16, writeU16 } from './bytes';

const FLAG_COMPRESSED = 0x01;
const FLAG_BUNDLE = 0x02;
const MAX_NAME_LEN = 0xffff;

/**
 * Build the (plaintext) envelope for a file, compressing content when it helps.
 *
 * `bundle` marks CONTENT as a .zip of several files. A single-file save never
 * sets it, so by far the commonest case still produces byte-for-byte the
 * envelope it always did.
 */
export async function buildPayload(
  filename: string,
  content: Uint8Array,
  opts: { bundle?: boolean } = {},
): Promise<Uint8Array> {
  const nameBytes = new TextEncoder().encode(filename);
  if (nameBytes.length > MAX_NAME_LEN) throw new RangeError('payload: filename too long');

  const { data, compressed } = await compressOpportunistic(content);
  const flags = (compressed ? FLAG_COMPRESSED : 0) | (opts.bundle ? FLAG_BUNDLE : 0);

  const header = new Uint8Array(1 + 2);
  header[0] = flags;
  writeU16(header, 1, nameBytes.length);
  return concatBytes(header, nameBytes, data);
}

/**
 * Parse an envelope back into filename + original content. `maxContentBytes`
 * bounds decompression of the (untrusted) content to guard against a gzip bomb.
 */
export async function parsePayload(
  bytes: Uint8Array,
  maxContentBytes: number,
): Promise<{ filename: string; content: Uint8Array; bundled: boolean }> {
  if (bytes.length < 3) throw new Error('payload: too short');
  const flags = bytes[0]!;
  const nameLen = readU16(bytes, 1);
  const nameEnd = 3 + nameLen;
  if (bytes.length < nameEnd) throw new Error('payload: truncated filename');
  const filename = new TextDecoder().decode(bytes.slice(3, nameEnd));
  const stored = bytes.slice(nameEnd);
  const content = flags & FLAG_COMPRESSED ? await gzipDecompress(stored, maxContentBytes) : stored;
  return { filename, content, bundled: Boolean(flags & FLAG_BUNDLE) };
}
