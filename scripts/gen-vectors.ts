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
import { toHex, writeU16, concatBytes } from '../src/core/bytes';
import { normalizePassword, serializeKeyBlock, type Argon2Params } from '../src/core/crypto';
import { buildPayload } from '../src/core/payload';

const subtle = globalThis.crypto.subtle;

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Deterministic patterned bytes (NOT random — these are fixed test inputs). */
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
  seeds: { salt: number; wrapIv: number; dek: number; contentIv: number },
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
  const contentIv = pattern(12, seeds.contentIv);
  const ctHex = await gcmEncrypt(kb.dekHex, toHex(contentIv), toHex(envelope));

  const keyBlock = fromHex(kb.blockHex);
  const embedded = mode === 'embedded' ? keyBlock : new Uint8Array(0);
  const lenField = new Uint8Array(2);
  writeU16(lenField, 0, embedded.length);
  const blob = concatBytes(lenField, embedded, contentIv, fromHex(ctHex));

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

// ---- Main -----------------------------------------------------------------------

const PARAMS_FAST: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };

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
      { salt: 201, wrapIv: 202, dek: 203, contentIv: 204 },
      PARAMS_FAST,
    ),
    // Highly compressible content → stored gzip-compressed (FLAGS bit 0 set).
    await makeVaultBlobVector(
      'embedded-compressed-content',
      'embedded',
      'vault password',
      'notes.txt',
      new Uint8Array(512).fill(0x41),
      { salt: 205, wrapIv: 206, dek: 207, contentIv: 208 },
      PARAMS_FAST,
    ),
    await makeVaultBlobVector(
      'keyfile-external-key',
      'keyfile',
      'keyfile password',
      'wallet.dat',
      pattern(48, 210),
      { salt: 211, wrapIv: 212, dek: 213, contentIv: 214 },
      PARAMS_FAST,
    ),
  ];

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
  };

  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'vectors');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'crypto-vectors.json');
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  console.log(
    `wrote ${path}: ${argon2.length} argon2id, ${aesGcm.length} aes-gcm, ` +
      `${keyBlock.length} key-block, ${vaultBlob.length} vault-blob vectors`,
  );
}

await main();
