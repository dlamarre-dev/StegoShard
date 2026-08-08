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

import { argon2id, createHMAC, createSHA256, type IHasher } from 'hash-wasm';
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

/**
 * Optional user-supplied entropy layer (SPEC: generation-side only).
 *
 * Some users do not want to trust the platform CSPRNG alone (a suspect hardware
 * RNG, a cloned VM, a browser they do not control). When they install a string
 * of their own — mashed keys, dice rolls — every draw becomes
 *
 *     output = getRandomValues() XOR HMAC-SHA256(K, counter)
 *
 * where K = HKDF(user string, session salt drawn from the CSPRNG). This is
 * belt-and-braces, never a replacement: WebCrypto is still consulted for every
 * single byte, so if the user's string is worthless ("aaaa", or nothing at all)
 * the output is exactly today's CSPRNG output, and if the CSPRNG is worthless
 * the output is still unpredictable to anyone who does not know the string.
 * Neither source can weaken the other — XOR with an independent stream can only
 * preserve or add uncertainty.
 *
 * It affects generation only. Nothing about it is stored, so a vault written
 * with extra entropy is read back with no extra entropy needed: the format and
 * the Python reference decoder are untouched.
 */
const USER_ENTROPY_INFO = new TextEncoder().encode('stegoshard/v1/user-entropy');

interface EntropyPool {
  /** hash-wasm HMAC instance: the factory is async, init/update/digest are sync
   *  — required, because `randomBytes` is synchronous by contract. */
  hmac: IHasher;
  /** Monotonic block counter; never repeats within a session. */
  counter: number;
  /** Leftover keystream bytes from the last block, so a 12-byte IV does not
   *  burn a whole block. */
  buf: Uint8Array;
  off: number;
}

let pool: EntropyPool | null = null;

/**
 * Install an extra entropy source for this session (expert option). Idempotent
 * in effect but not in state: calling it again re-seeds with a fresh session
 * salt. Passing an empty string clears the layer.
 */
export async function installUserEntropy(text: string): Promise<void> {
  // Tear down any previous layer first, so its leftover keystream bytes are
  // zeroized rather than orphaned on the heap when `pool` is overwritten below.
  clearUserEntropy();
  if (!text) return;
  // The session salt makes the keystream unique per install, so the same string
  // reused forever still never replays a keystream.
  const sessionSalt = randomBytes(32);
  const ikm = new TextEncoder().encode(text.normalize('NFC'));
  const key = await hkdf(ikm, USER_ENTROPY_INFO, 32, sessionSalt);
  const hmac = await createHMAC(createSHA256(), key);
  ikm.fill(0);
  key.fill(0);
  pool = { hmac, counter: 0, buf: new Uint8Array(0), off: 0 };
}

/** Drop the extra entropy layer; draws return to plain CSPRNG output. */
export function clearUserEntropy(): void {
  pool?.buf.fill(0);
  pool = null;
}

/** True when an extra entropy layer is installed for this session. */
export function hasUserEntropy(): boolean {
  return pool !== null;
}

/** Next keystream block: HMAC(K, u64be(counter++)). */
function keystreamBlock(p: EntropyPool): Uint8Array {
  const ctr = new Uint8Array(8);
  // counter is a JS number: safe up to 2^53 blocks — unreachable in a session.
  writeU32(ctr, 0, Math.floor(p.counter / 0x1_0000_0000));
  writeU32(ctr, 4, p.counter >>> 0);
  p.counter++;
  p.hmac.init();
  p.hmac.update(ctr);
  return p.hmac.digest('binary') as Uint8Array;
}

/** XOR the user keystream into freshly drawn CSPRNG bytes, in place. */
function mixUserEntropy(out: Uint8Array): void {
  const p = pool;
  if (!p) return;
  for (let i = 0; i < out.length; i++) {
    if (p.off >= p.buf.length) {
      p.buf.fill(0);
      p.buf = keystreamBlock(p);
      p.off = 0;
    }
    out[i]! ^= p.buf[p.off++]!;
  }
  if (p.off >= p.buf.length) {
    p.buf.fill(0);
    p.buf = new Uint8Array(0);
    p.off = 0;
  }
}

/**
 * Cryptographically secure random bytes. `getRandomValues` caps at 65536 bytes
 * per call, so larger requests (e.g. filling a dead region up to the .db bucket
 * ceiling, §10.4) are filled in windows. When the user has installed extra
 * entropy (see above), it is XORed in afterwards — the CSPRNG is consulted
 * either way, so this can never produce *less* randomness than before.
 */
export function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  const MAX = 65536;
  if (len <= MAX) {
    globalThis.crypto.getRandomValues(out);
  } else {
    for (let off = 0; off < len; off += MAX) {
      globalThis.crypto.getRandomValues(out.subarray(off, Math.min(off + MAX, len)));
    }
  }
  mixUserEntropy(out);
  return out;
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

/**
 * Generate a fresh, extractable DEK (needed so it can be wrapped). Built from
 * `randomBytes` rather than `subtle.generateKey` so that it goes through the
 * same single entropy tap as every other secret — including the optional
 * user-entropy layer, which `subtle.generateKey` would bypass. The §10 paths
 * already mint their DEKs this way (access.ts, vault.ts).
 */
export async function generateDEK(): Promise<CryptoKey> {
  const raw = randomBytes(DEK_LEN);
  const key = await subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, true, [
    'encrypt',
    'decrypt',
  ]);
  raw.fill(0); // zeroize the transient raw DEK
  return key;
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

/**
 * AES-GCM seal with a caller-supplied 12-byte nonce and additional authenticated
 * data (AAD). Returns `ciphertext || tag` (WebCrypto's combined form). Used by the
 * segmented binary format (STREAM), where the caller manages a strict per-chunk
 * nonce discipline — unlike `encryptBytes`, which picks a random IV. Keeping the
 * two on separate helpers ensures the random-IV and counter-nonce disciplines are
 * never accidentally crossed.
 */
export async function aeadSeal(
  key: CryptoKey,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  if (nonce.length !== IV_LEN) throw new RangeError('aead: bad nonce length');
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return new Uint8Array(ct);
}

/** AES-GCM open (verify + decrypt) for `aeadSeal`. Throws on a bad tag/AAD/nonce. */
export async function aeadOpen(
  key: CryptoKey,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  if (nonce.length !== IV_LEN) throw new RangeError('aead: bad nonce length');
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return new Uint8Array(pt);
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

// --- Access structures: key-slot array (SPEC §10.3) --------------------------
//
// On the gallery and .db paths a container carries a fixed array of SLOT_COUNT
// key slots over REGION_COUNT payload regions, instead of the single 92-byte
// "SSKY" key block above. Each live slot AES-GCM-wraps an INDEPENDENT per-region
// DEK plus the index of the region it unlocks; dead slots are indistinguishable
// CSPRNG. The array is magicless — the geometry is known from the decode
// entrypoint (a gallery decode / a `.db` variant), never read from a byte, so no
// field can distinguish a decoy container from a plain one (§10.2).

/** Slots and regions are fixed constants for ALL containers on the two paths. */
export const SLOT_COUNT = 4;
export const REGION_COUNT = 2;
/** Slot plaintext: dek[32] || region_index[1] || reserved[15] (zero on write). */
export const SLOT_PLAINTEXT_LEN = DEK_LEN + 1 + 15; // 48
const REGION_INDEX_OFF = DEK_LEN; // 32
/** Serialized slot: nonce[12] || AES-GCM(plaintext = 48) → ct[48]+tag[16] = 64. */
export const SLOT_SIZE = IV_LEN + SLOT_PLAINTEXT_LEN + GCM_TAG_LEN; // 76
export const SLOT_ARRAY_LEN = SLOT_COUNT * SLOT_SIZE; // 304
/** Per-vault salt for the slot KEK(s). Reuses the 16-byte salt convention. */
export const VAULT_SALT_LEN = SALT_LEN; // 16

const EMPTY_AAD = new Uint8Array(0);
const REGION_INFO_PREFIX = new TextEncoder().encode('stegoshard/vault/region');
const KEYFILE_KEK_INFO = new TextEncoder().encode('stegoshard/v1/keyfile-kek');
const SLOT_KEK_INFO = new TextEncoder().encode('stegoshard/v1/slot-kek');
/**
 * Length of the external key factor (the keyfile / stego secret) mixed into the
 * slot KEK on the multi-region paths. A fresh random 32-byte secret, delivered as
 * a `.key` file or hidden in a cover image — it looks like random bytes, unlike
 * the old serialized key block, which aids the deniability it serves.
 */
export const KEY_FACTOR_LEN = 32;

// --- Stego key-factor envelope (SSKF) ----------------------------------------
//
// When the external key factor is delivered by stego (hidden in a cover photo)
// rather than a raw `.key` file, it needs the same wrong-password-indistinguish-
// able self-check the 92-byte key block has: after de-whitening, a wrong password
// yields random bytes, so extraction must be able to tell "this is a factor" from
// "this is noise". A raw 32-byte factor has no such structure, so stego wraps it
// in a fixed, magic-framed envelope. (The `.key` file stays the bare 32 bytes —
// on disk a magic would be a distinguisher; under stego the whole envelope is
// whitened, so its structure never appears on the wire.)
const KEY_FACTOR_MAGIC = Uint8Array.from([0x53, 0x53, 0x4b, 0x46]); // "SSKF"
const KEY_FACTOR_BLOCK_VERSION = 1;
/** Fixed length of the SSKF envelope: magic(4) + version(1) + factor(32) = 37. */
export const KEY_FACTOR_BLOCK_LEN = KEY_FACTOR_MAGIC.length + 1 + KEY_FACTOR_LEN;

/** Wrap a raw 32-byte key factor in the fixed, self-validating SSKF envelope. */
export function serializeKeyFactorBlock(factor: Uint8Array): Uint8Array {
  if (factor.length !== KEY_FACTOR_LEN) throw new RangeError('key factor: bad length');
  return concatBytes(KEY_FACTOR_MAGIC, Uint8Array.of(KEY_FACTOR_BLOCK_VERSION), factor);
}

/**
 * Recover the 32-byte factor from an SSKF envelope, or null when the bytes are
 * not one (a wrong stego password de-whitens to noise → reported as "no factor
 * here", indistinguishable from a cover that never carried one).
 */
export function parseKeyFactorBlock(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length !== KEY_FACTOR_BLOCK_LEN) return null;
  for (let i = 0; i < KEY_FACTOR_MAGIC.length; i++) {
    if (bytes[i] !== KEY_FACTOR_MAGIC[i]) return null;
  }
  if (bytes[KEY_FACTOR_MAGIC.length] !== KEY_FACTOR_BLOCK_VERSION) return null;
  return bytes.slice(KEY_FACTOR_MAGIC.length + 1);
}

/** Import raw key bytes as a non-extractable AES-GCM key. */
export function importAesGcmKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Derive the raw KEK bytes (Argon2id output) from a password + per-vault salt.
 * Unlike `deriveKEK` (which imports and zeroizes), this hands back the 32 raw
 * bytes so a caller can both import an AES-GCM key AND feed them to `gateKek`
 * (SPEC §10.6.2) — running Argon2id exactly once per candidate. The caller MUST
 * zeroize the returned buffer.
 */
export async function deriveKekBytes(
  password: string,
  salt: Uint8Array,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<Uint8Array> {
  return (await argon2id({
    password: normalizePassword(password),
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memoryKiB,
    hashLength: DEK_LEN,
    outputType: 'binary',
  })) as Uint8Array;
}

/**
 * Derive the slot-array KEK from a password (Argon2id, run exactly once) plus an
 * OPTIONAL external key factor (a random keyfile / stego secret) mixed in via HKDF
 * for domain separation. With no factor this is the password-only ("embedded")
 * KEK. The slot KEK's Argon2 parameters are the frozen DEFAULT_ARGON2 and are NOT
 * stored in the container (like the gallery/stego keys) — the geometry carries no
 * cost field, so the decoder uses the same frozen cost.
 */
/**
 * The RAW base slot-KEK bytes: Argon2id(password, vault_salt) run ONCE, plus an
 * optional keyfile/stego factor mixed in via HKDF. The caller MUST zeroize the
 * returned buffer. Used both to import the ungated KEK and to feed `gateKek`
 * (SPEC §10.6.2), so Argon2id never runs more than once per unlock.
 */
export async function slotKekRaw(
  password: string,
  vaultSalt: Uint8Array,
  keyFactor: Uint8Array | null,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<Uint8Array> {
  const kekBytes = await deriveKekBytes(password, vaultSalt, params);
  if (!keyFactor) return kekBytes;
  const mixed = await hkdf(concatBytes(kekBytes, keyFactor), KEYFILE_KEK_INFO, DEK_LEN, vaultSalt);
  kekBytes.fill(0);
  return mixed;
}

export async function deriveSlotKek(
  password: string,
  vaultSalt: Uint8Array,
  keyFactor: Uint8Array | null,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<CryptoKey> {
  const raw = await slotKekRaw(password, vaultSalt, keyFactor, params);
  const key = await importAesGcmKey(raw);
  raw.fill(0);
  return key;
}

/**
 * Gate a base KEK on threshold material (SPEC §10.6.2): the slot KEK becomes
 * HKDF-SHA256(ikm = baseKek || secret, salt = vault_salt, info = "…/v1/slot-kek").
 * HKDF (not XOR) for domain separation and to avoid any algebraic relation between
 * the gated and ungated KEK. `secret` is the recovered Shamir S (§10.6.1).
 */
export async function gateKek(
  baseKek: Uint8Array,
  secret: Uint8Array,
  vaultSalt: Uint8Array,
): Promise<CryptoKey> {
  const gated = await hkdf(concatBytes(baseKek, secret), SLOT_KEK_INFO, DEK_LEN, vaultSalt);
  const key = await importAesGcmKey(gated);
  gated.fill(0);
  return key;
}

/**
 * Candidate slot KEKs for an unlock: the ungated KEK, plus — when threshold
 * material is supplied — the gated KEK, derived from the SAME single Argon2id
 * output. So a with-shares unlock adds only cheap HKDF over a without-shares one,
 * preserving the constant-work timing property (§10.3.1). Sub-threshold shares
 * yield a wrong `secret` → a wrong gated KEK → no slot opens (inability, §10.6.1).
 */
export async function slotKekCandidates(
  password: string,
  vaultSalt: Uint8Array,
  keyFactor: Uint8Array | null,
  secret: Uint8Array | null,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<CryptoKey[]> {
  // Argon2id runs EXACTLY ONCE; every candidate below is a cheap HKDF/import over
  // its output, so the constant-work timing property is Argon2-bound (§10.4).
  const kekBytes = await deriveKekBytes(password, vaultSalt, params);
  // Base KEKs to attempt: the password-only KEK, and — when a factor is supplied —
  // the factor-mixed KEK. BOTH are offered because a duress decoy slot (§10.9) is
  // sealed WITHOUT the factor while the real slot is sealed WITH it, and restore
  // presents the factor for either credential (it can't know which region a
  // credential opens, nor that a `.key`/cover sitting beside the vault is only for
  // the real region). Offering the no-factor base keeps the decoy openable even
  // when the factor is present. The extra base matches nothing in plain/Mode B (no
  // no-factor live slot exists there), so it is harmless; credential independence
  // (§10.9) guarantees the real and decoy KEKs never both match.
  const bases: Uint8Array[] = [kekBytes];
  if (keyFactor) {
    bases.push(await hkdf(concatBytes(kekBytes, keyFactor), KEYFILE_KEK_INFO, DEK_LEN, vaultSalt));
  }
  const candidates: CryptoKey[] = [];
  for (const base of bases) {
    candidates.push(await importAesGcmKey(base));
    if (secret) candidates.push(await gateKek(base, secret, vaultSalt));
  }
  for (const base of bases) base.fill(0);
  return candidates;
}

/**
 * Derive a per-region content key from that region's INDEPENDENT DEK. A distinct
 * `info` label per region gives domain separation even in the (single-real-region)
 * case where a DEK is not shared; `salt` is the region's own content salt. The
 * raw DEK never leaves this function. Frozen format; mirrored by the Python decoder.
 */
export async function deriveRegionKey(
  dek: Uint8Array,
  salt: Uint8Array,
  regionIndex: number,
): Promise<CryptoKey> {
  const info = concatBytes(REGION_INFO_PREFIX, Uint8Array.of(regionIndex));
  const cekBytes = await hkdf(dek, info, DEK_LEN, salt);
  const key = await importAesGcmKey(cekBytes);
  cekBytes.fill(0);
  return key;
}

/**
 * Seal one slot: nonce[12] || AES-GCM_kek(dek[32] || region_index[1] ||
 * reserved[15]). `region_index` is authenticated by the GCM tag, so an adversary
 * cannot redirect a slot to another region by editing the container (§10.3 rule 3).
 * The 12-byte nonce is caller-supplied (fresh per slot on write; explicit bytes
 * for deterministic test vectors).
 */
export async function serializeSlot(
  kek: CryptoKey,
  nonce: Uint8Array,
  dek: Uint8Array,
  regionIndex: number,
): Promise<Uint8Array> {
  if (nonce.length !== IV_LEN) throw new RangeError('slot: bad nonce length');
  if (dek.length !== DEK_LEN) throw new RangeError('slot: bad dek length');
  const pt = new Uint8Array(SLOT_PLAINTEXT_LEN); // reserved bytes stay zero
  pt.set(dek, 0);
  pt[REGION_INDEX_OFF] = regionIndex;
  const sealed = await aeadSeal(kek, nonce, pt, EMPTY_AAD);
  pt.fill(0); // zeroize the transient plaintext DEK
  return concatBytes(nonce, sealed);
}

/** A live slot to write: a KEK that wraps `dek`, which unlocks `regionIndex`. */
export interface SlotEntry {
  kek: CryptoKey;
  dek: Uint8Array;
  regionIndex: number;
}

/**
 * Build the fixed SLOT_ARRAY_LEN slot array. Live entries are sealed with fresh
 * CSPRNG nonces; the remaining slots are filled from the CSPRNG (a random 76-byte
 * block is indistinguishable from a live slot without the KEK); then ALL slots are
 * shuffled by an unbiased permutation, so slot position carries no meaning.
 */
export async function buildSlotArray(entries: SlotEntry[]): Promise<Uint8Array> {
  if (entries.length < 1 || entries.length > SLOT_COUNT) {
    throw new RangeError(`slot array: ${entries.length} live entries (want 1..${SLOT_COUNT})`);
  }
  const slots: Uint8Array[] = [];
  for (const e of entries) {
    if (e.regionIndex < 0 || e.regionIndex >= REGION_COUNT) {
      throw new RangeError(`slot: region index ${e.regionIndex} out of range`);
    }
    slots.push(await serializeSlot(e.kek, randomBytes(IV_LEN), e.dek, e.regionIndex));
  }
  while (slots.length < SLOT_COUNT) slots.push(randomBytes(SLOT_SIZE));
  secureShuffle(slots);
  return concatBytes(...slots);
}

/**
 * Try to open one 76-byte slot with a candidate KEK. Non-throwing: a GCM auth
 * failure (wrong KEK, or a dead/random slot) returns null. Validates the region
 * index. Returns the recovered independent DEK and its region index on success.
 */
export async function tryOpenSlot(
  kek: CryptoKey,
  slot: Uint8Array,
): Promise<{ dek: Uint8Array; regionIndex: number } | null> {
  if (slot.length !== SLOT_SIZE) return null;
  const nonce = slot.subarray(0, IV_LEN);
  const sealed = slot.subarray(IV_LEN);
  let pt: Uint8Array;
  try {
    pt = await aeadOpen(kek, nonce, sealed, EMPTY_AAD);
  } catch {
    return null;
  }
  if (pt.length !== SLOT_PLAINTEXT_LEN) {
    pt.fill(0);
    return null;
  }
  const regionIndex = pt[REGION_INDEX_OFF]!;
  if (regionIndex >= REGION_COUNT) {
    pt.fill(0);
    return null;
  }
  const dek = pt.slice(0, DEK_LEN);
  pt.fill(0);
  return { dek, regionIndex };
}

/**
 * Constant-work slot open (SPEC §10.3.1). Attempts EVERY candidate KEK against
 * EVERY slot with no early exit, so total work depends only on the number of
 * candidate KEKs — never on which slot matched or whether any did. A well-formed
 * container yields exactly one match; zero (wrong credential) and more than one
 * (malformed — fail closed) both surface as the single uniform `WrongPasswordError`,
 * leaking nothing about the cause, which slot index matched, or the region.
 */
export async function openSlotArray(
  slotArray: Uint8Array,
  candidateKeks: CryptoKey[],
): Promise<{ dek: Uint8Array; regionIndex: number }> {
  if (slotArray.length !== SLOT_ARRAY_LEN) throw new WrongPasswordError();
  let found: { dek: Uint8Array; regionIndex: number } | null = null;
  let matches = 0;
  for (const kek of candidateKeks) {
    for (let i = 0; i < SLOT_COUNT; i++) {
      const slot = slotArray.subarray(i * SLOT_SIZE, (i + 1) * SLOT_SIZE);
      const opened = await tryOpenSlot(kek, slot); // never throws; no early exit
      if (opened) {
        matches++;
        if (!found) found = opened;
      }
    }
  }
  if (matches !== 1 || !found) throw new WrongPasswordError();
  return found;
}

/**
 * Unlock a slot array from a password: derive one KEK (Argon2id runs ONCE) over
 * the shared per-vault salt and open the array. Salt reuse across slots is sound —
 * the per-vault CSPRNG salt already defeats cross-vault precomputation, and
 * distinct passwords yield distinct KEKs regardless. Any failure maps to the
 * uniform `WrongPasswordError`. For the threshold (Mode B) path a caller instead
 * derives the candidate list itself (via `deriveKekBytes` + `gateKek`) and calls
 * `openSlotArray` directly, so Argon2id still runs exactly once.
 */
export async function unlockSlotArray(
  slotArray: Uint8Array,
  vaultSalt: Uint8Array,
  password: string,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<{ dek: Uint8Array; regionIndex: number }> {
  let kekBytes: Uint8Array;
  try {
    kekBytes = await deriveKekBytes(password, vaultSalt, params);
  } catch {
    throw new WrongPasswordError();
  }
  try {
    const kek = await importAesGcmKey(kekBytes);
    return await openSlotArray(slotArray, [kek]);
  } finally {
    kekBytes.fill(0);
  }
}

/**
 * Unbiased in-place Fisher–Yates shuffle using rejection-sampled indices from the
 * CSPRNG, so live-slot position is uniform over authorings (a biased shuffle would
 * leak the live slot's location — §10.10 slot-randomness test).
 */
export function secureShuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomIntBelow(i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}

/** Uniform integer in [0, n) via rejection sampling over a u32 (no modulo bias). */
function randomIntBelow(n: number): number {
  if (n <= 0) throw new RangeError('randomIntBelow: n must be positive');
  if (n === 1) return 0;
  const limit = Math.floor(0x1_0000_0000 / n) * n; // largest multiple of n ≤ 2^32
  for (;;) {
    const b = randomBytes(4);
    const v = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
    if (v < limit) return v % n;
  }
}
