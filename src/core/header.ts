/**
 * Self-describing per-image header (plan §1), replicated in every image so any
 * single surviving image describes the whole set — there is no separate
 * "manifest image" to protect.
 *
 * Fixed layout (33 bytes, big-endian), frozen in SPEC.md:
 *   [ MAGIC 4 = "IVLT" ][ VERSION 1 ][ SET_ID 8 ][ SHARD_INDEX u16 ]
 *   [ K u16 ][ M u16 ][ CODEC_ID u8 ][ PROFILE u8 ][ SHARD_LEN u32 ]
 *   [ BLOB_LEN u32 ][ HASH_GLOBAL 4 ]
 *
 * The full image payload carried by the codec is HEADER || SHARD_DATA, where
 * SHARD_DATA is SHARD_LEN bytes.
 */

import { concatBytes, readU16, readU32, writeU16, writeU32 } from './bytes';

export const MAGIC = Uint8Array.from([0x49, 0x56, 0x4c, 0x54]); // "IVLT"
export const FORMAT_VERSION = 1;
export const SET_ID_LEN = 8;
export const HASH_LEN = 4;
export const HEADER_LEN = 33;

export const CODEC_QR_GRID = 0;
export const PROFILE_DISK = 0;
export const PROFILE_CLOUD = 1;
export const PROFILE_PAPER = 2;

export interface Header {
  version: number;
  setId: Uint8Array; // 8 bytes identifying the vault set
  shardIndex: number; // 0 .. k+m-1
  k: number; // data shards
  m: number; // parity shards
  codecId: number;
  profile: number;
  shardLen: number; // bytes per shard (all shards equal)
  blobLen: number; // true length of the vault blob (to strip padding)
  hash: Uint8Array; // 4-byte short hash of the vault blob
}

export function encodeHeader(h: Header): Uint8Array {
  if (h.setId.length !== SET_ID_LEN) throw new RangeError('header: bad setId length');
  if (h.hash.length !== HASH_LEN) throw new RangeError('header: bad hash length');
  const body = new Uint8Array(HEADER_LEN - MAGIC.length);
  let o = 0;
  body[o++] = h.version;
  body.set(h.setId, o);
  o += SET_ID_LEN;
  writeU16(body, o, h.shardIndex);
  o += 2;
  writeU16(body, o, h.k);
  o += 2;
  writeU16(body, o, h.m);
  o += 2;
  body[o++] = h.codecId;
  body[o++] = h.profile;
  writeU32(body, o, h.shardLen);
  o += 4;
  writeU32(body, o, h.blobLen);
  o += 4;
  body.set(h.hash, o);
  o += HASH_LEN;
  return concatBytes(MAGIC, body);
}

export function decodeHeader(bytes: Uint8Array): Header {
  if (bytes.length < HEADER_LEN) throw new Error('header: too short');
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error('header: bad magic');
  }
  let o = MAGIC.length;
  const version = bytes[o++]!;
  if (version !== FORMAT_VERSION) throw new Error(`header: unsupported version ${version}`);
  const setId = bytes.slice(o, o + SET_ID_LEN);
  o += SET_ID_LEN;
  const shardIndex = readU16(bytes, o);
  o += 2;
  const k = readU16(bytes, o);
  o += 2;
  const m = readU16(bytes, o);
  o += 2;
  const codecId = bytes[o++]!;
  const profile = bytes[o++]!;
  const shardLen = readU32(bytes, o);
  o += 4;
  const blobLen = readU32(bytes, o);
  o += 4;
  const hash = bytes.slice(o, o + HASH_LEN);

  // Validate parameters from this (untrusted) header before any allocation or
  // reconstruction downstream.
  if (k < 1 || m < 0 || k + m > 256) throw new Error(`header: invalid k/m (${k}/${m})`);
  if (shardIndex >= k + m) throw new Error(`header: shard index ${shardIndex} out of range`);
  if (shardLen < 1) throw new Error('header: invalid shard length');
  if (blobLen < 1 || blobLen > k * shardLen) throw new Error('header: invalid blob length');

  return { version, setId, shardIndex, k, m, codecId, profile, shardLen, blobLen, hash };
}

/** Build the full image payload: header followed by the shard's bytes. */
export function encodeImagePayload(header: Header, shard: Uint8Array): Uint8Array {
  if (shard.length !== header.shardLen) throw new RangeError('header: shard length mismatch');
  return concatBytes(encodeHeader(header), shard);
}

/** Split an image payload back into its header and shard bytes. */
export function decodeImagePayload(bytes: Uint8Array): { header: Header; shard: Uint8Array } {
  const header = decodeHeader(bytes);
  const shard = bytes.slice(HEADER_LEN, HEADER_LEN + header.shardLen);
  if (shard.length !== header.shardLen) throw new Error('header: truncated shard');
  return { header, shard };
}
