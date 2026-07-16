/**
 * Adversarial hardening tests for the crypto core.
 *
 *  - Entropy audit: every random value flows through crypto.getRandomValues
 *    (CSPRNG); no Math.random anywhere in the core; IVs and salts never repeat.
 *  - Negative testing: exhaustive single-byte corruption of the key block,
 *    truncation ladders, parameter boundary matrix, seeded fuzzing — nothing
 *    ever "succeeds wrong", crashes the process, or leaks the failure cause.
 *  - Failure indistinguishability: a wrong password and a tampered block throw
 *    the identical typed error, so an attacker learns nothing from the message.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import {
  type Argon2Params,
  type KeyBlock,
  DEK_LEN,
  GCM_TAG_LEN,
  IV_LEN,
  KEY_BLOCK_LEN,
  SALT_LEN,
  WrongPasswordError,
  createKeyBlock,
  decryptBytes,
  encryptBytes,
  parseKeyBlock,
  randomBytes,
  serializeKeyBlock,
  unlockKeyBlock,
  validateArgon2Params,
} from './crypto';
import { toHex } from './bytes';

// Minimal-cost valid params: many tests below run hundreds of derivations.
const FAST: Argon2Params = { iterations: 1, memoryKiB: 64, parallelism: 1 };

/** Deterministic PRNG for reproducible fuzzing (NOT crypto — test-only). */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s >>> 24; // 0..255
  };
}

/** unlock a serialized block end-to-end; returns the failure, or null on success. */
async function unlockSerialized(bytes: Uint8Array, password: string): Promise<unknown | null> {
  try {
    await unlockKeyBlock(parseKeyBlock(bytes), password);
    return null;
  } catch (e) {
    return e;
  }
}

describe('entropy audit', () => {
  it('the core contains no Math.random and no other randomness source', () => {
    const coreDir = join(fileURLToPath(import.meta.url), '..');
    const files = readdirSync(coreDir, { recursive: true, encoding: 'utf-8' }).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'),
    );
    expect(files.length).toBeGreaterThan(5); // sanity: the scan actually saw the core
    for (const f of files) {
      const src = readFileSync(join(coreDir, f), 'utf-8');
      expect(src, `${f} must not use Math.random`).not.toMatch(/Math\.random/);
      expect(src, `${f} must not seed randomness from time`).not.toMatch(/Date\.now\(\)/);
    }
  });

  it('salt and IV generation call through to crypto.getRandomValues', async () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    try {
      spy.mockClear();
      const { dek, block } = await createKeyBlock('pw', FAST);
      // salt (16) + wrap IV (12): both must come from the CSPRNG.
      const sizes = spy.mock.calls.map((c) => (c[0] as Uint8Array).length);
      expect(sizes).toContain(SALT_LEN);
      expect(sizes).toContain(IV_LEN);
      expect(block.salt.length).toBe(SALT_LEN);

      spy.mockClear();
      await encryptBytes(dek, new Uint8Array(8));
      expect(spy.mock.calls.some((c) => (c[0] as Uint8Array).length === IV_LEN)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('never repeats an IV across many encryptions with the same key', async () => {
    const { dek } = await createKeyBlock('pw', FAST);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const { iv } = await encryptBytes(dek, new Uint8Array(1));
      const hex = toHex(iv);
      expect(seen.has(hex)).toBe(false);
      seen.add(hex);
    }
  });

  it('never repeats a salt across many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      const hex = toHex(randomBytes(SALT_LEN));
      expect(seen.has(hex)).toBe(false);
      seen.add(hex);
    }
  });

  it('random bytes look uniform (all 256 values present, sane mean)', () => {
    const n = 65536;
    const buf = randomBytes(n);
    const counts = new Array<number>(256).fill(0);
    let sum = 0;
    for (const b of buf) {
      counts[b]!++;
      sum += b;
    }
    // With 65536 draws the probability of a missing byte value is ~e^-256.
    expect(counts.every((c) => c > 0)).toBe(true);
    const mean = sum / n;
    expect(mean).toBeGreaterThan(120);
    expect(mean).toBeLessThan(135);
  });
});

describe('exhaustive key block corruption', () => {
  it('flipping any single byte anywhere in the block never unlocks', async () => {
    const password = 'the one true password';
    const { block } = await createKeyBlock(password, FAST);
    const bytes = serializeKeyBlock(block);
    expect(bytes.length).toBe(KEY_BLOCK_LEN);

    // Control: the untouched block unlocks.
    expect(await unlockSerialized(bytes, password)).toBeNull();

    for (let i = 0; i < bytes.length; i++) {
      for (const mask of [0x01, 0x80]) {
        const mutated = bytes.slice();
        mutated[i] = mutated[i]! ^ mask;
        const err = await unlockSerialized(mutated, password);
        expect(err, `byte ${i} flipped with ${mask} must not unlock`).toBeInstanceOf(Error);
        // If the mutation survived parsing, the failure must be the uniform
        // wrong-password error — nothing about *what* broke may leak.
        if (err instanceof WrongPasswordError) {
          expect((err as Error).message).toBe('wrong password');
        }
      }
    }
  });

  it('tampering with only the GCM tag (last 16 bytes) is always rejected', async () => {
    const password = 'pw';
    const { block } = await createKeyBlock(password, FAST);
    const bytes = serializeKeyBlock(block);
    for (let i = bytes.length - GCM_TAG_LEN; i < bytes.length; i++) {
      const mutated = bytes.slice();
      mutated[i] = mutated[i]! ^ 0xff;
      await expect(unlockKeyBlock(parseKeyBlock(mutated), password)).rejects.toBeInstanceOf(
        WrongPasswordError,
      );
    }
  });

  it('every possible truncation of the block fails to parse', async () => {
    const { block } = await createKeyBlock('pw', FAST);
    const bytes = serializeKeyBlock(block);
    for (let len = 0; len < bytes.length; len++) {
      expect(() => parseKeyBlock(bytes.slice(0, len)), `prefix of ${len} bytes`).toThrow(Error);
    }
  });

  it('rejects trailing bytes (canonical encoding)', async () => {
    const { block } = await createKeyBlock('pw', FAST);
    const bytes = serializeKeyBlock(block);
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    expect(() => parseKeyBlock(padded)).toThrow(/trailing/);
  });

  it('rejects an unsupported version', async () => {
    const { block } = await createKeyBlock('pw', FAST);
    const bytes = serializeKeyBlock(block);
    bytes[4] = 2;
    expect(() => parseKeyBlock(bytes)).toThrow(/version/);
  });
});

describe('failure indistinguishability', () => {
  it('wrong password and tampered block throw the identical error', async () => {
    const { block } = await createKeyBlock('right', FAST);

    const errors: WrongPasswordError[] = [];
    errors.push(await unlockKeyBlock(block, 'wrong').then(fail, (e) => e as WrongPasswordError));

    const tamperedWrapped: KeyBlock = { ...block, wrapped: block.wrapped.slice() };
    tamperedWrapped.wrapped[0] = tamperedWrapped.wrapped[0]! ^ 1;
    errors.push(
      await unlockKeyBlock(tamperedWrapped, 'right').then(fail, (e) => e as WrongPasswordError),
    );

    const tamperedSalt: KeyBlock = { ...block, salt: block.salt.slice() };
    tamperedSalt.salt[0] = tamperedSalt.salt[0]! ^ 1;
    errors.push(
      await unlockKeyBlock(tamperedSalt, 'right').then(fail, (e) => e as WrongPasswordError),
    );

    for (const e of errors) {
      expect(e).toBeInstanceOf(WrongPasswordError);
      expect(e.name).toBe('WrongPasswordError');
      expect(e.message).toBe('wrong password');
    }

    function fail(): never {
      throw new Error('expected rejection');
    }
  });

  it('an empty password is rejected with the same typed error (never a crash)', async () => {
    const { block } = await createKeyBlock('nonempty', FAST);
    await expect(unlockKeyBlock(block, '')).rejects.toBeInstanceOf(WrongPasswordError);
  });
});

describe('password edge cases', () => {
  it('unlocks across Unicode normalization forms but not case/whitespace changes', async () => {
    const nfc = 'café pass'; // precomposed (NFC)
    const nfd = 'café pass'; // e + combining acute (NFD) - same rendered text
    expect(nfc).not.toBe(nfd); // genuinely different byte sequences
    expect(nfc.normalize('NFC')).toBe(nfd.normalize('NFC'));

    // A vault created with the NFC form unlocks when the password is later
    // typed in the NFD form (and vice versa) - the whole point of §5.1.
    const { block } = await createKeyBlock(nfc, FAST);
    await expect(unlockKeyBlock(block, nfc)).resolves.toBeTruthy();
    await expect(unlockKeyBlock(block, nfd)).resolves.toBeTruthy();

    const { block: block2 } = await createKeyBlock(nfd, FAST);
    await expect(unlockKeyBlock(block2, nfc)).resolves.toBeTruthy();

    // Normalization is NOT case-folding or trimming: those still fail.
    for (const wrong of ['CAFÉ PASS', ` ${nfc}`, `${nfc} `, nfc.slice(0, -1)]) {
      await expect(unlockKeyBlock(block, wrong)).rejects.toBeInstanceOf(WrongPasswordError);
    }
  });

  it('supports emoji and embedded-NUL passwords round-trip', async () => {
    for (const password of ['\u{1f511}\u{1f40e}\u{1f50b}', 'pa\u0000ss', 'x'.repeat(1024)]) {
      const { block } = await createKeyBlock(password, FAST);
      await expect(unlockKeyBlock(block, password)).resolves.toBeTruthy();
      await expect(unlockKeyBlock(block, password + '.')).rejects.toBeInstanceOf(
        WrongPasswordError,
      );
    }
  });
});

describe('Argon2id parameter boundaries', () => {
  const base: Argon2Params = { iterations: 3, memoryKiB: 1024, parallelism: 1 };

  const accepted: Partial<Argon2Params>[] = [
    { iterations: 1 },
    { iterations: 16 },
    { memoryKiB: 8 },
    { memoryKiB: 1024 * 1024 },
    { parallelism: 1 },
    { parallelism: 4 },
  ];
  const rejected: Partial<Argon2Params>[] = [
    { iterations: 0 },
    { iterations: 17 },
    { iterations: 1.5 },
    { iterations: -1 },
    { memoryKiB: 7 },
    { memoryKiB: 1024 * 1024 + 1 },
    { memoryKiB: 0xffffffff },
    { parallelism: 0 },
    { parallelism: 5 },
    { iterations: Number.NaN },
    { memoryKiB: Number.POSITIVE_INFINITY },
  ];

  for (const patch of accepted) {
    it(`accepts ${JSON.stringify(patch)}`, () => {
      expect(() => validateArgon2Params({ ...base, ...patch })).not.toThrow();
    });
  }
  for (const patch of rejected) {
    it(`rejects ${JSON.stringify(patch)}`, () => {
      expect(() => validateArgon2Params({ ...base, ...patch })).toThrow(/out of range/);
    });
  }

  it('parseKeyBlock enforces the limits on attacker-controlled bytes', async () => {
    const { block } = await createKeyBlock('pw', FAST);
    // Each patch is applied to the serialized bytes, then must fail to parse.
    const patches: { offset: number; value: number[]; name: string }[] = [
      { offset: 5, value: [0, 0, 0, 0], name: 'iterations 0' },
      { offset: 5, value: [0, 0, 0, 17], name: 'iterations 17' },
      { offset: 9, value: [0xff, 0xff, 0xff, 0xff], name: 'memoryKiB ~4TiB' },
      { offset: 9, value: [0, 0, 0, 7], name: 'memoryKiB 7' },
      { offset: 13, value: [0], name: 'parallelism 0' },
      { offset: 13, value: [5], name: 'parallelism 5' },
    ];
    for (const p of patches) {
      const bytes = serializeKeyBlock(block);
      bytes.set(p.value, p.offset);
      expect(() => parseKeyBlock(bytes), p.name).toThrow(/out of range/);
    }
  });
});

describe('seeded fuzzing (reproducible)', () => {
  it('parseKeyBlock never crashes or mis-parses random garbage', () => {
    const rnd = makePrng(0xc0ffee);
    for (let round = 0; round < 2000; round++) {
      const len = (rnd() * 256 + rnd()) % 200;
      const buf = Uint8Array.from({ length: len }, () => rnd());
      // Random bytes can't produce the 4-byte magic + valid structure except
      // with probability ~2^-32 per attempt — a throw is the only sane result.
      expect(() => parseKeyBlock(buf)).toThrow(Error);
    }
  });

  it('random multi-byte mutations of a valid block never unlock', async () => {
    const password = 'fuzz password';
    const { block } = await createKeyBlock(password, FAST);
    const original = serializeKeyBlock(block);
    const rnd = makePrng(0xdecade);

    for (let round = 0; round < 150; round++) {
      const mutated = original.slice();
      const nMut = 1 + (rnd() % 4);
      for (let j = 0; j < nMut; j++) {
        const pos = (rnd() * 256 + rnd()) % mutated.length;
        mutated[pos] = mutated[pos]! ^ (1 + (rnd() % 255)); // guaranteed change
      }
      const err = await unlockSerialized(mutated, password);
      expect(err, `mutation round ${round}`).toBeInstanceOf(Error);
    }
  });
});

describe('AES-GCM shape and misuse rejection', () => {
  it('ciphertext is exactly plaintext length + 16-byte tag, all sizes', async () => {
    const { dek } = await createKeyBlock('pw', FAST);
    for (const size of [0, 1, 15, 16, 17, 1000]) {
      const pt = randomBytes(size);
      const { iv, ciphertext } = await encryptBytes(dek, pt);
      expect(iv.length).toBe(IV_LEN);
      expect(ciphertext.length).toBe(size + GCM_TAG_LEN);
      const back = await decryptBytes(dek, iv, ciphertext);
      expect(toHex(back)).toBe(toHex(pt));
    }
  });

  it('rejects a wrong-length IV outright', async () => {
    const { dek } = await createKeyBlock('pw', FAST);
    const { iv, ciphertext } = await encryptBytes(dek, new Uint8Array(4));
    for (const badIv of [iv.slice(0, 11), new Uint8Array(0), new Uint8Array(16)]) {
      await expect(decryptBytes(dek, badIv, ciphertext)).rejects.toBeInstanceOf(RangeError);
    }
  });

  it('rejects ciphertext shorter than the tag, and the empty ciphertext', async () => {
    const { dek } = await createKeyBlock('pw', FAST);
    const { iv } = await encryptBytes(dek, new Uint8Array(4));
    for (const bad of [new Uint8Array(0), new Uint8Array(GCM_TAG_LEN - 1)]) {
      await expect(decryptBytes(dek, iv, bad)).rejects.toBeTruthy();
    }
  });

  it("rejects decryption under another message's IV", async () => {
    const { dek } = await createKeyBlock('pw', FAST);
    const a = await encryptBytes(dek, new Uint8Array(32));
    const b = await encryptBytes(dek, new Uint8Array(32));
    await expect(decryptBytes(dek, b.iv, a.ciphertext)).rejects.toBeTruthy();
  });

  it('rejects a swap of two wrapped DEKs between blocks (no mix-and-match)', async () => {
    const a = await createKeyBlock('same password', FAST);
    const b = await createKeyBlock('same password', FAST);
    // Same password, but different salts → different KEKs: a's wrapped DEK
    // must not unwrap under b's salt/iv and vice versa.
    const franken: KeyBlock = { ...a.block, wrapped: b.block.wrapped };
    await expect(unlockKeyBlock(franken, 'same password')).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it('wrapped DEK length is fixed: DEK + tag', async () => {
    const { block } = await createKeyBlock('pw', FAST);
    expect(block.wrapped.length).toBe(DEK_LEN + GCM_TAG_LEN);
  });

  it('serializeKeyBlock refuses malformed salt or IV lengths', async () => {
    const { block } = await createKeyBlock('pw', FAST);
    expect(() => serializeKeyBlock({ ...block, salt: block.salt.slice(1) })).toThrow(RangeError);
    expect(() => serializeKeyBlock({ ...block, iv: block.iv.slice(1) })).toThrow(RangeError);
  });
});
