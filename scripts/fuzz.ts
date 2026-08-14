/**
 * Parser fuzzer for the untrusted-input entry points. Feeds pseudo-random bytes
 * (and mutations of valid artifacts) to every parser that touches attacker-
 * controlled data and asserts the ONLY outcomes are: a structure that satisfies
 * the parser's own contract, or a thrown `Error`. A non-Error throw, a returned
 * structure that violates its contract, or a hang, fails the run.
 *
 * That second half used to be a claim rather than a check. Until this was fixed
 * the success path discarded the parser's return value entirely, so "a parser
 * accepted random bytes and handed back nonsense" was indistinguishable from "a
 * parser correctly rejected them". Every target below now carries an invariant,
 * because a fuzzer that only asserts `instanceof Error` is testing the language,
 * not the parsers.
 *
 * The invariants are deliberately the parser's *own* documented contract, not a
 * re-derivation of it. `decodeJpeg` goes further and re-encodes: a model that
 * cannot be turned back into a parseable JPEG is wrong in a way no structural
 * assertion catches.
 *
 * Deterministic: seed from `--seed=N`, else GITHUB_RUN_ID, else a fixed
 * constant. No dependencies: a small LCG PRNG, same shape as the seeded fuzzing
 * in crypto.hardening.test.ts.
 *
 *   npm run fuzz -- --iters=20000 --seed=123
 */

import jpeg from 'jpeg-js';
import { createKeyBlock, parseKeyBlock, serializeKeyBlock } from '../src/core/crypto';
import {
  CODEC_COLOR_GRID,
  decodeHeader,
  decodeImagePayload,
  encodeHeader,
  PROFILE_DISK,
} from '../src/core/header';
import { buildPayload, parsePayload } from '../src/core/payload';
import { packSqlite, unpackSqlite } from '../src/core/sqlite-container';
import { unwrapBinary, wrapBinary } from '../src/core/binary-container';
import {
  decode as decodeJpeg,
  encode as encodeJpeg,
  JpegUnsupportedError,
} from '../src/core/jpeg-coeff';

function arg(name: string): string | undefined {
  return process.argv
    .slice(2)
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')[1];
}

/**
 * Iterations per target. Validated, because `--iters=0` used to be accepted and
 * the run then reported "OK - 7 targets" having fuzzed nothing at all. A fuzzer
 * that passes without fuzzing is the exact shape of green this file was rewritten
 * to refuse, and it had it.
 */
function iterations(): number {
  const raw = arg('iters');
  if (raw === undefined) return 5000;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    console.error(`fuzz: --iters must be a positive integer, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return n;
}

const ITERS = iterations();
// Truncated to 32 bits here rather than inside makePrng, so the seed printed in
// the log is the seed that actually drives the stream. A GITHUB_RUN_ID above
// 2^32 used to be truncated silently, leaving a log line that did not identify
// the run it came from.
const SEED =
  (arg('seed') !== undefined
    ? Number(arg('seed'))
    : process.env.GITHUB_SHA
      ? Number.parseInt(process.env.GITHUB_SHA.slice(0, 8), 16)
      : process.env.GITHUB_RUN_ID
        ? Number(process.env.GITHUB_RUN_ID)
        : 0xc0ffee) >>> 0;

function makePrng(seed: number): () => number {
  let s = seed;
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

/**
 * A target's contract on the success path. Throwing from here fails the run, so
 * the message must say what was violated and on which input length.
 */
type Check = (out: unknown, input: Uint8Array, mutated: boolean) => void;
type Target = {
  name: string;
  run: (b: Uint8Array) => unknown | Promise<unknown>;
  check: Check;
};

const PARSE_LIMIT = 1 << 20;

function bad(what: string, input: Uint8Array): never {
  throw new Error(`accepted ${input.length} bytes and returned ${what}`);
}

const targets: Target[] = [
  {
    name: 'parseKeyBlock',
    run: (b) => parseKeyBlock(b),
    // The Argon2 parameters here are attacker-controlled and are consumed before
    // any authentication succeeds (crypto.ts:40-54), so a parser that let one
    // through out of range would be a memory-exhaustion hole rather than a
    // cosmetic defect.
    check: (out, input) => {
      const kb = out as {
        salt: Uint8Array;
        iv: Uint8Array;
        wrapped: Uint8Array;
        params: { iterations: number; memoryKiB: number; parallelism: number };
      };
      if (kb.salt.length !== 16) bad(`a ${kb.salt.length}-byte salt`, input);
      if (kb.iv.length !== 12) bad(`a ${kb.iv.length}-byte IV`, input);
      if (kb.wrapped.length < 16) bad(`a ${kb.wrapped.length}-byte wrapped key`, input);
      const { iterations, memoryKiB, parallelism } = kb.params;
      if (iterations < 1 || iterations > 4) bad(`iterations=${iterations}`, input);
      if (memoryKiB < 8 || memoryKiB > 256 * 1024) bad(`memoryKiB=${memoryKiB}`, input);
      if (parallelism < 1 || parallelism > 4) bad(`parallelism=${parallelism}`, input);
    },
  },
  {
    name: 'decodeHeader',
    run: (b) => decodeHeader(b),
    check: (out, input) => checkHeader(out, input),
  },
  {
    name: 'decodeImagePayload',
    run: (b) => decodeImagePayload(b),
    check: (out, input) => {
      const r = out as { header: unknown; shard: Uint8Array };
      const h = checkHeader(r.header, input);
      // The whole point of decodeImagePayload over decodeHeader: the shard it
      // hands back must be exactly as long as the header said it would be.
      if (r.shard.length !== h.shardLen) {
        bad(`a ${r.shard.length}-byte shard for a declared shardLen of ${h.shardLen}`, input);
      }
    },
  },
  {
    name: 'parsePayload',
    run: (b) => parsePayload(b, PARSE_LIMIT),
    // The limit exists to bound decompression. A returned payload above it means
    // the bound was advisory, which is the bug this target is here to find.
    check: (out, input) => {
      const p = out as { filename: string; content: Uint8Array; bundled: boolean };
      if (p.content.length > PARSE_LIMIT) {
        bad(`${p.content.length} bytes against a ${PARSE_LIMIT}-byte limit`, input);
      }
      if (typeof p.bundled !== 'boolean') bad(`bundled=${String(p.bundled)}`, input);
    },
  },
  {
    name: 'unpackSqlite',
    run: (b) => unpackSqlite(b),
    // null means "not one of ours", which is a valid answer. An empty blob is
    // not: unpackSqlite:417 promises null rather than a zero-length result, and
    // a caller that trusted a length-zero success would decrypt nothing.
    check: (out, input) => {
      if (out === null) return;
      const blob = out as Uint8Array;
      if (!(blob instanceof Uint8Array)) bad(`a non-Uint8Array (${typeof out})`, input);
      if (blob.length === 0) bad('a zero-length blob instead of null', input);
    },
  },
  {
    name: 'unwrapBinary',
    run: (b) => unwrapBinary(b),
    check: (out, input) => {
      if (out === null) return;
      const r = out as { payload: Uint8Array; variant: string };
      if (!(r.payload instanceof Uint8Array)) bad(`a non-Uint8Array payload`, input);
      if (r.variant !== 'branded' && r.variant !== 'disguised') {
        bad(`variant=${r.variant}`, input);
      }
    },
  },
  {
    name: 'decodeJpeg',
    run: (b) => decodeJpeg(b),
    // The strongest check in this file. A structural assertion cannot tell a
    // sound model from one whose scan offsets or component geometry are
    // nonsense; re-encoding and re-parsing can. This is also the only place the
    // encode path sees adversarial input at all.
    check: (out, input, mutated) => {
      const m = out as {
        width: number;
        height: number;
        components: unknown[];
        scanStart: number;
        scanEnd: number;
        bytes: Uint8Array;
      };
      if (m.width <= 0 || m.height <= 0) bad(`${m.width}x${m.height}`, input);
      if (m.components.length < 1 || m.components.length > 4) {
        bad(`${m.components.length} components`, input);
      }
      if (m.scanStart < 0 || m.scanEnd > m.bytes.length || m.scanStart >= m.scanEnd) {
        bad(`scan range [${m.scanStart}, ${m.scanEnd}) over ${m.bytes.length} bytes`, input);
      }
      // Encoding a model our own decoder just produced may legitimately fail on
      // a corrupted file: a mutated DHT can leave a table unable to express the
      // coefficients decoded under it. What it may never do is fail *untyped*.
      // That distinction is the whole point here; this fuzzer found `encode`
      // reading `.code` off undefined and throwing a bare TypeError from inside
      // the bit writer, which callers cannot handle. See huffCode() in
      // jpeg-coeff.ts.
      let re: Uint8Array;
      try {
        re = encodeJpeg(m as never);
      } catch (e) {
        if (e instanceof JpegUnsupportedError) return;
        bad(`an encoder crash: ${(e as Error).name}: ${(e as Error).message}`, input);
      }
      if (re![0] !== 0xff || re![1] !== 0xd8) bad('a re-encoding with no SOI', input);

      // A full round-trip is only required of an intact source. A mutated JPEG
      // can decode with fabricated coefficients, because `fill()` synthesises
      // 0xff past the end of the scan (jpeg-coeff.ts:103-108) rather than
      // failing, and that model re-encodes to a scan that will not re-decode.
      // Requiring it here would make the fuzzer red for a known behaviour rather
      // than for a regression; tightening it is blocked on deciding whether
      // truncation should throw.
      if (mutated) return;
      const round = decodeJpeg(re!);
      if (round.width !== m.width || round.height !== m.height) {
        bad(`a model that re-encoded to ${round.width}x${round.height}`, input);
      }
    },
  },
];

/** Shared by decodeHeader and decodeImagePayload; returns the validated header. */
function checkHeader(out: unknown, input: Uint8Array): { shardLen: number } {
  const h = out as {
    k: number;
    m: number;
    shardIndex: number;
    shardLen: number;
    blobLen: number;
    setId: Uint8Array;
    hash: Uint8Array;
  };
  if (h.k < 1) bad(`k=${h.k}`, input);
  if (h.m < 0) bad(`m=${h.m}`, input);
  if (h.k + h.m > 256) bad(`k+m=${h.k + h.m}`, input);
  if (h.shardIndex >= h.k + h.m) bad(`shardIndex=${h.shardIndex} for k+m=${h.k + h.m}`, input);
  if (h.setId.length !== 8) bad(`a ${h.setId.length}-byte setId`, input);
  if (h.hash.length !== 4) bad(`a ${h.hash.length}-byte hash`, input);
  // A shard cannot be longer than the blob it is a piece of, padded to k shards.
  if (h.shardLen * h.k < h.blobLen) {
    bad(`shardLen=${h.shardLen} x k=${h.k} below blobLen=${h.blobLen}`, input);
  }
  return h;
}

async function fuzzOne(t: Target, input: Uint8Array, mutated = false): Promise<void> {
  let out: unknown;
  try {
    out = await t.run(input);
  } catch (e) {
    if (!(e instanceof Error)) {
      throw new Error(
        `${t.name} threw a non-Error value (${typeof e}) on input len=${input.length}`,
        { cause: e },
      );
    }
    // A typed Error is the expected rejection of malformed input.
    return;
  }
  // Accepted. Now the half that used to be a claim rather than a check.
  try {
    t.check(out, input, mutated);
  } catch (e) {
    throw new Error(`${t.name}: ${(e as Error).message}`, { cause: e });
  }
}

/**
 * A valid artifact for every target, so mutation fuzzing reaches the accept path.
 *
 * This exists because of a measurement. Over 20,000 random inputs per target,
 * `parseKeyBlock`, `decodeHeader`, `decodeImagePayload` and `decodeJpeg` accepted
 * **zero**; `unpackSqlite` and `unwrapBinary` returned null every single time,
 * which is their "not one of ours" answer rather than an acceptance; only
 * `parsePayload`, which has no magic bytes to fail on, accepted 61.
 *
 * Random bytes therefore exercise rejection and almost nothing else. Before this,
 * only two of the seven targets had a valid seed to mutate, so the success path
 * of the other five was effectively unreachable and any invariant on it would
 * have been decoration. Bit-flipping a valid artifact is what lands near enough
 * to the accept path for the contracts above to mean anything.
 */
async function validSeeds(): Promise<Map<string, Uint8Array>> {
  const keyBlock = serializeKeyBlock(
    (await createKeyBlock('fuzz', { iterations: 1, memoryKiB: 256, parallelism: 1 })).block,
  );
  const shard = randomBytes();
  const header = encodeHeader({
    version: 1,
    setId: Uint8Array.from({ length: 8 }, () => next()),
    shardIndex: 0,
    k: 2,
    m: 2,
    codecId: CODEC_COLOR_GRID,
    profile: PROFILE_DISK,
    shardLen: shard.length,
    blobLen: shard.length * 2,
    hash: Uint8Array.from({ length: 4 }, () => next()),
  });
  const imagePayload = new Uint8Array(header.length + shard.length);
  imagePayload.set(header);
  imagePayload.set(shard, header.length);

  // 8x8 is the smallest useful JPEG: one MCU, which still carries a full set of
  // Huffman tables and a scan for the mutator to corrupt.
  const raw = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < raw.length; i++) raw[i] = i % 4 === 3 ? 0xff : next();
  const jpegBytes = new Uint8Array(
    jpeg.encode({ data: Buffer.from(raw), width: 8, height: 8 }, 80).data,
  );

  return new Map([
    ['parseKeyBlock', keyBlock],
    ['decodeHeader', header],
    ['decodeImagePayload', imagePayload],
    ['parsePayload', await buildPayload('fuzz.txt', randomBytes())],
    ['unpackSqlite', packSqlite(randomBytes())],
    ['unwrapBinary', wrapBinary(randomBytes(), 'branded')],
    ['decodeJpeg', jpegBytes],
  ]);
}

async function main(): Promise<void> {
  console.log(`fuzz: seed=${SEED} iters=${ITERS} per target`);

  const seeds = await validSeeds();
  const missing = targets.filter((t) => !seeds.has(t.name)).map((t) => t.name);
  if (missing.length > 0) {
    // A target with no valid seed only ever sees garbage it rejects, which is the
    // silent half-coverage this whole arrangement exists to prevent.
    throw new Error(`no valid seed for: ${missing.join(', ')}`);
  }

  for (const t of targets) {
    for (let i = 0; i < ITERS; i++) await fuzzOne(t, randomBytes());
    const seed = seeds.get(t.name)!;
    for (let i = 0; i < ITERS; i++) await fuzzOne(t, mutate(seed), true);
  }

  console.log(
    `fuzz: OK - ${targets.length} targets, random and mutated; ` +
      'every acceptance satisfied its contract',
  );
}

main().catch((e) => {
  console.error('fuzz: FAILED', e);
  process.exit(1);
});
