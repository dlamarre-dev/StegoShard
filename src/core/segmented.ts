/**
 * Segmented binary vault format (SPEC §8), the container for the non-image
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
 *    (key, nonce) never repeats, the one thing GCM cannot survive.
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
  type Argon2Params,
  CONTENT_SALT_LEN,
  DEFAULT_ARGON2,
  DEK_LEN,
  deriveContentKey,
  deriveRegionKey,
  deriveSlotKek,
  slotKekCandidates,
  GCM_TAG_LEN,
  IV_LEN,
  openSlotArray,
  parseKeyBlock,
  randomBytes,
  REGION_COUNT,
  SLOT_ARRAY_LEN,
  type SlotEntry,
  buildSlotArray,
  unlockKeyBlock,
  VAULT_SALT_LEN,
  WrongPasswordError,
} from './crypto';
import { DB_LADDER, pickBucket } from './buckets';
import { REGION_LEN_FIELD, padRegionPlaintext, parseRegionPlaintext } from './regions';
import { buildPayload, parsePayload } from './payload';
import type { OnProgress } from './progress';
import type { KeyMode } from './types';
import type { LiveRegion, VaultKey } from './vault';
import { MissingKeyError } from './vault';

/** "SSCS": StegoShard Chunked Segments. Distinct from SSBN/SSKY/SSHD. */
export const SEG_MAGIC = Uint8Array.from([0x53, 0x53, 0x43, 0x53]);
export const SEG_VERSION = 1;
/** Random per-export nonce prefix; 7 + 4 (counter) + 1 (final) = 12-byte GCM IV. */
export const NONCE_PREFIX_LEN = 7;
/** Default chunk size: 1 MiB, ~0.0015% tag overhead, ~100 updates per 100 MiB. */
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
  o += 1; // flags: informational; the true source is KB_LEN
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
  bundle = false,
): Promise<Uint8Array> {
  const envelope = await buildPayload(filename, content, { bundle });
  onProgress?.({ phase: 'compress', done: envelope.length, total: envelope.length });

  const contentSalt = randomBytes(CONTENT_SALT_LEN);
  const noncePrefix = randomBytes(NONCE_PREFIX_LEN);
  const cek = await deriveContentKey(key.dek, contentSalt);
  const embeddedKeyBlock = keyMode === 'embedded' ? key.keyBlock : new Uint8Array(0);
  const header = buildHeader(
    embeddedKeyBlock,
    contentSalt,
    noncePrefix,
    chunkSize,
    envelope.length,
  );

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
): Promise<{ filename: string; content: Uint8Array; bundled: boolean }> {
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
): Promise<{ filename: string; content: Uint8Array; bundled: boolean }> {
  const parsed = parseHeader(blob);
  const cek = await deriveContentKey(dek, parsed.contentSalt);
  const envelope = await decryptChunks(blob, parsed, cek, maxContentBytes, onProgress);
  return parsePayload(envelope, maxContentBytes);
}

// --- Multi-region segmented blob (SPEC §10.4, the `.db` path) ----------------
//
// The always-on geometry for the SQLite decoy wrapper. Layout:
//
//   [ SEG_MAGIC 4 ][ SEG_VERSION 1 ][ FLAGS 1 ][ vault_salt 16 ][ slot_array 304 ]
//   [ chunkSize u32 ][ bucketLen u64 ]                   <- container-level, shared
//   [ region0_stream S ][ region1_stream S ]
//
// Each region stream (S bytes, identical for both):
//   [ contentSalt 16 ][ noncePrefix 7 ][ chunk_0 .. chunk_{n-1} ]
//
// CRITICAL indistinguishability point: chunkSize and bucketLen live in the SHARED
// container head, NOT per region. A region stream therefore contains only
// pseudorandom bytes (a random salt + prefix + AES-GCM chunks), so a *dead* region
// filled with S CSPRNG bytes is byte-indistinguishable from a live one. Storing
// bucketLen per region would leak which region is real (a dead region's random
// bytes almost never equal a ladder value). RS is not used on this path; the
// SQLite container carries the whole blob intact.
//
// Geometry is selected by the caller (`variant === 'disguised'`), never sniffed
// from a byte (SPEC §10 governing decision 2); FLAGS stays 0/reserved here.

/** Container-level fixed head: magic+ver+flags + vault_salt + slot_array + chunkSize + bucketLen. */
const MULTI_HEAD_LEN = SEG_MAGIC.length + 1 + 1 + VAULT_SALT_LEN + SLOT_ARRAY_LEN + 4 + 8; // 334
/** Per-region cleartext prefix ahead of the sealed chunks. */
const REGION_PREFIX_LEN = CONTENT_SALT_LEN + NONCE_PREFIX_LEN; // 23
/** Hard structural cap on a region's padded (bucket) length: the .db ladder top. */
const MULTI_MAX_BUCKET = DB_LADDER[DB_LADDER.length - 1]!;

/** Region stream length for a given bucket + chunk size: prefix + body + tags. */
function multiRegionStreamLen(bucket: number, chunkSize: number): number {
  const n = Math.max(1, Math.ceil(bucket / chunkSize));
  return REGION_PREFIX_LEN + bucket + n * GCM_TAG_LEN;
}

function buildMultiHead(
  vaultSalt: Uint8Array,
  slotArray: Uint8Array,
  chunkSize: number,
  bucketLen: number,
): Uint8Array {
  const head = new Uint8Array(MULTI_HEAD_LEN);
  let o = 0;
  head.set(SEG_MAGIC, o);
  o += SEG_MAGIC.length;
  head[o++] = SEG_VERSION;
  head[o++] = 0; // FLAGS reserved; geometry is known from the path, not this byte
  head.set(vaultSalt, o);
  o += VAULT_SALT_LEN;
  head.set(slotArray, o);
  o += SLOT_ARRAY_LEN;
  writeU32(head, o, chunkSize);
  o += 4;
  writeU64(head, o, bucketLen);
  return head;
}

/** AAD binding every chunk to the whole container, its region index, and its salt/prefix. */
function regionAad(
  head: Uint8Array,
  regionIndex: number,
  contentSalt: Uint8Array,
  noncePrefix: Uint8Array,
): Uint8Array {
  return concatBytes(head, Uint8Array.of(regionIndex), contentSalt, noncePrefix);
}

/** Seal one region's padded plaintext into a chunked STREAM stream. */
async function buildRegionStream(
  head: Uint8Array,
  region: LiveRegion,
  bucket: number,
  chunkSize: number,
  onChunk?: (done: number) => void,
): Promise<Uint8Array> {
  const contentSalt = randomBytes(CONTENT_SALT_LEN);
  const noncePrefix = randomBytes(NONCE_PREFIX_LEN);
  const cek = await deriveRegionKey(region.dek, contentSalt, region.regionIndex);
  const aad = regionAad(head, region.regionIndex, contentSalt, noncePrefix);
  const plaintext = padRegionPlaintext(region.envelope, bucket); // exactly `bucket` bytes
  const n = Math.max(1, Math.ceil(bucket / chunkSize));
  const parts: Uint8Array[] = [contentSalt, noncePrefix];
  for (let i = 0; i < n; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, bucket);
    const nonce = buildNonce(noncePrefix, i, i === n - 1);
    parts.push(await aeadSeal(cek, nonce, plaintext.subarray(start, end), aad));
    onChunk?.(end);
  }
  return concatBytes(...parts);
}

/**
 * Assemble a multi-region segmented blob. Mode-agnostic: `live` decides which
 * regions carry data (one for plain/non-possession, two for duress); dead regions
 * are filled with S CSPRNG bytes.
 */
export async function buildMultiRegionSegmentedBlob(
  vaultSalt: Uint8Array,
  slotEntries: SlotEntry[],
  live: LiveRegion[],
  ladder: readonly number[],
  onProgress?: OnProgress,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): Promise<Uint8Array> {
  if (vaultSalt.length !== VAULT_SALT_LEN) throw new SegmentedFormatError('bad vault salt');
  const lens: [number, number] = [0, 0];
  for (const r of live) lens[r.regionIndex] = REGION_LEN_FIELD + r.envelope.length;
  const bucket = pickBucket(lens[0], lens[1], ladder);
  const slotArray = await buildSlotArray(slotEntries);
  const head = buildMultiHead(vaultSalt, slotArray, chunkSize, bucket);
  const S = multiRegionStreamLen(bucket, chunkSize);
  const streams: [Uint8Array | null, Uint8Array | null] = [null, null];
  const totalLive = live.length * bucket || 1;
  let base = 0;
  for (const r of live) {
    streams[r.regionIndex] = await buildRegionStream(head, r, bucket, chunkSize, (done) =>
      onProgress?.({ phase: 'encrypt', done: base + done, total: totalLive }),
    );
    base += bucket;
  }
  for (let i = 0; i < REGION_COUNT; i++) if (!streams[i]) streams[i] = randomBytes(S);
  return concatBytes(head, streams[0]!, streams[1]!);
}

/**
 * Plain single-payload multi-region segmented blob: one live slot, one real region
 * at a CSPRNG index, the other dead. Every `.db` vault uses this in Phase 1. Returns
 * the region index + DEK for post-save verification.
 */
export async function buildPlainSegmentedBlobMulti(
  filename: string,
  content: Uint8Array,
  password: string,
  ladder: readonly number[],
  params: Argon2Params = DEFAULT_ARGON2,
  onProgress?: OnProgress,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  keyFactor: Uint8Array | null = null,
  bundle = false,
): Promise<{ blob: Uint8Array; regionIndex: number; dek: Uint8Array }> {
  const vaultSalt = randomBytes(VAULT_SALT_LEN);
  const kek = await deriveSlotKek(password, vaultSalt, keyFactor, params);
  const dek = randomBytes(DEK_LEN);
  const regionIndex = randomBytes(1)[0]! & 1;
  const envelope = await buildPayload(filename, content, { bundle });
  onProgress?.({ phase: 'compress', done: envelope.length, total: envelope.length });
  const blob = await buildMultiRegionSegmentedBlob(
    vaultSalt,
    [{ kek, dek, regionIndex }],
    [{ regionIndex, dek, envelope }],
    ladder,
    onProgress,
    chunkSize,
  );
  return { blob, regionIndex, dek };
}

interface ParsedMultiHead {
  head: Uint8Array;
  vaultSalt: Uint8Array;
  slotArray: Uint8Array;
  chunkSize: number;
  bucketLen: number;
  regionArea: Uint8Array;
  S: number;
}

function parseMultiHead(blob: Uint8Array, maxContentBytes: number): ParsedMultiHead {
  if (blob.length < MULTI_HEAD_LEN) throw new SegmentedFormatError('too short');
  if (!looksLikeSegmented(blob)) throw new SegmentedFormatError('bad magic');
  let o = SEG_MAGIC.length;
  const version = blob[o]!;
  o += 1;
  if (version !== SEG_VERSION) throw new SegmentedFormatError(`unsupported version ${version}`);
  o += 1; // FLAGS: reserved on this path
  const vaultSalt = blob.slice(o, o + VAULT_SALT_LEN);
  o += VAULT_SALT_LEN;
  const slotArray = blob.slice(o, o + SLOT_ARRAY_LEN);
  o += SLOT_ARRAY_LEN;
  const chunkSize = readU32(blob, o);
  o += 4;
  const bucketLen = readU64(blob, o);
  if (chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
    throw new SegmentedFormatError(`chunk size out of range (${chunkSize})`);
  }
  if (
    bucketLen <= 0 ||
    bucketLen > MULTI_MAX_BUCKET ||
    bucketLen > maxContentBytes + REGION_LEN_FIELD
  ) {
    throw new SegmentedFormatError(`region length out of range (${bucketLen})`);
  }
  const S = multiRegionStreamLen(bucketLen, chunkSize);
  // Exact length cross-check: the container is head + two equal region streams.
  if (blob.length !== MULTI_HEAD_LEN + REGION_COUNT * S) {
    throw new SegmentedFormatError('container length does not match header');
  }
  return {
    head: blob.slice(0, MULTI_HEAD_LEN),
    vaultSalt,
    slotArray,
    chunkSize,
    bucketLen,
    regionArea: blob.subarray(MULTI_HEAD_LEN),
    S,
  };
}

/** Decrypt one region stream to its envelope (parses the region framing). */
async function decryptRegionStream(
  head: Uint8Array,
  stream: Uint8Array,
  regionIndex: number,
  dek: Uint8Array,
  chunkSize: number,
  bucketLen: number,
  maxContentBytes: number,
  onProgress?: OnProgress,
): Promise<Uint8Array> {
  const contentSalt = stream.subarray(0, CONTENT_SALT_LEN);
  const noncePrefix = stream.subarray(CONTENT_SALT_LEN, REGION_PREFIX_LEN);
  const cek = await deriveRegionKey(dek, contentSalt, regionIndex);
  const aad = regionAad(head, regionIndex, contentSalt, noncePrefix);
  const n = Math.max(1, Math.ceil(bucketLen / chunkSize));
  const lastSegLen = bucketLen - (n - 1) * chunkSize;
  const out = new Uint8Array(bucketLen);
  let inOff = REGION_PREFIX_LEN;
  let outOff = 0;
  for (let i = 0; i < n; i++) {
    const segLen = i === n - 1 ? lastSegLen : chunkSize;
    const ct = stream.subarray(inOff, inOff + segLen + GCM_TAG_LEN);
    inOff += segLen + GCM_TAG_LEN;
    const nonce = buildNonce(noncePrefix, i, i === n - 1);
    let pt: Uint8Array;
    try {
      pt = await aeadOpen(cek, nonce, ct, aad);
    } catch {
      throw new SegmentedFormatError(`region chunk ${i} failed authentication`);
    }
    out.set(pt, outOff);
    outOff += pt.length;
    onProgress?.({ phase: 'decrypt', done: outOff, total: bucketLen });
  }
  return parseRegionPlaintext(out, maxContentBytes);
}

/**
 * Decode a multi-region segmented blob with a password: open the slot array
 * (constant-work), then decrypt ONLY the one region the credential unlocks. No
 * key-block option; the slot array is always embedded on this path.
 */
export async function decodeMultiRegionSegmentedBlob(
  blob: Uint8Array,
  password: string,
  opts: {
    params?: Argon2Params;
    maxContentBytes: number;
    keyFactor?: Uint8Array | null;
    /** Recovered Shamir secret S for a Mode B (threshold-gated) slot (§10.6). */
    secret?: Uint8Array | null;
  },
  onProgress?: OnProgress,
): Promise<{ filename: string; content: Uint8Array; bundled: boolean }> {
  const parsed = parseMultiHead(blob, opts.maxContentBytes);
  onProgress?.({ phase: 'unlock', done: 0, total: 0 });
  let candidates: CryptoKey[];
  try {
    candidates = await slotKekCandidates(
      password,
      parsed.vaultSalt,
      opts.keyFactor ?? null,
      opts.secret ?? null,
      opts.params,
    );
  } catch {
    throw new WrongPasswordError();
  }
  const { dek, regionIndex } = await openSlotArray(parsed.slotArray, candidates);
  onProgress?.({ phase: 'unlock', done: 1, total: 1 });
  const stream = parsed.regionArea.subarray(regionIndex * parsed.S, (regionIndex + 1) * parsed.S);
  const envelope = await decryptRegionStream(
    parsed.head,
    stream,
    regionIndex,
    dek,
    parsed.chunkSize,
    parsed.bucketLen,
    opts.maxContentBytes,
    onProgress,
  );
  return parsePayload(envelope, opts.maxContentBytes);
}

/** Decode a specific region with a known DEK (post-save verification). */
export async function decodeMultiRegionSegmentedBlobWithDek(
  blob: Uint8Array,
  dek: Uint8Array,
  regionIndex: number,
  maxContentBytes: number,
  onProgress?: OnProgress,
): Promise<{ filename: string; content: Uint8Array; bundled: boolean }> {
  const parsed = parseMultiHead(blob, maxContentBytes);
  const stream = parsed.regionArea.subarray(regionIndex * parsed.S, (regionIndex + 1) * parsed.S);
  const envelope = await decryptRegionStream(
    parsed.head,
    stream,
    regionIndex,
    dek,
    parsed.chunkSize,
    parsed.bucketLen,
    maxContentBytes,
    onProgress,
  );
  return parsePayload(envelope, maxContentBytes);
}
