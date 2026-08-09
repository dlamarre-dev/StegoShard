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
  CONTENT_SALT_LEN,
  DEK_LEN,
  KEY_FACTOR_LEN,
  REGION_COUNT,
  SLOT_ARRAY_LEN,
  type SlotEntry,
  VAULT_SALT_LEN,
  buildSlotArray,
  decryptBytes,
  deriveContentKey,
  deriveRegionKey,
  deriveSlotKek,
  slotKekCandidates,
  encryptBytes,
  GCM_TAG_LEN,
  IV_LEN,
  KEY_BLOCK_LEN,
  type Argon2Params,
  DEFAULT_ARGON2,
  openSlotArray,
  parseKeyBlock,
  randomBytes,
  unlockKeyBlock,
  WrongPasswordError,
} from './crypto';
import { BucketTooLargeError, DB_LADDER, pickBucket } from './buckets';
import { REGION_LEN_FIELD, padRegionPlaintext, parseRegionPlaintext } from './regions';
import type { KeyMode } from './types';
import type { OnProgress } from './progress';
import { type BinaryVariant, unwrapBinary, wrapBinary } from './binary-container';
import {
  DEFAULT_CHUNK_SIZE,
  buildPlainSegmentedBlobMulti,
  buildSegmentedBlob,
  decodeMultiRegionSegmentedBlob,
  decodeMultiRegionSegmentedBlobWithDek,
  decodeSegmentedBlob,
  decodeSegmentedBlobWithDek,
} from './segmented';
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
 * secrets, and the segmented format processes it in chunks off the main thread.
 * Two caps: the CLI (headless, only bounded by RAM) allows more than the browser
 * UI (which still buffers the whole plaintext in a tab). Callers pass the cap via
 * `maxBytes`; both also bound decompression as a gzip-bomb guard.
 */
export const MAX_FILE_BYTES_BINARY_CLI = 1024 * 1024 * 1024; // 1 GiB
export const MAX_FILE_BYTES_BINARY_UI = 256 * 1024 * 1024; // 256 MiB
/** Default (most generous) binary cap; individual callers may pass a lower one. */
export const MAX_FILE_BYTES_BINARY = MAX_FILE_BYTES_BINARY_CLI;
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

/** Thrown when more input files are handed in than a surface will accept. */
export class TooManyFilesError extends Error {
  constructor(
    readonly count: number,
    readonly limit: number,
  ) {
    super(`too many input files: ${count} (limit ${limit})`);
    this.name = 'TooManyFilesError';
  }
}

/** Bytes of shard data that fit one image for a codec/profile (header aside). */
function dataPerShard(codecId: number, profile: number): number {
  return getCodec(codecId).capacity(profile) - HEADER_LEN;
}

/** Analytical vault blob length. `embedKey` includes the wrapped DEK block. */
export function blobLenFor(envelopeLen: number, embedKey: boolean): number {
  // [ KB_LEN u16 ][ key block? ][ contentSalt 16 ][ IV ][ ciphertext = envelope + GCM tag ]
  return 2 + (embedKey ? KEY_BLOCK_LEN : 0) + CONTENT_SALT_LEN + IV_LEN + envelopeLen + GCM_TAG_LEN;
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
  profile?: number | undefined;
  codecId?: number | undefined;
  /** 'embedded' stores the key block in the images; others deliver it externally. */
  keyMode?: KeyMode | undefined;
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

/** vault blob = [ KB_LEN u16 ][ keyBlock ][ contentSalt 16 ][ IV 12 ][ ciphertext ] */
function serializeVaultBlob(
  keyBlock: Uint8Array,
  contentSalt: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  const lenField = new Uint8Array(2);
  writeU16(lenField, 0, keyBlock.length);
  return concatBytes(lenField, keyBlock, contentSalt, iv, ciphertext);
}

function parseVaultBlob(blob: Uint8Array): {
  keyBlock: Uint8Array;
  contentSalt: Uint8Array;
  iv: Uint8Array;
  ciphertext: Uint8Array;
} {
  const kbLen = readU16(blob, 0);
  let o = 2;
  const keyBlock = blob.slice(o, o + kbLen);
  o += kbLen;
  const contentSalt = blob.slice(o, o + CONTENT_SALT_LEN);
  o += CONTENT_SALT_LEN;
  const iv = blob.slice(o, o + IV_LEN);
  o += IV_LEN;
  const ciphertext = blob.slice(o);
  return { keyBlock, contentSalt, iv, ciphertext };
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
  const envelope = await buildPayload(filename, content);
  return imagesForEnvelopeLen(envelope.length, options);
}

/**
 * The image split for an already-built envelope length, without re-compressing.
 * Callers that need counts for several profiles of the same file should build
 * the envelope once (`buildPayload`) and call this per profile.
 */
export function imagesForEnvelopeLen(
  envelopeLen: number,
  options: ExportOptions = {},
): { k: number; m: number; images: number } {
  const profile = options.profile ?? PROFILE_DISK;
  const codecId = options.codecId ?? CODEC_QR_GRID;
  const embedKey = isEmbedded(options.keyMode ?? 'embedded');
  const blobLen = blobLenFor(envelopeLen, embedKey);
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
  // Encrypt under a per-export subkey (CEK) derived from the DEK and a fresh
  // random salt, so the random-IV collision bound is per-export even though the
  // DEK is shared across vaults (SPEC §6).
  const contentSalt = randomBytes(CONTENT_SALT_LEN);
  const cek = await deriveContentKey(key.dek, contentSalt);
  const { iv, ciphertext } = await encryptBytes(cek, envelope);
  // Embed the key block, or leave it out (KB_LEN=0) so it can be delivered
  // separately (keyfile/stego/binary-key modes).
  const embeddedKeyBlock = isEmbedded(keyMode) ? key.keyBlock : new Uint8Array(0);
  return serializeVaultBlob(embeddedKeyBlock, contentSalt, iv, ciphertext);
}

/** Reverse of buildVaultBlob: blob (+ external key) → original file. */
export async function decodeVaultBlob(
  blob: Uint8Array,
  password: string,
  opts: { keyBlock?: Uint8Array | undefined; maxContentBytes: number },
): Promise<{ filename: string; content: Uint8Array }> {
  const { keyBlock, contentSalt, iv, ciphertext } = parseVaultBlob(blob);
  // Embedded key block travels in the blob; otherwise the caller must supply it.
  const kbBytes = keyBlock.length > 0 ? keyBlock : opts.keyBlock;
  if (!kbBytes || kbBytes.length === 0) throw new MissingKeyError();
  const dek = await unlockKeyBlock(parseKeyBlock(kbBytes), password);
  const cek = await deriveContentKey(dek, contentSalt);
  const envelope = await decryptBytes(cek, iv, ciphertext);
  return parsePayload(envelope, opts.maxContentBytes);
}

// --- Multi-region vault blob (SPEC §10.4, single-shot GCM path) --------------
//
// The always-on geometry for Gallery Mode. Layout:
//   [ vault_salt 16 ][ slot_array 304 ][ region0 R ][ region1 R ]   R = 44 + bucket
// Each region block = [ contentSalt 16 ][ IV 12 ][ GCM_CEK(region_plaintext) ]
// (ciphertext = bucket + 16-byte tag). A *dead* region (one no slot points at) is
// exactly R bytes of CSPRNG. The two blocks are always the same length R, so
// which region is real is invisible. RS erasure coding runs over the WHOLE blob
// as one stream (upstream, unchanged), so shard boundaries never partition by
// region. Per SPEC §10 governing decision 3, each region has an INDEPENDENT DEK,
// carried inside its slot — a shared DEK would let a decoy-slot opener derive the
// other region's key.

/** Per-region block overhead: content salt + IV + GCM tag (bucket adds the rest). */
const REGION_OVERHEAD = CONTENT_SALT_LEN + IV_LEN + GCM_TAG_LEN; // 44

/** A live region to write: its independent DEK, target index, and plaintext envelope. */
export interface LiveRegion {
  regionIndex: number;
  dek: Uint8Array;
  envelope: Uint8Array;
}

/** Build the two equal-length region blocks; dead regions are filled from CSPRNG. */
async function buildRegionBlocks(
  live: LiveRegion[],
  ladder: readonly number[],
): Promise<{ blocks: [Uint8Array, Uint8Array]; R: number }> {
  const lens: [number, number] = [0, 0];
  for (const r of live) lens[r.regionIndex] = REGION_LEN_FIELD + r.envelope.length;
  const bucket = pickBucket(lens[0], lens[1], ladder);
  const R = REGION_OVERHEAD + bucket;
  const blocks: [Uint8Array | null, Uint8Array | null] = [null, null];
  for (const r of live) {
    const contentSalt = randomBytes(CONTENT_SALT_LEN);
    const cek = await deriveRegionKey(r.dek, contentSalt, r.regionIndex);
    const { iv, ciphertext } = await encryptBytes(cek, padRegionPlaintext(r.envelope, bucket));
    blocks[r.regionIndex] = concatBytes(contentSalt, iv, ciphertext);
  }
  for (let i = 0; i < REGION_COUNT; i++) if (!blocks[i]) blocks[i] = randomBytes(R);
  return { blocks: [blocks[0]!, blocks[1]!], R };
}

/**
 * Assemble a multi-region vault blob from an explicit slot array and live regions.
 * The mode (plain / duress / non-possession) decides how many slots are live and
 * which regions carry data; this assembler is mode-agnostic.
 */
export async function buildMultiRegionVaultBlob(
  vaultSalt: Uint8Array,
  slotEntries: SlotEntry[],
  live: LiveRegion[],
  ladder: readonly number[],
): Promise<Uint8Array> {
  if (vaultSalt.length !== VAULT_SALT_LEN) throw new RangeError('multi-region: bad vault salt');
  const slotArray = await buildSlotArray(slotEntries);
  const {
    blocks: [b0, b1],
  } = await buildRegionBlocks(live, ladder);
  return concatBytes(vaultSalt, slotArray, b0, b1);
}

/**
 * Plain single-payload multi-region blob (no decoy, no threshold): one live slot,
 * one real region at a CSPRNG-chosen index, the other region dead. Every gallery
 * vault uses this in Phase 1 — the 2× cost is mandatory, not optional (§10.9).
 * Returns the blob plus the live region index and DEK for post-save verification.
 */
export async function buildPlainVaultBlobMulti(
  filename: string,
  content: Uint8Array,
  password: string,
  ladder: readonly number[],
  params: Argon2Params = DEFAULT_ARGON2,
  keyFactor: Uint8Array | null = null,
): Promise<{ blob: Uint8Array; regionIndex: number; dek: Uint8Array }> {
  const vaultSalt = randomBytes(VAULT_SALT_LEN);
  const kek = await deriveSlotKek(password, vaultSalt, keyFactor, params);
  const dek = randomBytes(DEK_LEN);
  const regionIndex = randomBytes(1)[0]! & 1; // CSPRNG bit: real region equally likely 0 or 1
  const envelope = await buildPayload(filename, content);
  const blob = await buildMultiRegionVaultBlob(
    vaultSalt,
    [{ kek, dek, regionIndex }],
    [{ regionIndex, dek, envelope }],
    ladder,
  );
  return { blob, regionIndex, dek };
}

/** Analytical multi-region blob length for capacity estimates (no crypto run). */
export function multiRegionBlobLen(
  env0Len: number,
  env1Len: number,
  ladder: readonly number[],
): number {
  const l0 = env0Len > 0 ? REGION_LEN_FIELD + env0Len : 0;
  const l1 = env1Len > 0 ? REGION_LEN_FIELD + env1Len : 0;
  const R = REGION_OVERHEAD + pickBucket(l0, l1, ladder);
  return VAULT_SALT_LEN + SLOT_ARRAY_LEN + REGION_COUNT * R;
}

/** Split a multi-region blob into its fixed sections; validates geometry before use. */
function splitMultiRegionBlob(blob: Uint8Array): {
  vaultSalt: Uint8Array;
  slotArray: Uint8Array;
  regionArea: Uint8Array;
  R: number;
} {
  const head = VAULT_SALT_LEN + SLOT_ARRAY_LEN;
  // Two regions, each at least the fixed overhead plus a non-empty bucket.
  if (blob.length < head + REGION_COUNT * (REGION_OVERHEAD + 1)) {
    throw new Error('multi-region blob: too short');
  }
  const regionArea = blob.subarray(head);
  if (regionArea.length % REGION_COUNT !== 0) throw new Error('multi-region blob: odd region area');
  const R = regionArea.length / REGION_COUNT;
  if (R < REGION_OVERHEAD + 1) throw new Error('multi-region blob: region too small');
  return {
    vaultSalt: blob.subarray(0, VAULT_SALT_LEN),
    slotArray: blob.subarray(VAULT_SALT_LEN, head),
    regionArea,
    R,
  };
}

/** Decrypt one region block with its independent DEK. */
async function decodeRegion(
  regionArea: Uint8Array,
  R: number,
  regionIndex: number,
  dek: Uint8Array,
  maxContentBytes: number,
): Promise<{ filename: string; content: Uint8Array }> {
  const block = regionArea.subarray(regionIndex * R, (regionIndex + 1) * R);
  const contentSalt = block.subarray(0, CONTENT_SALT_LEN);
  const iv = block.subarray(CONTENT_SALT_LEN, CONTENT_SALT_LEN + IV_LEN);
  const ciphertext = block.subarray(CONTENT_SALT_LEN + IV_LEN);
  const cek = await deriveRegionKey(dek, contentSalt, regionIndex);
  const plaintext = await decryptBytes(cek, iv, ciphertext);
  const envelope = parseRegionPlaintext(plaintext, maxContentBytes);
  return parsePayload(envelope, maxContentBytes);
}

/**
 * Decode a multi-region blob with a password: open the slot array (constant-work,
 * §10.3.1), then decrypt ONLY the one region the credential's slot points at. The
 * return value carries no region index, slot index, or mode — a plain, duress, and
 * non-possession unlock are indistinguishable to the caller.
 */
export async function decodeMultiRegionVaultBlob(
  blob: Uint8Array,
  password: string,
  opts: {
    params?: Argon2Params;
    maxContentBytes: number;
    keyFactor?: Uint8Array | null;
    /** Recovered Shamir secret S for a Mode B (threshold-gated) slot (§10.6). */
    secret?: Uint8Array | null;
  },
): Promise<{ filename: string; content: Uint8Array }> {
  const { vaultSalt, slotArray, regionArea, R } = splitMultiRegionBlob(blob);
  let candidates: CryptoKey[];
  try {
    candidates = await slotKekCandidates(
      password,
      vaultSalt,
      opts.keyFactor ?? null,
      opts.secret ?? null,
      opts.params,
    );
  } catch {
    throw new WrongPasswordError();
  }
  const { dek, regionIndex } = await openSlotArray(slotArray, candidates);
  return decodeRegion(regionArea, R, regionIndex, dek, opts.maxContentBytes);
}

/**
 * Decode a specific region with an already-known DEK (no password, no Argon2).
 * Used by post-save verification, which holds the authoring region DEK + index.
 */
export async function decodeMultiRegionVaultBlobWithDek(
  blob: Uint8Array,
  dek: Uint8Array,
  regionIndex: number,
  maxContentBytes = MAX_FILE_BYTES_BINARY,
): Promise<{ filename: string; content: Uint8Array }> {
  const { regionArea, R } = splitMultiRegionBlob(blob);
  return decodeRegion(regionArea, R, regionIndex, dek, maxContentBytes);
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
  const setId = randomBytes(SET_ID_LEN);
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
  const blob = await reassembleBlob(payloads);
  return decodeVaultBlob(blob, password, {
    keyBlock: opts.keyBlock,
    maxContentBytes: MAX_FILE_BYTES,
  });
}

/**
 * Decode image payloads back to the verified vault blob: majority-set selection
 * (foreign/corrupt images dropped), RS reconstruction tolerant of up to m missing
 * shards, retrying alternative k-subsets so one present-but-wrong shard can't turn
 * a recoverable set fatal, gated by the integrity hash. Shared by importVault and
 * post-save verification.
 */
async function reassembleBlob(payloads: Uint8Array[]): Promise<Uint8Array> {
  if (payloads.length === 0) throw new Error('import: no images provided');

  const decoded: { header: Header; shard: Uint8Array }[] = [];
  for (const payload of payloads) {
    try {
      decoded.push(decodeImagePayload(payload));
    } catch {
      // not an StegoShard image / unreadable header — skip it
    }
  }
  if (decoded.length === 0) throw new Error('import: no valid StegoShard images found');

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

  const slots: (Uint8Array | null)[] = new Array(k + m).fill(null);
  for (const { header, shard } of members) {
    if (header.shardIndex < k + m) slots[header.shardIndex] = shard;
  }

  const blob = await reconstructVerified(slots, k, m, blobLen, first.hash);
  if (!blob) throw new Error('import: reconstructed blob failed its integrity check');
  return blob;
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
/**
 * Export the vault as a **branded** `.ssbn` container (§8) — an EXCLUDED path, so
 * it keeps the single-region v1 geometry with the managed DEK, byte-for-byte
 * unchanged. The disguised `.db` path is supported by §10 and uses the separate
 * multi-region function below (it needs the password, not the managed key).
 */
export async function exportVaultBinary(
  filename: string,
  content: Uint8Array,
  key: VaultKey,
  options: { keyMode?: KeyMode; variant?: BinaryVariant; maxBytes?: number } = {},
  onProgress?: OnProgress,
): Promise<{ container: Uint8Array; keyMode: KeyMode; keyBlock: Uint8Array }> {
  const variant = options.variant ?? 'branded';
  if (variant !== 'branded') {
    // The disguised path is a §10 multi-region container — use exportVaultBinaryDisguised.
    throw new Error('exportVaultBinary handles only the branded (.ssbn) variant');
  }
  const maxBytes = options.maxBytes ?? MAX_FILE_BYTES_BINARY;
  if (content.length > maxBytes) {
    throw new FileTooLargeError(content.length, maxBytes);
  }
  const keyMode = options.keyMode ?? 'embedded';
  const blob = await buildSegmentedBlob(filename, content, key, keyMode, onProgress);
  return { container: wrapBinary(blob, variant), keyMode, keyBlock: key.keyBlock };
}

/**
 * Export the vault as a **disguised** `.db` container (§8 + §10): the mandatory
 * 4-slot / 2-region geometry inside a valid SQLite database. Needs the PASSWORD
 * (to derive the slot KEK), not the managed DEK — each region gets its own fresh
 * DEK. `embedded` mode is password-only; `keyfile`/`stego` return a 32-byte key
 * factor to deliver externally (SPEC §10; keyMode carries no length signal). The
 * returned `regionIndex` + `dek` are for post-save verification only.
 */
export async function exportVaultBinaryDisguised(
  filename: string,
  content: Uint8Array,
  password: string,
  options: { keyMode?: KeyMode; maxBytes?: number } = {},
  onProgress?: OnProgress,
): Promise<{
  container: Uint8Array;
  keyMode: KeyMode;
  keyBlock: Uint8Array;
  regionIndex: number;
  dek: Uint8Array;
}> {
  const maxBytes = options.maxBytes ?? MAX_FILE_BYTES_BINARY;
  if (content.length > maxBytes) throw new FileTooLargeError(content.length, maxBytes);
  const keyMode = options.keyMode ?? 'embedded';
  // `keyfile` and `stego` both externalise the same 32-byte key factor (§10.3);
  // they differ only in HOW it is delivered (a raw `.key` vs. hidden in a cover),
  // which is the caller's job. The core just mints and returns the factor.
  const keyFactor = keyMode === 'embedded' ? null : randomBytes(KEY_FACTOR_LEN);
  let built: { blob: Uint8Array; regionIndex: number; dek: Uint8Array };
  try {
    built = await buildPlainSegmentedBlobMulti(
      filename,
      content,
      password,
      DB_LADDER,
      DEFAULT_ARGON2,
      onProgress,
      DEFAULT_CHUNK_SIZE,
      keyFactor,
    );
  } catch (err) {
    if (err instanceof BucketTooLargeError) {
      throw new FileTooLargeError(content.length, DB_LADDER[DB_LADDER.length - 1]!);
    }
    throw err;
  }
  return {
    container: wrapBinary(built.blob, 'disguised'),
    keyMode,
    keyBlock: keyFactor ?? new Uint8Array(0),
    regionIndex: built.regionIndex,
    dek: built.dek,
  };
}

/**
 * Restore a file from a binary container. Geometry is chosen by the recovered
 * variant, never sniffed (§10 governing decision 2): a disguised `.db` is decoded
 * as multi-region (opts.keyBlock is the 32-byte key factor for keyfile/stego);
 * branded `.ssbn` and bare payloads stay single-region (opts.keyBlock is the SSKY
 * key block).
 */
export async function importVaultBinary(
  container: Uint8Array,
  password: string,
  opts: {
    keyBlock?: Uint8Array | undefined;
    maxBytes?: number;
    /** Recovered Shamir secret S for a Mode B (threshold-gated) .db vault (§10.6). */
    secret?: Uint8Array | null;
  } = {},
  onProgress?: OnProgress,
): Promise<{ filename: string; content: Uint8Array }> {
  const unwrapped = unwrapBinary(container);
  const blob = unwrapped?.payload ?? container;
  const maxContentBytes = opts.maxBytes ?? MAX_FILE_BYTES_BINARY;
  if (unwrapped?.variant === 'disguised') {
    return decodeMultiRegionSegmentedBlob(
      blob,
      password,
      { keyFactor: opts.keyBlock ?? null, secret: opts.secret ?? null, maxContentBytes },
      onProgress,
    );
  }
  // Branded, or bytes matching neither variant (bare blob — AES-GCM is the final
  // arbiter): single-region geometry.
  return decodeSegmentedBlob(
    blob,
    password,
    { keyBlock: opts.keyBlock, maxContentBytes },
    onProgress,
  );
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// --- Post-save round-trip verification ---------------------------------------
//
// Immediately after producing the artifacts, decode them back and confirm the
// original file returns — BEFORE telling the user the save succeeded. This catches
// any encoding/carrier fault (erasure, codec, container, a lossy cover) at save
// time rather than at some future restore when the original is gone.

/** Thrown when a just-saved artifact does not decode back to the original file. */
export class VerificationError extends Error {
  constructor() {
    super('post-save verification failed: the saved artifact did not restore to the original file');
    this.name = 'VerificationError';
  }
}

/**
 * Decrypt a vault blob's content with an already-unlocked DEK — no password, no
 * Argon2 (the content key is derived from the DEK regardless of key mode). Lets
 * verification reuse the managed key in hand instead of re-deriving from a password.
 */
export async function decodeVaultBlobWithDek(
  blob: Uint8Array,
  dek: CryptoKey,
  maxContentBytes = MAX_FILE_BYTES_BINARY,
): Promise<{ filename: string; content: Uint8Array }> {
  const { contentSalt, iv, ciphertext } = parseVaultBlob(blob);
  const cek = await deriveContentKey(dek, contentSalt);
  const envelope = await decryptBytes(cek, iv, ciphertext);
  return parsePayload(envelope, maxContentBytes);
}

async function assertRestores(
  blob: Uint8Array,
  dek: CryptoKey,
  filename: string,
  content: Uint8Array,
): Promise<void> {
  let got: { filename: string; content: Uint8Array };
  try {
    got = await decodeVaultBlobWithDek(blob, dek);
  } catch {
    throw new VerificationError();
  }
  if (got.filename !== filename || !bytesEqual(got.content, content)) throw new VerificationError();
}

/** Verify a freshly produced image set (disk/cloud/paper) round-trips. */
export async function verifyImageExport(
  imagePayloads: Uint8Array[],
  dek: CryptoKey,
  filename: string,
  content: Uint8Array,
): Promise<void> {
  let blob: Uint8Array;
  try {
    blob = await reassembleBlob(imagePayloads);
  } catch {
    throw new VerificationError();
  }
  await assertRestores(blob, dek, filename, content);
}

/** Verify a freshly produced branded (.ssbn) container round-trips (single-region). */
export async function verifyBinaryExport(
  container: Uint8Array,
  dek: CryptoKey,
  filename: string,
  content: Uint8Array,
  onProgress?: OnProgress,
): Promise<void> {
  const blob = unwrapBinary(container)?.payload ?? container;
  let got: { filename: string; content: Uint8Array };
  try {
    got = await decodeSegmentedBlobWithDek(blob, dek, MAX_FILE_BYTES_BINARY, onProgress);
  } catch {
    throw new VerificationError();
  }
  if (got.filename !== filename || !bytesEqual(got.content, content)) throw new VerificationError();
}

/**
 * Verify a freshly produced disguised (.db) container round-trips. Uses the
 * authoring region DEK + index directly (no password, no Argon2), decoding just
 * the live region — mirrors `decodeMultiRegionSegmentedBlobWithDek`.
 */
export async function verifyDisguisedExport(
  container: Uint8Array,
  dek: Uint8Array,
  regionIndex: number,
  filename: string,
  content: Uint8Array,
  onProgress?: OnProgress,
): Promise<void> {
  const blob = unwrapBinary(container)?.payload ?? container;
  let got: { filename: string; content: Uint8Array };
  try {
    got = await decodeMultiRegionSegmentedBlobWithDek(
      blob,
      dek,
      regionIndex,
      MAX_FILE_BYTES_BINARY,
      onProgress,
    );
  } catch {
    throw new VerificationError();
  }
  if (got.filename !== filename || !bytesEqual(got.content, content)) throw new VerificationError();
}
