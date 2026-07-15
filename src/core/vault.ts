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

import { concatBytes, readU16, writeU16 } from './bytes';
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

/** Hard limit on the source file — this vault targets small secrets (plan §5). */
export const MAX_FILE_BYTES = 256 * 1024;
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

async function sha256Short(data: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource);
  return new Uint8Array(digest).slice(0, HASH_LEN);
}

/** vault blob = [ KB_LEN u16 ][ keyBlock ][ IV 12 ][ ciphertext ] */
function serializeVaultBlob(keyBlock: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Uint8Array {
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

  const envelope = await buildPayload(filename, content);
  const { iv, ciphertext } = await encryptBytes(key.dek, envelope);
  // Embed the key block, or leave it out (KB_LEN=0) so it can be delivered
  // separately as a .key file (keyfile/stego modes).
  const embeddedKeyBlock = isEmbedded(keyMode) ? key.keyBlock : new Uint8Array(0);
  const blob = serializeVaultBlob(embeddedKeyBlock, iv, ciphertext);

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

  const decoded = payloads.map(decodeImagePayload);
  const first = decoded[0]!.header;
  const { k, m, blobLen } = first;

  // Place each shard at its global index; ignore foreign sets.
  const slots: (Uint8Array | null)[] = new Array(k + m).fill(null);
  for (const { header, shard } of decoded) {
    if (!sameSet(header.setId, first.setId)) continue;
    if (header.shardIndex < k + m) slots[header.shardIndex] = shard;
  }

  const blob = decodeBlob(slots, k, m, blobLen);
  const hash = await sha256Short(blob);
  if (!bytesEqual(hash, first.hash)) {
    throw new Error('import: reconstructed blob failed its integrity check');
  }

  const { keyBlock, iv, ciphertext } = parseVaultBlob(blob);
  // Embedded key block travels in the blob; otherwise the caller must supply it.
  const kbBytes = keyBlock.length > 0 ? keyBlock : opts.keyBlock;
  if (!kbBytes || kbBytes.length === 0) throw new MissingKeyError();
  const dek = await unlockKeyBlock(parseKeyBlock(kbBytes), password);
  const envelope = await decryptBytes(dek, iv, ciphertext);
  return parsePayload(envelope, MAX_FILE_BYTES);
}

function sameSet(a: Uint8Array, b: Uint8Array): boolean {
  return bytesEqual(a, b);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
