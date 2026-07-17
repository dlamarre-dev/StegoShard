import { describe, it, expect } from 'vitest';
import {
  type Argon2Params,
  WrongPasswordError,
  createKeyBlock,
  serializeKeyBlock,
} from './crypto';
import {
  FileTooLargeError,
  MAX_FILE_BYTES,
  MissingKeyError,
  type VaultKey,
  estimateImageCount,
  estimateImages,
  exportVault,
  importVault,
} from './vault';

const TEST_PARAMS: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };

async function makeKey(password: string): Promise<VaultKey> {
  const { dek, block } = await createKeyBlock(password, TEST_PARAMS);
  return { dek, keyBlock: serializeKeyBlock(block) };
}

function pseudoRandom(len: number, seed: number): Uint8Array {
  let s = seed >>> 0;
  return Uint8Array.from({ length: len }, () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 24) & 0xff;
  });
}

describe('vault export/import round-trip (embedded key)', () => {
  it('restores a small file from the full image set', async () => {
    const key = await makeKey('pw');
    const content = new TextEncoder().encode('seed phrase: alpha bravo charlie');
    const { imagePayloads } = await exportVault('seed.txt', content, key);
    const out = await importVault(imagePayloads, 'pw');
    expect(out.filename).toBe('seed.txt');
    expect(new TextDecoder().decode(out.content)).toBe('seed phrase: alpha bravo charlie');
  });

  it('spans multiple images and restores exactly', async () => {
    const key = await makeKey('pw');
    const content = pseudoRandom(6000, 42);
    const { imagePayloads, k, m } = await exportVault('blob.bin', content, key);
    expect(k).toBeGreaterThan(1);
    expect(imagePayloads.length).toBe(k + m);
    const out = await importVault(imagePayloads, 'pw');
    expect([...out.content]).toEqual([...content]);
  });

  it('restores after losing up to m images, in any order', async () => {
    const key = await makeKey('pw');
    const content = pseudoRandom(6000, 7);
    const { imagePayloads, k, m } = await exportVault('blob.bin', content, key);
    const survivors = imagePayloads.slice(m).reverse();
    expect(survivors.length).toBe(k);
    const out = await importVault(survivors, 'pw');
    expect([...out.content]).toEqual([...content]);
  });

  it('fails to restore when more than m images are lost', async () => {
    const key = await makeKey('pw');
    const content = pseudoRandom(6000, 9);
    const { imagePayloads, m } = await exportVault('blob.bin', content, key);
    await expect(importVault(imagePayloads.slice(m + 1), 'pw')).rejects.toBeTruthy();
  });

  it('rejects a wrong password with a typed error', async () => {
    const key = await makeKey('right');
    const { imagePayloads } = await exportVault('s.txt', new TextEncoder().encode('x'), key);
    await expect(importVault(imagePayloads, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('enforces the hard file-size limit', async () => {
    const key = await makeKey('pw');
    await expect(
      exportVault('big.bin', new Uint8Array(MAX_FILE_BYTES + 1), key),
    ).rejects.toBeInstanceOf(FileTooLargeError);
  });
});

describe('keyfile mode (external key block)', () => {
  it('does not embed the key; restores only with the external key block', async () => {
    const key = await makeKey('pw');
    const content = new TextEncoder().encode('secret keys');
    const { imagePayloads, keyBlock, keyMode } = await exportVault('k.txt', content, key, {
      keyMode: 'keyfile',
    });
    expect(keyMode).toBe('keyfile');

    // Without the key block, restore fails with a clear typed error.
    await expect(importVault(imagePayloads, 'pw')).rejects.toBeInstanceOf(MissingKeyError);

    // With the key block, it restores.
    const out = await importVault(imagePayloads, 'pw', { keyBlock });
    expect(new TextDecoder().decode(out.content)).toBe('secret keys');
  });

  it('needs fewer images than embedded (no key block in the blob)', async () => {
    const key = await makeKey('pw');
    const content = pseudoRandom(6000, 11);
    const embedded = await exportVault('a', content, key, { keyMode: 'embedded' });
    const keyfile = await exportVault('a', content, key, { keyMode: 'keyfile' });
    expect(keyfile.imagePayloads.length).toBeLessThanOrEqual(embedded.imagePayloads.length);
  });
});

describe('import robustness', () => {
  it('detects a silently corrupted shard via the blob integrity check', async () => {
    const key = await makeKey('pw');
    const content = pseudoRandom(3000, 33);
    const { imagePayloads } = await exportVault('a.bin', content, key);
    // Corrupt one shard byte past the header: erasure coding only repairs
    // MISSING shards, so with the full set present the corruption survives
    // reconstruction and must be caught by the blob hash before decryption.
    const corrupted = imagePayloads.map((p) => p.slice());
    corrupted[0]![40] = corrupted[0]![40]! ^ 0xff;
    await expect(importVault(corrupted, 'pw')).rejects.toThrow(/integrity/);
  });

  it('ignores a foreign/corrupt image mixed into the set', async () => {
    const key = await makeKey('pw');
    const content = pseudoRandom(3000, 21);
    const { imagePayloads } = await exportVault('a.bin', content, key);
    const foreign = new Uint8Array(60); // bad magic → not an StegoShard payload
    const out = await importVault([foreign, ...imagePayloads], 'pw');
    expect([...out.content]).toEqual([...content]);
  });

  it('restores the majority set when two vaults are mixed', async () => {
    const key = await makeKey('pw');
    const a = await exportVault('a.bin', pseudoRandom(3000, 1), key);
    const b = await exportVault('b.bin', pseudoRandom(3000, 2), key);
    // One image from B + the full A set → A is the majority.
    const out = await importVault([b.imagePayloads[0]!, ...a.imagePayloads], 'pw');
    expect(out.filename).toBe('a.bin');
  });
});

describe('estimateImages (accurate)', () => {
  it('matches the actual image count', async () => {
    const key = await makeKey('pw');
    const content = pseudoRandom(4000, 5);
    const est = await estimateImages('x.bin', content);
    const { imagePayloads } = await exportVault('x.bin', content, key);
    expect(est.images).toBe(imagePayloads.length);
  });

  it('reflects compression versus the worst-case sync estimate', async () => {
    const content = new Uint8Array(20000).fill(65); // highly compressible
    const est = await estimateImages('big.txt', content);
    expect(est.images).toBeLessThan(estimateImageCount(content.length));
  });
});
