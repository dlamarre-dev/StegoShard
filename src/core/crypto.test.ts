import { describe, it, expect } from 'vitest';
import {
  type Argon2Params,
  createKeyBlock,
  decryptBytes,
  encryptBytes,
  exportDekRaw,
  importDek,
  parseKeyBlock,
  rewrapKeyBlock,
  serializeKeyBlock,
  unlockKeyBlock,
  WrongPasswordError,
} from './crypto';

// Cheap Argon2 params keep the suite fast; production uses DEFAULT_ARGON2.
const TEST_PARAMS: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('AES-GCM content encryption', () => {
  it('round-trips arbitrary bytes', async () => {
    const { dek } = await createKeyBlock('pw', TEST_PARAMS);
    const data = enc('the quick brown fox');
    const { iv, ciphertext } = await encryptBytes(dek, data);
    expect(dec(await decryptBytes(dek, iv, ciphertext))).toBe('the quick brown fox');
  });

  it('uses a fresh IV per encryption', async () => {
    const { dek } = await createKeyBlock('pw', TEST_PARAMS);
    const a = await encryptBytes(dek, enc('x'));
    const b = await encryptBytes(dek, enc('x'));
    expect([...a.iv]).not.toEqual([...b.iv]);
  });

  it('rejects tampered ciphertext', async () => {
    const { dek } = await createKeyBlock('pw', TEST_PARAMS);
    const { iv, ciphertext } = await encryptBytes(dek, enc('secret'));
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    await expect(decryptBytes(dek, iv, ciphertext)).rejects.toBeTruthy();
  });
});

describe('DEK raw export/import (session storage)', () => {
  it('round-trips a DEK through raw bytes and still decrypts', async () => {
    const { dek } = await createKeyBlock('pw', TEST_PARAMS);
    const { iv, ciphertext } = await encryptBytes(dek, enc('session data'));
    const raw = await exportDekRaw(dek);
    expect(raw.length).toBe(32);
    const dek2 = await importDek(raw);
    expect(dec(await decryptBytes(dek2, iv, ciphertext))).toBe('session data');
  });
});

describe('KEK/DEK unlock', () => {
  it('unlocks with the correct password and decrypts content', async () => {
    const { dek, block } = await createKeyBlock('correct horse', TEST_PARAMS);
    const { iv, ciphertext } = await encryptBytes(dek, enc('vault contents'));

    const dek2 = await unlockKeyBlock(block, 'correct horse');
    expect(dec(await decryptBytes(dek2, iv, ciphertext))).toBe('vault contents');
  });

  it('rejects a wrong password with a typed error', async () => {
    const { block } = await createKeyBlock('right', TEST_PARAMS);
    await expect(unlockKeyBlock(block, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError);
  });
});

describe('key block serialization', () => {
  it('round-trips through bytes', async () => {
    const { block } = await createKeyBlock('pw', TEST_PARAMS);
    const parsed = parseKeyBlock(serializeKeyBlock(block));
    expect([...parsed.salt]).toEqual([...block.salt]);
    expect([...parsed.iv]).toEqual([...block.iv]);
    expect([...parsed.wrapped]).toEqual([...block.wrapped]);
    expect(parsed.params).toEqual(block.params);
  });

  it('rejects a corrupt magic', async () => {
    const { block } = await createKeyBlock('pw', TEST_PARAMS);
    const bytes = serializeKeyBlock(block);
    bytes[0] = bytes[0]! ^ 0xff;
    expect(() => parseKeyBlock(bytes)).toThrow(/magic/);
  });

  it('rejects attacker-inflated Argon2id parameters (DoS guard)', async () => {
    const { block } = await createKeyBlock('pw', TEST_PARAMS);
    const bytes = serializeKeyBlock(block);
    // memoryKiB is the u32 right after magic(4)+version(1)+iterations(4) => offset 9.
    bytes[9] = 0xff;
    bytes[10] = 0xff;
    bytes[11] = 0xff;
    bytes[12] = 0xff; // ~4 TiB
    expect(() => parseKeyBlock(bytes)).toThrow(/out of range/);
  });

  it('rejects a truncated key block', () => {
    expect(() => parseKeyBlock(new Uint8Array(10))).toThrow(/too short|magic/);
  });
});

describe('change password', () => {
  it('re-wraps the same DEK under a new password', async () => {
    const { dek, block } = await createKeyBlock('old', TEST_PARAMS);
    const { iv, ciphertext } = await encryptBytes(dek, enc('data'));

    const newBlock = await rewrapKeyBlock(block, 'old', 'new', TEST_PARAMS);

    // Old password no longer works; new one recovers the same DEK.
    await expect(unlockKeyBlock(newBlock, 'old')).rejects.toBeTruthy();
    const dek2 = await unlockKeyBlock(newBlock, 'new');
    expect(dec(await decryptBytes(dek2, iv, ciphertext))).toBe('data');
  });
});
