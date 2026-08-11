/**
 * Key-material isolation: formally verify that no secret bytes ever leak into
 * the produced artifacts.
 *
 *  - keyfile mode (KB_LEN = 0): NO window of the serialized key block may
 *    appear anywhere in the vault blob or in any image payload;
 *  - both modes: the raw DEK, the raw KEK, and the password bytes must never
 *    appear in any output artifact (only the *wrapped* DEK may travel).
 *
 * The blob is reconstructed from the actual image payloads (the k data shards
 * are verbatim slices of it), so the scan covers exactly what an attacker who
 * finds the images would hold.
 */

import { describe, it, expect } from 'vitest';
import { argon2id } from 'hash-wasm';
import {
  type Argon2Params,
  KEY_BLOCK_LEN,
  createKeyBlock,
  exportDekRaw,
  randomBytes,
  serializeKeyBlock,
} from './crypto';
import { decodeImagePayload } from './header';
import { concatBytes, readU16 } from './bytes';
import { type VaultKey, exportVault } from './vault';

const TEST_PARAMS: Argon2Params = { iterations: 1, memoryKiB: 64, parallelism: 1 };
const PASSWORD = 'isolation-test-password-longer-than-any-window';
const WINDOW = 8; // a coincidental 8-byte (2^-64) match is effectively impossible

/** True if `needle` occurs anywhere in `haystack` (byte-exact). */
function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** True if ANY `window`-byte slice of `secret` occurs in `haystack`. */
function leaksAnyWindow(haystack: Uint8Array, secret: Uint8Array, window = WINDOW): boolean {
  for (let i = 0; i + window <= secret.length; i++) {
    if (contains(haystack, secret.slice(i, i + window))) return true;
  }
  return false;
}

/** Rebuild the exact vault blob from the image payloads (data shards 0..k-1). */
function rebuildBlob(payloads: Uint8Array[]): Uint8Array {
  const decoded = payloads.map((p) => decodeImagePayload(p));
  const { k, blobLen } = decoded[0]!.header;
  const data = decoded
    .filter(({ header }) => header.shardIndex < k)
    .sort((a, b) => a.header.shardIndex - b.header.shardIndex)
    .map(({ shard }) => shard);
  expect(data.length).toBe(k);
  return concatBytes(...data).slice(0, blobLen);
}

interface Artifacts {
  key: VaultKey;
  rawDek: Uint8Array;
  rawKek: Uint8Array;
  payloads: Uint8Array[];
  blob: Uint8Array;
  everything: Uint8Array; // all payloads concatenated (covers parity shards too)
}

async function makeArtifacts(keyMode: 'embedded' | 'keyfile'): Promise<Artifacts> {
  const { dek, block } = await createKeyBlock(PASSWORD, TEST_PARAMS);
  const key: VaultKey = { dek, keyBlock: serializeKeyBlock(block) };
  const rawDek = await exportDekRaw(dek);
  const rawKek = (await argon2id({
    password: PASSWORD,
    salt: block.salt,
    iterations: TEST_PARAMS.iterations,
    memorySize: TEST_PARAMS.memoryKiB,
    parallelism: TEST_PARAMS.parallelism,
    hashLength: 32,
    outputType: 'binary',
  })) as Uint8Array;

  const content = randomBytes(5000);
  const { imagePayloads } = await exportVault('secrets.bin', content, key, { keyMode });
  return {
    key,
    rawDek,
    rawKek,
    payloads: imagePayloads,
    blob: rebuildBlob(imagePayloads),
    everything: concatBytes(...imagePayloads),
  };
}

describe('keyfile mode: the key block is formally absent from every artifact', () => {
  it('produces KB_LEN = 0 and zero key-block bytes in blob and images', async () => {
    const a = await makeArtifacts('keyfile');

    expect(readU16(a.blob, 0)).toBe(0);

    // No 8-byte window of the serialized key block appears anywhere: not in
    // the blob, not in any single payload, not across the concatenation.
    expect(leaksAnyWindow(a.blob, a.key.keyBlock)).toBe(false);
    expect(leaksAnyWindow(a.everything, a.key.keyBlock)).toBe(false);
    for (const p of a.payloads) expect(leaksAnyWindow(p, a.key.keyBlock)).toBe(false);
  });

  it('scanner sanity check: embedded mode DOES contain the key block', async () => {
    // Proves leaksAnyWindow actually detects the key block when it is present,
    // guarding the keyfile assertions above against a vacuous scanner.
    const a = await makeArtifacts('embedded');
    expect(readU16(a.blob, 0)).toBe(KEY_BLOCK_LEN);
    expect(contains(a.blob, a.key.keyBlock)).toBe(true);
    expect(leaksAnyWindow(a.everything, a.key.keyBlock)).toBe(true);
  });
});

describe('both modes: raw key material never appears in any artifact', () => {
  for (const mode of ['embedded', 'keyfile'] as const) {
    it(`${mode}: no raw DEK, raw KEK, or password bytes in blob or images`, async () => {
      const a = await makeArtifacts(mode);
      const passwordBytes = new TextEncoder().encode(PASSWORD);

      for (const [name, secret] of [
        ['raw DEK', a.rawDek],
        ['raw KEK', a.rawKek],
        ['password', passwordBytes],
      ] as const) {
        expect(leaksAnyWindow(a.blob, secret), `${name} leaked into the blob`).toBe(false);
        expect(leaksAnyWindow(a.everything, secret), `${name} leaked into an image`).toBe(false);
      }
    });
  }

  it('two exports of the same content share no ciphertext (fresh IV each time)', async () => {
    const { dek, block } = await createKeyBlock(PASSWORD, TEST_PARAMS);
    const key: VaultKey = { dek, keyBlock: serializeKeyBlock(block) };
    const content = randomBytes(600);

    const a = await exportVault('same.bin', content, key, { keyMode: 'keyfile' });
    const b = await exportVault('same.bin', content, key, { keyMode: 'keyfile' });

    const blobA = rebuildBlob(a.imagePayloads);
    const blobB = rebuildBlob(b.imagePayloads);
    // Same DEK + same plaintext, but a fresh random IV → entirely different
    // ciphertext. A shared 8-byte window would indicate IV/keystream reuse.
    const ctA = blobA.slice(2 + 12); // [KB_LEN=0 u16][IV 12][ciphertext]
    const ctB = blobB.slice(2 + 12);
    expect(leaksAnyWindow(ctB, ctA)).toBe(false);
    expect([...a.setId]).not.toEqual([...b.setId]);
  });
});
