/**
 * The syndrome-trellis code reproduces its frozen vectors (tests/vectors/stc-vectors.json).
 *
 * The writer's output is part of the format only through its syndrome, but it
 * is pinned here bit for bit all the same: it is what the Python reader checks
 * against, and a change to the embedder that kept round trips working while
 * moving its output would otherwise pass unseen. Regenerate with
 * `npm run vectors:stc` only for a deliberate change to S1 (SPEC §9.3.1).
 */

import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STC_HEIGHT, keyedOrder, stcEmbed, stcExtract } from './stc';

interface Vectors {
  height: number;
  small: { m: number; w: number; x: string; message: string; y: string; changes: number }[];
  large: {
    m: number;
    w: number;
    xSeed: number;
    messageSeed: number;
    changes: number;
    ySha256: string;
  };
  orders: { seed: string; count: number; n: number; first: number[]; sha256: string }[];
}

const V = JSON.parse(
  readFileSync(new URL('../../tests/vectors/stc-vectors.json', import.meta.url), 'utf-8'),
) as Vectors;

const fromBits = (s: string) => Uint8Array.from(s, (c) => (c === '1' ? 1 : 0));
function xorshiftBits(seed: number, n: number): Uint8Array {
  let s = seed >>> 0;
  return Uint8Array.from({ length: n }, () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s & 1;
  });
}

describe('stc vectors', () => {
  it('were made at this constraint height', () => {
    expect(V.height).toBe(STC_HEIGHT);
  });

  it.each(V.small.map((c) => [`m=${c.m} w=${c.w}`, c] as const))('embeds %s as frozen', (_, c) => {
    const out = stcEmbed(fromBits(c.x), null, fromBits(c.message), c.w);
    expect(Array.from(out.y).join('')).toBe(c.y);
    expect(out.changes).toBe(c.changes);
    expect(stcExtract(out.y, c.m, c.w)).toEqual(fromBits(c.message));
  });

  it('embeds a gallery-sized code as frozen', () => {
    const { m, w } = V.large;
    const out = stcEmbed(
      xorshiftBits(V.large.xSeed, m * w),
      null,
      xorshiftBits(V.large.messageSeed, m),
      w,
    );
    expect(out.changes).toBe(V.large.changes);
    expect(createHash('sha256').update(out.y).digest('hex')).toBe(V.large.ySha256);
  });

  it.each(V.orders.map((o) => [`${o.n} of ${o.count}`, o] as const))(
    'draws the keyed order %s',
    async (_, o) => {
      const key = await webcrypto.subtle.importKey(
        'raw',
        Buffer.from(o.seed, 'hex'),
        'AES-CTR',
        false,
        ['encrypt'],
      );
      const stream = new Uint8Array(
        await webcrypto.subtle.encrypt(
          { name: 'AES-CTR', counter: new Uint8Array(16), length: 64 },
          key,
          new Uint8Array(4 * o.n + 65_536),
        ),
      );
      const order = keyedOrder(stream, o.count, o.n);
      expect(Array.from(order.subarray(0, 16))).toEqual(o.first);
      const be = Buffer.alloc(4 * o.n);
      order.forEach((v, i) => be.writeUInt32BE(v, 4 * i));
      expect(createHash('sha256').update(be).digest('hex')).toBe(o.sha256);
    },
  );
});
