/**
 * Adversarial hardening tests for the crypto core.
 *
 *  - Entropy audit: every random value flows through crypto.getRandomValues
 *    (CSPRNG); no Math.random anywhere in the core; IVs and salts never repeat.
 *  - Negative testing: exhaustive single-byte corruption of the key block,
 *    truncation ladders, parameter boundary matrix, seeded fuzzing; nothing
 *    ever "succeeds wrong", crashes the process, or leaks the failure cause.
 *  - Failure indistinguishability: a wrong password and a tampered block throw
 *    the identical typed error, so an attacker learns nothing from the message.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  type Argon2Params,
  type KeyBlock,
  DEFAULT_ARGON2,
  DEK_LEN,
  GCM_TAG_LEN,
  IV_LEN,
  KEY_BLOCK_LEN,
  SALT_LEN,
  WrongPasswordError,
  clearUserEntropy,
  createKeyBlock,
  decryptBytes,
  encryptBytes,
  hasUserEntropy,
  hkdf,
  installUserEntropy,
  aeadOpen,
  aeadSeal,
  importAesGcmKey,
  isSerializedKeyBlock,
  parseKeyBlock,
  randomBytes,
  serializeKeyBlock,
  unlockKeyBlock,
  validateArgon2Params,
} from './crypto';
import { toHex } from './bytes';
import { createHMAC, createSHA256 } from 'hash-wasm';
import { EMPTY_AAD } from './aad';

// Minimal-cost valid params: many tests below run hundreds of derivations.
const FAST: Argon2Params = { iterations: 1, memoryKiB: 64, parallelism: 1 };

/** Deterministic PRNG for reproducible fuzzing (NOT crypto; test-only). */
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
      await encryptBytes(dek, new Uint8Array(8), EMPTY_AAD);
      expect(spy.mock.calls.some((c) => (c[0] as Uint8Array).length === IV_LEN)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it(
    'never repeats an IV across many encryptions with the same key',
    { timeout: 15000 },
    async () => {
      const { dek } = await createKeyBlock('pw', FAST);
      const seen = new Set<string>();
      for (let i = 0; i < 2000; i++) {
        const { iv } = await encryptBytes(dek, new Uint8Array(1), EMPTY_AAD);
        const hex = toHex(iv);
        expect(seen.has(hex)).toBe(false);
        seen.add(hex);
      }
    },
  );

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

describe('optional user entropy layer', () => {
  afterEach(() => {
    clearUserEntropy();
  });

  it('still draws every byte from the CSPRNG when installed', async () => {
    await installUserEntropy('dice: 4 1 6 2 5 3');
    expect(hasUserEntropy()).toBe(true);
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    try {
      spy.mockClear();
      const out = randomBytes(64);
      expect(out.length).toBe(64);
      // The CSPRNG must be consulted for the full length; the user layer is a
      // second source, never a substitute.
      expect(spy.mock.calls.map((c) => (c[0] as Uint8Array).length)).toContain(64);
    } finally {
      spy.mockRestore();
    }
  });

  it('contributes: draws differ even when the CSPRNG is stuck at a constant', async () => {
    await installUserEntropy('mashed keys asdlkfjasdlkfj');
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    try {
      spy.mockImplementation(((buf: Uint8Array) => {
        buf.fill(7); // a totally broken "CSPRNG"
        return buf;
      }) as typeof globalThis.crypto.getRandomValues);
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) {
        const hex = toHex(randomBytes(16));
        expect(hex).not.toBe('07'.repeat(16)); // the user layer did something
        expect(seen.has(hex)).toBe(false);
        seen.add(hex);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('the CSPRNG contributes: same string, same session, draws never repeat', async () => {
    await installUserEntropy('a'); // a deliberately worthless string
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const hex = toHex(randomBytes(SALT_LEN));
      expect(seen.has(hex)).toBe(false);
      seen.add(hex);
    }
  });

  it('re-installing the same string yields a different keystream (session salt)', async () => {
    const fixedCsprng = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((
      buf: Uint8Array,
    ) => {
      buf.fill(0);
      return buf;
    }) as typeof globalThis.crypto.getRandomValues);
    try {
      // The session salt itself comes from the (stubbed) CSPRNG here, so force a
      // difference through the salt draw instead: restore, install, stub again.
      fixedCsprng.mockRestore();
      await installUserEntropy('same string');
      vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((buf: Uint8Array) => {
        buf.fill(0);
        return buf;
      }) as typeof globalThis.crypto.getRandomValues);
      const first = toHex(randomBytes(32));
      vi.restoreAllMocks();

      await installUserEntropy('same string');
      vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((buf: Uint8Array) => {
        buf.fill(0);
        return buf;
      }) as typeof globalThis.crypto.getRandomValues);
      const second = toHex(randomBytes(32));
      expect(second).not.toBe(first);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('clearing restores plain CSPRNG passthrough', async () => {
    await installUserEntropy('temporary');
    clearUserEntropy();
    expect(hasUserEntropy()).toBe(false);
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    try {
      spy.mockImplementation(((buf: Uint8Array) => {
        buf.fill(9);
        return buf;
      }) as typeof globalThis.crypto.getRandomValues);
      expect(toHex(randomBytes(8))).toBe('09'.repeat(8));
    } finally {
      spy.mockRestore();
    }
  });

  it('an empty string installs nothing, and tears down a previous layer', async () => {
    await installUserEntropy('first');
    expect(hasUserEntropy()).toBe(true);
    await installUserEntropy('');
    expect(hasUserEntropy()).toBe(false);
  });

  it('mixed output still looks uniform', async () => {
    await installUserEntropy('dice rolls: 3 6 1 2 4 5 5 2');
    const n = 65536;
    const buf = randomBytes(n);
    const counts = new Array<number>(256).fill(0);
    let sum = 0;
    for (const b of buf) {
      counts[b]!++;
      sum += b;
    }
    expect(counts.every((c) => c > 0)).toBe(true);
    const mean = sum / n;
    expect(mean).toBeGreaterThan(120);
    expect(mean).toBeLessThan(135);
  });

  it('a vault written with extra entropy needs none to unlock (no format impact)', async () => {
    await installUserEntropy('paranoid dice');
    const { block } = await createKeyBlock('pw', FAST);
    const bytes = serializeKeyBlock(block);
    clearUserEntropy();
    expect(await unlockSerialized(bytes, 'pw')).toBeNull();
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
        // wrong-password error; nothing about *what* broke may leak.
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
    // 0xff rather than "the next version up": this assertion is about rejecting
    // what the reader does not know, and pinning it to the current constant + 1
    // would silently start testing the supported version on the next bump.
    bytes[4] = 0xff;
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
    { iterations: 4 },
    { memoryKiB: 8 },
    { memoryKiB: 256 * 1024 },
    // Parallelism is pinned: min and max are both 1, so this single row is the
    // whole accepted range and `{ parallelism: 2 }` below is its max + 1.
    { parallelism: 1 },
  ];
  const rejected: Partial<Argon2Params>[] = [
    { iterations: 0 },
    { iterations: 5 },
    { iterations: 1.5 },
    { iterations: -1 },
    { memoryKiB: 7 },
    { memoryKiB: 256 * 1024 + 1 },
    { memoryKiB: 0xffffffff },
    { parallelism: 0 },
    { parallelism: 2 },
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
      { offset: 13, value: [2], name: 'parallelism 2' },
      { offset: 13, value: [5], name: 'parallelism 5' },
    ];
    for (const p of patches) {
      const bytes = serializeKeyBlock(block);
      bytes.set(p.value, p.offset);
      expect(() => parseKeyBlock(bytes), p.name).toThrow(/out of range/);
    }
  });

  // DEFAULT_ARGON2 is the default argument of every derivation in crypto.ts, so a
  // single mutation would weaken every KDF in the process at once. Frozen, the
  // attempt throws in strict mode (ES modules are always strict) instead of
  // silently succeeding.
  it('DEFAULT_ARGON2 cannot be weakened in place', () => {
    expect(Object.isFrozen(DEFAULT_ARGON2)).toBe(true);
    const mutable = DEFAULT_ARGON2 as Argon2Params;
    expect(() => {
      mutable.memoryKiB = 8;
    }).toThrow(TypeError);
    expect(DEFAULT_ARGON2.memoryKiB).toBe(256 * 1024);
    expect(DEFAULT_ARGON2.iterations).toBe(4);
    expect(DEFAULT_ARGON2.parallelism).toBe(1);
  });
});

describe('seeded fuzzing (reproducible)', () => {
  it('parseKeyBlock never crashes or mis-parses random garbage', () => {
    const rnd = makePrng(0xc0ffee);
    for (let round = 0; round < 2000; round++) {
      const len = (rnd() * 256 + rnd()) % 200;
      const buf = Uint8Array.from({ length: len }, () => rnd());
      // Random bytes can't produce the 4-byte magic + valid structure except
      // with probability ~2^-32 per attempt, so a throw is the only sane result.
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
      const { iv, ciphertext } = await encryptBytes(dek, pt, EMPTY_AAD);
      expect(iv.length).toBe(IV_LEN);
      expect(ciphertext.length).toBe(size + GCM_TAG_LEN);
      const back = await decryptBytes(dek, iv, ciphertext, EMPTY_AAD);
      expect(toHex(back)).toBe(toHex(pt));
    }
  });

  it('rejects a wrong-length IV outright', async () => {
    const { dek } = await createKeyBlock('pw', FAST);
    const { iv, ciphertext } = await encryptBytes(dek, new Uint8Array(4), EMPTY_AAD);
    for (const badIv of [iv.slice(0, 11), new Uint8Array(0), new Uint8Array(16)]) {
      await expect(decryptBytes(dek, badIv, ciphertext, EMPTY_AAD)).rejects.toBeInstanceOf(
        RangeError,
      );
    }
  });

  it('rejects ciphertext shorter than the tag, and the empty ciphertext', async () => {
    const { dek } = await createKeyBlock('pw', FAST);
    const { iv } = await encryptBytes(dek, new Uint8Array(4), EMPTY_AAD);
    for (const bad of [new Uint8Array(0), new Uint8Array(GCM_TAG_LEN - 1)]) {
      await expect(decryptBytes(dek, iv, bad, EMPTY_AAD)).rejects.toBeTruthy();
    }
  });

  it("rejects decryption under another message's IV", async () => {
    const { dek } = await createKeyBlock('pw', FAST);
    const a = await encryptBytes(dek, new Uint8Array(32), EMPTY_AAD);
    const b = await encryptBytes(dek, new Uint8Array(32), EMPTY_AAD);
    await expect(decryptBytes(dek, b.iv, a.ciphertext, EMPTY_AAD)).rejects.toBeTruthy();
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

/**
 * The §10 AEAD primitives' own argument checks, and the cheap structural test the
 * stego layer leans on. Every one of these was reported as no coverage: the lines
 * had never run at all, so each guard could have been deleted with the suite
 * still green.
 */
describe('primitive argument guards', () => {
  const EMPTY_AAD = new Uint8Array(0);

  async function aesKey(): Promise<CryptoKey> {
    return importAesGcmKey(randomBytes(DEK_LEN));
  }

  /**
   * `aeadSeal` and `aeadOpen` exist as a separate pair from `encryptBytes` so the
   * counter-nonce discipline of §10 is never crossed with the random-IV one. That
   * separation is only worth anything if the nonce they are handed is the length
   * they expect, since a short nonce is silently padded by some implementations
   * and a repeated one is catastrophic for GCM.
   */
  it.each([11, 13, 0, 16])('refuses a %i-byte nonce on both seal and open', async (len) => {
    const key = await aesKey();
    const nonce = randomBytes(len);
    // The message is asserted, not only the type. A first version of this test
    // checked `RangeError` alone, and mutation testing answered that emptying the
    // message changes nothing it can see: a caller handed a bare RangeError out
    // of a crypto primitive is left guessing which argument was wrong.
    await expect(aeadSeal(key, nonce, randomBytes(8), EMPTY_AAD)).rejects.toThrow(
      /aead: bad nonce length/,
    );
    await expect(aeadOpen(key, nonce, randomBytes(32), EMPTY_AAD)).rejects.toThrow(
      /aead: bad nonce length/,
    );
    await expect(aeadSeal(key, nonce, randomBytes(8), EMPTY_AAD)).rejects.toBeInstanceOf(
      RangeError,
    );
  });

  it('accepts exactly the nonce length it documents, so the guard is not simply always on', async () => {
    const key = await aesKey();
    const nonce = randomBytes(IV_LEN);
    const sealed = await aeadSeal(key, nonce, randomBytes(8), EMPTY_AAD);
    expect(sealed.length).toBe(8 + GCM_TAG_LEN);
    expect((await aeadOpen(key, nonce, sealed, EMPTY_AAD)).length).toBe(8);
  });

  /**
   * The stego layer calls this on every de-whitened candidate to decide, without
   * throwing, whether it is looking at a key block or at noise from a wrong
   * password. A length check that answered `true` for the wrong length would turn
   * "no key here" into a parse attempt on arbitrary bytes.
   */
  /**
   * Each of the three checks is defeated on its own.
   *
   * A first version of this used buffers of zeros at various lengths, which fail
   * the length, the magic and the version all at once. Every mutant survived it:
   * a fixture that breaks everything pins nothing, because deleting any single
   * check still leaves two others to reject it. Each case below is a valid key
   * block with exactly one property spoiled.
   */
  it('rejects a buffer failing any one of length, magic or version', async () => {
    const { block } = await createKeyBlock('pw', FAST);
    const real = serializeKeyBlock(block);
    expect(real.length).toBe(KEY_BLOCK_LEN);
    expect(isSerializedKeyBlock(real), 'a real block must be recognised').toBe(true);

    // Length only: a real block with one byte appended, so magic and version are
    // still correct and the length check is the only thing that can refuse it.
    const tooLong = new Uint8Array(KEY_BLOCK_LEN + 1);
    tooLong.set(real);
    expect(isSerializedKeyBlock(tooLong), 'trailing byte').toBe(false);
    expect(isSerializedKeyBlock(real.slice(0, KEY_BLOCK_LEN - 1)), 'one byte short').toBe(false);

    // Magic only: right length, right version, one wrong byte in the four-byte
    // tag. Every position, so a loop that stops early is caught too.
    for (let i = 0; i < 4; i++) {
      const badMagic = real.slice();
      badMagic[i] = badMagic[i]! ^ 0xff;
      expect(isSerializedKeyBlock(badMagic), `magic byte ${i}`).toBe(false);
    }

    // Version only: right length, right magic, an unsupported version.
    const badVersion = real.slice();
    badVersion[4] = badVersion[4]! + 1;
    expect(isSerializedKeyBlock(badVersion), 'unsupported version').toBe(false);
  });
});

/**
 * The shape of the user-entropy keystream, not just that it contributes.
 *
 * The tests above establish that the CSPRNG is still consulted and that the
 * layer changes the output. Neither says anything about *how* the keystream is
 * consumed, and the whole cluster of surviving mutants sat there: the block
 * refill, the offset tracking, the counter increment. A layer that restarted its
 * counter on every draw would pass every assertion above while XORing the same
 * keystream into two different secrets, which is the classic two-time-pad
 * failure and would be worse than having no layer at all.
 *
 * The construction becomes deterministic under a stubbed CSPRNG, which is what
 * makes this testable: `installUserEntropy` clears the pool before drawing its
 * session salt, so that draw is unmixed, and a CSPRNG stuck at zero yields a
 * fixed salt, a fixed HKDF key, and therefore a fixed keystream. With the CSPRNG
 * contributing zeros, `randomBytes` returns the keystream itself.
 */
describe('user-entropy keystream discipline', () => {
  const TEXT = 'dice 3 1 4 1 5 9 2 6';

  afterEach(() => {
    clearUserEntropy();
  });

  /** Run `fn` with the CSPRNG stuck at zero, so draws expose the keystream. */
  async function withZeroCsprng<T>(fn: () => Promise<T>): Promise<T> {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    spy.mockImplementation(((buf: Uint8Array) => {
      buf.fill(0);
      return buf;
    }) as typeof globalThis.crypto.getRandomValues);
    try {
      return await fn();
    } finally {
      spy.mockRestore();
    }
  }

  it('is one continuous stream: the same bytes however a draw is split', async () => {
    await withZeroCsprng(async () => {
      // A fixed salt makes the layer reproducible across installs, so these four
      // runs are comparable at all.
      await installUserEntropy(TEXT);
      const whole = toHex(randomBytes(64));

      // 64 bytes is two SHA-256 keystream blocks, so this crosses a refill.
      expect(whole).not.toBe('00'.repeat(64));
      expect(whole.slice(0, 64)).not.toBe(whole.slice(64)); // block 0 != block 1

      for (const split of [
        [32, 32],
        [16, 16, 16, 16],
        [1, 63],
        [63, 1],
        [40, 24],
      ]) {
        await installUserEntropy(TEXT);
        const parts = split.map((n) => toHex(randomBytes(n))).join('');
        expect(parts, `split ${split.join('+')}`).toBe(whole);
      }
    });
  });

  it('never hands the same keystream to two draws in a session', async () => {
    await withZeroCsprng(async () => {
      await installUserEntropy(TEXT);
      const seen = new Set<string>();
      // Deliberately not a multiple of the 32-byte block, so a draw that ends
      // mid-block is followed by one that must resume mid-block.
      for (let i = 0; i < 40; i++) {
        const hex = toHex(randomBytes(20));
        expect(seen.has(hex), `draw ${i} repeated a keystream slice`).toBe(false);
        seen.add(hex);
      }
    });
  });

  it('re-seeds on reinstall rather than continuing the old stream', async () => {
    // The real CSPRNG here: a fresh session salt per install is the property, and
    // stubbing it to zero would defeat exactly what is being measured.
    await installUserEntropy(TEXT);
    const first = toHex(randomBytes(32));
    await installUserEntropy(TEXT);
    const second = toHex(randomBytes(32));
    expect(second).not.toBe(first);
  });

  it('stops contributing once cleared', async () => {
    await withZeroCsprng(async () => {
      await installUserEntropy(TEXT);
      expect(toHex(randomBytes(32))).not.toBe('00'.repeat(32));
      clearUserEntropy();
      expect(hasUserEntropy()).toBe(false);
      // With no layer and a zeroed CSPRNG, the draw is exactly what the CSPRNG
      // gave: nothing is left mixing in.
      expect(toHex(randomBytes(32))).toBe('00'.repeat(32));
    });
  });
});

/**
 * `getRandomValues` refuses more than 65536 bytes per call, so larger requests
 * are filled in windows. The windows have to tile the output exactly: a gap
 * leaves zeros inside what a caller believes is random, and §10.4 fills dead
 * regions up to the .db bucket ceiling this way, where a zeroed stretch would be
 * a visible tell in a container whose whole purpose is to look unremarkable.
 */
describe('large draws are filled in windows that tile exactly', () => {
  it.each([65_536, 65_537, 131_072, 200_000])('covers every byte of a %i-byte draw', (len) => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const windows: [number, number][] = [];
    spy.mockImplementation(((buf: Uint8Array) => {
      windows.push([buf.byteOffset, buf.length]);
      buf.fill(0xab);
      return buf;
    }) as typeof globalThis.crypto.getRandomValues);
    try {
      const out = randomBytes(len);
      expect(out.length).toBe(len);

      // No window may exceed the platform cap, or the call would have thrown.
      for (const [, n] of windows) expect(n).toBeLessThanOrEqual(65_536);

      // Contiguous from 0 to len, no gap and no overlap.
      windows.sort((a, b) => a[0] - b[0]);
      let cursor = 0;
      for (const [off, n] of windows) {
        expect(off, `window starts at ${off}, expected ${cursor}`).toBe(cursor);
        cursor += n;
      }
      expect(cursor).toBe(len);

      // And the bytes really landed: an unfilled gap would still be zero.
      expect(out.every((b) => b === 0xab)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * The keystream against an independently computed expectation.
 *
 * Everything above compares the layer to itself: a split draw against a whole
 * one, one draw against the next. Those are strong properties and they miss a
 * whole class of fault, because a construction that refilled its block on every
 * single byte would satisfy all of them and still be a different cipher than the
 * one SPEC and the crypto dossier describe.
 *
 * So this restates the construction from the outside, the way the committed
 * crypto vectors do: `HKDF-SHA256` over the NFC text with a known salt and info,
 * then `HMAC-SHA256(key, u64be(counter))`, and asserts the bytes match. The info
 * label is spelled out rather than imported, so a change to it has to be made
 * twice, deliberately.
 */
describe('user-entropy keystream matches an independent derivation', () => {
  afterEach(() => {
    clearUserEntropy();
  });

  it('is HMAC-SHA256(HKDF(text), counter) from block zero', async () => {
    const TEXT = 'a known phrase for the vector';
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    spy.mockImplementation(((buf: Uint8Array) => {
      buf.fill(0);
      return buf;
    }) as typeof globalThis.crypto.getRandomValues);

    let got: string;
    try {
      // With the CSPRNG at zero the session salt is 32 zero bytes, so the whole
      // layer is reproducible, and the draw is the keystream unchanged.
      await installUserEntropy(TEXT);
      got = toHex(randomBytes(64));
    } finally {
      spy.mockRestore();
    }

    const info = new TextEncoder().encode('stegoshard/v1/user-entropy');
    const key = await hkdf(
      new TextEncoder().encode(TEXT.normalize('NFC')),
      info,
      32,
      new Uint8Array(32),
    );
    const hmac = await createHMAC(createSHA256(), key);
    const block = (counter: number): Uint8Array => {
      const ctr = new Uint8Array(8);
      new DataView(ctr.buffer).setUint32(0, Math.floor(counter / 0x1_0000_0000));
      new DataView(ctr.buffer).setUint32(4, counter >>> 0);
      hmac.init();
      hmac.update(ctr);
      return hmac.digest('binary') as Uint8Array;
    };

    expect(got).toBe(toHex(block(0)) + toHex(block(1)));
  });
});

/**
 * The windowing above is checked with a stubbed CSPRNG, which is what lets the
 * windows be observed at all, and which also removes the constraint that makes
 * the branch exist. This draws large through the real one.
 *
 * `crypto.getRandomValues` throws `QuotaExceededError` past 65,536 bytes, so a
 * build that dropped the windowing would fail here and nowhere else in the
 * suite.
 *
 * Three mutants in these ten lines survive both tests and always will, recorded
 * so nobody spends an afternoon on them:
 *
 * - `len <= MAX` weakened to `len < MAX` sends exactly 65,536 bytes down the
 *   windowed path, which produces a single window covering the whole buffer. The
 *   same bytes, by a slightly longer route.
 * - the same condition forced to `false` sends everything that way, for the same
 *   reason: one window is what the loop makes of any length up to the cap.
 * - `off < len` widened to `off <= len` adds one final pass with
 *   `subarray(len, len)`, an empty view, which fills nothing.
 *
 * All three are the fast path being optional rather than load-bearing. The
 * output is identical, so no assertion can separate them.
 */
describe('a large draw goes through the real CSPRNG without tripping its cap', () => {
  it.each([65_536, 65_537, 200_000])('draws %i bytes', (len) => {
    const out = randomBytes(len);
    expect(out.length).toBe(len);
    // Not a randomness test: just proof that every window was actually written,
    // since an unfilled tail would stay zero.
    expect(out.subarray(len - 64).some((b) => b !== 0)).toBe(true);
    expect(out.subarray(0, 64).some((b) => b !== 0)).toBe(true);
  });
});

/**
 * Two structural guards in `parseKeyBlock` that the corruption sweep above walks
 * past.
 *
 * That sweep flips bytes inside a valid block, so it always hands the parser
 * something of the right length. These are the guards for a block of the wrong
 * length: one at the bottom of the fixed prefix, one where a declared payload
 * length outruns the bytes that follow it. Both are parsing untrusted input,
 * both could be deleted with the suite green.
 */
describe('key block length guards', () => {
  const FIXED_PREFIX = 44; // magic 4 + ver 1 + iter 4 + mem 4 + par 1 + salt 16 + iv 12 + len 2

  it('puts the too-short boundary exactly at the fixed prefix', async () => {
    const { block } = await createKeyBlock('pw', FAST);
    const real = serializeKeyBlock(block);

    // One byte below the prefix cannot describe a block at all.
    expect(() => parseKeyBlock(real.slice(0, FIXED_PREFIX - 1))).toThrow(/too short/);

    // At the prefix it is no longer this guard's business. The block is still
    // rejected, further down, for declaring a payload it does not carry: what
    // matters here is that the refusal changes, so the boundary is where the
    // code says it is rather than one byte off.
    expect(() => parseKeyBlock(real.slice(0, FIXED_PREFIX))).not.toThrow(/too short/);
  });

  it('refuses a block whose declared payload runs past its bytes', async () => {
    const { block } = await createKeyBlock('pw', FAST);
    const real = serializeKeyBlock(block);

    // The wrapped length is the last two bytes of the fixed prefix. Claim one
    // byte more than the block actually carries.
    const lying = real.slice();
    const declared = (lying[FIXED_PREFIX - 2]! << 8) | lying[FIXED_PREFIX - 1]!;
    lying[FIXED_PREFIX - 2] = ((declared + 1) >> 8) & 0xff;
    lying[FIXED_PREFIX - 1] = (declared + 1) & 0xff;

    expect(() => parseKeyBlock(lying)).toThrow(/truncated/);
    // And the honest one still parses, so this is about the length field and not
    // about the block.
    expect(() => parseKeyBlock(real)).not.toThrow();
  });
});
