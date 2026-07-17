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
  KEY_BLOCK_LEN,
  isSerializedKeyBlock,
  normalizePassword,
} from './crypto';
import { decode as decodeJpeg, encode as encodeJpeg, eligibleCoefficients } from './jpeg-coeff';

const subtle = globalThis.crypto.subtle;

/**
 * Fixed application salt for the stego key derivation. Unlike the key block's
 * own random salt, this cannot be stored in the image (that would be a
 * detectable structure), so it is a constant — acceptable because the stego
 * layer is defense-in-depth for hiding, not the vault's confidentiality (that
 * is the password-wrapped key block). "IVKY-stego-v1" padded to 16 bytes.
 */
export const STEGO_SALT = Uint8Array.from([
  0x49, 0x56, 0x4b, 0x59, 0x2d, 0x73, 0x74, 0x65, 0x67, 0x6f, 0x2d, 0x76, 0x31, 0x00, 0x00, 0x00,
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

/** Deterministic keystream of `len` bytes from the password via Argon2id + AES-CTR. */
async function keystream(password: string, len: number, params: Argon2Params): Promise<Uint8Array> {
  const seed = (await argon2id({
    password: normalizePassword(password),
    salt: STEGO_SALT,
    iterations: params.iterations,
    memorySize: params.memoryKiB,
    parallelism: params.parallelism,
    hashLength: 32,
    outputType: 'binary',
  })) as Uint8Array;
  const key = await subtle.importKey('raw', seed as BufferSource, { name: 'AES-CTR' }, false, [
    'encrypt',
  ]);
  seed.fill(0);
  const stream = new Uint8Array(
    await subtle.encrypt(
      { name: 'AES-CTR', counter: new Uint8Array(16), length: 64 },
      key,
      new Uint8Array(len),
    ),
  );
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

  const stream = await keystream(password, streamLen(), params);
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

  const stream = await keystream(password, streamLen(), params);
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
  const carriers = eligibleCoefficients(model);
  if (carriers.count < JPEG_MIN_CAPACITY) throw new StegoCapacityError(carriers.count);

  const stream = await keystream(password, streamLen(), params);
  const pad = stream.subarray(0, PAYLOAD_LEN);
  const reader = new StreamReader(stream.subarray(PAYLOAD_LEN));
  const positions = pickPositions(reader, carriers.count, PAYLOAD_BITS);

  for (let i = 0; i < PAYLOAD_BITS; i++) {
    const bit = ((keyBlock[i >> 3]! ^ pad[i >> 3]!) >> (7 - (i & 7))) & 1;
    carriers.setLsb(positions[i]!, bit);
  }
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
  let carriers: ReturnType<typeof eligibleCoefficients>;
  try {
    carriers = eligibleCoefficients(decodeJpeg(jpegBytes));
  } catch {
    return null; // not a baseline JPEG → no key here
  }
  if (carriers.count < JPEG_MIN_CAPACITY) return null;

  const stream = await keystream(password, streamLen(), params);
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
