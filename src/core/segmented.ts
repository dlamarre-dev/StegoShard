/**
 * Segmented binary vault format (SPEC §8) — the container for the non-image
 * ".ssbn"/".db" delivery paths.
 *
 * Instead of one opaque `AES-GCM(envelope)` (which blocks for seconds on large
 * files and gives no progress), the compressed envelope is split into fixed-size
 * chunks and each chunk is sealed independently with AES-256-GCM under a STREAM
 * nonce discipline (Hoang–Reyhanitabar–Rogaway–Vizár; the construction `age`
 * uses). This lets the encrypt/decrypt loop report a real byte-level percentage
 * and yield between chunks (off the main thread, in a Web Worker).
 *
 * Blob layout (self-describing so branded / SQLite-disguised / bare all dispatch
 * identically on the SEG_MAGIC):
 *
 *   [ SEG_MAGIC "SSCS" 4 ][ SEG_VERSION 1 ][ FLAGS 1 ][ KB_LEN u16 ]
 *   [ keyBlock KB_LEN ][ contentSalt 16 ][ noncePrefix 7 ]
 *   [ chunkSize u32 ][ plaintextLen u64 ]
 *   [ chunk_0 ] … [ chunk_{n-1} ]      chunk_i = ciphertext_i || tag_i(16)
 *
 * Security properties:
 *  - Nonce = noncePrefix(7, random per export) || u32_be(chunkIndex) || finalByte.
 *    The prefix is fresh per export and the counter is unique per chunk, so
 *    (key, nonce) never repeats — the one thing GCM cannot survive.
 *  - AAD = the entire header prefix, binding every chunk to the version, salt,
 *    nonce prefix, chunk size, plaintext length, and key block.
 *  - Only the final chunk carries finalByte = 1; truncation at a chunk boundary
 *    makes the new last chunk decrypt under finalByte = 1 though it was sealed
 *    with 0 → tag fails. An exact body-length cross-check is a cheaper second
 *    guard. Reordering swaps counters → tag fails. Each chunk is authenticated
 *    before its plaintext is retained, and nothing is delivered until the whole
 *    message decodes (no partial-plaintext exposure).
 *
 * Mirrored by the Python reference decoder (python/stegoshard/segmented.py) and
 * pinned by cross-language test vectors.
 */

import { concatBytes, readU16, readU32, readU64, writeU16, writeU32, writeU64 } from './bytes';
import {
  aeadOpen,
  aeadSeal,
  CONTENT_SALT_LEN,
  deriveContentKey,
  GCM_TAG_LEN,
  IV_LEN,
  parseKeyBlock,
  randomBytes,
  unlockKeyBlock,
} from './crypto';
import { buildPayload, parsePayload } from './payload';
import type { OnProgress } from './progress';
import type { KeyMode } from './types';
import type { VaultKey } from './vault';
import { MissingKeyError } from './vault';

/** "SSCS" — StegoShard Chunked Segments. Distinct from SSBN/SSKY/SSHD. */
export const SEG_MAGIC = Uint8Array.from([0x53, 0x53, 0x43, 0x53]);
export const SEG_VERSION = 1;
/** Random per-export nonce prefix; 7 + 4 (counter) + 1 (final) = 12-byte GCM IV. */
export const NONCE_PREFIX_LEN = 7;
/** Default chunk size: 1 MiB — ~0.0015% tag overhead, ~100 updates per 100 MiB. */
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const MIN_CHUNK_SIZE = 4096;
const MAX_CHUNK_SIZE = 16 * 1024 * 1024;

const FLAG_KEY_EMBEDDED = 0x01;
/** Fixed header bytes preceding the (variable) key block: magic+ver+flags+kbLen. */
const HEAD_FIXED = SEG_MAGIC.length + 1 + 1 + 2; // 8
/** Fixed header bytes after the key block: salt + noncePrefix + chunkSize + len. */
const TAIL_FIXED = CONTENT_SALT_LEN + NONCE_PREFIX_LEN + 4 + 8; // 35

/** Raised on any structural / authentication failure of a segmented blob. */
export class SegmentedFormatError extends Error {
  constructor(message: string) {
    super(`segmented vault: ${message}`);
    this.name = 'SegmentedFormatError';
  }
}

/** True when `bytes` begins with the segmented-blob magic. */
export function looksLikeSegmented(bytes: Uint8Array): boolean {
  if (bytes.length < SEG_MAGIC.length) return false;
  for (let i = 0; i < SEG_MAGIC.length; i++) if (bytes[i] !== SEG_MAGIC[i]) return false;
  return true;
}

function buildNonce(prefix: Uint8Array, index: number, final: boolean): Uint8Array {
  const nonce = new Uint8Array(IV_LEN);
  nonce.set(prefix, 0);
  writeU32(nonce, NONCE_PREFIX_LEN, index);
  nonce[IV_LEN - 1] = final ? 1 : 0;
  return nonce;
}

function buildHeader(
  keyBlock: Uint8Array,
  contentSalt: Uint8Array,
  noncePrefix: Uint8Array,
  chunkSize: number,
  plaintextLen: number,
): Uint8Array {
  const head = new Uint8Array(HEAD_FIXED);
  head.set(SEG_MAGIC, 0);
  head[SEG_MAGIC.length] = SEG_VERSION;
  head[SEG_MAGIC.length + 1] = keyBlock.length > 0 ? FLAG_KEY_EMBEDDED : 0;
  writeU16(head, SEG_MAGIC.length + 2, keyBlock.length);
  const tail = new Uint8Array(TAIL_FIXED);
  tail.set(contentSalt, 0);
  tail.set(noncePrefix, CONTENT_SALT_LEN);
  writeU32(tail, CONTENT_SALT_LEN + NONCE_PREFIX_LEN, chunkSize);
  writeU64(tail, CONTENT_SALT_LEN + NONCE_PREFIX_LEN + 4, plaintextLen);
  return concatBytes(head, keyBlock, tail);
}

interface ParsedHeader {
  header: Uint8Array; // the AAD: header bytes [0, headerLen)
  headerLen: number;
  keyBlock: Uint8Array;
  contentSalt: Uint8Array;
  noncePrefix: Uint8Array;
  chunkSize: number;
  plaintextLen: number;
}

function parseHeader(blob: Uint8Array): ParsedHeader {
  if (blob.length < HEAD_FIXED) throw new SegmentedFormatError('too short');
  if (!looksLikeSegmented(blob)) throw new SegmentedFormatError('bad magic');
  let o = SEG_MAGIC.length;
  const version = blob[o]!;
  o += 1;
  if (version !== SEG_VERSION) throw new SegmentedFormatError(`unsupported version ${version}`);
  o += 1; // flags — informational; the true source is KB_LEN
  const kbLen = readU16(blob, o);
  o += 2;
  const headerLen = o + kbLen + TAIL_FIXED;
  if (blob.length < headerLen) throw new SegmentedFormatError('truncated header');
  const keyBlock = blob.slice(o, o + kbLen);
  o += kbLen;
  const contentSalt = blob.slice(o, o + CONTENT_SALT_LEN);
  o += CONTENT_SALT_LEN;
  const noncePrefix = blob.slice(o, o + NONCE_PREFIX_LEN);
  o += NONCE_PREFIX_LEN;
  const chunkSize = readU32(blob, o);
  o += 4;
  const plaintextLen = readU64(blob, o);
  if (chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
    throw new SegmentedFormatError(`chunk size out of range (${chunkSize})`);
  }
  return {
    header: blob.slice(0, headerLen),
    headerLen,
    keyBlock,
    contentSalt,
    noncePrefix,
    chunkSize,
    plaintextLen,
  };
}

/**
 * Build a segmented vault blob from a file. `key.dek` is the managed DEK; a fresh
 * content salt + nonce prefix are generated per export. `keyMode === 'embedded'`
 * stores the wrapped key block in the header; otherwise it is delivered
 * externally (KB_LEN = 0).
 */
export async function buildSegmentedBlob(
  filename: string,
  content: Uint8Array,
  key: VaultKey,
  keyMode: KeyMode,
  onProgress?: OnProgress,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): Promise<Uint8Array> {
  const envelope = await buildPayload(filename, content);
  onProgress?.({ phase: 'compress', done: envelope.length, total: envelope.length });

  const contentSalt = randomBytes(CONTENT_SALT_LEN);
  const noncePrefix = randomBytes(NONCE_PREFIX_LEN);
  const cek = await deriveContentKey(key.dek, contentSalt);
  const embeddedKeyBlock = keyMode === 'embedded' ? key.keyBlock : new Uint8Array(0);
  const header = buildHeader(embeddedKeyBlock, contentSalt, noncePrefix, chunkSize, envelope.length);

  const L = envelope.length;
  const n = Math.max(1, Math.ceil(L / chunkSize));
  const parts: Uint8Array[] = [header];
  for (let i = 0; i < n; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, L);
    const segment = envelope.subarray(start, end);
    const nonce = buildNonce(noncePrefix, i, i === n - 1);
    parts.push(await aeadSeal(cek, nonce, segment, header));
    onProgress?.({ phase: 'encrypt', done: end, total: L });
  }
  return concatBytes(...parts);
}

/** Decrypt every chunk with an already-derived CEK, enforcing the framing. */
async function decryptChunks(
  blob: Uint8Array,
  parsed: ParsedHeader,
  cek: CryptoKey,
  maxContentBytes: number,
  onProgress?: OnProgress,
): Promise<Uint8Array> {
  const { header, headerLen, noncePrefix, chunkSize, plaintextLen } = parsed;
  if (plaintextLen > maxContentBytes + chunkSize) {
    // Reject an over-cap claim before allocating. (+chunkSize leaves slack for
    // the envelope's small filename/flags header vs. the content cap.)
    throw new SegmentedFormatError('declared length exceeds the allowed size');
  }
  const n = Math.max(1, Math.ceil(plaintextLen / chunkSize));
  const lastSegLen = plaintextLen - (n - 1) * chunkSize; // 0..chunkSize
  // Exact body-length cross-check: fixes `n` from the header, so truncation,
  // trailing bytes, or a lying length are rejected before we allocate/decrypt.
  const expectedBody = (n - 1) * (chunkSize + GCM_TAG_LEN) + (lastSegLen + GCM_TAG_LEN);
  if (blob.length - headerLen !== expectedBody) {
    throw new SegmentedFormatError('container length does not match header');
  }

  const out = new Uint8Array(plaintextLen);
  let inOff = headerLen;
  let outOff = 0;
  for (let i = 0; i < n; i++) {
    const segLen = i === n - 1 ? lastSegLen : chunkSize;
    const ct = blob.subarray(inOff, inOff + segLen + GCM_TAG_LEN);
    inOff += segLen + GCM_TAG_LEN;
    const nonce = buildNonce(noncePrefix, i, i === n - 1);
    let pt: Uint8Array;
    try {
      pt = await aeadOpen(cek, nonce, ct, header);
    } catch {
      throw new SegmentedFormatError(`chunk ${i} failed authentication`);
    }
    out.set(pt, outOff);
    outOff += pt.length;
    onProgress?.({ phase: 'decrypt', done: outOff, total: plaintextLen });
  }
  return out;
}

/**
 * Decode a segmented blob with a password (unlocks the key block, embedded or
 * supplied). Mirrors `decodeVaultBlob` for the single-shot image path.
 */
export async function decodeSegmentedBlob(
  blob: Uint8Array,
  password: string,
  opts: { keyBlock?: Uint8Array | undefined; maxContentBytes: number },
  onProgress?: OnProgress,
): Promise<{ filename: string; content: Uint8Array }> {
  const parsed = parseHeader(blob);
  const kbBytes = parsed.keyBlock.length > 0 ? parsed.keyBlock : opts.keyBlock;
  if (!kbBytes || kbBytes.length === 0) throw new MissingKeyError();
  // Argon2id is the multi-second cost on restore; flag it as an indeterminate phase.
  onProgress?.({ phase: 'unlock', done: 0, total: 0 });
  const dek = await unlockKeyBlock(parseKeyBlock(kbBytes), password);
  onProgress?.({ phase: 'unlock', done: 1, total: 1 });
  const cek = await deriveContentKey(dek, parsed.contentSalt);
  const envelope = await decryptChunks(blob, parsed, cek, opts.maxContentBytes, onProgress);
  return parsePayload(envelope, opts.maxContentBytes);
}

/**
 * Decode a segmented blob with an already-unlocked DEK (no password, no Argon2).
 * Mirrors `decodeVaultBlobWithDek`; used by post-save verification.
 */
export async function decodeSegmentedBlobWithDek(
  blob: Uint8Array,
  dek: CryptoKey,
  maxContentBytes: number,
  onProgress?: OnProgress,
): Promise<{ filename: string; content: Uint8Array }> {
  const parsed = parseHeader(blob);
  const cek = await deriveContentKey(dek, parsed.contentSalt);
  const envelope = await decryptChunks(blob, parsed, cek, maxContentBytes, onProgress);
  return parsePayload(envelope, maxContentBytes);
}
