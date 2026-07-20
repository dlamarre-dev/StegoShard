/**
 * Vault orchestration: the offline pipeline that turns a file into a set of
 * self-describing image payloads and back (plan §0).
 *
 *   EXPORT: file → envelope → encrypt (DEK) → vault blob → erasure code
 *           → per-image payloads (header || shard)
 *   IMPORT: image payloads → reassemble shards → Reed-Solomon reconstruct
 *           → vault blob → decrypt → file
 *
 * This module works purely on bytes: rendering a payload to pixels (and back)
 * is the codec's job (see codec/), and the disk profile is lossless so the
 * codec is an identity over these bytes. Missing-image tolerance is a property
 * of the erasure coding and is exercised here at the byte level.
 *
 * Phase 1 uses the "embedded" key mode: the wrapped DEK block travels inside the
 * vault blob, so the images plus the password are self-sufficient. Separate
 * keyfile / stego modes arrive in Phase 2.
 */

import { concatBytes, readU16, toHex, writeU16 } from './bytes';
import {
  decryptBytes,
  encryptBytes,
  GCM_TAG_LEN,
  IV_LEN,
  KEY_BLOCK_LEN,
  parseKeyBlock,
  unlockKeyBlock,
} from './crypto';
import type { KeyMode } from './types';
import { type BinaryVariant, unwrapBinary, wrapBinary } from './binary-container';
import { buildPayload, parsePayload } from './payload';
import { decodeBlob, encodeShards, parityCount } from './erasure';
import {
  CODEC_QR_GRID,
  type Header,
  HASH_LEN,
  HEADER_LEN,
  PROFILE_DISK,
  decodeImagePayload,
  encodeImagePayload,
} from './header';
import { SET_ID_LEN } from './header';
import { getCodec } from './codec';

/** Hard limit on the source file for the image/PDF paths (plan §5). */
export const MAX_FILE_BYTES = 1024 * 1024;
/**
 * Above this the image/PDF output starts to sprawl; front-ends warn and show the
 * projected image count so the user can switch to binary output before saving.
 */
export const WARN_FILE_BYTES = 256 * 1024;
/**
 * Binary (non-image) output has no per-image ceiling, so it tolerates far larger
 * secrets. This bound doubles as the decompression-bomb guard on that path.
 */
export const MAX_FILE_BYTES_BINARY = 100 * 1024 * 1024;
/** Independent safety ceiling on the number of images (plan §5). */
export const MAX_IMAGES = 150;

/** Thrown when the source file exceeds MAX_FILE_BYTES. Carries the numbers. */
export class FileTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(`file too large: ${size} bytes (limit ${limit}); this vault targets small secrets`);
    this.name = 'FileTooLargeError';
  }
}

/** Thrown when a vault would need more than MAX_IMAGES images. */
export class TooManyImagesError extends Error {
  constructor(
    readonly count: number,
    readonly limit: number,
  ) {
    super(`would need ${count} images (limit ${limit})`);
    this.name = 'TooManyImagesError';
  }
}

/** Bytes of shard data that fit one image for a codec/profile (header aside). */
function dataPerShard(codecId: number, profile: number): number {
  return getCodec(codecId).capacity(profile) - HEADER_LEN;
}

/** Analytical vault blob length. `embedKey` includes the wrapped DEK block. */
function blobLenFor(envelopeLen: number, embedKey: boolean): number {
  // [ KB_LEN u16 ][ key block? ][ IV ][ ciphertext = envelope + GCM tag ]
  return 2 + (embedKey ? KEY_BLOCK_LEN : 0) + IV_LEN + envelopeLen + GCM_TAG_LEN;
}

/** True when this key mode stores the wrapped DEK inside the images. */
function isEmbedded(keyMode: KeyMode): boolean {
  return keyMode === 'embedded';
}

/**
 * The managed vault key: a random DEK plus its serialized, password-wrapped key
 * block. Produced by the keystore; the same DEK is reused across vaults.
 */
export interface VaultKey {
  dek: CryptoKey;
  keyBlock: Uint8Array; // serialized (see crypto.serializeKeyBlock)
}

export interface ExportOptions {
  profile?: number;
  codecId?: number;
  /** 'embedded' stores the key block in the images; others deliver it externally. */
  keyMode?: KeyMode;
}

export interface ExportResult {
  /** One payload per image (header || shard), in global shard-index order. */
  imagePayloads: Uint8Array[];
  k: number;
  m: number;
  setId: Uint8Array;
  keyMode: KeyMode;
  /** The serialized key block — save it separately for keyfile/stego modes. */
  keyBlock: Uint8Array;
}

/** Thrown when a keyfile/stego set is restored without its external key block. */
export class MissingKeyError extends Error {
  constructor() {
    super('this image set needs a separate key (.key file) to restore');
    this.name = 'MissingKeyError';
  }
}

export async function sha256Short(data: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource);
  return new Uint8Array(digest).slice(0, HASH_LEN);
}

/** vault blob = [ KB_LEN u16 ][ keyBlock ][ IV 12 ][ ciphertext ] */
function serializeVaultBlob(
  keyBlock: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  const lenField = new Uint8Array(2);
  writeU16(lenField, 0, keyBlock.length);
  return concatBytes(lenField, keyBlock, iv, ciphertext);
}

function parseVaultBlob(blob: Uint8Array): {
  keyBlock: Uint8Array;
  iv: Uint8Array;
  ciphertext: Uint8Array;
} {
  const kbLen = readU16(blob, 0);
  let o = 2;
  const keyBlock = blob.slice(o, o + kbLen);
  o += kbLen;
  const iv = blob.slice(o, o + IV_LEN);
  o += IV_LEN;
  const ciphertext = blob.slice(o);
  return { keyBlock, iv, ciphertext };
}

/**
 * Rough worst-case image count from a content length alone (no compression
 * assumed). Useful for a synchronous ceiling; prefer `estimateImages` for an
 * accurate figure, since compression often reduces the real count sharply.
 */
export function estimateImageCount(
  contentLen: number,
  profile: number = PROFILE_DISK,
  codecId: number = CODEC_QR_GRID,
): number {
  const blobLen = blobLenFor(contentLen + 64, true); // + small filename allowance
  const k = Math.max(1, Math.ceil(blobLen / dataPerShard(codecId, profile)));
  return k + parityCount(k);
}

/**
 * Accurate image count: compresses the content exactly as export would, so the
 * figure matches what `exportVault` produces (differing only if compression is
 * nondeterministic, which gzip is not here).
 */
export async function estimateImages(
  filename: string,
  content: Uint8Array,
  options: ExportOptions = {},
): Promise<{ k: number; m: number; images: number }> {
  const profile = options.profile ?? PROFILE_DISK;
  const codecId = options.codecId ?? CODEC_QR_GRID;
  const embedKey = isEmbedded(options.keyMode ?? 'embedded');
  const envelope = await buildPayload(filename, content);
  const blobLen = blobLenFor(envelope.length, embedKey);
  const k = Math.max(1, Math.ceil(blobLen / dataPerShard(codecId, profile)));
  const m = parityCount(k);
  return { k, m, images: k + m };
}

/**
 * Build the encrypted vault blob — the container shared by every output path.
 * The image path erasure-codes it; the binary path wraps it in a container file.
 */
export async function buildVaultBlob(
  filename: string,
  content: Uint8Array,
  key: VaultKey,
  keyMode: KeyMode,
): Promise<Uint8Array> {
  const envelope = await buildPayload(filename, content);
  const { iv, ciphertext } = await encryptBytes(key.dek, envelope);
  // Embed the key block, or leave it out (KB_LEN=0) so it can be delivered
  // separately (keyfile/stego/binary-key modes).
  const embeddedKeyBlock = isEmbedded(keyMode) ? key.keyBlock : new Uint8Array(0);
  return serializeVaultBlob(embeddedKeyBlock, iv, ciphertext);
}

/** Reverse of buildVaultBlob: blob (+ external key) → original file. */
export async function decodeVaultBlob(
  blob: Uint8Array,
  password: string,
  opts: { keyBlock?: Uint8Array | undefined; maxContentBytes: number },
): Promise<{ filename: string; content: Uint8Array }> {
  const { keyBlock, iv, ciphertext } = parseVaultBlob(blob);
  // Embedded key block travels in the blob; otherwise the caller must supply it.
  const kbBytes = keyBlock.length > 0 ? keyBlock : opts.keyBlock;
  if (!kbBytes || kbBytes.length === 0) throw new MissingKeyError();
  const dek = await unlockKeyBlock(parseKeyBlock(kbBytes), password);
  const envelope = await decryptBytes(dek, iv, ciphertext);
  return parsePayload(envelope, opts.maxContentBytes);
}

export async function exportVault(
  filename: string,
  content: Uint8Array,
  key: VaultKey,
  options: ExportOptions = {},
): Promise<ExportResult> {
  if (content.length > MAX_FILE_BYTES) {
    throw new FileTooLargeError(content.length, MAX_FILE_BYTES);
  }
  const profile = options.profile ?? PROFILE_DISK;
  const codecId = options.codecId ?? CODEC_QR_GRID;
  const keyMode = options.keyMode ?? 'embedded';

  const blob = await buildVaultBlob(filename, content, key, keyMode);

  const k = Math.max(1, Math.ceil(blob.length / dataPerShard(codecId, profile)));
  const m = parityCount(k);
  const total = k + m;
  if (total > MAX_IMAGES) {
    throw new TooManyImagesError(total, MAX_IMAGES);
  }

  const { shards, shardLen } = encodeShards(blob, k, m);
  const setId = globalThis.crypto.getRandomValues(new Uint8Array(SET_ID_LEN));
  const hash = await sha256Short(blob);

  const imagePayloads = shards.map((shard, shardIndex) => {
    const header: Header = {
      version: 1,
      setId,
      shardIndex,
      k,
      m,
      codecId,
      profile,
      shardLen,
      blobLen: blob.length,
      hash,
    };
    return encodeImagePayload(header, shard);
  });

  return { imagePayloads, k, m, setId, keyMode, keyBlock: key.keyBlock };
}

/**
 * Reconstruct the original file from decoded image payloads. Payloads may be a
 * subset of the set and may arrive in any order; up to `m` may be missing.
 */
export async function importVault(
  payloads: Uint8Array[],
  password: string,
  opts: { keyBlock?: Uint8Array | undefined } = {},
): Promise<{ filename: string; content: Uint8Array }> {
  if (payloads.length === 0) throw new Error('import: no images provided');

  // Decode defensively: silently drop images that are not valid StegoShard
  // payloads (a foreign QR, a corrupt header) rather than aborting the restore.
  const decoded: { header: Header; shard: Uint8Array }[] = [];
  for (const payload of payloads) {
    try {
      decoded.push(decodeImagePayload(payload));
    } catch {
      // not an StegoShard image / unreadable header — skip it
    }
  }
  if (decoded.length === 0) throw new Error('import: no valid StegoShard images found');

  // Images from different vaults may be mixed in; use the majority set so one
  // stray or first-listed foreign image cannot derail reconstruction.
  const counts = new Map<string, number>();
  for (const { header } of decoded) {
    const key = toHex(header.setId);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let bestSet = '';
  let bestCount = -1;
  for (const [key, n] of counts) {
    if (n > bestCount) {
      bestCount = n;
      bestSet = key;
    }
  }
  const members = decoded.filter(({ header }) => toHex(header.setId) === bestSet);
  const first = members[0]!.header;
  const { k, m, blobLen } = first;

  // Place each shard at its global index.
  const slots: (Uint8Array | null)[] = new Array(k + m).fill(null);
  for (const { header, shard } of members) {
    if (header.shardIndex < k + m) slots[header.shardIndex] = shard;
  }

  // An erasure code can fill gaps but cannot detect a present-but-wrong shard.
  // If the first-k reconstruction fails the integrity hash while extra shards are
  // available, retry over other k-subsets so one corrupt shard cannot turn an
  // otherwise-recoverable set fatal (bounded attempts guard against blow-up).
  const blob = await reconstructVerified(slots, k, m, blobLen, first.hash);
  if (!blob) throw new Error('import: reconstructed blob failed its integrity check');

  return decodeVaultBlob(blob, password, {
    keyBlock: opts.keyBlock,
    maxContentBytes: MAX_FILE_BYTES,
  });
}

/** Upper bound on RS reconstruction attempts when trying alternative shard subsets. */
const MAX_RECON_ATTEMPTS = 256;

/**
 * Reconstruct the blob and verify it against `expectedHash`, trying alternative
 * k-subsets of the present shards if the first attempt fails its hash. Returns
 * the verified blob, or null if none of the attempted subsets reconstruct it.
 */
async function reconstructVerified(
  slots: (Uint8Array | null)[],
  k: number,
  m: number,
  blobLen: number,
  expectedHash: Uint8Array,
): Promise<Uint8Array | null> {
  const present: number[] = [];
  slots.forEach((s, i) => {
    if (s) present.push(i);
  });
  if (present.length < k) return null;

  let attempts = 0;
  for (const subset of kSubsets(present, k)) {
    if (++attempts > MAX_RECON_ATTEMPTS) break;
    const trial: (Uint8Array | null)[] = new Array<Uint8Array | null>(slots.length).fill(null);
    for (const i of subset) trial[i] = slots[i]!;
    let blob: Uint8Array;
    try {
      blob = decodeBlob(trial, k, m, blobLen);
    } catch {
      continue; // singular matrix for this subset — try another
    }
    if (bytesEqual(await sha256Short(blob), expectedHash)) return blob;
  }
  return null;
}

/** Lazily yield every k-combination of `items` (first yield = the first k). */
function* kSubsets(items: number[], k: number): Generator<number[]> {
  const n = items.length;
  if (k > n || k < 1) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield idx.map((i) => items[i]!);
    let p = k - 1;
    while (p >= 0 && idx[p] === n - k + p) p--;
    if (p < 0) return;
    idx[p]! += 1;
    for (let j = p + 1; j < k; j++) idx[j] = idx[j - 1]! + 1;
  }
}

/**
 * Export the vault as a single binary container file (SPEC §8) instead of
 * images. Returns the container bytes and the serialized key block (save it
 * separately for keyfile/stego/binary-key modes). The 100 MiB cap applies here;
 * there is no image-count ceiling on this path.
 */
export async function exportVaultBinary(
  filename: string,
  content: Uint8Array,
  key: VaultKey,
  options: { keyMode?: KeyMode; variant?: BinaryVariant } = {},
): Promise<{ container: Uint8Array; keyMode: KeyMode; keyBlock: Uint8Array }> {
  if (content.length > MAX_FILE_BYTES_BINARY) {
    throw new FileTooLargeError(content.length, MAX_FILE_BYTES_BINARY);
  }
  const keyMode = options.keyMode ?? 'embedded';
  const variant = options.variant ?? 'branded';
  const blob = await buildVaultBlob(filename, content, key, keyMode);
  return { container: wrapBinary(blob, variant), keyMode, keyBlock: key.keyBlock };
}

/** Restore a file from a binary container produced by exportVaultBinary. */
export async function importVaultBinary(
  container: Uint8Array,
  password: string,
  opts: { keyBlock?: Uint8Array | undefined } = {},
): Promise<{ filename: string; content: Uint8Array }> {
  // Strip the container; bytes matching neither variant are treated as a bare
  // blob, letting AES-GCM be the final arbiter of whether they are ours.
  const blob = unwrapBinary(container)?.payload ?? container;
  return decodeVaultBlob(blob, password, {
    keyBlock: opts.keyBlock,
    maxContentBytes: MAX_FILE_BYTES_BINARY,
  });
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
