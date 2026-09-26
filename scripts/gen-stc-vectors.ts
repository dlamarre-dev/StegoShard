/**
 * Generate frozen known-answer vectors for the syndrome-trellis code of
 * embedding scheme S1 (SPEC §9.3.1).
 *
 * The TypeScript suite (src/core/stc.vectors.test.ts) must reproduce every
 * embedder output bit for bit; the Python reader (python/tests/test_stc_vectors.py)
 * must recover every message from those outputs with its own implementation, and
 * reproduce every keyed order. A bug the writer and the TypeScript reader share,
 * a truncation off by one say, round-trips cleanly in TypeScript and is caught
 * only here, by the second implementation.
 *
 * Run with: npm run vectors:stc   (rewrites tests/vectors/stc-vectors.json)
 */

import { createHash, webcrypto } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STC_HEIGHT, STC_WIDTH, keyedOrder, stcEmbed } from '../src/core/stc';

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'tests',
  'vectors',
  'stc-vectors.json',
);

/** xorshift32 bits from a seed: documented in the JSON, so a reader can regenerate inputs. */
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

const bitString = (b: Uint8Array): string => Array.from(b).join('');
const packed = (b: Uint8Array): string => {
  const out = new Uint8Array(Math.ceil(b.length / 8));
  b.forEach((v, i) => (out[i >> 3]! |= v << (7 - (i & 7))));
  return Buffer.from(out).toString('base64');
};

async function aesCtrStream(seedHex: string, len: number): Promise<Uint8Array> {
  const key = await webcrypto.subtle.importKey(
    'raw',
    Buffer.from(seedHex, 'hex'),
    'AES-CTR',
    false,
    ['encrypt'],
  );
  return new Uint8Array(
    await webcrypto.subtle.encrypt(
      { name: 'AES-CTR', counter: new Uint8Array(16), length: 64 },
      key,
      new Uint8Array(len),
    ),
  );
}

async function main(): Promise<void> {
  // Small cases in the clear, chosen for the edges: messages shorter than h, one
  // column wide, and the truncated tail of an ordinary code.
  const shapes: [number, number][] = [
    [1, 1],
    [3, 4],
    [STC_HEIGHT - 1, 5],
    [STC_HEIGHT, 7],
    [STC_HEIGHT + 1, 16],
    [37, 2],
    [64, STC_WIDTH],
  ];
  const small = shapes.map(([m, w], i) => {
    const x = xorshiftBits(0x1000 + i, m * w);
    const message = xorshiftBits(0x2000 + i, m);
    const { y, changes } = stcEmbed(x, null, message, w);
    return { m, w, x: bitString(x), message: bitString(message), y: bitString(y), changes };
  });

  // One gallery-sized code, inputs regenerated from seeds and the output packed.
  const m = 16_872;
  const w = STC_WIDTH;
  const x = xorshiftBits(0x5107, m * w);
  const message = xorshiftBits(0x5108, m);
  const { y, changes } = stcEmbed(x, null, message, w);
  const large = {
    m,
    w,
    xSeed: 0x5107,
    messageSeed: 0x5108,
    y: packed(y),
    changes,
    ySha256: createHash('sha256').update(y).digest('hex'),
  };

  // Keyed orders over an AES-256-CTR keystream (counter 0), as S1 draws them.
  const orders = [];
  for (const [count, n] of [
    [10, 10],
    [1000, 16],
    [269_952, 269_952],
    [1_000_003, 269_952],
  ] as const) {
    const seed = createHash('sha256').update(`stc-order|${count}|${n}`).digest('hex');
    const order = keyedOrder(await aesCtrStream(seed, 4 * n + 65_536), count, n);
    const be = Buffer.alloc(4 * n);
    order.forEach((v, i) => be.writeUInt32BE(v, 4 * i));
    orders.push({
      seed,
      count,
      n,
      first: Array.from(order.subarray(0, 16)),
      sha256: createHash('sha256').update(be).digest('hex'),
    });
  }

  const doc = {
    comment:
      'Frozen STC vectors for embedding scheme S1 (SPEC §9.3.1). Bits are strings of 0/1 or ' +
      'MSB-first base64. xorshift32 inputs: s ^= s<<13; s ^= s>>>17; s ^= s<<5 (32-bit), bit = s & 1. ' +
      'Orders: AES-256-CTR(seed) keystream from counter 0, 4n + 65536 bytes; sha256 over the order as u32 BE.',
    height: STC_HEIGHT,
    small,
    large,
    orders,
  };
  writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${OUT}`);
}

await main();
