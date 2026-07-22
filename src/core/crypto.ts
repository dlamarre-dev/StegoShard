/**
 * Cryptographic core: a password-protected KEK/DEK scheme (plan §4).
 *
 *  - DEK (Data Encryption Key): a random AES-GCM-256 key that encrypts the
 *    content. Never stored in the clear.
 *  - KEK (Key Encryption Key): derived from the user's password with Argon2id
 *    (+ a random salt). Wraps/unwraps the DEK.
 *
 * The stored/exported artifact is the *wrapped DEK block*: it is useless without
 * the password. Recovery therefore needs the password AND this block (embedded
 * in the images, a .key file, or a stego image — see plan §4).
 *
 * No home-grown crypto: AES-GCM comes from WebCrypto, Argon2id from the audited
 * hash-wasm WASM build. All parameters here are frozen in SPEC.md so the Python
 * reference decoder can reproduce them.
 */

import { argon2id } from 'hash-wasm';
import { concatBytes, readU16, readU32, writeU16, writeU32 } from './bytes';

const subtle = globalThis.crypto.subtle;

export const SALT_LEN = 16;
export const IV_LEN = 12; // AES-GCM standard nonce length
export const DEK_LEN = 32; // AES-256
export const GCM_TAG_LEN = 16;
/**
 * Fixed serialized size of a key block: magic(4) + ver(1) + iterations(4) +
 * memoryKiB(4) + parallelism(1) + salt(16) + iv(12) + wrappedLen(2) +
 * wrappedDEK(DEK_LEN + GCM tag). Constant because all fields are fixed-width.
 */
export const KEY_BLOCK_LEN = 4 + 1 + 4 + 4 + 1 + SALT_LEN + IV_LEN + 2 + DEK_LEN + GCM_TAG_LEN;

/** Argon2id cost parameters (hashLength is fixed at 32 bytes = the KEK size). */
export interface Argon2Params {
  iterations: number;
  memoryKiB: number;
  parallelism: number;
}

/**
 * Sane bounds for Argon2id parameters. These come from an *untrusted* key block
 * (it travels inside the images, or in a supplied .key file) and are used to run
 * Argon2id BEFORE any authentication succeeds, so unbounded values are a
 * memory-exhaustion DoS. Reject anything outside a generous-but-safe range.
 */
const ARGON2_LIMITS = {
  iterations: { min: 1, max: 16 },
  memoryKiB: { min: 8, max: 1024 * 1024 }, // ≤ 1 GiB
  parallelism: { min: 1, max: 4 },
} as const;

/** Validate Argon2id parameters against ARGON2_LIMITS; throw on anything absurd. */
export function validateArgon2Params(p: Argon2Params): void {
  for (const key of ['iterations', 'memoryKiB', 'parallelism'] as const) {
    const value = p[key];
    const { min, max } = ARGON2_LIMITS[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`key block: Argon2id ${key} out of range (${value})`);
    }
  }
}

/**
 * Production defaults. Calibrated toward a ~1–2 s unlock on typical desktop
 * hardware while staying viable in a browser tab and on mobile. 256 MiB × t=4
 * raises the cost of an offline password search several-fold over the old
 * 64 MiB × t=3 baseline. Frozen in SPEC.md. Tests override these with cheaper
 * values, and the Python reference decoder mirrors them for the stego/gallery
 * layer (whose cost is not stored — see python/stegoshard/stego.py).
 */
export const DEFAULT_ARGON2: Argon2Params = {
  iterations: 4,
  memoryKiB: 256 * 1024, // 256 MiB
  parallelism: 1,
};

/** Cryptographically secure random bytes. */
export function randomBytes(len: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(len));
}

/**
 * Normalize a password to Unicode NFC before it is ever hashed. Different
 * platforms/keyboards can emit the same text as different byte sequences
 * (precomposed "é" vs. "e" + combining accent); NFC makes the KEK depend on the
 * *text*, not on how it happened to be encoded, so a vault created on one device
 * unlocks on another. Frozen in SPEC.md — both the extension and the Python
 * reference decoder must normalize identically.
 */
export function normalizePassword(password: string): string {
  return password.normalize('NFC');
}

/** Derive the KEK (an AES-GCM key) from a password and salt via Argon2id. */
export async function deriveKEK(
  password: string,
  salt: Uint8Array,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<CryptoKey> {
  const raw = await argon2id({
    password: normalizePassword(password),
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memoryKiB,
    hashLength: DEK_LEN,
    outputType: 'binary',
  });
  const key = await subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  raw.fill(0); // zeroize the transient KEK bytes
  return key;
}

/** Generate a fresh, extractable DEK (needed so it can be wrapped). */
export async function generateDEK(): Promise<CryptoKey> {
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** Export a DEK to raw bytes (for holding it in volatile session storage).
 *  Returns an independent copy so a caller that zeroizes it can never alias
 *  live key material (see the note in wrapDEK). */
export async function exportDekRaw(dek: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array((await subtle.exportKey('raw', dek)).slice(0));
}

/** Re-import a raw DEK exported by exportDekRaw. */
export function importDek(raw: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, true, [
    'encrypt',
    'decrypt',
  ]);
}

/** AES-GCM encrypt. Returns iv + ciphertext(+tag) separately. */
export async function encryptBytes(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  const iv = randomBytes(IV_LEN);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return { iv, ciphertext: new Uint8Array(ct) };
}

/** AES-GCM decrypt. Throws (OperationError) on a wrong key or tampering. */
export async function decryptBytes(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  // GCM accepts any nonzero IV length, but this format only ever produces
  // 12-byte IVs — reject anything else instead of silently diverging.
  if (iv.length !== IV_LEN) throw new RangeError('decrypt: bad iv length');
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return new Uint8Array(pt);
}

/**
 * HKDF-SHA256 (RFC 5869) key derivation. Used to split one high-entropy secret
 * (e.g. an Argon2id output) into several independent, domain-separated subkeys
 * via distinct `info` labels — safer than reusing the same bytes for two jobs.
 * `salt` defaults to empty (the IKM is already high-entropy). Reproduced by the
 * Python reference decoder, so it is part of the frozen format.
 */
export async function hkdf(
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
  salt: Uint8Array = new Uint8Array(0),
): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** Length of the random per-export content salt stored in the vault blob (§6). */
export const CONTENT_SALT_LEN = 16;
const CONTENT_INFO = new TextEncoder().encode('stegoshard/vault/content');

/**
 * Derive a per-export content-encryption key (CEK) from the DEK via HKDF-SHA256.
 * The DEK is reused across vaults (the keystore holds one), which alone would
 * make the AES-GCM random-IV collision bound accumulate across every export
 * under that key. A fresh random `salt` per export gives each export its own CEK,
 * so the (key, IV) space is per-export and the bound resets — one export is one
 * message. The raw DEK never leaves this function. Frozen format (SPEC §6);
 * mirrored by the Python reference decoder.
 */
export async function deriveContentKey(dek: CryptoKey, salt: Uint8Array): Promise<CryptoKey> {
  const rawDek = new Uint8Array((await subtle.exportKey('raw', dek)).slice(0));
  const cekBytes = await hkdf(rawDek, CONTENT_INFO, DEK_LEN, salt);
  rawDek.fill(0); // zeroize the transient raw DEK copy
  const key = await subtle.importKey('raw', cekBytes as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  cekBytes.fill(0); // zeroize the transient raw CEK bytes (key is now non-extractable)
  return key;
}

/** Wrap (encrypt) the DEK with the KEK. */
export async function wrapDEK(
  dek: CryptoKey,
  kek: CryptoKey,
): Promise<{ iv: Uint8Array; wrapped: Uint8Array }> {
  // Copy into a private buffer before zeroizing. Per the Web Crypto spec
  // exportKey returns a fresh ArrayBuffer, but some runtimes (observed under
  // Deno) hand back memory that still aliases the live CryptoKey — filling that
  // would corrupt the DEK itself. `.slice()` guarantees an independent copy, so
  // the zeroization can never scribble on key material.
  const rawDek = (await subtle.exportKey('raw', dek)).slice(0);
  const view = new Uint8Array(rawDek);
  const { iv, ciphertext } = await encryptBytes(kek, view);
  view.fill(0); // zeroize the transient plaintext DEK (our private copy)
  return { iv, wrapped: ciphertext };
}

/** Unwrap (decrypt) the DEK with the KEK. Throws on a wrong password. */
export async function unwrapDEK(
  wrapped: Uint8Array,
  iv: Uint8Array,
  kek: CryptoKey,
): Promise<CryptoKey> {
  const rawDek = await decryptBytes(kek, iv, wrapped);
  const key = await subtle.importKey('raw', rawDek as BufferSource, { name: 'AES-GCM' }, true, [
    'encrypt',
    'decrypt',
  ]);
  rawDek.fill(0); // zeroize the transient plaintext DEK
  return key;
}

// --- Wrapped DEK block: self-contained, password-protected key artifact ------

const KEY_MAGIC = Uint8Array.from([0x53, 0x53, 0x4b, 0x59]); // "SSKY" (StegoShard KeY)
const KEY_BLOCK_VERSION = 1;

export interface KeyBlock {
  salt: Uint8Array;
  params: Argon2Params;
  iv: Uint8Array;
  wrapped: Uint8Array;
}

/**
 * Serialize the wrapped DEK block:
 *   [ MAGIC 4 ][ VER 1 ][ salt 16 ][ iterations u32 ][ memoryKiB u32 ]
 *   [ parallelism u8 ][ iv 12 ][ wrappedLen u16 ][ wrapped ]
 */
export function serializeKeyBlock(block: KeyBlock): Uint8Array {
  if (block.salt.length !== SALT_LEN) throw new RangeError('key block: bad salt length');
  if (block.iv.length !== IV_LEN) throw new RangeError('key block: bad iv length');
  const head = new Uint8Array(1 + 4 + 4 + 1);
  head[0] = KEY_BLOCK_VERSION;
  writeU32(head, 1, block.params.iterations);
  writeU32(head, 5, block.params.memoryKiB);
  head[9] = block.params.parallelism;
  const lenField = new Uint8Array(2);
  writeU16(lenField, 0, block.wrapped.length);
  return concatBytes(KEY_MAGIC, head, block.salt, block.iv, lenField, block.wrapped);
}

/**
 * Cheap structural check: do these bytes begin like a serialized key block
 * (magic + supported version) and have exactly the fixed length? Used by the
 * stego layer to decide, without throwing, whether a de-whitened candidate is
 * a real key block or random noise from a wrong password.
 */
export function isSerializedKeyBlock(bytes: Uint8Array): boolean {
  if (bytes.length !== KEY_BLOCK_LEN) return false;
  for (let i = 0; i < KEY_MAGIC.length; i++) {
    if (bytes[i] !== KEY_MAGIC[i]) return false;
  }
  return bytes[KEY_MAGIC.length] === KEY_BLOCK_VERSION;
}

/** Parse a wrapped DEK block produced by serializeKeyBlock. */
export function parseKeyBlock(bytes: Uint8Array): KeyBlock {
  // Fixed prefix = magic(4)+ver(1)+iter(4)+mem(4)+par(1)+salt(16)+iv(12)+len(2).
  if (bytes.length < 44) throw new Error('key block: too short');
  let o = 0;
  for (let i = 0; i < KEY_MAGIC.length; i++) {
    if (bytes[o + i] !== KEY_MAGIC[i]) throw new Error('key block: bad magic');
  }
  o += KEY_MAGIC.length;
  const version = bytes[o];
  o += 1;
  if (version !== KEY_BLOCK_VERSION) throw new Error(`key block: unsupported version ${version}`);
  const iterations = readU32(bytes, o);
  o += 4;
  const memoryKiB = readU32(bytes, o);
  o += 4;
  const parallelism = bytes[o]!;
  o += 1;
  const salt = bytes.slice(o, o + SALT_LEN);
  o += SALT_LEN;
  const iv = bytes.slice(o, o + IV_LEN);
  o += IV_LEN;
  const wrappedLen = readU16(bytes, o);
  o += 2;
  const wrapped = bytes.slice(o, o + wrappedLen);
  if (wrapped.length !== wrappedLen) throw new Error('key block: truncated');
  // Enforce a canonical encoding: exactly one byte sequence parses to a given
  // block. Trailing bytes would otherwise ride along unauthenticated.
  if (bytes.length !== o + wrappedLen) throw new Error('key block: trailing bytes');
  const params = { iterations, memoryKiB, parallelism };
  validateArgon2Params(params); // reject attacker-controlled DoS parameters
  return { salt, params, iv, wrapped };
}

// --- High-level helpers ------------------------------------------------------

/** Create a new vault key: fresh DEK, wrapped by a KEK derived from `password`. */
export async function createKeyBlock(
  password: string,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<{ dek: CryptoKey; block: KeyBlock }> {
  const salt = randomBytes(SALT_LEN);
  const kek = await deriveKEK(password, salt, params);
  const dek = await generateDEK();
  const { iv, wrapped } = await wrapDEK(dek, kek);
  return { dek, block: { salt, params, iv, wrapped } };
}

/** Thrown when the DEK cannot be unwrapped — almost always a wrong password. */
export class WrongPasswordError extends Error {
  constructor() {
    super('wrong password');
    this.name = 'WrongPasswordError';
  }
}

/** Recover the DEK from a key block and password. Throws on a wrong password. */
export async function unlockKeyBlock(block: KeyBlock, password: string): Promise<CryptoKey> {
  try {
    // Derivation failures (e.g. the empty password, which Argon2 here rejects
    // and which therefore can never have created a block) and GCM auth
    // failures both surface as the same typed error: nothing about the cause
    // is leaked, and callers get one uniform "wrong password" signal.
    const kek = await deriveKEK(password, block.salt, block.params);
    return await unwrapDEK(block.wrapped, block.iv, kek);
  } catch {
    throw new WrongPasswordError();
  }
}

/** Change the password: re-wrap the *same* DEK under a new password. */
export async function rewrapKeyBlock(
  block: KeyBlock,
  oldPassword: string,
  newPassword: string,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<KeyBlock> {
  const dek = await unlockKeyBlock(block, oldPassword);
  const salt = randomBytes(SALT_LEN);
  const kek = await deriveKEK(newPassword, salt, params);
  const { iv, wrapped } = await wrapDEK(dek, kek);
  return { salt, params, iv, wrapped };
}
