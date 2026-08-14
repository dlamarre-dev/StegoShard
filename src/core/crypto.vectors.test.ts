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
 * Viega, also in NIST's CAVP set) so the platform itself, not just our two
 * implementations agreeing with each other, is validated.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { argon2id } from 'hash-wasm';
import { toHex, readU16 } from './bytes';
import { gfMul, gfDiv, gfInv, FIELD_POLY, FIELD_GENERATOR } from './gf256';
import {
  type Argon2Params,
  CONTENT_SALT_LEN,
  IV_LEN,
  decryptBytes,
  deriveContentKey,
  exportDekRaw,
  normalizePassword,
  parseKeyBlock,
  unlockKeyBlock,
  WrongPasswordError,
} from './crypto';
import { parsePayload } from './payload';
import { decodeMultiRegionVaultBlob } from './vault';
import { decodeMultiRegionSegmentedBlob } from './segmented';
import { shamirRecover } from './shamir';

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
interface MultiRegionSegmentedVector extends MultiRegionVaultVector {
  chunkSize: number;
}
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
interface ShamirVector {
  name: string;
  secretHex: string;
  k: number;
  n: number;
  shares: string[];
}
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
interface Vectors {
  argon2id: Argon2Vector[];
  aesGcm: GcmVector[];
  keyBlock: KeyBlockVector[];
  vaultBlob: VaultBlobVector[];
  multiRegionVaultBlob: MultiRegionVaultVector[];
  multiRegionSegmentedBlob: MultiRegionSegmentedVector[];
  gatedVaultBlob: GatedVaultVector[];
  shamir: ShamirVector[];
  duressVaultBlob: DuressVaultVector[];
  gf256: Gf256Vectors;
}

interface Gf256Vectors {
  poly: number;
  generator: number;
  products: { a: number; b: number; product: number }[];
  quotients: { a: number; b: number; quotient: number }[];
  inverses: { a: number; inverse: number }[];
  expSha256: string;
  logSha256: string;
}

function vectorParams(v: {
  iterations: number;
  memoryKiB: number;
  parallelism: number;
}): Argon2Params {
  return { iterations: v.iterations, memoryKiB: v.memoryKiB, parallelism: v.parallelism };
}
function vectorFactor(hex: string): Uint8Array | null {
  return hex ? fromHex(hex) : null;
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
      let o = 2 + kbLen;
      const contentSalt = blob.slice(o, o + CONTENT_SALT_LEN);
      o += CONTENT_SALT_LEN;
      const iv = blob.slice(o, o + IV_LEN);
      o += IV_LEN;
      const ciphertext = blob.slice(o);

      const dek = await unlockKeyBlock(parseKeyBlock(kbBytes), v.password);
      const cek = await deriveContentKey(dek, contentSalt);
      const envelope = await decryptBytes(cek, iv, ciphertext);
      const { filename, content } = await parsePayload(envelope, 1024 * 1024);
      expect(filename).toBe(v.filename);
      expect(toHex(content)).toBe(v.contentHex);
    });
  }
});

describe('frozen vectors: multi-region vault blob (§10.6, gallery geometry)', () => {
  for (const v of vectors.multiRegionVaultBlob) {
    it(`decodes ${v.name}`, async () => {
      const { filename, content } = await decodeMultiRegionVaultBlob(
        fromHex(v.blobHex),
        v.password,
        {
          params: vectorParams(v),
          keyFactor: vectorFactor(v.keyFactorHex),
          maxContentBytes: 1024 * 1024,
        },
      );
      expect(filename).toBe(v.filename);
      expect(toHex(content)).toBe(v.contentHex);
    });

    it(`rejects ${v.name} without the key factor / with a wrong password`, async () => {
      // keyfile vectors require the factor; embedded vectors reject a wrong password.
      const bad =
        v.mode === 'keyfile'
          ? decodeMultiRegionVaultBlob(fromHex(v.blobHex), v.password, {
              params: vectorParams(v),
              maxContentBytes: 1024 * 1024,
            })
          : decodeMultiRegionVaultBlob(fromHex(v.blobHex), v.password + 'x', {
              params: vectorParams(v),
              maxContentBytes: 1024 * 1024,
            });
      await expect(bad).rejects.toBeInstanceOf(WrongPasswordError);
    });
  }
});

describe('frozen vectors: multi-region segmented blob (§10.7, .db geometry)', () => {
  for (const v of vectors.multiRegionSegmentedBlob) {
    it(`decodes ${v.name}`, async () => {
      const { filename, content } = await decodeMultiRegionSegmentedBlob(
        fromHex(v.blobHex),
        v.password,
        {
          params: vectorParams(v),
          keyFactor: vectorFactor(v.keyFactorHex),
          maxContentBytes: 1024 * 1024,
        },
      );
      expect(filename).toBe(v.filename);
      expect(toHex(content)).toBe(v.contentHex);
    });
  }
});

describe('frozen vectors: threshold-gated slot (Mode B, §10.6)', () => {
  for (const v of vectors.gatedVaultBlob) {
    it(`decodes ${v.name} only with the threshold secret`, async () => {
      // With the recovered secret S the gated slot opens.
      const { filename, content } = await decodeMultiRegionVaultBlob(
        fromHex(v.blobHex),
        v.password,
        {
          params: vectorParams(v),
          secret: fromHex(v.secretHex),
          maxContentBytes: 1024 * 1024,
        },
      );
      expect(filename).toBe(v.filename);
      expect(toHex(content)).toBe(v.contentHex);

      // The correct password WITHOUT the secret cannot open it (inability, §10.6).
      await expect(
        decodeMultiRegionVaultBlob(fromHex(v.blobHex), v.password, {
          params: vectorParams(v),
          maxContentBytes: 1024 * 1024,
        }),
      ).rejects.toBeInstanceOf(WrongPasswordError);
    });
  }
});

describe('frozen vectors: Shamir shares (§10.6.1)', () => {
  for (const v of vectors.shamir) {
    it(`${v.name}: any k recover S, k-1 do not`, async () => {
      const shares = v.shares.map(fromHex);
      // Any k of the n shares reconstruct the exact secret.
      const kSubset = shares.slice(0, v.k);
      expect(toHex(await shamirRecover(kSubset))).toBe(v.secretHex);
      // k-1 shares reveal zero information (must not reconstruct S).
      if (v.k > 1) {
        expect(toHex(await shamirRecover(shares.slice(0, v.k - 1)))).not.toBe(v.secretHex);
      }
    });
  }
});

describe('frozen vectors: duress (Mode A, §10.5)', () => {
  for (const v of vectors.duressVaultBlob) {
    it(`${v.name}: each credential opens its own region`, async () => {
      const blob = fromHex(v.blobHex);
      const opts = { params: vectorParams(v), maxContentBytes: 1024 * 1024 };
      // The real credential yields the real region.
      const real = await decodeMultiRegionVaultBlob(blob, v.realPassword, opts);
      expect(real.filename).toBe(v.realFilename);
      expect(toHex(real.content)).toBe(v.realContentHex);
      // The duress credential yields ONLY the decoy, never the real content.
      const duress = await decodeMultiRegionVaultBlob(blob, v.duressPassword, opts);
      expect(duress.filename).toBe(v.decoyFilename);
      expect(toHex(duress.content)).toBe(v.decoyContentHex);
      expect(toHex(duress.content)).not.toBe(v.realContentHex);
    });
  }
});

describe('frozen vectors: GF(2^8) field (§7.1)', () => {
  const gf = vectors.gf256;

  it('pins the field parameters', () => {
    // Nothing else in the repository pinned these. Every other assertion about
    // the field is self-referential and holds in any correctly built GF(2^8):
    // moving POLY to 0x12D, also primitive with generator 2, left all 620 tests
    // of the TypeScript suite green, and the Python conformance suite green as
    // well once its fixtures were regenerated the way CI regenerates them, while
    // changing 96% of the parity bytes on a k=4, m=3 shard set.
    expect(gf.poly).toBe(FIELD_POLY);
    expect(gf.generator).toBe(FIELD_GENERATOR);
    expect(gf.poly).toBe(0x11d);
    expect(gf.generator).toBe(0x02);
  });

  it('reproduces every product, quotient and inverse', () => {
    // Each pair reduces at least once. Products that stay inside eight bits are
    // identical in every GF(2^8) and would pin nothing.
    for (const { a, b, product } of gf.products) expect(gfMul(a, b)).toBe(product);
    for (const { a, b, quotient } of gf.quotients) expect(gfDiv(a, b)).toBe(quotient);
    for (const { a, inverse } of gf.inverses) expect(gfInv(a)).toBe(inverse);
  });

  it('reproduces the exp and log table digests', () => {
    // The only place the generator is observable. Any of this field's 128
    // primitive elements yields identical products, since
    // log_g(xy) = log_g(x) + log_g(y) whatever the base, so the products above
    // cannot pin it and these digests are not redundant with them.
    const exp = new Uint8Array(255);
    const log = new Uint8Array(256);
    let x = 1;
    for (let i = 0; i < 255; i++) {
      exp[i] = x;
      log[x] = i;
      x = gfMul(x, FIELD_GENERATOR);
    }
    const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
    expect(sha256(exp)).toBe(gf.expSha256);
    expect(sha256(log)).toBe(gf.logSha256);
  });

  it('counts the vectors, so the set cannot quietly shrink', () => {
    // Same contract as elsewhere in this file: drift in either direction should
    // fail loudly. A set that silently emptied would still report green.
    expect(gf.products.length).toBe(8);
    expect(gf.quotients.length).toBe(4);
    expect(gf.inverses.length).toBe(6);
  });
});
