/**
 * The JPEG key-photo paths leave no derived secret behind (issue #240).
 *
 * Found by mutation testing: deleting any of five `fill(0)` calls in
 * `embedFixedStegoJpeg` / `extractFixedStegoJpeg` left every test green. Those
 * mutants used to time out and count as detected, which hid the gap until the
 * run got fast enough to finish them.
 *
 * `stego.keystream.test.ts` counts wipes by length on the RGBA path. This file
 * holds on to the buffers themselves, as `crypto.zeroize.test.ts` does, because
 * a count cannot say *which* 32-byte buffer was wiped and the extract path has
 * three of them. Each secret is caught where it is made:
 *
 * - cover keys (`k1`, `k0`, and `keystream`'s `ckey`) are 32-byte `hkdf` outputs.
 *   The 16-byte cover-guard tag also comes from `hkdf`, but it is stored on
 *   purpose, so only 32-byte outputs are kept.
 * - keystreams (`stream`, `s1`, `s0`) are views over the buffer an AES-CTR
 *   `subtle.encrypt` returns, so wiping the view wipes that buffer.
 * - the whitened message is the third argument to `stcEmbed`.
 *
 * Same honest limit as the other two files: this proves the bytes are zero when
 * the call returns, not that no copy was ever made elsewhere.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jpeg from 'jpeg-js';

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

const messages: Uint8Array[] = [];
vi.mock('./stc', async (importOriginal) => {
  const real = await importOriginal<typeof import('./stc')>();
  return {
    ...real,
    stcEmbed: (...args: Parameters<typeof real.stcEmbed>) => {
      messages.push(args[2]);
      return real.stcEmbed(...args);
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

beforeEach(() => {
  resetStegoCoverGuard();
  const subtle = globalThis.crypto.subtle;
  const real = subtle.encrypt.bind(subtle);
  vi.spyOn(subtle, 'encrypt').mockImplementation(async (algorithm, key, data) => {
    const out = await real(algorithm, key, data);
    if (typeof algorithm === 'object' && algorithm.name === 'AES-CTR') keystreams.push(out);
    return out;
  });
});

afterEach(() => vi.restoreAllMocks());

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
  coverKeys.length = 0;
  messages.length = 0;
  keystreams = [];
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
    expect(messages).toHaveLength(1);
    expect(coverKeys).toHaveLength(1);
    expect(allZero(keystreams[0]!), 'the S1 keystream was left in memory').toBe(true);
    expect(allZero(messages[0]!), 'the whitened message was left in memory').toBe(true);
    expect(allZero(coverKeys[0]!), 'the cover key was left in memory').toBe(true);
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
});

describe('extracting a key block from a JPEG wipes what it derived', () => {
  it('S1 cover key and keystream when the S1 read succeeds', async () => {
    const kb = await keyBlock('pw');
    const stego = await embedKeyBlockStegoJpeg(noisyJpeg(160, 5), kb, 'pw', FAST);

    const out = await during(() => extractKeyBlockStegoJpeg(stego, 'pw', FAST));

    expect(out, 'the fixture stopped round-tripping, so this measured nothing').toEqual(kb);
    // S1 succeeded, so S0 never ran: one cover key, one keystream.
    expect(coverKeys).toHaveLength(1);
    expect(keystreams).toHaveLength(1);
    expect(allZero(coverKeys[0]!), 'k1 was left in memory').toBe(true);
    expect(allZero(keystreams[0]!), 's1 was left in memory').toBe(true);
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
  });
});
