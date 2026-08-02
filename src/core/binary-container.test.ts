import { describe, it, expect } from 'vitest';
import { type Argon2Params, WrongPasswordError, createKeyBlock, serializeKeyBlock } from './crypto';
import { BINARY_MAGIC, binaryExtension, unwrapBinary, wrapBinary } from './binary-container';
import {
  MissingKeyError,
  type VaultKey,
  exportVaultBinary,
  exportVaultBinaryDisguised,
  importVaultBinary,
} from './vault';

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

  it('disguises as a structurally valid SQLite database with no trailing bytes', () => {
    const payload = Uint8Array.from({ length: 20_000 }, (_, i) => (i * 37) & 0xff);
    const wrapped = wrapBinary(payload, 'disguised');
    // A real SQLite header: magic string...
    expect(new TextDecoder().decode(wrapped.slice(0, 15))).toBe('SQLite format 3');
    expect(wrapped[15]).toBe(0);
    // ...page size 4096 at offset 16...
    const pageSize = (wrapped[16]! << 8) | wrapped[17]!;
    expect(pageSize).toBe(4096);
    // ...and NO unreferenced trailing bytes: file size == page_count × page_size.
    const dv = new DataView(wrapped.buffer, wrapped.byteOffset, wrapped.byteLength);
    const pageCount = dv.getUint32(28, false);
    expect(wrapped.length).toBe(pageCount * pageSize);
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

  it('restores an embedded-key branded (.ssbn) vault (single-region, managed key)', async () => {
    const key = await makeKey('pw');
    const { container } = await exportVaultBinary('seed.txt', content, key, { variant: 'branded' });
    const out = await importVaultBinary(container, 'pw');
    expect(out.filename).toBe('seed.txt');
    expect([...out.content]).toEqual([...content]);
  });

  it('restores an embedded disguised (.db) vault (§10 multi-region, password-keyed)', async () => {
    const { container } = await exportVaultBinaryDisguised(
      'seed.txt',
      content,
      'pw',
      {},
      undefined,
    );
    const out = await importVaultBinary(container, 'pw');
    expect(out.filename).toBe('seed.txt');
    expect([...out.content]).toEqual([...content]);
    // No managed key involved on the supported path — each region has its own DEK.
  }, 20000);

  it('rejects a wrong password on a disguised (.db) vault', async () => {
    const { container } = await exportVaultBinaryDisguised('seed.txt', content, 'right', {});
    await expect(importVaultBinary(container, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError);
  }, 20000);

  it('restores a keyfile-mode branded vault only with its external key block', async () => {
    const key = await makeKey('pw');
    const { container, keyBlock } = await exportVaultBinary('seed.txt', content, key, {
      keyMode: 'keyfile',
      variant: 'branded',
    });
    await expect(importVaultBinary(container, 'pw')).rejects.toBeInstanceOf(MissingKeyError);
    const out = await importVaultBinary(container, 'pw', { keyBlock });
    expect([...out.content]).toEqual([...content]);
  });

  it('restores a keyfile-mode disguised (.db) vault only with its key factor', async () => {
    const { container, keyBlock } = await exportVaultBinaryDisguised('seed.txt', content, 'pw', {
      keyMode: 'keyfile',
    });
    expect(keyBlock.length).toBe(32); // the random key factor, not a serialized block
    // Without the factor the slot KEK is wrong → uniform wrong-password failure.
    await expect(importVaultBinary(container, 'pw')).rejects.toBeInstanceOf(WrongPasswordError);
    const out = await importVaultBinary(container, 'pw', { keyBlock });
    expect([...out.content]).toEqual([...content]);
  }, 20000);

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
