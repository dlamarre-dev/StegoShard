import { describe, it, expect } from 'vitest';
import { type Argon2Params, WrongPasswordError, createKeyBlock, serializeKeyBlock } from './crypto';
import { BINARY_MAGIC, binaryExtension, unwrapBinary, wrapBinary } from './binary-container';
import { MissingKeyError, type VaultKey, exportVaultBinary, importVaultBinary } from './vault';

const TEST_PARAMS: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };

async function makeKey(password: string): Promise<VaultKey> {
  const { dek, block } = await createKeyBlock(password, TEST_PARAMS);
  return { dek, keyBlock: serializeKeyBlock(block) };
}

describe('binary container wrap/unwrap', () => {
  it('round-trips the branded variant and reports its extension', () => {
    const payload = Uint8Array.from([1, 2, 3, 4, 5]);
    const wrapped = wrapBinary(payload, 'branded');
    expect([...wrapped.slice(0, 4)]).toEqual([...BINARY_MAGIC]);
    const un = unwrapBinary(wrapped);
    expect(un?.variant).toBe('branded');
    expect([...un!.payload]).toEqual([...payload]);
    expect(binaryExtension('branded')).toBe('ssbn');
  });

  it('disguises with a complete, valid 100-byte SQLite header', () => {
    const payload = Uint8Array.from([9, 8, 7]);
    const wrapped = wrapBinary(payload, 'disguised');
    // Magic string...
    expect(new TextDecoder().decode(wrapped.slice(0, 15))).toBe('SQLite format 3');
    expect(wrapped[15]).toBe(0);
    // ...and a valid page-size at offset 16 (what file(1) actually validates).
    const pageSize = (wrapped[16]! << 8) | wrapped[17]!;
    expect(pageSize).toBe(4096); // a power of two in [512, 65536]
    // The full 100-byte header precedes the payload.
    expect([...wrapped.slice(100)]).toEqual([...payload]);
    const un = unwrapBinary(wrapped);
    expect(un?.variant).toBe('disguised');
    expect([...un!.payload]).toEqual([...payload]);
    expect(binaryExtension('disguised')).toBe('db');
  });

  it('returns null for bytes matching neither container', () => {
    expect(unwrapBinary(Uint8Array.from([0, 1, 2, 3, 4, 5]))).toBeNull();
  });

  it('rejects an unsupported branded version', () => {
    const bad = wrapBinary(Uint8Array.of(1, 2), 'branded');
    bad[BINARY_MAGIC.length] = 99;
    expect(() => unwrapBinary(bad)).toThrow(/unsupported version/);
  });
});

describe('binary vault export/import round-trip', () => {
  const content = new TextEncoder().encode('seed phrase: alpha bravo charlie delta');

  for (const variant of ['branded', 'disguised'] as const) {
    it(`restores an embedded-key vault (${variant})`, async () => {
      const key = await makeKey('pw');
      const { container } = await exportVaultBinary('seed.txt', content, key, { variant });
      const out = await importVaultBinary(container, 'pw');
      expect(out.filename).toBe('seed.txt');
      expect([...out.content]).toEqual([...content]);
    });
  }

  it('restores a keyfile-mode vault only with its external key block', async () => {
    const key = await makeKey('pw');
    const { container, keyBlock } = await exportVaultBinary('seed.txt', content, key, {
      keyMode: 'keyfile',
    });
    await expect(importVaultBinary(container, 'pw')).rejects.toBeInstanceOf(MissingKeyError);
    const out = await importVaultBinary(container, 'pw', { keyBlock });
    expect([...out.content]).toEqual([...content]);
  });

  it('tolerates a bare (unwrapped) blob for forward-compatibility', async () => {
    const key = await makeKey('pw');
    const { container } = await exportVaultBinary('seed.txt', content, key, { variant: 'branded' });
    const bare = container.slice(5); // strip the SSBN header
    const out = await importVaultBinary(bare, 'pw');
    expect([...out.content]).toEqual([...content]);
  });

  it('rejects a wrong password', async () => {
    const key = await makeKey('correct horse');
    const { container } = await exportVaultBinary('seed.txt', content, key);
    await expect(importVaultBinary(container, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError);
  });
});
