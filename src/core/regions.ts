/**
 * Region plaintext framing (SPEC §10.4) for the access-structure paths.
 *
 * Each payload region on a multi-region container is padded to a shared length
 * bucket BEFORE encryption, so the ciphertext length reveals only the bucket.
 * The true (unpadded) length must therefore travel *inside* the encrypted
 * region, never in any container header; otherwise a header field would leak
 * which region is larger, defeating the §10.2 invariant.
 *
 *   region_plaintext (bucket bytes) = [ REGION_LEN u32 ][ envelope ][ zero-pad ]
 *
 * The pad is zeros (hidden by encryption). Only a wholly *dead* region (one no
 * slot points at) is filled with CSPRNG bytes instead, and that happens at the
 * blob layer, not here, because a dead region has no DEK to encrypt with.
 *
 * Mirrored by the Python reference decoder (python/stegoshard/format.py).
 */

import { readU32, writeU32 } from './bytes';

/** Fixed prefix: the u32 true-length field ahead of the envelope. */
export const REGION_LEN_FIELD = 4;

/**
 * Pad an (already compressed) envelope into a `bucket`-byte region plaintext:
 * prepend the true length as a u32, then zero-fill to the bucket. `bucket` must
 * be ≥ `REGION_LEN_FIELD + envelope.length` (the caller chose it via
 * `pickBucket` over `REGION_LEN_FIELD + compressedLen`).
 */
export function padRegionPlaintext(envelope: Uint8Array, bucket: number): Uint8Array {
  const need = REGION_LEN_FIELD + envelope.length;
  if (bucket < need) throw new RangeError(`region: bucket ${bucket} too small for ${need} bytes`);
  const out = new Uint8Array(bucket); // zero-filled
  writeU32(out, 0, envelope.length);
  out.set(envelope, REGION_LEN_FIELD);
  return out;
}

/**
 * Recover the envelope from a decrypted region plaintext. `REGION_LEN` is bounded
 * against both the bucket and `maxContentBytes` BEFORE slicing, so a corrupt or
 * hostile length can never drive an over-large read. Returns the envelope slice
 * (still an envelope; the caller runs `parsePayload` with its own gzip guard).
 */
export function parseRegionPlaintext(plaintext: Uint8Array, maxContentBytes: number): Uint8Array {
  if (plaintext.length < REGION_LEN_FIELD) throw new Error('region: too short');
  const len = readU32(plaintext, 0);
  if (len > plaintext.length - REGION_LEN_FIELD) throw new Error('region: length exceeds bucket');
  if (len > maxContentBytes) throw new Error('region: declared length exceeds the allowed size');
  return plaintext.slice(REGION_LEN_FIELD, REGION_LEN_FIELD + len);
}
