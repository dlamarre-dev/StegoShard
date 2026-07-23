/**
 * Gallery Mode (SPEC §9): hide a secret, fragmented across many ordinary photos,
 * so the set survives partial loss and stays deniable.
 *
 * Threat model & shape:
 *  - The secret is encrypted once into the standard self-contained vault blob
 *    (embedded key mode; reuses buildVaultBlob/decodeVaultBlob), then split by
 *    Reed-Solomon into K data + M parity shards — any K of K+M reconstruct it.
 *  - Each shard is packed into the standard 33-byte SSHD header, padded to a
 *    fixed slot, and **sealed as its own AES-256-GCM message** with a fresh
 *    random nonce carried in the slot. That per-fragment AEAD is what enables
 *    *blind winnowing*: on restore we trial-open every image; a failed tag means
 *    a decoy, a recompressed/destroyed carrier, or a foreign image — dropped
 *    silently. Survivors ≥ K are reconstructed.
 *  - Extra "decoy" photos (≥ GALLERY_MIN_DECOYS) carry uniform random bytes of
 *    the same slot size at the same seed-derived positions, indistinguishable
 *    from sealed fragments without the password.
 *
 * Keys: one Argon2id(password, GALLERY_SALT) seed, HKDF-split into an image-
 * independent position key (so blind extraction is possible) and an AEAD key.
 * The gallery Argon2 cost is the frozen DEFAULT_ARGON2 and is not stored (like
 * the stego key-block salt); `options.params` exists only to speed up tests.
 *
 * Honest limit (see docs/CRYPTO-REVIEW.md): this hides from an adversary without
 * the originals. Gallery Mode modifies *every* selected photo, so an adversary
 * holding the untouched originals can diff them — amplified vs. single-image stego.
 */

import { argon2id } from 'hash-wasm';
import { concatBytes, toHex } from './bytes';
import {
  type Argon2Params,
  DEFAULT_ARGON2,
  GCM_TAG_LEN,
  IV_LEN,
  createKeyBlock,
  decryptBytes,
  encryptBytes,
  hkdf,
  normalizePassword,
  randomBytes,
  serializeKeyBlock,
} from './crypto';
import { buildPayload } from './payload';
import type { KeyMode } from './types';
import { decodeBlob, encodeShards, parityCount } from './erasure';
import {
  CODEC_GALLERY,
  type Header,
  HEADER_LEN,
  PROFILE_DISK,
  SET_ID_LEN,
  decodeImagePayload,
  encodeImagePayload,
} from './header';
import {
  GALLERY_SALT,
  StegoCapacityError,
  embedBytesStegoJpeg,
  embedBytesStegoRgba,
  extractBytesStegoJpeg,
  extractBytesStegoRgba,
} from './stego';
import {
  type VaultKey,
  MAX_FILE_BYTES,
  VerificationError,
  blobLenFor,
  buildVaultBlob,
  decodeVaultBlob,
  sha256Short,
} from './vault';

const subtle = globalThis.crypto.subtle;

/** Shard-data bytes carried per image (frozen). Fixed so blind decode knows the slot size. */
export const GALLERY_SLOT_DATA = 2048;
/** Fixed inner AEAD plaintext length: the SSHD header plus one (padded) shard. */
export const GALLERY_FRAG_LEN = HEADER_LEN + GALLERY_SLOT_DATA;
/** Fixed embedded slot size: 12-byte nonce + AES-GCM(header||shard) + 16-byte tag. */
export const GALLERY_SLOT_BYTES = IV_LEN + GALLERY_FRAG_LEN + GCM_TAG_LEN;
const GALLERY_SLOT_BITS = GALLERY_SLOT_BYTES * 8;
/** Eligible carriers must exceed the slot size by this factor (keeps embedding sparse). */
export const GALLERY_CAPACITY_MARGIN = 4;
/** Minimum total photos (≥ 1 data + 2 parity + 2 decoy). */
export const GALLERY_MIN_IMAGES = 5;
/** Minimum decoy photos, so winnowing always has chaff to reject. */
export const GALLERY_MIN_DECOYS = 2;
/** Max data shards, bounded so K + parity + decoys stays under the GF(256) limit of 256. */
export const GALLERY_K_MAX = 190;
/** Largest vault blob a gallery can carry. */
export const GALLERY_MAX_BLOB = GALLERY_SLOT_DATA * GALLERY_K_MAX;
/** Sanity ceiling on the number of photos processed. */
export const GALLERY_MAX_IMAGES = 256;

const LABEL_POS = new TextEncoder().encode('stegoshard/gallery/pos');
const LABEL_AEAD = new TextEncoder().encode('stegoshard/gallery/aead');

/** A cover photo to hide fragments in: a baseline JPEG, or raw RGBA (for PNG). */
export type GalleryCover =
  | { kind: 'jpeg'; name: string; jpeg: Uint8Array }
  | {
      kind: 'rgba';
      name: string;
      rgba: Uint8Array | Uint8ClampedArray;
      width: number;
      height: number;
    };

/** A produced gallery image, mirroring its cover's kind (UI turns RGBA into a PNG). */
export type GalleryImage =
  | { kind: 'jpeg'; name: string; jpeg: Uint8Array }
  | { kind: 'rgba'; name: string; rgba: Uint8Array; width: number; height: number };

export interface GalleryEncodeOptions {
  /** Argon2 cost; leave unset in production (frozen DEFAULT_ARGON2). Tests pass cheaper values. */
  params?: Argon2Params;
  /**
   * How the vault key is delivered. 'embedded' (default) hides it in the fragments;
   * 'keyfile'/'stego' leave it out (KB_LEN=0) so the caller delivers `keyBlock`
   * separately (a loose .key or hidden in a cover photo).
   */
  keyMode?: KeyMode;
}
export interface GalleryEncodeResult {
  images: GalleryImage[];
  k: number;
  m: number;
  decoys: number;
  setId: Uint8Array;
  /** The serialized key block — travels in the images when embedded, else delivered externally. */
  keyBlock: Uint8Array;
}
export interface GalleryDecodeOptions {
  params?: Argon2Params;
  /** External key block for keyfile/stego galleries (omit for embedded). */
  keyBlock?: Uint8Array | undefined;
}

/**
 * Estimate how many cover photos a secret needs, without running Argon2. The
 * vault blob is fixed-width apart from the (compressed) envelope, so blobLen is
 * computable analytically; returns the shard split and the minimum photo count
 * (`k + m + GALLERY_MIN_DECOYS`).
 */
export async function estimateGalleryCovers(
  filename: string,
  content: Uint8Array,
  keyMode: KeyMode = 'embedded',
): Promise<{ k: number; m: number; needed: number }> {
  const envelope = await buildPayload(filename, content);
  return galleryCoversForEnvelopeLen(envelope.length, keyMode);
}

/**
 * The gallery shard split + minimum photo count for an already-built envelope
 * length, without re-compressing (mirrors `imagesForEnvelopeLen`).
 */
export function galleryCoversForEnvelopeLen(
  envelopeLen: number,
  keyMode: KeyMode = 'embedded',
): { k: number; m: number; needed: number } {
  const embedded = keyMode === 'embedded';
  // Reuse the single source of truth for blob length (includes A3's contentSalt);
  // duplicating the formula here previously drifted from vault.ts.
  const blobLen = blobLenFor(envelopeLen, embedded);
  const k = Math.max(1, Math.ceil(blobLen / GALLERY_SLOT_DATA));
  const m = parityCount(k);
  return { k, m, needed: k + m + GALLERY_MIN_DECOYS };
}

/** Thrown when too few photos are supplied for the secret plus the decoy floor. */
export class GalleryTooFewImagesError extends Error {
  constructor(
    readonly provided: number,
    readonly needed: number,
  ) {
    super(`gallery needs at least ${needed} photos, got ${provided}`);
    this.name = 'GalleryTooFewImagesError';
  }
}

/** Thrown when the secret is larger than a gallery can carry. */
export class GalleryFileTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(`secret too large for gallery mode: ${size} bytes (limit ~${limit})`);
    this.name = 'GalleryFileTooLargeError';
  }
}

/** Thrown when more cover photos are supplied than a gallery will process. */
export class GalleryTooManyImagesError extends Error {
  constructor(
    readonly provided: number,
    readonly limit: number,
  ) {
    super(`gallery accepts at most ${limit} photos, got ${provided}`);
    this.name = 'GalleryTooManyImagesError';
  }
}

/** Thrown when a cover photo has too few eligible carriers to hide a slot deniably. */
export class GalleryCoverCapacityError extends Error {
  constructor(
    readonly coverName: string,
    readonly capacityBits: number,
    readonly neededBits: number,
  ) {
    super(`cover "${coverName}" too small: ${capacityBits} carriers, need ${neededBits}`);
    this.name = 'GalleryCoverCapacityError';
  }
}

/**
 * Thrown when no gallery can be restored — either the password is wrong or these
 * photos hold no gallery. The two are deliberately indistinguishable.
 */
export class GalleryRestoreError extends Error {
  constructor() {
    super('no restorable gallery found (wrong password or no gallery images)');
    this.name = 'GalleryRestoreError';
  }
}

/** Argon2id(password, GALLERY_SALT) → HKDF-split position key + AEAD key. */
async function galleryKeys(
  password: string,
  params: Argon2Params,
): Promise<{ posKey: Uint8Array; aeadKey: CryptoKey }> {
  const seed = (await argon2id({
    password: normalizePassword(password),
    salt: GALLERY_SALT,
    iterations: params.iterations,
    memorySize: params.memoryKiB,
    parallelism: params.parallelism,
    hashLength: 32,
    outputType: 'binary',
  })) as Uint8Array;
  const posKey = await hkdf(seed, LABEL_POS, 32);
  const aeadRaw = await hkdf(seed, LABEL_AEAD, 32);
  seed.fill(0);
  const aeadKey = await subtle.importKey(
    'raw',
    aeadRaw as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
  aeadRaw.fill(0);
  return { posKey, aeadKey };
}

/**
 * Hide a slot in a cover, returning an image of the same kind. RGBA is copied, not
 * mutated. The capacity check lives in the stego embedders (margin factor); a
 * too-small cover surfaces as a named GalleryCoverCapacityError.
 */
async function embedSlot(
  cover: GalleryCover,
  slot: Uint8Array,
  posKey: Uint8Array,
): Promise<GalleryImage> {
  try {
    if (cover.kind === 'jpeg') {
      return {
        kind: 'jpeg',
        name: cover.name,
        jpeg: await embedBytesStegoJpeg(cover.jpeg, slot, posKey, GALLERY_CAPACITY_MARGIN),
      };
    }
    const rgba = Uint8Array.from(cover.rgba);
    await embedBytesStegoRgba(
      rgba,
      cover.width,
      cover.height,
      slot,
      posKey,
      GALLERY_CAPACITY_MARGIN,
    );
    return { kind: 'rgba', name: cover.name, rgba, width: cover.width, height: cover.height };
  } catch (err) {
    if (err instanceof StegoCapacityError) {
      throw new GalleryCoverCapacityError(
        cover.name,
        err.capacityBits,
        GALLERY_SLOT_BITS * GALLERY_CAPACITY_MARGIN,
      );
    }
    throw err;
  }
}

/**
 * Read a fixed-size slot out of a cover; null if it cannot hold one. The same
 * capacity margin as embedding is required, so a real carrier always passes and a
 * smaller image is skipped rather than draining the position keystream.
 */
async function extractSlot(cover: GalleryCover, posKey: Uint8Array): Promise<Uint8Array | null> {
  return cover.kind === 'jpeg'
    ? extractBytesStegoJpeg(cover.jpeg, posKey, GALLERY_SLOT_BYTES, GALLERY_CAPACITY_MARGIN)
    : extractBytesStegoRgba(
        cover.rgba,
        cover.width,
        cover.height,
        posKey,
        GALLERY_SLOT_BYTES,
        GALLERY_CAPACITY_MARGIN,
      );
}

/**
 * Encode a secret across `covers`, sealing each RS fragment into its own photo and
 * filling the remaining photos with decoys. Every cover is modified and must have
 * enough eligible carriers; the first K+M covers become fragment carriers, the rest
 * decoys. Returns the modified images plus the set's parameters.
 */
export async function galleryEncode(
  filename: string,
  content: Uint8Array,
  password: string,
  covers: GalleryCover[],
  options: GalleryEncodeOptions = {},
): Promise<GalleryEncodeResult> {
  const params = options.params ?? DEFAULT_ARGON2;
  const keyMode = options.keyMode ?? 'embedded';
  if (covers.length > GALLERY_MAX_IMAGES) {
    throw new GalleryTooManyImagesError(covers.length, GALLERY_MAX_IMAGES);
  }
  if (covers.length < GALLERY_MIN_IMAGES) {
    throw new GalleryTooFewImagesError(covers.length, GALLERY_MIN_IMAGES);
  }
  // Cap the *original* content, not just the compressed blob: restore bounds the
  // decompressed size, so a highly compressible secret that slips under the blob
  // ceiling here would otherwise be unrecoverable. Matches the Python decoder's
  // MAX_CONTENT_BYTES (1 MiB), keeping the two implementations in agreement.
  if (content.length > MAX_FILE_BYTES) {
    throw new GalleryFileTooLargeError(content.length, MAX_FILE_BYTES);
  }

  // One self-contained, password-encrypted vault blob. The key block travels in
  // the fragments (embedded) or is left out for the caller to deliver separately.
  const { dek, block } = await createKeyBlock(password, params);
  const keyBlock = serializeKeyBlock(block);
  const key: VaultKey = { dek, keyBlock };
  const blob = await buildVaultBlob(filename, content, key, keyMode);
  if (blob.length > GALLERY_MAX_BLOB) {
    throw new GalleryFileTooLargeError(content.length, GALLERY_MAX_BLOB);
  }

  const k = Math.max(1, Math.ceil(blob.length / GALLERY_SLOT_DATA));
  const m = parityCount(k);
  const carriers = k + m;
  const decoys = covers.length - carriers;
  if (decoys < GALLERY_MIN_DECOYS) {
    throw new GalleryTooFewImagesError(covers.length, carriers + GALLERY_MIN_DECOYS);
  }

  const { shards, shardLen } = encodeShards(blob, k, m);
  const setId = randomBytes(SET_ID_LEN);
  const hash = await sha256Short(blob);
  const { posKey, aeadKey } = await galleryKeys(password, params);

  const images: GalleryImage[] = [];
  for (let i = 0; i < covers.length; i++) {
    let slot: Uint8Array;
    if (i < carriers) {
      const header: Header = {
        version: 1,
        setId,
        shardIndex: i,
        k,
        m,
        codecId: CODEC_GALLERY,
        profile: PROFILE_DISK,
        shardLen,
        blobLen: blob.length,
        hash,
      };
      // header||shard, zero-padded to the fixed fragment length, then sealed.
      const frag = new Uint8Array(GALLERY_FRAG_LEN);
      frag.set(encodeImagePayload(header, shards[i]!), 0);
      const { iv, ciphertext } = await encryptBytes(aeadKey, frag);
      slot = concatBytes(iv, ciphertext);
    } else {
      slot = randomBytes(GALLERY_SLOT_BYTES);
    }
    images.push(await embedSlot(covers[i]!, slot, posKey));
  }
  posKey.fill(0);
  return { images, k, m, decoys, setId, keyBlock };
}

/** Reconstruct one set's blob from its authenticated fragments, or throw. */
async function reconstructGroup(
  members: { header: Header; shard: Uint8Array }[],
  password: string,
  keyBlock: Uint8Array | undefined,
): Promise<{ filename: string; content: Uint8Array }> {
  const first = members[0]!.header;
  const { k, m, blobLen } = first;
  const slots: (Uint8Array | null)[] = new Array(k + m).fill(null);
  let present = 0;
  for (const { header, shard } of members) {
    // Ignore fragments that disagree with the set's shape or duplicate an index.
    if (header.k !== k || header.m !== m || header.blobLen !== blobLen) continue;
    if (header.shardIndex < k + m && slots[header.shardIndex] === null) {
      slots[header.shardIndex] = shard;
      present++;
    }
  }
  if (present < k) throw new GalleryRestoreError();

  const blob = decodeBlob(slots, k, m, blobLen);
  const hash = await sha256Short(blob);
  if (toHex(hash) !== toHex(first.hash)) throw new GalleryRestoreError();
  return decodeVaultBlob(blob, password, {
    // External key block for keyfile/stego galleries; ignored when the blob
    // carries an embedded one.
    keyBlock,
    // The decompressed content ceiling — the compressed blob is bounded
    // separately by GALLERY_MAX_BLOB at encode time (see galleryEncode).
    maxContentBytes: MAX_FILE_BYTES,
  });
}

/**
 * Restore a secret from a folder of photos, blindly. Every image is trial-opened;
 * only fragments whose AEAD tag verifies are kept (winnowing), grouped by set id,
 * and reconstructed once ≥ K survive. Handles mixed folders and decoys; throws
 * GalleryRestoreError when nothing restorable is found (wrong password or none).
 */
export async function galleryDecode(
  images: GalleryCover[],
  password: string,
  options: GalleryDecodeOptions = {},
): Promise<{ filename: string; content: Uint8Array }> {
  const params = options.params ?? DEFAULT_ARGON2;
  const { posKey, aeadKey } = await galleryKeys(password, params);

  const frags: { header: Header; shard: Uint8Array }[] = [];
  for (const img of images) {
    const slot = await extractSlot(img, posKey);
    if (!slot) continue;
    let frag: Uint8Array;
    try {
      frag = await decryptBytes(aeadKey, slot.subarray(0, IV_LEN), slot.subarray(IV_LEN));
    } catch {
      continue; // failed tag → decoy, destroyed carrier, or foreign image
    }
    try {
      frags.push(decodeImagePayload(frag));
    } catch {
      continue; // authenticated but malformed (should not happen) — skip
    }
  }
  posKey.fill(0);
  if (frags.length === 0) throw new GalleryRestoreError();

  // Group by set id; try the largest groups first so a mixed folder (or a second
  // same-password gallery) still resolves to a complete set.
  const groups = new Map<string, { header: Header; shard: Uint8Array }[]>();
  for (const f of frags) {
    const gkey = toHex(f.header.setId);
    const g = groups.get(gkey);
    if (g) g.push(f);
    else groups.set(gkey, [f]);
  }
  for (const members of [...groups.values()].sort((a, b) => b.length - a.length)) {
    try {
      return await reconstructGroup(members, password, options.keyBlock);
    } catch {
      // this set is incomplete or failed integrity — try the next
    }
  }
  throw new GalleryRestoreError();
}

/**
 * Post-save verification for Gallery Mode: blind-winnow the freshly produced
 * photos and confirm they restore to (filename, content). Runs the full decode
 * (one gallery Argon2 + key-block unwrap) — acceptable on this deliberately heavy,
 * opt-in path. Throws VerificationError on any mismatch.
 */
export async function verifyGalleryExport(
  images: GalleryImage[],
  password: string,
  keyBlock: Uint8Array | undefined,
  filename: string,
  content: Uint8Array,
): Promise<void> {
  let got: { filename: string; content: Uint8Array };
  try {
    got = await galleryDecode(images as GalleryCover[], password, { keyBlock });
  } catch {
    throw new VerificationError();
  }
  if (got.filename !== filename || got.content.length !== content.length) throw new VerificationError();
  for (let i = 0; i < content.length; i++) {
    if (got.content[i] !== content[i]) throw new VerificationError();
  }
}
