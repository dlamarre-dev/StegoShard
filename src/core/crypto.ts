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
 * Production defaults, calibrated toward ~0.25–1 s on typical hardware
 * (plan §4). Frozen in SPEC.md. Tests override these with cheaper values.
 */
export const DEFAULT_ARGON2: Argon2Params = {
  iterations: 3,
  memoryKiB: 64 * 1024, // 64 MiB
  parallelism: 1,
};

/** Cryptographically secure random bytes. */
export function randomBytes(len: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(len));
}

/** Derive the KEK (an AES-GCM key) from a password and salt via Argon2id. */
export async function deriveKEK(
  password: string,
  salt: Uint8Array,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<CryptoKey> {
  const raw = await argon2id({
    password,
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

/** Export a DEK to raw bytes (for holding it in volatile session storage). */
export async function exportDekRaw(dek: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await subtle.exportKey('raw', dek));
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
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return new Uint8Array(pt);
}

/** Wrap (encrypt) the DEK with the KEK. */
export async function wrapDEK(
  dek: CryptoKey,
  kek: CryptoKey,
): Promise<{ iv: Uint8Array; wrapped: Uint8Array }> {
  const rawDek = new Uint8Array(await subtle.exportKey('raw', dek));
  const { iv, ciphertext } = await encryptBytes(kek, rawDek);
  rawDek.fill(0); // zeroize the transient plaintext DEK
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

const KEY_MAGIC = Uint8Array.from([0x49, 0x56, 0x4b, 0x59]); // "IVKY"
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
  const kek = await deriveKEK(password, block.salt, block.params);
  try {
    // AES-GCM authenticates the wrapped DEK, so a wrong password fails here.
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
