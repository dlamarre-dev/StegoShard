/**
 * Parser fuzzer for the untrusted-input entry points. Feeds pseudo-random bytes
 * (and mutations of valid artifacts) to every parser that touches attacker-
 * controlled data and asserts the ONLY outcomes are: a valid structure, or a
 * thrown `Error`. A non-Error throw, or a hang/crash (caught by the CI timeout),
 * fails the run.
 *
 * Deterministic: seed from `--seed=N`, else GITHUB_RUN_ID (coverage-over-time in
 * CI), else a fixed constant. No dependencies — a small LCG PRNG, same shape as
 * the seeded fuzzing in crypto.hardening.test.ts.
 *
 *   npm run fuzz -- --iters=20000 --seed=123
 */

import { createKeyBlock, parseKeyBlock, serializeKeyBlock } from '../src/core/crypto';
import { decodeHeader, decodeImagePayload } from '../src/core/header';
import { parsePayload } from '../src/core/payload';
import { packSqlite, unpackSqlite } from '../src/core/sqlite-container';
import { unwrapBinary } from '../src/core/binary-container';
import { decode as decodeJpeg } from '../src/core/jpeg-coeff';

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
}

const ITERS = Number(arg('iters') ?? 5000);
const SEED =
  arg('seed') !== undefined
    ? Number(arg('seed'))
    : process.env.GITHUB_RUN_ID
      ? Number(process.env.GITHUB_RUN_ID) >>> 0
      : 0xc0ffee;

function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 24) & 0xff;
  };
}
const next = makePrng(SEED);

/** A random-length buffer; occasionally larger to reach length-sensitive paths. */
function randomBytes(): Uint8Array {
  const big = (next() & 0x0f) === 0; // ~1/16 chance of a larger buffer
  const len = big ? next() * 32 + next() : next(); // up to ~8 KiB, else 0..255
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = next();
  return b;
}

/** Flip 1-3 random bytes of a copy (mutation fuzzing of a valid artifact). */
function mutate(base: Uint8Array): Uint8Array {
  const b = base.slice();
  const flips = 1 + (next() % 3);
  for (let i = 0; i < flips && b.length > 0; i++) {
    const idx = (next() * 256 + next()) % b.length;
    b[idx] = (b[idx]! ^ (1 << (next() & 7))) & 0xff;
  }
  return b;
}

type Target = { name: string; run: (b: Uint8Array) => unknown | Promise<unknown> };

const targets: Target[] = [
  { name: 'parseKeyBlock', run: (b) => parseKeyBlock(b) },
  { name: 'decodeHeader', run: (b) => decodeHeader(b) },
  { name: 'decodeImagePayload', run: (b) => decodeImagePayload(b) },
  { name: 'parsePayload', run: (b) => parsePayload(b, 1 << 20) },
  { name: 'unpackSqlite', run: (b) => unpackSqlite(b) },
  { name: 'unwrapBinary', run: (b) => unwrapBinary(b) },
  { name: 'decodeJpeg', run: (b) => decodeJpeg(b) },
];

async function fuzzOne(t: Target, input: Uint8Array): Promise<void> {
  try {
    await t.run(input);
  } catch (e) {
    if (!(e instanceof Error)) {
      throw new Error(
        `${t.name} threw a non-Error value (${typeof e}) on input len=${input.length}`,
        { cause: e },
      );
    }
    // A typed Error is the expected rejection of malformed input.
  }
}

async function main(): Promise<void> {
  console.log(`fuzz: seed=${SEED} iters=${ITERS} per target`);

  // Cheap valid seeds for mutation fuzzing (reach deeper than pure garbage).
  const validKeyBlock = serializeKeyBlock(
    (await createKeyBlock('fuzz', { iterations: 1, memoryKiB: 256, parallelism: 1 })).block,
  );
  const validSqlite = packSqlite(randomBytes());

  for (const t of targets) {
    for (let i = 0; i < ITERS; i++) await fuzzOne(t, randomBytes());
  }
  for (let i = 0; i < ITERS; i++) {
    await fuzzOne(targets[0]!, mutate(validKeyBlock)); // parseKeyBlock
    await fuzzOne(
      { name: 'unpackSqlite', run: (b) => unpackSqlite(b) },
      mutate(validSqlite),
    );
  }

  console.log(`fuzz: OK — ${targets.length} targets survived random + mutation inputs`);
}

main().catch((e) => {
  console.error('fuzz: FAILED', e);
  process.exit(1);
});
