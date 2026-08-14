/**
 * Generate frozen cross-implementation crypto test vectors.
 *
 * Every vector is produced from FIXED inputs (passwords, salts, IVs, DEKs), so
 * the outputs are fully deterministic. The committed JSON is the contract:
 *
 *  - the TypeScript suite (src/core/crypto.vectors.test.ts) must reproduce
 *    every output bit-for-bit (regression against hash-wasm / WebCrypto drift);
 *  - the Python suite (python/tests/test_vectors.py) must reproduce them with
 *    completely independent implementations (argon2-cffi binds the official
 *    phc-winner-argon2 C code; `cryptography` wraps OpenSSL), proving the two
 *    stacks agree on Argon2id and AES-256-GCM at the bit level.
 *
 * Run with: npx tsx scripts/gen-vectors.ts   (rewrites tests/vectors/crypto-vectors.json)
 *
 * Regenerating should be a rare, deliberate act (e.g. adding a vector class):
 * the whole point of freezing the file is to catch either stack drifting.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argon2id } from 'hash-wasm';
import { toHex, writeU16, writeU32, writeU64, concatBytes } from '../src/core/bytes';
import { gfAdd, gfMul, gfInv, gfDiv, FIELD_POLY, FIELD_GENERATOR } from '../src/core/gf256';
import {
  CONTENT_SALT_LEN,
  hkdf,
  normalizePassword,
  serializeKeyBlock,
  type Argon2Params,
} from '../src/core/crypto';
import { buildPayload } from '../src/core/payload';
import { rsEncode } from '../src/core/reed-solomon';

const subtle = globalThis.crypto.subtle;

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Deterministic patterned bytes (NOT random; these are fixed test inputs). */
function pattern(len: number, seed: number): Uint8Array {
  let s = seed >>> 0;
  return Uint8Array.from({ length: len }, () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 24) & 0xff;
  });
}

async function kekHex(password: string, salt: Uint8Array, p: Argon2Params): Promise<string> {
  return argon2id({
    // Mirror deriveKEK: the KEK depends on NFC-normalized text, not raw bytes.
    password: normalizePassword(password),
    salt,
    parallelism: p.parallelism,
    iterations: p.iterations,
    memorySize: p.memoryKiB,
    hashLength: 32,
    outputType: 'hex',
  });
}

async function gcmEncrypt(keyHex: string, ivHex: string, ptHex: string): Promise<string> {
  const key = await subtle.importKey(
    'raw',
    fromHex(keyHex) as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: fromHex(ivHex) as BufferSource },
    key,
    fromHex(ptHex) as BufferSource,
  );
  return toHex(new Uint8Array(ct));
}

// ---- Argon2id KEK derivation vectors ----------------------------------------

interface Argon2Vector {
  name: string;
  password: string;
  saltHex: string;
  iterations: number;
  memoryKiB: number;
  parallelism: number;
  kekHex: string;
}

const ARGON2_CASES: Omit<Argon2Vector, 'kekHex'>[] = [
  {
    name: 'basic-ascii',
    password: 'correct horse battery staple',
    saltHex: '000102030405060708090a0b0c0d0e0f',
    iterations: 1,
    memoryKiB: 256,
    parallelism: 1,
  },
  {
    name: 'varied-params',
    password: 'password',
    saltHex: 'f0e1d2c3b4a5968778695a4b3c2d1e0f',
    iterations: 3,
    memoryKiB: 1024,
    parallelism: 2,
  },
  {
    name: 'max-parallelism',
    password: 'p4ssw0rd!',
    saltHex: 'deadbeefdeadbeefdeadbeefdeadbeef',
    iterations: 2,
    memoryKiB: 512,
    parallelism: 4,
  },
  {
    // Precomposed (NFC) spelling. Shares salt/params with the NFD case below:
    // after NFC normalization both derive the SAME KEK (SPEC §5.1).
    name: 'unicode-nfc',
    password: 'pâsswörd☕',
    saltHex: '101112131415161718191a1b1c1d1e1f',
    iterations: 1,
    memoryKiB: 256,
    parallelism: 1,
  },
  {
    // Same rendered text as unicode-nfc but typed decomposed (a + U+0302,
    // o + U+0308): different raw UTF-8, but normalization makes the KEK match.
    name: 'unicode-nfd',
    password: 'pâsswörd☕',
    saltHex: '101112131415161718191a1b1c1d1e1f',
    iterations: 1,
    memoryKiB: 256,
    parallelism: 1,
  },
  {
    name: 'emoji',
    password: '\u{1f511}\u{1f40e}\u{1f50b}\u{1f4ce}',
    saltHex: '202122232425262728292a2b2c2d2e2f',
    iterations: 1,
    memoryKiB: 256,
    parallelism: 1,
  },
  {
    name: 'embedded-nul',
    password: 'pa\u0000ss',
    saltHex: '303132333435363738393a3b3c3d3e3f',
    iterations: 1,
    memoryKiB: 256,
    parallelism: 1,
  },
  {
    name: 'long-128-chars',
    password: 'x'.repeat(128),
    saltHex: '404142434445464748494a4b4c4d4e4f',
    iterations: 1,
    memoryKiB: 256,
    parallelism: 1,
  },
  {
    name: 'empty-password',
    password: '',
    saltHex: '505152535455565758595a5b5c5d5e5f',
    iterations: 1,
    memoryKiB: 256,
    parallelism: 1,
  },
];

// ---- AES-256-GCM vectors (ciphertext includes the 16-byte tag) ---------------

interface GcmVector {
  name: string;
  keyHex: string;
  ivHex: string;
  plaintextHex: string;
  ciphertextHex: string;
}

const GCM_CASES: Omit<GcmVector, 'ciphertextHex'>[] = [
  {
    name: 'empty-plaintext',
    keyHex: toHex(pattern(32, 1)),
    ivHex: toHex(pattern(12, 2)),
    plaintextHex: '',
  },
  {
    name: 'single-byte',
    keyHex: toHex(pattern(32, 3)),
    ivHex: toHex(pattern(12, 4)),
    plaintextHex: 'a5',
  },
  {
    name: 'one-block',
    keyHex: toHex(pattern(32, 5)),
    ivHex: toHex(pattern(12, 6)),
    plaintextHex: toHex(pattern(16, 7)),
  },
  {
    name: 'non-block-multiple',
    keyHex: toHex(pattern(32, 8)),
    ivHex: toHex(pattern(12, 9)),
    plaintextHex: toHex(pattern(33, 10)),
  },
  {
    name: 'quarter-kib',
    keyHex: toHex(pattern(32, 11)),
    ivHex: toHex(pattern(12, 12)),
    plaintextHex: toHex(pattern(256, 13)),
  },
];

// ---- Full key block vectors ---------------------------------------------------

interface KeyBlockVector {
  name: string;
  password: string;
  /** Serialized key block per SPEC §5.1 (canonical bytes). */
  blockHex: string;
  /** The raw DEK the block must unwrap to with `password`. */
  dekHex: string;
  iterations: number;
  memoryKiB: number;
  parallelism: number;
}

async function makeKeyBlockVector(
  name: string,
  password: string,
  saltSeed: number,
  ivSeed: number,
  dekSeed: number,
  params: Argon2Params,
): Promise<KeyBlockVector> {
  const salt = pattern(16, saltSeed);
  const iv = pattern(12, ivSeed);
  const dek = pattern(32, dekSeed);
  const kek = await kekHex(password, salt, params);
  const wrappedHex = await gcmEncrypt(kek, toHex(iv), toHex(dek));
  const blockHex = toHex(serializeKeyBlock({ salt, params, iv, wrapped: fromHex(wrappedHex) }));
  return {
    name,
    password,
    blockHex,
    dekHex: toHex(dek),
    iterations: params.iterations,
    memoryKiB: params.memoryKiB,
    parallelism: params.parallelism,
  };
}

// ---- Full vault blob vectors ----------------------------------------------------

interface VaultBlobVector {
  name: string;
  mode: 'embedded' | 'keyfile';
  password: string;
  /** SPEC §6 blob: [KB_LEN u16][key block][IV 12][ciphertext]. */
  blobHex: string;
  /** Serialized key block; external copy for keyfile mode (KB_LEN = 0). */
  keyBlockHex: string;
  filename: string;
  contentHex: string;
}

async function makeVaultBlobVector(
  name: string,
  mode: 'embedded' | 'keyfile',
  password: string,
  filename: string,
  content: Uint8Array,
  seeds: { salt: number; wrapIv: number; dek: number; contentSalt: number; contentIv: number },
  params: Argon2Params,
): Promise<VaultBlobVector> {
  const kb = await makeKeyBlockVector(
    'inner',
    password,
    seeds.salt,
    seeds.wrapIv,
    seeds.dek,
    params,
  );
  const envelope = await buildPayload(filename, content);
  // Per-export content subkey: CEK = HKDF-SHA256(DEK, salt=contentSalt,
  // info="stegoshard/vault/content"). Mirrors crypto.deriveContentKey (SPEC §6).
  const contentSalt = pattern(CONTENT_SALT_LEN, seeds.contentSalt);
  const contentInfo = new TextEncoder().encode('stegoshard/vault/content');
  const cek = await hkdf(fromHex(kb.dekHex), contentInfo, 32, contentSalt);
  const contentIv = pattern(12, seeds.contentIv);
  const ctHex = await gcmEncrypt(toHex(cek), toHex(contentIv), toHex(envelope));

  const keyBlock = fromHex(kb.blockHex);
  const embedded = mode === 'embedded' ? keyBlock : new Uint8Array(0);
  const lenField = new Uint8Array(2);
  writeU16(lenField, 0, embedded.length);
  const blob = concatBytes(lenField, embedded, contentSalt, contentIv, fromHex(ctHex));

  return {
    name,
    mode,
    password,
    blobHex: toHex(blob),
    keyBlockHex: kb.blockHex,
    filename,
    contentHex: toHex(content),
  };
}

// ---- Multi-region blob vectors (SPEC §10) ---------------------------------------
//
// Deterministically assembled from fixed inputs (vault salt, slot nonces, a fixed
// live-slot position, region DEK, content salt, IV). A compact synthetic bucket is
// used: a decode KAT exercises the wire layout + slot/region crypto, which is what
// both stacks must agree on; the ladder policy is encode-side and tested separately.

const ENC = (s: string) => new TextEncoder().encode(s);
const REGION_INFO = (idx: number) =>
  concatBytes(ENC('stegoshard/vault/region'), Uint8Array.of(idx));

async function gcmEncryptAad(
  keyHex: string,
  ivHex: string,
  ptHex: string,
  aadHex: string,
): Promise<string> {
  const key = await subtle.importKey(
    'raw',
    fromHex(keyHex) as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const ct = await subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: fromHex(ivHex) as BufferSource,
      additionalData: fromHex(aadHex) as BufferSource,
    },
    key,
    fromHex(ptHex) as BufferSource,
  );
  return toHex(new Uint8Array(ct));
}

/** The slot KEK: Argon2id output, or HKDF(argon || factor) when a key factor is present. */
async function slotKekBytes(
  password: string,
  vaultSalt: Uint8Array,
  params: Argon2Params,
  keyFactor: Uint8Array | null,
): Promise<Uint8Array> {
  const argon = fromHex(await kekHex(password, vaultSalt, params));
  if (!keyFactor) return argon;
  return hkdf(concatBytes(argon, keyFactor), ENC('stegoshard/v1/keyfile-kek'), 32, vaultSalt);
}

/** One live slot: nonce || AES-GCM_kek(dek || region_index || reserved[15]). */
async function liveSlot(
  kek: Uint8Array,
  nonce: Uint8Array,
  dek: Uint8Array,
  regionIndex: number,
): Promise<Uint8Array> {
  const pt = concatBytes(dek, Uint8Array.of(regionIndex), new Uint8Array(15));
  const ct = fromHex(await gcmEncrypt(toHex(kek), toHex(nonce), toHex(pt)));
  return concatBytes(nonce, ct);
}

/** Assemble the 304-byte slot array with the live slot at a fixed position. */
async function slotArray(
  kek: Uint8Array,
  dek: Uint8Array,
  regionIndex: number,
  livePos: number,
  nonceSeed: number,
  deadSeed: number,
): Promise<Uint8Array> {
  const live = await liveSlot(kek, pattern(12, nonceSeed), dek, regionIndex);
  const slots: Uint8Array[] = [];
  for (let i = 0; i < 4; i++) slots.push(i === livePos ? live : pattern(76, deadSeed + i));
  return concatBytes(...slots);
}

interface MultiRegionVaultVector {
  name: string;
  mode: 'embedded' | 'keyfile';
  password: string;
  keyFactorHex: string;
  blobHex: string;
  filename: string;
  contentHex: string;
  iterations: number;
  memoryKiB: number;
  parallelism: number;
}

async function makeMultiRegionVaultVector(
  name: string,
  mode: 'embedded' | 'keyfile',
  password: string,
  filename: string,
  content: Uint8Array,
  bucket: number,
  regionIndex: number,
  livePos: number,
  seeds: Record<string, number>,
  params: Argon2Params,
): Promise<MultiRegionVaultVector> {
  const vaultSalt = pattern(16, seeds.vaultSalt!);
  const keyFactor = mode === 'keyfile' ? pattern(32, seeds.keyFactor!) : null;
  const kek = await slotKekBytes(password, vaultSalt, params, keyFactor);
  const dek = pattern(32, seeds.dek!);
  const arr = await slotArray(kek, dek, regionIndex, livePos, seeds.slotNonce!, seeds.dead!);

  const contentSalt = pattern(16, seeds.contentSalt!);
  const iv = pattern(12, seeds.iv!);
  const envelope = await buildPayload(filename, content);
  const cek = await hkdf(dek, REGION_INFO(regionIndex), 32, contentSalt);
  const rp = new Uint8Array(bucket);
  writeU32(rp, 0, envelope.length);
  rp.set(envelope, 4);
  const ct = fromHex(await gcmEncrypt(toHex(cek), toHex(iv), toHex(rp)));
  const live = concatBytes(contentSalt, iv, ct);
  const dead = pattern(44 + bucket, seeds.deadRegion!);
  const blob = concatBytes(
    vaultSalt,
    arr,
    regionIndex === 0 ? live : dead,
    regionIndex === 0 ? dead : live,
  );

  return {
    name,
    mode,
    password,
    keyFactorHex: keyFactor ? toHex(keyFactor) : '',
    blobHex: toHex(blob),
    filename,
    contentHex: toHex(content),
    iterations: params.iterations,
    memoryKiB: params.memoryKiB,
    parallelism: params.parallelism,
  };
}

interface MultiRegionSegmentedVector extends MultiRegionVaultVector {
  chunkSize: number;
}

async function makeMultiRegionSegmentedVector(
  name: string,
  mode: 'embedded' | 'keyfile',
  password: string,
  filename: string,
  content: Uint8Array,
  bucket: number,
  chunkSize: number,
  regionIndex: number,
  livePos: number,
  seeds: Record<string, number>,
  params: Argon2Params,
): Promise<MultiRegionSegmentedVector> {
  const vaultSalt = pattern(16, seeds.vaultSalt!);
  const keyFactor = mode === 'keyfile' ? pattern(32, seeds.keyFactor!) : null;
  const kek = await slotKekBytes(password, vaultSalt, params, keyFactor);
  const dek = pattern(32, seeds.dek!);
  const arr = await slotArray(kek, dek, regionIndex, livePos, seeds.slotNonce!, seeds.dead!);

  // Container head: SSCS ver flags vault_salt slot_array chunkSize bucketLen.
  const head = new Uint8Array(6 + 16 + 304 + 4 + 8);
  head.set(ENC('SSCS'), 0);
  head[4] = 1; // SEG_VERSION
  head[5] = 0; // FLAGS reserved
  head.set(vaultSalt, 6);
  head.set(arr, 22);
  writeU32(head, 326, chunkSize);
  writeU64(head, 330, bucket);

  const contentSalt = pattern(16, seeds.contentSalt!);
  const noncePrefix = pattern(7, seeds.noncePrefix!);
  const envelope = await buildPayload(filename, content);
  const cek = await hkdf(dek, REGION_INFO(regionIndex), 32, contentSalt);
  const rp = new Uint8Array(bucket);
  writeU32(rp, 0, envelope.length);
  rp.set(envelope, 4);

  const aad = concatBytes(head, Uint8Array.of(regionIndex), contentSalt, noncePrefix);
  const n = Math.max(1, Math.ceil(bucket / chunkSize));
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const seg = rp.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, bucket));
    const counter = new Uint8Array(4);
    writeU32(counter, 0, i);
    const nonce = concatBytes(noncePrefix, counter, Uint8Array.of(i === n - 1 ? 1 : 0));
    chunks.push(fromHex(await gcmEncryptAad(toHex(cek), toHex(nonce), toHex(seg), toHex(aad))));
  }
  const live = concatBytes(contentSalt, noncePrefix, ...chunks);
  const streamLen = 23 + bucket + n * 16;
  const dead = pattern(streamLen, seeds.deadRegion!);
  const blob = concatBytes(head, regionIndex === 0 ? live : dead, regionIndex === 0 ? dead : live);

  return {
    name,
    mode,
    password,
    keyFactorHex: keyFactor ? toHex(keyFactor) : '',
    blobHex: toHex(blob),
    filename,
    contentHex: toHex(content),
    iterations: params.iterations,
    memoryKiB: params.memoryKiB,
    parallelism: params.parallelism,
    chunkSize,
  };
}

// ---- Mode B vectors: gated slot KEK + Shamir shares (SPEC §10.6) -----------------

interface GatedVaultVector {
  name: string;
  password: string;
  secretHex: string;
  blobHex: string;
  filename: string;
  contentHex: string;
  iterations: number;
  memoryKiB: number;
  parallelism: number;
}

/** A multi-region vault blob whose single live slot is threshold-GATED (§10.6.2). */
async function makeGatedVaultVector(
  name: string,
  password: string,
  secret: Uint8Array,
  filename: string,
  content: Uint8Array,
  bucket: number,
  regionIndex: number,
  livePos: number,
  seeds: Record<string, number>,
  params: Argon2Params,
): Promise<GatedVaultVector> {
  const vaultSalt = pattern(16, seeds.vaultSalt!);
  const argon = fromHex(await kekHex(password, vaultSalt, params));
  const kek = await hkdf(concatBytes(argon, secret), ENC('stegoshard/v1/slot-kek'), 32, vaultSalt);
  const dek = pattern(32, seeds.dek!);
  const arr = await slotArray(kek, dek, regionIndex, livePos, seeds.slotNonce!, seeds.dead!);

  const contentSalt = pattern(16, seeds.contentSalt!);
  const iv = pattern(12, seeds.iv!);
  const envelope = await buildPayload(filename, content);
  const cek = await hkdf(dek, REGION_INFO(regionIndex), 32, contentSalt);
  const rp = new Uint8Array(bucket);
  writeU32(rp, 0, envelope.length);
  rp.set(envelope, 4);
  const ct = fromHex(await gcmEncrypt(toHex(cek), toHex(iv), toHex(rp)));
  const live = concatBytes(contentSalt, iv, ct);
  const dead = pattern(44 + bucket, seeds.deadRegion!);
  const blob = concatBytes(
    vaultSalt,
    arr,
    regionIndex === 0 ? live : dead,
    regionIndex === 0 ? dead : live,
  );

  return {
    name,
    password,
    secretHex: toHex(secret),
    blobHex: toHex(blob),
    filename,
    contentHex: toHex(content),
    iterations: params.iterations,
    memoryKiB: params.memoryKiB,
    parallelism: params.parallelism,
  };
}

interface ShamirVector {
  name: string;
  secretHex: string;
  k: number;
  n: number;
  shares: string[];
}

/** Horner evaluation of p(x) = s0 + c1·x + … over GF(2^8). */
function evalPolyGen(coeffs: Uint8Array, s0: number, x: number): number {
  let acc = 0;
  for (let t = coeffs.length - 1; t >= 0; t--) acc = gfAdd(coeffs[t]!, gfMul(acc, x));
  return gfAdd(s0, gfMul(acc, x));
}

/** Deterministic Shamir shares (fixed coefficients); a frozen split KAT. */
async function makeShamirVector(
  name: string,
  secret: Uint8Array,
  k: number,
  n: number,
  coeffSeed: number,
): Promise<ShamirVector> {
  const coeffs: Uint8Array[] = [];
  for (let j = 0; j < 32; j++) coeffs.push(pattern(k - 1, coeffSeed + j));
  const shares: string[] = [];
  for (let index = 1; index <= n; index++) {
    const value = new Uint8Array(32);
    for (let j = 0; j < 32; j++) value[j] = evalPolyGen(coeffs[j]!, secret[j]!, index);
    const body = concatBytes(Uint8Array.of(1, index), value); // version 1
    const digest = new Uint8Array(await subtle.digest('SHA-256', body as BufferSource)).slice(0, 4);
    shares.push(toHex(concatBytes(body, digest)));
  }
  return { name, secretHex: toHex(secret), k, n, shares };
}

// ---- Mode A vectors: duress (two live slots, two real regions) (SPEC §10.5) -----

interface DuressVaultVector {
  name: string;
  realPassword: string;
  duressPassword: string;
  blobHex: string;
  realFilename: string;
  realContentHex: string;
  decoyFilename: string;
  decoyContentHex: string;
  iterations: number;
  memoryKiB: number;
  parallelism: number;
}

/** Build one region block: contentSalt || IV || GCM_CEK(REGION_LEN || envelope || pad). */
async function regionBlock(
  dek: Uint8Array,
  regionIndex: number,
  filename: string,
  content: Uint8Array,
  bucket: number,
  saltSeed: number,
  ivSeed: number,
): Promise<Uint8Array> {
  const contentSalt = pattern(16, saltSeed);
  const iv = pattern(12, ivSeed);
  const envelope = await buildPayload(filename, content);
  const cek = await hkdf(dek, REGION_INFO(regionIndex), 32, contentSalt);
  const rp = new Uint8Array(bucket);
  writeU32(rp, 0, envelope.length);
  rp.set(envelope, 4);
  const ct = fromHex(await gcmEncrypt(toHex(cek), toHex(iv), toHex(rp)));
  return concatBytes(contentSalt, iv, ct);
}

async function makeDuressVaultVector(
  name: string,
  realPassword: string,
  duressPassword: string,
  realFilename: string,
  realContent: Uint8Array,
  decoyFilename: string,
  decoyContent: Uint8Array,
  bucket: number,
  realRegionIndex: number,
  seeds: Record<string, number>,
  params: Argon2Params,
): Promise<DuressVaultVector> {
  const vaultSalt = pattern(16, seeds.vaultSalt!);
  const realKek = fromHex(await kekHex(realPassword, vaultSalt, params));
  const duressKek = fromHex(await kekHex(duressPassword, vaultSalt, params));
  const dekReal = pattern(32, seeds.dekReal!);
  const dekDecoy = pattern(32, seeds.dekDecoy!);
  const decoyRegionIndex = 1 - realRegionIndex;

  // Two live slots (real @ position 1, duress @ position 3), two dead slots.
  const realSlot = await liveSlot(realKek, pattern(12, seeds.realNonce!), dekReal, realRegionIndex);
  const duressSlot = await liveSlot(
    duressKek,
    pattern(12, seeds.duressNonce!),
    dekDecoy,
    decoyRegionIndex,
  );
  const slotArray = concatBytes(
    pattern(76, seeds.dead0!),
    realSlot,
    pattern(76, seeds.dead1!),
    duressSlot,
  );

  const realBlock = await regionBlock(
    dekReal,
    realRegionIndex,
    realFilename,
    realContent,
    bucket,
    seeds.realSalt!,
    seeds.realIv!,
  );
  const decoyBlock = await regionBlock(
    dekDecoy,
    decoyRegionIndex,
    decoyFilename,
    decoyContent,
    bucket,
    seeds.decoySalt!,
    seeds.decoyIv!,
  );
  const block0 = realRegionIndex === 0 ? realBlock : decoyBlock;
  const block1 = realRegionIndex === 0 ? decoyBlock : realBlock;
  const blob = concatBytes(vaultSalt, slotArray, block0, block1);

  return {
    name,
    realPassword,
    duressPassword,
    blobHex: toHex(blob),
    realFilename,
    realContentHex: toHex(realContent),
    decoyFilename,
    decoyContentHex: toHex(decoyContent),
    iterations: params.iterations,
    memoryKiB: params.memoryKiB,
    parallelism: params.parallelism,
  };
}

// ---- Main -----------------------------------------------------------------------

const PARAMS_FAST: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };

/**
 * Pairs whose product differs between 0x11D and the polynomials it is most
 * likely to be confused with, above all the AES field 0x11B. Each one reduces at
 * least once, so a wrong polynomial cannot slip through: products that never
 * overflow eight bits are identical in every GF(2^8) and would pin nothing.
 */
const GF_PRODUCT_PAIRS: [number, number][] = [
  // Verified to differ under both 0x11B and 0x12D. A pair whose carry-less
  // product stays inside eight bits never reduces, so it is identical in every
  // GF(2^8) and pins nothing; 0x0E * 0x0B was in this list until the check in
  // tests/erasure caught it.
  [0x57, 0x13], // the classic worked example: 0xFE under AES 0x11B, 0xE0 here
  [0x02, 0x87],
  [0x53, 0xca],
  [0x80, 0x02],
  [0xff, 0xff],
  [0xb6, 0x53],
  [0x8e, 0x0b],
  [0x1d, 0xff],
];

const GF_QUOTIENT_PAIRS: [number, number][] = [
  [0x01, 0x02],
  [0xe0, 0x13],
  [0xff, 0x53],
  [0x8d, 0xca],
];

const GF_INVERSE_INPUTS = [0x01, 0x02, 0x53, 0x87, 0xca, 0xff];

/**
 * Field vectors for GF(2^8), the field under both Reed-Solomon (SPEC.md §7) and
 * Shamir sharing (§8.4).
 *
 * These pin what no other test in this repository pinned. Every existing
 * assertion about the field is self-referential - inverse round-trips,
 * encode-then-decode - and all of them hold in any correctly built GF(2^8), not
 * only in the one the specification names. Measured: moving POLY to 0x12D, which
 * is also primitive with generator 2, left the TypeScript suite's 620 tests green
 * and the Python conformance suite's 89 green as well, once its fixtures were
 * regenerated the way CI regenerates them, while changing 96% of the parity bytes
 * on a k=4, m=3 shard set.
 *
 * The two table digests are not redundant with the products. A different
 * *primitive* generator leaves every product unchanged, since
 * log_g(xy) = log_g(x) + log_g(y) whatever the base, so the tables are the only
 * place where the generator is observable at all.
 *
 * tests/erasure checks these values against reedsolo and against a table-free
 * multiply, which is what stops the file from being a snapshot of our own output.
 */
async function makeGf256Vectors() {
  const exp = new Uint8Array(255);
  const log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x = gfMul(x, FIELD_GENERATOR);
  }
  const sha256 = async (b: Uint8Array) =>
    toHex(new Uint8Array(await subtle.digest('SHA-256', b as BufferSource)));

  return {
    poly: FIELD_POLY,
    generator: FIELD_GENERATOR,
    products: GF_PRODUCT_PAIRS.map(([a, b]) => ({ a, b, product: gfMul(a, b) })),
    quotients: GF_QUOTIENT_PAIRS.map(([a, b]) => ({ a, b, quotient: gfDiv(a, b) })),
    inverses: GF_INVERSE_INPUTS.map((a) => ({ a, inverse: gfInv(a) })),
    expSha256: await sha256(exp),
    logSha256: await sha256(log),
  };
}

/**
 * Reed-Solomon parity, frozen.
 *
 * The three configurations are the ones the encoder actually produces at the low end:
 * the MIN_PARITY floor at k=1, a small multi-shard set, and a wider one. The two
 * colour-grid layouts (135+19 and 57+31) are deliberately absent: freezing their
 * parity would add tens of kilobytes to this file, and tests/erasure covers them by
 * comparing the generator matrix itself, which is where a construction error would
 * live.
 *
 * Verified in tests/erasure against `galois`, which rebuilds the Cauchy matrix from
 * the formula in SPEC.md §7.4 and recomputes these bytes with an independent linear
 * algebra engine. Without that, these numbers would be a snapshot of our own encoder
 * and the TypeScript and Python suites would only be confirming what they already
 * agreed on.
 */
const RS_CASES: { name: string; k: number; m: number; shardLen: number; seed: number }[] = [
  { name: 'min-parity-floor', k: 1, m: 2, shardLen: 32, seed: 901 },
  { name: 'small-set', k: 4, m: 3, shardLen: 32, seed: 902 },
  { name: 'wider-set', k: 10, m: 3, shardLen: 32, seed: 903 },
];

function makeReedSolomonVectors() {
  return RS_CASES.map(({ name, k, m, shardLen, seed }) => {
    const data = Array.from({ length: k }, (_, i) => pattern(shardLen, seed + i));
    return {
      name,
      k,
      m,
      shardLen,
      dataHex: data.map(toHex),
      parityHex: rsEncode(data, m).map(toHex),
    };
  });
}

async function main() {
  const argon2: Argon2Vector[] = [];
  for (const c of ARGON2_CASES) {
    try {
      const kek = await kekHex(c.password, fromHex(c.saltHex), {
        iterations: c.iterations,
        memoryKiB: c.memoryKiB,
        parallelism: c.parallelism,
      });
      argon2.push({ ...c, kekHex: kek });
    } catch (e) {
      console.warn(`argon2 case ${c.name} skipped: ${(e as Error).message}`);
    }
  }

  const aesGcm: GcmVector[] = [];
  for (const c of GCM_CASES) {
    aesGcm.push({ ...c, ciphertextHex: await gcmEncrypt(c.keyHex, c.ivHex, c.plaintextHex) });
  }

  const keyBlock: KeyBlockVector[] = [
    await makeKeyBlockVector(
      'standard',
      'correct horse battery staple',
      100,
      101,
      102,
      PARAMS_FAST,
    ),
    await makeKeyBlockVector('unicode-password', 'pâsswörd☕\u{1f511}', 103, 104, 105, {
      iterations: 2,
      memoryKiB: 512,
      parallelism: 2,
    }),
  ];

  const vaultBlob: VaultBlobVector[] = [
    // Incompressible content → stored raw (FLAGS bit 0 clear).
    await makeVaultBlobVector(
      'embedded-raw-content',
      'embedded',
      'vault password',
      'seed-phrase.txt',
      pattern(64, 200),
      { salt: 201, wrapIv: 202, dek: 203, contentSalt: 219, contentIv: 204 },
      PARAMS_FAST,
    ),
    // Highly compressible content → stored gzip-compressed (FLAGS bit 0 set).
    await makeVaultBlobVector(
      'embedded-compressed-content',
      'embedded',
      'vault password',
      'notes.txt',
      new Uint8Array(512).fill(0x41),
      { salt: 205, wrapIv: 206, dek: 207, contentSalt: 220, contentIv: 208 },
      PARAMS_FAST,
    ),
    await makeVaultBlobVector(
      'keyfile-external-key',
      'keyfile',
      'keyfile password',
      'wallet.dat',
      pattern(48, 210),
      { salt: 211, wrapIv: 212, dek: 213, contentSalt: 221, contentIv: 214 },
      PARAMS_FAST,
    ),
  ];

  // Multi-region access-structure blobs (SPEC §10), compact synthetic bucket.
  const multiRegionVaultBlob: MultiRegionVaultVector[] = [
    await makeMultiRegionVaultVector(
      'embedded-region0',
      'embedded',
      'vault password',
      'note.txt',
      pattern(40, 300),
      256,
      0,
      2, // live slot at position 2
      {
        vaultSalt: 301,
        dek: 302,
        slotNonce: 303,
        dead: 310,
        contentSalt: 304,
        iv: 305,
        deadRegion: 306,
      },
      PARAMS_FAST,
    ),
    await makeMultiRegionVaultVector(
      'keyfile-region1',
      'keyfile',
      'vault password',
      'wallet.dat',
      pattern(48, 320),
      256,
      1, // live region is region 1
      0, // live slot at position 0
      {
        vaultSalt: 321,
        keyFactor: 322,
        dek: 323,
        slotNonce: 324,
        dead: 330,
        contentSalt: 325,
        iv: 326,
        deadRegion: 327,
      },
      PARAMS_FAST,
    ),
  ];

  const multiRegionSegmentedBlob: MultiRegionSegmentedVector[] = [
    await makeMultiRegionSegmentedVector(
      'embedded-region0',
      'embedded',
      'db password',
      'cache.bin',
      pattern(40, 400),
      256, // bucket
      4096, // chunkSize (min); n = 1
      0,
      1, // live slot at position 1
      {
        vaultSalt: 401,
        dek: 402,
        slotNonce: 403,
        dead: 410,
        contentSalt: 404,
        noncePrefix: 405,
        deadRegion: 406,
      },
      PARAMS_FAST,
    ),
  ];

  // Mode B (§10.6): a threshold-gated slot, plus a deterministic Shamir split KAT.
  const gatedVaultBlob: GatedVaultVector[] = [
    await makeGatedVaultVector(
      'gated-region0',
      'db password',
      pattern(32, 500), // the threshold secret S (recovered from shares at unlock)
      'ledger.txt',
      pattern(40, 501),
      256,
      0,
      3, // live slot at position 3
      {
        vaultSalt: 502,
        dek: 503,
        slotNonce: 504,
        dead: 510,
        contentSalt: 505,
        iv: 506,
        deadRegion: 507,
      },
      PARAMS_FAST,
    ),
  ];
  const shamir: ShamirVector[] = [
    await makeShamirVector('3-of-5', pattern(32, 600), 3, 5, 620),
    await makeShamirVector('2-of-3', pattern(32, 610), 2, 3, 640),
  ];
  // Mode A (§10.5): two live slots (real + duress) over two real regions.
  const duressVaultBlob: DuressVaultVector[] = [
    await makeDuressVaultVector(
      'real-region0',
      'the-real-credential',
      'the-duress-credential',
      'real.txt',
      pattern(40, 700),
      'decoy.txt',
      pattern(36, 710),
      256,
      0, // real region is region 0, decoy is region 1
      {
        vaultSalt: 701,
        dekReal: 702,
        dekDecoy: 712,
        realNonce: 703,
        duressNonce: 713,
        dead0: 720,
        dead1: 721,
        realSalt: 704,
        realIv: 705,
        decoySalt: 714,
        decoyIv: 715,
      },
      PARAMS_FAST,
    ),
  ];

  const gf256 = await makeGf256Vectors();
  const reedSolomon = makeReedSolomonVectors();

  const out = {
    _comment:
      'Frozen cross-implementation vectors. Generated once by scripts/gen-vectors.ts; ' +
      'verified bit-for-bit by src/core/crypto.vectors.test.ts (hash-wasm + WebCrypto) ' +
      'and python/tests/test_vectors.py (argon2-cffi + cryptography). Do not regenerate casually.',
    argon2Version: 0x13,
    argon2id: argon2,
    aesGcm,
    keyBlock,
    vaultBlob,
    multiRegionVaultBlob,
    multiRegionSegmentedBlob,
    gatedVaultBlob,
    shamir,
    gf256,
    reedSolomon,
    duressVaultBlob,
  };

  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'vectors');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'crypto-vectors.json');
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  console.log(
    `wrote ${path}: ${argon2.length} argon2id, ${aesGcm.length} aes-gcm, ` +
      `${keyBlock.length} key-block, ${vaultBlob.length} vault-blob, ` +
      `${multiRegionVaultBlob.length} multi-region vault, ` +
      `${multiRegionSegmentedBlob.length} multi-region segmented vectors`,
  );
}

await main();
