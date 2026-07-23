/**
 * Post-save round-trip verification (A1): a just-produced artifact must decode
 * back to the original file, and verification must REJECT a corrupted one.
 */

import { describe, it, expect } from 'vitest';
import { type Argon2Params, createKeyBlock, serializeKeyBlock } from './crypto';
import {
  type VaultKey,
  VerificationError,
  exportVault,
  exportVaultBinary,
  verifyBinaryExport,
  verifyImageExport,
} from './vault';

const FAST: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };
const NAME = 'secret.txt';
const CONTENT = new Uint8Array(3000).map((_, i) => (i * 131 + 7) & 0xff);

async function makeKey(): Promise<VaultKey> {
  const { dek, block } = await createKeyBlock('pw', FAST);
  return { dek, keyBlock: serializeKeyBlock(block) };
}

describe('post-save verification: image export', () => {
  it('accepts a faithful image set', async () => {
    const key = await makeKey();
    const { imagePayloads } = await exportVault(NAME, CONTENT, key);
    await expect(verifyImageExport(imagePayloads, key.dek, NAME, CONTENT)).resolves.toBeUndefined();
  });

  it('rejects when too many shards are missing to reconstruct', async () => {
    const key = await makeKey();
    const { imagePayloads, k } = await exportVault(NAME, CONTENT, key);
    const tooFew = imagePayloads.slice(0, Math.max(0, k - 1)); // below the k needed
    await expect(verifyImageExport(tooFew, key.dek, NAME, CONTENT)).rejects.toBeInstanceOf(
      VerificationError,
    );
  });

  it('rejects when a shard payload is corrupted beyond RS tolerance', async () => {
    const key = await makeKey();
    const { imagePayloads } = await exportVault(NAME, CONTENT, key);
    // Corrupt every payload's shard region — no k-subset can reconstruct the blob.
    const corrupted = imagePayloads.map((p) => {
      const c = p.slice();
      c[c.length - 1] = c[c.length - 1]! ^ 0xff;
      return c;
    });
    await expect(verifyImageExport(corrupted, key.dek, NAME, CONTENT)).rejects.toBeInstanceOf(
      VerificationError,
    );
  });
});

describe('post-save verification: binary container', () => {
  it('accepts a faithful container', async () => {
    const key = await makeKey();
    const { container } = await exportVaultBinary(NAME, CONTENT, key, { variant: 'branded' });
    await expect(verifyBinaryExport(container, key.dek, NAME, CONTENT)).resolves.toBeUndefined();
  });

  it('rejects a container with a flipped ciphertext byte (GCM tag fails)', async () => {
    const key = await makeKey();
    const { container } = await exportVaultBinary(NAME, CONTENT, key, { variant: 'branded' });
    container[container.length - 1] = container[container.length - 1]! ^ 0x01;
    await expect(verifyBinaryExport(container, key.dek, NAME, CONTENT)).rejects.toBeInstanceOf(
      VerificationError,
    );
  });

  it('rejects when the decoded content does not match the original', async () => {
    const key = await makeKey();
    const { container } = await exportVaultBinary(NAME, CONTENT, key, { variant: 'branded' });
    const otherContent = new Uint8Array(CONTENT.length).fill(0x42);
    await expect(verifyBinaryExport(container, key.dek, NAME, otherContent)).rejects.toBeInstanceOf(
      VerificationError,
    );
  });
});
