/**
 * Known-answer tests (KATs) against the frozen cross-implementation vectors in
 * tests/vectors/crypto-vectors.json.
 *
 * The same file is verified by the Python reference decoder
 * (python/tests/test_vectors.py) with independent implementations
 * (argon2-cffi = official phc-winner-argon2 C code, cryptography = OpenSSL).
 * Together the two suites prove hash-wasm + WebCrypto and the Python stack
 * agree bit-for-bit on Argon2id, AES-256-GCM, the key block, and the vault
 * blob. This suite alone pins the TypeScript stack against silent drift.
 *
 * On top of the frozen vectors, the AES-GCM implementation is checked against
 * two authoritative test cases from the original GCM specification (McGrew &
 * Viega, also in NIST's CAVP set) so the platform itself — not just our two
 * implementations agreeing with each other — is validated.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { argon2id } from 'hash-wasm';
import { toHex, readU16 } from './bytes';
import {
  IV_LEN,
  decryptBytes,
  exportDekRaw,
  normalizePassword,
  parseKeyBlock,
  unlockKeyBlock,
  WrongPasswordError,
} from './crypto';
import { parsePayload } from './payload';

interface Argon2Vector {
  name: string;
  password: string;
  saltHex: string;
  iterations: number;
  memoryKiB: number;
  parallelism: number;
  kekHex: string;
}
interface GcmVector {
  name: string;
  keyHex: string;
  ivHex: string;
  plaintextHex: string;
  ciphertextHex: string;
}
interface KeyBlockVector {
  name: string;
  password: string;
  blockHex: string;
  dekHex: string;
}
interface VaultBlobVector {
  name: string;
  mode: 'embedded' | 'keyfile';
  password: string;
  blobHex: string;
  keyBlockHex: string;
  filename: string;
  contentHex: string;
}
interface Vectors {
  argon2id: Argon2Vector[];
  aesGcm: GcmVector[];
  keyBlock: KeyBlockVector[];
  vaultBlob: VaultBlobVector[];
}

const vectors: Vectors = JSON.parse(
  readFileSync(new URL('../../tests/vectors/crypto-vectors.json', import.meta.url), 'utf-8'),
);

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const subtle = globalThis.crypto.subtle;

async function importGcmKey(keyHex: string): Promise<CryptoKey> {
  return subtle.importKey('raw', fromHex(keyHex) as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

describe('frozen vectors: Argon2id KEK derivation', () => {
  for (const v of vectors.argon2id) {
    it(`reproduces ${v.name}`, async () => {
      const kek = await argon2id({
        // Mirror deriveKEK: NFC-normalize before hashing.
        password: normalizePassword(v.password),
        salt: fromHex(v.saltHex),
        iterations: v.iterations,
        memorySize: v.memoryKiB,
        parallelism: v.parallelism,
        hashLength: 32,
        outputType: 'hex',
      });
      expect(kek).toBe(v.kekHex);
    });
  }

  it('NFC and NFD spellings of the same password derive the SAME KEK (normalized)', () => {
    const nfc = vectors.argon2id.find((v) => v.name === 'unicode-nfc')!;
    const nfd = vectors.argon2id.find((v) => v.name === 'unicode-nfd')!;
    // Different raw bytes, same normalized text → identical KEK.
    expect(nfc.password).not.toBe(nfd.password);
    expect(nfc.password.normalize('NFC')).toBe(nfd.password.normalize('NFC'));
    expect(nfc.kekHex).toBe(nfd.kekHex);
  });
});

describe('frozen vectors: AES-256-GCM (ciphertext || tag layout)', () => {
  for (const v of vectors.aesGcm) {
    it(`reproduces ${v.name}`, async () => {
      const key = await importGcmKey(v.keyHex);
      const ct = await subtle.encrypt(
        { name: 'AES-GCM', iv: fromHex(v.ivHex) as BufferSource },
        key,
        fromHex(v.plaintextHex) as BufferSource,
      );
      expect(toHex(new Uint8Array(ct))).toBe(v.ciphertextHex);
      // And the inverse direction.
      const pt = await decryptBytes(key, fromHex(v.ivHex), fromHex(v.ciphertextHex));
      expect(toHex(pt)).toBe(v.plaintextHex);
    });
  }
});

describe('authoritative AES-256-GCM vectors (GCM spec test cases 13/14)', () => {
  it('empty plaintext, zero key/IV → known tag', async () => {
    const key = await importGcmKey('00'.repeat(32));
    const ct = await subtle.encrypt(
      { name: 'AES-GCM', iv: new Uint8Array(12) },
      key,
      new Uint8Array(0),
    );
    expect(toHex(new Uint8Array(ct))).toBe('530f8afbc74536b9a963b4f1c4cb738b');
  });

  it('one zero block, zero key/IV → known ciphertext and tag', async () => {
    const key = await importGcmKey('00'.repeat(32));
    const ct = await subtle.encrypt(
      { name: 'AES-GCM', iv: new Uint8Array(12) },
      key,
      new Uint8Array(16),
    );
    expect(toHex(new Uint8Array(ct))).toBe(
      'cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919',
    );
  });
});

describe('frozen vectors: full key block unwrap', () => {
  for (const v of vectors.keyBlock) {
    it(`unwraps ${v.name} to the exact DEK`, async () => {
      const block = parseKeyBlock(fromHex(v.blockHex));
      const dek = await unlockKeyBlock(block, v.password);
      expect(toHex(await exportDekRaw(dek))).toBe(v.dekHex);
    });

    it(`rejects ${v.name} with a wrong password`, async () => {
      const block = parseKeyBlock(fromHex(v.blockHex));
      await expect(unlockKeyBlock(block, v.password + 'x')).rejects.toBeInstanceOf(
        WrongPasswordError,
      );
    });
  }
});

describe('frozen vectors: full vault blob decrypt', () => {
  for (const v of vectors.vaultBlob) {
    it(`decrypts ${v.name}`, async () => {
      const blob = fromHex(v.blobHex);
      const kbLen = readU16(blob, 0);
      if (v.mode === 'keyfile') expect(kbLen).toBe(0);
      else expect(kbLen).toBeGreaterThan(0);

      const kbBytes = kbLen > 0 ? blob.slice(2, 2 + kbLen) : fromHex(v.keyBlockHex);
      const iv = blob.slice(2 + kbLen, 2 + kbLen + IV_LEN);
      const ciphertext = blob.slice(2 + kbLen + IV_LEN);

      const dek = await unlockKeyBlock(parseKeyBlock(kbBytes), v.password);
      const envelope = await decryptBytes(dek, iv, ciphertext);
      const { filename, content } = await parsePayload(envelope, 1024 * 1024);
      expect(filename).toBe(v.filename);
      expect(toHex(content)).toBe(v.contentHex);
    });
  }
});
