/**
 * The JPEG key-photo paths leave no derived secret behind (issue #240).
 *
 * Found by mutation testing: deleting any of five `fill(0)` calls in
 * `embedFixedStegoJpeg` / `extractFixedStegoJpeg` left every test green. Those
 * mutants used to time out and count as detected, which hid the gap until the
 * run got fast enough to finish them. Writing these tests then turned up three
 * leaks the wipes did not cover: the embed's message on a failed `stcEmbed`, the
 * extract's own message (never wiped), and every extract secret whenever
 * something threw between deriving it and wiping it.
 *
 * `stego.keystream.test.ts` counts wipes by length on the RGBA path. This file
 * holds on to the buffers themselves, as `crypto.zeroize.test.ts` does, because
 * a count cannot say *which* 32-byte buffer was wiped and the extract path has
 * three of them. Each secret is caught where it is made:
 *
 * - the Argon2id seed, the password-derived root of all of them, is what
 *   `argon2id` returns.
 * - cover keys (`k1`, `k0`, and `keystream`'s `ckey`) are 32-byte `hkdf` outputs.
 *   The 16-byte cover-guard tag also comes from `hkdf`, but it is stored on
 *   purpose, so only 32-byte outputs are kept.
 * - keystreams (`stream`, `s1`, `s0`) are views over the buffer an AES-CTR
 *   `subtle.encrypt` returns, so wiping the view wipes that buffer.
 * - the whitened message is the third argument to `stcEmbed` on embed, and what
 *   `stcExtract` returns on extract.
 *
 * The same wrappers can be told to throw, which is how the failure paths are
 * reached without touching the code under test.
 *
 * Same honest limit as the other two files: this proves the bytes are zero when
 * the call settles, not that no copy was ever made elsewhere.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jpeg from 'jpeg-js';

const INJECTED = new Error('injected failure');

const seeds: Uint8Array[] = [];
// Delegates to the real implementation, as stego.key-s1.test.ts does.
vi.mock('hash-wasm', async (importOriginal) => {
  const real = await importOriginal<typeof import('hash-wasm')>();
  return {
    ...real,
    // `unknown` because argon2id's overloads return a string or bytes depending
    // on `outputType`, and Parameters<> only sees the string one.
    argon2id: (async (...args: Parameters<typeof real.argon2id>) => {
      const out: unknown = await real.argon2id(...args);
      if (out instanceof Uint8Array) seeds.push(out);
      return out;
    }) as typeof real.argon2id,
  };
});

const coverKeys: Uint8Array[] = [];
vi.mock('./crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('./crypto')>();
  return {
    ...real,
    hkdf: async (...args: Parameters<typeof real.hkdf>) => {
      const out = await real.hkdf(...args);
      if (out.length === 32) coverKeys.push(out);
      return out;
    },
  };
});

const embedded: Uint8Array[] = [];
const extracted: Uint8Array[] = [];
const fail = { stcEmbed: false, stcExtract: false, ctrCall: 0 };
vi.mock('./stc', async (importOriginal) => {
  const real = await importOriginal<typeof import('./stc')>();
  return {
    ...real,
    stcEmbed: (...args: Parameters<typeof real.stcEmbed>) => {
      embedded.push(args[2]);
      // After the message is built, so a wipe on the way out has bytes to clear.
      if (fail.stcEmbed) throw INJECTED;
      return real.stcEmbed(...args);
    },
    stcExtract: (...args: Parameters<typeof real.stcExtract>) => {
      if (fail.stcExtract) throw INJECTED;
      const out = real.stcExtract(...args);
      extracted.push(out);
      return out;
    },
  };
});

const {
  createKeyBlock,
  embedKeyBlockStegoJpeg,
  extractKeyBlockStegoJpeg,
  resetStegoCoverGuard,
  serializeKeyBlock,
} = await import('./index');

const FAST = { iterations: 1, memoryKiB: 64, parallelism: 1 };

let keystreams: ArrayBuffer[] = [];
let ctrCalls = 0;

beforeEach(() => {
  resetStegoCoverGuard();
  const subtle = globalThis.crypto.subtle;
  const real = subtle.encrypt.bind(subtle);
  vi.spyOn(subtle, 'encrypt').mockImplementation(async (algorithm, key, data) => {
    const ctr = typeof algorithm === 'object' && algorithm.name === 'AES-CTR';
    if (ctr && ++ctrCalls === fail.ctrCall) throw INJECTED;
    const out = await real(algorithm, key, data);
    if (ctr) keystreams.push(out);
    return out;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fail.stcEmbed = false;
  fail.stcExtract = false;
  fail.ctrCall = 0;
});

/** A textured q85 baseline JPEG, so it has plenty of |coef| ≥ 2 carriers. */
function noisyJpeg(side: number, seed = 1): Uint8Array {
  const data = Buffer.alloc(side * side * 4);
  let s = seed >>> 0;
  for (let i = 0; i < side * side; i++) {
    for (let c = 0; c < 3; c++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      data[i * 4 + c] = s >>> 24;
    }
    data[i * 4 + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data, width: side, height: side }, 85).data);
}

async function keyBlock(password: string): Promise<Uint8Array> {
  return serializeKeyBlock((await createKeyBlock(password, FAST)).block);
}

/** Forget everything recorded so far, so only `run` is measured. */
async function during<T>(run: () => Promise<T>): Promise<T> {
  seeds.length = 0;
  coverKeys.length = 0;
  embedded.length = 0;
  extracted.length = 0;
  keystreams = [];
  ctrCalls = 0;
  return run();
}

function allZero(bytes: Uint8Array | ArrayBuffer): boolean {
  return new Uint8Array(bytes).every((b) => b === 0);
}

describe('embedding a key block in a JPEG wipes what it derived', () => {
  it('the keystream, the whitened message, and the cover key', async () => {
    const kb = await keyBlock('pw');
    const cover = noisyJpeg(160, 3);

    await during(() => embedKeyBlockStegoJpeg(cover, kb, 'pw', FAST));

    // One of each, counted so that a path change which stops producing one
    // fails here instead of passing on an empty list.
    expect(keystreams).toHaveLength(1);
    expect(embedded).toHaveLength(1);
    expect(coverKeys).toHaveLength(1);
    expect(allZero(keystreams[0]!), 'the S1 keystream was left in memory').toBe(true);
    expect(allZero(embedded[0]!), 'the whitened message was left in memory').toBe(true);
    expect(allZero(coverKeys[0]!), 'the cover key was left in memory').toBe(true);
    expect(seeds).toHaveLength(1);
    expect(allZero(seeds[0]!), 'the Argon2id seed was left in memory').toBe(true);
  });

  it('wipes the keystream when the embed fails after it was derived', async () => {
    const kb = await keyBlock('pw');
    const cover = noisyJpeg(160, 4);
    const boom = new Error('caller rejected the claim');

    await expect(
      during(() =>
        embedKeyBlockStegoJpeg(cover, kb, 'pw', FAST, {
          onClaim: () => {
            throw boom;
          },
        }),
      ),
    ).rejects.toBe(boom);

    expect(keystreams).toHaveLength(1);
    expect(allZero(keystreams[0]!), 'the failure path kept the keystream').toBe(true);
  });

  it('wipes the whitened message too when the embed fails inside the code', async () => {
    // The message is complete by the time stcEmbed is called, so a failure
    // there is the case where the failure path has real bytes to clear.
    fail.stcEmbed = true;
    const kb = await keyBlock('pw');
    const cover = noisyJpeg(160, 7);

    await expect(during(() => embedKeyBlockStegoJpeg(cover, kb, 'pw', FAST))).rejects.toBe(
      INJECTED,
    );

    expect(embedded).toHaveLength(1);
    expect(allZero(embedded[0]!), 'the failure path kept the whitened message').toBe(true);
    expect(allZero(keystreams[0]!), 'the failure path kept the keystream').toBe(true);
  });
});

describe('extracting a key block from a JPEG wipes what it derived', () => {
  it('S1 cover key, keystream and message when the S1 read succeeds', async () => {
    const kb = await keyBlock('pw');
    const stego = await embedKeyBlockStegoJpeg(noisyJpeg(160, 5), kb, 'pw', FAST);

    const out = await during(() => extractKeyBlockStegoJpeg(stego, 'pw', FAST));

    expect(out, 'the fixture stopped round-tripping, so this measured nothing').toEqual(kb);
    // S1 succeeded, so S0 never ran: one cover key, one keystream, one message.
    expect(coverKeys).toHaveLength(1);
    expect(keystreams).toHaveLength(1);
    expect(extracted).toHaveLength(1);
    expect(allZero(coverKeys[0]!), 'k1 was left in memory').toBe(true);
    expect(allZero(keystreams[0]!), 's1 was left in memory').toBe(true);
    expect(allZero(extracted[0]!), 'the extracted message was left in memory').toBe(true);
    expect(seeds).toHaveLength(1);
    expect(allZero(seeds[0]!), 'the Argon2id seed was left in memory').toBe(true);
  });

  it('both schemes’ keys and keystreams when nothing is found', async () => {
    // A wrong password makes S1 come up empty, which is the only way to reach
    // the S0 fallback and the k0 / s0 it derives.
    const kb = await keyBlock('pw');
    const stego = await embedKeyBlockStegoJpeg(noisyJpeg(160, 6), kb, 'pw', FAST);

    const out = await during(() => extractKeyBlockStegoJpeg(stego, 'not the password', FAST));

    expect(out).toBeNull();
    // k1 then k0, s1 then s0.
    expect(coverKeys).toHaveLength(2);
    expect(keystreams).toHaveLength(2);
    expect(allZero(coverKeys[0]!), 'k1 was left in memory').toBe(true);
    expect(allZero(coverKeys[1]!), 'k0 was left in memory').toBe(true);
    expect(allZero(keystreams[0]!), 's1 was left in memory').toBe(true);
    expect(allZero(keystreams[1]!), 's0 was left in memory').toBe(true);
    expect(allZero(extracted[0]!), 'the S1 message was left in memory').toBe(true);
    // One derivation serves both schemes, and it is wiped once both are done.
    expect(seeds).toHaveLength(1);
    expect(allZero(seeds[0]!), 'the Argon2id seed was left in memory').toBe(true);
  });

  describe('when a step between deriving a secret and wiping it throws', () => {
    async function stegoPhoto(seed: number): Promise<Uint8Array> {
      return embedKeyBlockStegoJpeg(noisyJpeg(160, seed), await keyBlock('pw'), 'pw', FAST);
    }

    it('k1 is wiped when its keystream cannot be generated', async () => {
      const stego = await stegoPhoto(8);
      fail.ctrCall = 1;

      await expect(during(() => extractKeyBlockStegoJpeg(stego, 'pw', FAST))).rejects.toBe(
        INJECTED,
      );

      expect(coverKeys).toHaveLength(1);
      expect(allZero(coverKeys[0]!), 'k1 survived the failure').toBe(true);
      expect(allZero(seeds[0]!), 'the seed survived the failure').toBe(true);
    });

    it('s1 is wiped when decoding the S1 syndrome fails', async () => {
      const stego = await stegoPhoto(9);
      fail.stcExtract = true;

      await expect(during(() => extractKeyBlockStegoJpeg(stego, 'pw', FAST))).rejects.toBe(
        INJECTED,
      );

      expect(keystreams).toHaveLength(1);
      expect(allZero(keystreams[0]!), 's1 survived the failure').toBe(true);
      expect(allZero(coverKeys[0]!), 'k1 survived the failure').toBe(true);
    });

    it('k0 is wiped when the S0 keystream cannot be generated', async () => {
      // Wrong password, so S1 finds nothing and S0 is attempted; its keystream
      // is the second AES-CTR call.
      const stego = await stegoPhoto(10);
      fail.ctrCall = 2;

      await expect(
        during(() => extractKeyBlockStegoJpeg(stego, 'not the password', FAST)),
      ).rejects.toBe(INJECTED);

      expect(coverKeys).toHaveLength(2);
      expect(allZero(coverKeys[1]!), 'k0 survived the failure').toBe(true);
      expect(allZero(keystreams[0]!), 's1 survived the failure').toBe(true);
    });
  });
});
