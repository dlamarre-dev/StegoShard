/**
 * `withStegoSeedCache`: one Argon2 derivation for a search across many photos.
 *
 * Restoring a gallery whose key photo was put in with the other photos means
 * trying each one for the key. The stego seed depends on the password alone,
 * so without the scope a set of twenty photos paid twenty derivations to find
 * one key. These tests count the derivations, and check that the scope changes
 * nothing about what is found and keeps nothing once it ends.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const argon2Calls = vi.hoisted(() => ({ n: 0 }));
vi.mock('hash-wasm', async (importOriginal) => {
  const real = await importOriginal<typeof import('hash-wasm')>();
  return {
    ...real,
    argon2id: (...args: Parameters<typeof real.argon2id>) => {
      argon2Calls.n++;
      return real.argon2id(...args);
    },
  };
});

import type { Argon2Params } from './crypto';
import { embedKeyFactorStego, extractKeyFactorStego, withStegoSeedCache } from './stego';
import { resetStegoCoverGuard } from './stego-guard';

const FAST: Argon2Params = { iterations: 1, memoryKiB: 64, parallelism: 1 };
const PW = 'the one password for the whole set';

function noise(side: number, seed: number): Uint8Array {
  const px = new Uint8Array(side * side * 4);
  let s = seed >>> 0;
  for (let i = 0; i < px.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    px[i] = i % 4 === 3 ? 255 : s >>> 24;
  }
  return px;
}

beforeEach(() => {
  resetStegoCoverGuard();
  argon2Calls.n = 0;
});

describe('withStegoSeedCache', () => {
  it('searches many photos for one derivation, and finds the same key', async () => {
    const side = 128;
    const photos = [noise(side, 1), noise(side, 2), noise(side, 3), noise(side, 4)];
    const factor = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    await embedKeyFactorStego(photos[2]!, side, side, factor, PW, FAST);

    argon2Calls.n = 0;
    const found = await withStegoSeedCache(async () => {
      const results = [];
      for (const p of photos) results.push(await extractKeyFactorStego(p, side, side, PW, FAST));
      return results;
    });
    expect(argon2Calls.n).toBe(1);
    expect(found.map((f) => f !== null)).toEqual([false, false, true, false]);
    expect(found[2]).toEqual(factor);
  });

  it('keeps nothing once the scope ends', async () => {
    const side = 64;
    const photo = noise(side, 9);
    await withStegoSeedCache(() => extractKeyFactorStego(photo, side, side, PW, FAST));
    argon2Calls.n = 0;
    await extractKeyFactorStego(photo, side, side, PW, FAST);
    await extractKeyFactorStego(photo, side, side, PW, FAST);
    expect(argon2Calls.n).toBe(2);
  });

  it('derives again for a different password inside one scope', async () => {
    const side = 64;
    const photo = noise(side, 11);
    await withStegoSeedCache(async () => {
      await extractKeyFactorStego(photo, side, side, PW, FAST);
      await extractKeyFactorStego(photo, side, side, 'a different password', FAST);
    });
    expect(argon2Calls.n).toBe(2);
  });
});
