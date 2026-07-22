/**
 * Deniable steganographic key block (plan §4, SPEC §5.2 "stego" mode).
 *
 * Hides the 92-byte wrapped-DEK key block inside an ordinary photo's RGB
 * least-significant bits. The design goal is *plausible deniability*: without
 * the password, the modified pixels are indistinguishable from a photo's
 * natural LSB noise, and there is no header, magic, or length field in the
 * image to betray that anything is hidden at all.
 *
 * How deniability is achieved:
 *  - **Password-keyed positions.** Argon2id(password, fixed salt) seeds an
 *    AES-CTR stream that (a) whitens the payload and (b) chooses which LSBs
 *    carry it. Without the password you cannot even locate the ~736 carrier
 *    bits among the millions in the image.
 *  - **Whitened payload.** The key block is XORed with the keystream before
 *    embedding, so the carried bits are uniformly random — statistically
 *    identical to untouched LSBs.
 *  - **No structure on the wire.** The payload length is fixed (KEY_BLOCK_LEN),
 *    so nothing about the size or layout is stored in the clear. Extraction
 *    with the wrong password yields random bytes that fail the key-block magic
 *    check, which is reported the same as "no key here" — the two are
 *    indistinguishable, which is the point.
 *  - **Argon2-gated.** Locating/de-whitening costs one Argon2id derivation per
 *    password guess, the same cost as unwrapping the key block itself, so the
 *    stego layer is not a cheap password oracle.
 *
 * Honest limits (see docs/CRYPTO-REVIEW.md): LSB steganography survives only
 * lossless storage — the carrier MUST be kept as the emitted PNG; re-encoding
 * to JPEG, resizing, or re-saving destroys the key. An adversary who holds the
 * *original* cover image can diff it against the carrier. And LSB steganalysis
 * is an arms race; this resists casual/statistical detection, not a dedicated
 * forensic adversary who already suspects a specific image and password.
 *
 * Works on raw RGBA bytes so it is environment-neutral (Node tests, workers,
 * browser pages); turning a file into RGBA and RGBA into a PNG is the UI's job.
 */

import { argon2id } from 'hash-wasm';
import {
  type Argon2Params,
  DEFAULT_ARGON2,
  hkdf,
  KEY_BLOCK_LEN,
  isSerializedKeyBlock,
  normalizePassword,
} from './crypto';
import {
  decode as decodeJpeg,
  encode as encodeJpeg,
  type JpegModel,
  eligibleCoefficients,
  eligibleInPlace,
  applyScanToggles,
} from './jpeg-coeff';

const subtle = globalThis.crypto.subtle;

// Per-cover keystream nonce for the key-block stego paths (SPEC §5.3/§5.4). The
// keystream that both whitens the payload and selects carrier positions is bound
// to a fingerprint of the *cover*, so two vaults saved with the same password
// into different covers (or the same cover reused) never share a whitening pad or
// a carrier layout — which would otherwise be a two-time-pad / correlation leak.
// The fingerprint is taken over exactly the bits embedding never changes (RGB
// with the LSB masked; JPEG coefficient magnitudes with bit 0 masked), so it is
// identical at embed and at extract and NOTHING has to be stored in the image
// ("no structure on the wire" is preserved). Mirrored bit-for-bit by the Python
// reference decoder. Gallery Mode (§9) does NOT use this: its slots are already
// per-fragment AES-GCM with random nonces and carry no whitening, so position
// reuse across covers leaks nothing — the per-cover hash would be pure cost.
const STEGO_COVER_INFO = new TextEncoder().encode('stegoshard/stego/cover');

/** SHA-256 over an RGBA cover's embedding-invariant bits (RGB, LSB masked; alpha excluded). */
async function coverFingerprintRgba(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const pixels = width * height;
  const masked = new Uint8Array(pixels * 3);
  let o = 0;
  for (let p = 0; p < pixels; p++) {
    const base = p * 4;
    masked[o++] = rgba[base]! & 0xfe;
    masked[o++] = rgba[base + 1]! & 0xfe;
    masked[o++] = rgba[base + 2]! & 0xfe;
  }
  return new Uint8Array(await subtle.digest('SHA-256', masked as BufferSource));
}

/**
 * SHA-256 over a baseline JPEG's embedding-invariant coefficient content: for
 * each eligible carrier (|coef| ≥ 2 AC coeff, in `eligibleCoefficients` order),
 * the signed magnitude with bit 0 masked off, encoded big-endian int32. Embedding
 * only flips those bit-0s and preserves |coef| ≥ 2, so this is stable.
 */
async function coverFingerprintJpeg(model: JpegModel): Promise<Uint8Array> {
  const vals: number[] = [];
  for (const comp of model.components) {
    for (const block of comp.blocks) {
      for (let k = 1; k < 64; k++) {
        const v = block[k]!;
        if (Math.abs(v) >= 2) {
          const m = Math.abs(v) & ~1;
          vals.push(v < 0 ? -m : m);
        }
      }
    }
  }
  const buf = new Uint8Array(vals.length * 4);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < vals.length; i++) dv.setInt32(i * 4, vals[i]!, false);
  return new Uint8Array(await subtle.digest('SHA-256', buf as BufferSource));
}

/** Derive the per-cover keystream key from a base secret and the cover fingerprint. */
async function coverKey(baseSeed: Uint8Array, fingerprint: Uint8Array): Promise<Uint8Array> {
  return hkdf(baseSeed, STEGO_COVER_INFO, 32, fingerprint);
}

/**
 * Fixed application salt for the stego key derivation. Unlike the key block's
 * own random salt, this cannot be stored in the image (that would be a
 * detectable structure), so it is a constant — acceptable because the stego
 * layer is defense-in-depth for hiding, not the vault's confidentiality (that
 * is the password-wrapped key block). ASCII "StegoShard-stego" (exactly 16 bytes).
 */
export const STEGO_SALT = Uint8Array.from([
  0x53, 0x74, 0x65, 0x67, 0x6f, 0x53, 0x68, 0x61, 0x72, 0x64, 0x2d, 0x73, 0x74, 0x65, 0x67, 0x6f,
]);

const PAYLOAD_LEN = KEY_BLOCK_LEN; // fixed 92 bytes
const PAYLOAD_BITS = PAYLOAD_LEN * 8;
/** Require the payload to use ≤ ~6% of the RGB LSBs (keeps embedding sparse). */
const MIN_CAPACITY = PAYLOAD_BITS * 16;

/** Thrown when a cover image is too small to carry the key block deniably. */
export class StegoCapacityError extends Error {
  constructor(readonly capacityBits: number) {
    super(`cover image too small for a deniable key block (need ${MIN_CAPACITY} LSBs)`);
    this.name = 'StegoCapacityError';
  }
}

/**
 * Thrown when a stego cover is not a supported format: only baseline JPEG and
 * PNG can carry the key. Progressive/arithmetic JPEG, HEIC, WebP, etc. are
 * refused (no silent transcode — that would change the file's size/appearance
 * and defeat the deniability goal).
 */
export class StegoCoverFormatError extends Error {
  constructor() {
    super('unsupported cover image: use a baseline JPEG or a PNG');
    this.name = 'StegoCoverFormatError';
  }
}

/** RGB LSB capacity of an RGBA buffer (alpha is never touched). */
function capacityBits(width: number, height: number): number {
  return width * height * 3;
}

/** Deterministic AES-CTR keystream of `len` bytes from a raw 32-byte seed. */
async function keystreamFromSeed(seed: Uint8Array, len: number): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', seed as BufferSource, { name: 'AES-CTR' }, false, [
    'encrypt',
  ]);
  return new Uint8Array(
    await subtle.encrypt(
      { name: 'AES-CTR', counter: new Uint8Array(16), length: 64 },
      key,
      new Uint8Array(len),
    ),
  );
}

/** Deterministic keystream of `len` bytes from the password via Argon2id + AES-CTR. */
async function keystream(
  password: string,
  len: number,
  params: Argon2Params,
  fingerprint: Uint8Array,
): Promise<Uint8Array> {
  const seed = (await argon2id({
    password: normalizePassword(password),
    salt: STEGO_SALT,
    iterations: params.iterations,
    memorySize: params.memoryKiB,
    parallelism: params.parallelism,
    hashLength: 32,
    outputType: 'binary',
  })) as Uint8Array;
  // Bind the keystream to this specific cover (SPEC §5.3): whitening pad and
  // carrier positions become unique per cover even under a reused password.
  const ckey = await coverKey(seed, fingerprint);
  seed.fill(0);
  const stream = await keystreamFromSeed(ckey, len);
  ckey.fill(0);
  return stream;
}

/** Reads uniform values from a fixed keystream; throws if it runs dry. */
class StreamReader {
  private o = 0;
  constructor(private readonly bytes: Uint8Array) {}
  next4(): number {
    if (this.o + 4 > this.bytes.length) throw new Error('stego: keystream exhausted');
    const b = this.bytes;
    const v =
      ((b[this.o]! << 24) | (b[this.o + 1]! << 16) | (b[this.o + 2]! << 8) | b[this.o + 3]!) >>> 0;
    this.o += 4;
    return v;
  }
}

/**
 * Pick `count` distinct bit-positions in [0, capacity) in a password-derived
 * order, by rejection sampling from the keystream (no modulo bias, no O(N)
 * shuffle of the whole image).
 */
function pickPositions(reader: StreamReader, capacity: number, count: number): number[] {
  const limit = Math.floor(0x1_0000_0000 / capacity) * capacity; // reject above this
  const used = new Set<number>();
  const positions: number[] = [];
  while (positions.length < count) {
    const r = reader.next4();
    if (r >= limit) continue; // avoid modulo bias
    const pos = r % capacity;
    if (used.has(pos)) continue;
    used.add(pos);
    positions.push(pos);
  }
  return positions;
}

/** Byte index of the RGB channel carrying bit-position `pos` in an RGBA buffer. */
function channelByte(pos: number): number {
  const pixel = Math.floor(pos / 3);
  const comp = pos % 3; // 0=R 1=G 2=B, never alpha
  return pixel * 4 + comp;
}

/** Generous keystream length: whitening pad + position draws + slack. */
function streamLen(): number {
  return PAYLOAD_LEN + PAYLOAD_BITS * 8 + 1024;
}

/**
 * Embed a serialized key block into `rgba` in place (deniable LSB stego).
 * `rgba` is RGBA (4 bytes/pixel). Throws if the block is the wrong length or
 * the cover is too small.
 */
export async function embedKeyBlockStego(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  keyBlock: Uint8Array,
  password: string,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<void> {
  if (keyBlock.length !== PAYLOAD_LEN) {
    throw new RangeError(`stego: key block must be ${PAYLOAD_LEN} bytes`);
  }
  const capacity = capacityBits(width, height);
  if (capacity < MIN_CAPACITY) throw new StegoCapacityError(capacity);

  const fingerprint = await coverFingerprintRgba(rgba, width, height);
  const stream = await keystream(password, streamLen(), params, fingerprint);
  const pad = stream.subarray(0, PAYLOAD_LEN);
  const reader = new StreamReader(stream.subarray(PAYLOAD_LEN));
  const positions = pickPositions(reader, capacity, PAYLOAD_BITS);

  for (let i = 0; i < PAYLOAD_BITS; i++) {
    const bit = ((keyBlock[i >> 3]! ^ pad[i >> 3]!) >> (7 - (i & 7))) & 1;
    const byteIndex = channelByte(positions[i]!);
    rgba[byteIndex] = (rgba[byteIndex]! & 0xfe) | bit;
  }
  stream.fill(0);
}

/**
 * Extract a key block previously embedded by embedKeyBlockStego. Returns the
 * serialized key block bytes, or null when the password is wrong / the image
 * carries no key for this password (the two are deliberately indistinguishable).
 */
export async function extractKeyBlockStego(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  password: string,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<Uint8Array | null> {
  const capacity = capacityBits(width, height);
  if (capacity < MIN_CAPACITY) return null;

  const fingerprint = await coverFingerprintRgba(rgba, width, height);
  const stream = await keystream(password, streamLen(), params, fingerprint);
  const pad = stream.subarray(0, PAYLOAD_LEN);
  const reader = new StreamReader(stream.subarray(PAYLOAD_LEN));
  const positions = pickPositions(reader, capacity, PAYLOAD_BITS);

  const out = new Uint8Array(PAYLOAD_LEN);
  for (let i = 0; i < PAYLOAD_BITS; i++) {
    const bit = rgba[channelByte(positions[i]!)]! & 1;
    if (bit) out[i >> 3]! |= 1 << (7 - (i & 7));
  }
  for (let j = 0; j < PAYLOAD_LEN; j++) out[j]! ^= pad[j]!;
  stream.fill(0);

  // Wrong password → random bytes → fails the magic check → reported as "no
  // key" (indistinguishable from an image that never held one).
  return isSerializedKeyBlock(out) ? out : null;
}

// --- JPEG DCT-coefficient variant (SPEC §5.4) --------------------------------
//
// Same keyed selection + whitening as the RGBA path, but the carrier is the set
// of eligible AC coefficients (|coef| ≥ 2) of a baseline JPEG, and the payload
// bit lives in the LSB of each coefficient's magnitude. Keeping |coef| ≥ 2 means
// an LSB flip never crosses a Huffman size-category boundary → the re-encoded
// scan is the same size and the eligible set is invariant (bit-exact extraction).

/** Eligible coefficients are far sparser than pixel LSBs; require a smaller margin. */
const JPEG_MIN_CAPACITY = PAYLOAD_BITS * 2;

/**
 * Hide the key block in a **baseline JPEG's** DCT coefficients and return new
 * JPEG bytes (only the entropy scan changes; all other segments are verbatim).
 * Throws JpegUnsupportedError (non-baseline cover) or StegoCapacityError.
 */
export async function embedKeyBlockStegoJpeg(
  jpegBytes: Uint8Array,
  keyBlock: Uint8Array,
  password: string,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<Uint8Array> {
  if (keyBlock.length !== PAYLOAD_LEN) {
    throw new RangeError(`stego: key block must be ${PAYLOAD_LEN} bytes`);
  }
  const model = decodeJpeg(jpegBytes); // throws JpegUnsupportedError if not baseline

  const fingerprint = await coverFingerprintJpeg(model);
  const stream = await keystream(password, streamLen(), params, fingerprint);
  const pad = stream.subarray(0, PAYLOAD_LEN);
  const bitAt = (i: number): number => ((keyBlock[i >> 3]! ^ pad[i >> 3]!) >> (7 - (i & 7))) & 1;

  if (model.restartInterval === 0) {
    // Byte-faithful in-place edit: toggle only the carrier LSB bits whose value
    // must change, leaving every other byte of the original JPEG untouched.
    const carriers = eligibleInPlace(model);
    if (carriers.count < JPEG_MIN_CAPACITY) throw new StegoCapacityError(carriers.count);
    const reader = new StreamReader(stream.subarray(PAYLOAD_LEN));
    const positions = pickPositions(reader, carriers.count, PAYLOAD_BITS);
    const toggles: number[] = [];
    for (let i = 0; i < PAYLOAD_BITS; i++) {
      const p = positions[i]!;
      if (carriers.get(p) !== bitAt(i)) toggles.push(carriers.bitPos(p));
    }
    stream.fill(0);
    return applyScanToggles(model, toggles);
  }

  // Rare restart-marker files: fall back to a full re-encode of the scan.
  const carriers = eligibleCoefficients(model);
  if (carriers.count < JPEG_MIN_CAPACITY) throw new StegoCapacityError(carriers.count);
  const reader = new StreamReader(stream.subarray(PAYLOAD_LEN));
  const positions = pickPositions(reader, carriers.count, PAYLOAD_BITS);
  for (let i = 0; i < PAYLOAD_BITS; i++) carriers.setLsb(positions[i]!, bitAt(i));
  stream.fill(0);
  return encodeJpeg(model);
}

/**
 * Recover a key block hidden in a baseline JPEG's coefficients, or null when the
 * password is wrong / the image carries no key (indistinguishable). A cover that
 * is not a decodable baseline JPEG also returns null.
 */
export async function extractKeyBlockStegoJpeg(
  jpegBytes: Uint8Array,
  password: string,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<Uint8Array | null> {
  let model: JpegModel;
  try {
    model = decodeJpeg(jpegBytes);
  } catch {
    return null; // not a baseline JPEG → no key here
  }
  const carriers = eligibleCoefficients(model);
  if (carriers.count < JPEG_MIN_CAPACITY) return null;

  const fingerprint = await coverFingerprintJpeg(model);
  const stream = await keystream(password, streamLen(), params, fingerprint);
  const pad = stream.subarray(0, PAYLOAD_LEN);
  const reader = new StreamReader(stream.subarray(PAYLOAD_LEN));
  const positions = pickPositions(reader, carriers.count, PAYLOAD_BITS);

  const out = new Uint8Array(PAYLOAD_LEN);
  for (let i = 0; i < PAYLOAD_BITS; i++) {
    if (carriers.get(positions[i]!)) out[i >> 3]! |= 1 << (7 - (i & 7));
  }
  for (let j = 0; j < PAYLOAD_LEN; j++) out[j]! ^= pad[j]!;
  stream.fill(0);

  return isSerializedKeyBlock(out) ? out : null;
}

// --- Variable-length payload stego (Gallery Mode, SPEC §9) --------------------
//
// The key-block paths above hide a fixed 92-byte block, whiten it, and validate
// a magic on extraction. Gallery Mode instead hides an arbitrary-length, already
// authenticated slot (a sealed fragment or a random decoy), so these variants:
//   - take a raw 32-byte position seed (the caller derives it once via Argon2id
//     + HKDF; there is no per-image Argon2 cost),
//   - do NOT whiten (the slot bytes are already uniform — GCM output or random),
//   - do NOT check any magic (the caller authenticates via the AEAD tag).
// Everything else — keyed position selection, the |coef|≥2 invariant, byte-exact
// same-size JPEG output — is shared with the key-block paths.

/** Fixed application salt for the gallery key derivation. ASCII "StegoShard-gllry" (16 bytes). */
export const GALLERY_SALT = Uint8Array.from([
  0x53, 0x74, 0x65, 0x67, 0x6f, 0x53, 0x68, 0x61, 0x72, 0x64, 0x2d, 0x67, 0x6c, 0x6c, 0x72, 0x79,
]);

/**
 * Keystream length that comfortably covers `payloadBits` distinct position draws
 * (4 bytes each) plus rejection-sampling and collision slack. The gallery keeps
 * carriers sparse (capacity ≫ payloadBits), so collisions are rare and this is
 * generous.
 */
function positionStreamLen(payloadBits: number): number {
  return payloadBits * 8 + 4096;
}

/**
 * Embed `data` into an RGBA buffer in place at seed-derived LSBs (no whitening).
 * `margin` requires the carrier count to exceed the payload by that factor — keeps
 * embedding sparse AND guarantees `pickPositions` never drains the keystream.
 */
export async function embedBytesStegoRgba(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  data: Uint8Array,
  seed: Uint8Array,
  margin = 1,
): Promise<void> {
  const capacity = capacityBits(width, height);
  const payloadBits = data.length * 8;
  if (capacity < payloadBits * margin) throw new StegoCapacityError(capacity);

  const stream = await keystreamFromSeed(seed, positionStreamLen(payloadBits));
  const positions = pickPositions(new StreamReader(stream), capacity, payloadBits);
  for (let i = 0; i < payloadBits; i++) {
    const bit = (data[i >> 3]! >> (7 - (i & 7))) & 1;
    const byteIndex = channelByte(positions[i]!);
    rgba[byteIndex] = (rgba[byteIndex]! & 0xfe) | bit;
  }
  stream.fill(0);
}

/**
 * Extract `length` bytes from an RGBA buffer at seed-derived LSBs. Returns null if
 * the carrier count is below `length*8*margin` — the same threshold embedding used,
 * so a real carrier always clears it and a too-small image is skipped (never drains
 * the keystream).
 */
export async function extractBytesStegoRgba(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  seed: Uint8Array,
  length: number,
  margin = 1,
): Promise<Uint8Array | null> {
  const capacity = capacityBits(width, height);
  const payloadBits = length * 8;
  if (capacity < payloadBits * margin) return null;

  const stream = await keystreamFromSeed(seed, positionStreamLen(payloadBits));
  const positions = pickPositions(new StreamReader(stream), capacity, payloadBits);
  const out = new Uint8Array(length);
  for (let i = 0; i < payloadBits; i++) {
    if (rgba[channelByte(positions[i]!)]! & 1) out[i >> 3]! |= 1 << (7 - (i & 7));
  }
  stream.fill(0);
  return out;
}

/** Eligible-carrier count of a baseline JPEG (|coef|≥2 AC coeffs), or 0 if undecodable. */
export function jpegStegoCapacityBits(jpegBytes: Uint8Array): number {
  try {
    return eligibleCoefficients(decodeJpeg(jpegBytes)).count;
  } catch {
    return 0;
  }
}

/**
 * Embed `data` into a baseline JPEG's DCT coefficients (no whitening); returns new
 * bytes. `margin` requires the eligible-carrier count to exceed the payload by that
 * factor (sparse embedding; also bounds `pickPositions`' keystream use).
 */
export async function embedBytesStegoJpeg(
  jpegBytes: Uint8Array,
  data: Uint8Array,
  seed: Uint8Array,
  margin = 1,
): Promise<Uint8Array> {
  const model = decodeJpeg(jpegBytes); // throws JpegUnsupportedError if not baseline
  const payloadBits = data.length * 8;
  const bitAt = (i: number): number => (data[i >> 3]! >> (7 - (i & 7))) & 1;
  const stream = await keystreamFromSeed(seed, positionStreamLen(payloadBits));

  if (model.restartInterval === 0) {
    const carriers = eligibleInPlace(model);
    if (carriers.count < payloadBits * margin) throw new StegoCapacityError(carriers.count);
    const positions = pickPositions(new StreamReader(stream), carriers.count, payloadBits);
    const toggles: number[] = [];
    for (let i = 0; i < payloadBits; i++) {
      const p = positions[i]!;
      if (carriers.get(p) !== bitAt(i)) toggles.push(carriers.bitPos(p));
    }
    stream.fill(0);
    return applyScanToggles(model, toggles);
  }

  const carriers = eligibleCoefficients(model);
  if (carriers.count < payloadBits * margin) throw new StegoCapacityError(carriers.count);
  const positions = pickPositions(new StreamReader(stream), carriers.count, payloadBits);
  for (let i = 0; i < payloadBits; i++) carriers.setLsb(positions[i]!, bitAt(i));
  stream.fill(0);
  return encodeJpeg(model);
}

/**
 * Extract `length` bytes from a baseline JPEG's coefficients. Returns null if
 * undecodable or if the carrier count is below `length*8*margin` (same threshold
 * as embedding, so real carriers pass and undersized images are skipped safely).
 */
export async function extractBytesStegoJpeg(
  jpegBytes: Uint8Array,
  seed: Uint8Array,
  length: number,
  margin = 1,
): Promise<Uint8Array | null> {
  let model: JpegModel;
  try {
    model = decodeJpeg(jpegBytes);
  } catch {
    return null;
  }
  const carriers = eligibleCoefficients(model);
  const payloadBits = length * 8;
  if (carriers.count < payloadBits * margin) return null;

  const stream = await keystreamFromSeed(seed, positionStreamLen(payloadBits));
  const positions = pickPositions(new StreamReader(stream), carriers.count, payloadBits);
  const out = new Uint8Array(length);
  for (let i = 0; i < payloadBits; i++) {
    if (carriers.get(positions[i]!)) out[i >> 3]! |= 1 << (7 - (i & 7));
  }
  stream.fill(0);
  return out;
}
