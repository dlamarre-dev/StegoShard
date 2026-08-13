/**
 * Build the image set the steganalysis suite runs against.
 *
 * Three kinds of output per cover, all PNG because zsteg and StegExpose only
 * read lossless formats:
 *
 *  - `<cover>-clean.png`   the decoded cover, untouched. The baseline every
 *                          other measurement is compared against.
 *  - `<cover>-stego.png`   StegoShard's real spatial embedding, via
 *                          `embedKeyBlockStego`. This is the operating point.
 *  - `<cover>-naive<NN>.png` a naive LSB replacement at NN% of the samples,
 *                          spread across the whole frame. These are the controls
 *                          that tell us whether the detector works on this cover
 *                          at all.
 *
 * Why the controls matter more than they look: a detector that reports "clean"
 * proves nothing until you have shown it reports "not clean" for the same cover
 * with a payload it should catch. Calibration (see docs/CRYPTO-REVIEW.md) put the
 * reliable control point at 40%, not the 20% first assumed: at 20% only one of
 * four covers crossed StegExpose's threshold, and then only just.
 *
 * Spread, not sequential. Filling the first N samples in row order leaves most of
 * the frame untouched, which dilutes the global statistics RS analysis and Sample
 * Pairs depend on. It also flatters chi-square, which is the attack against
 * *sequential* embedding. Spreading is what a real tool does.
 *
 * Run: tsx scripts/gen-stego-samples.ts <coversDir> <outDir>
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import {
  KEY_BLOCK_LEN,
  deriveKEK,
  generateDEK,
  randomBytes,
  serializeKeyBlock,
  wrapDEK,
} from '../src/core/crypto';
import { embedKeyBlockStego, embedKeyBlockStegoJpeg } from '../src/core/stego';

const coversDir = process.argv[2] ?? 'tests/steganalysis/covers';
const outDir = process.argv[3] ?? '';
if (!outDir) {
  console.error('usage: tsx scripts/gen-stego-samples.ts <coversDir> <outDir>');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

/** Naive-LSB control rates, as a fraction of RGB samples. */
const CONTROL_RATES = [0.05, 0.1, 0.2, 0.4, 0.6];

/**
 * Argon2 parameters are deliberately weak here. They gate *key derivation*, not
 * the embedding pattern, so they change nothing a steganalyser can see, and the
 * production defaults (t=4, m=256 MiB) would add seconds per image for no gain.
 */
const FAST_ARGON2 = { iterations: 1, memoryKiB: 8, parallelism: 1 } as const;

const PASSWORD = 'steganalysis-fixture-password';

/**
 * A genuine serialized key block, not random bytes.
 *
 * Statistically the two are identical once the whitening keystream is applied, so
 * the detectors cannot tell them apart. The difference matters for a different
 * reason: only a real block survives `extractKeyBlockStego*`, which is how the
 * generator proves the carrier actually carries a recoverable payload. An embed
 * that silently did nothing would otherwise produce a set of "clean" verdicts that
 * measure nothing at all.
 */
async function realKeyBlock(): Promise<Uint8Array> {
  const salt = randomBytes(16);
  const kek = await deriveKEK(PASSWORD, salt, FAST_ARGON2);
  const dek = await generateDEK();
  const { iv, wrapped } = await wrapDEK(dek, kek);
  return serializeKeyBlock({ salt, params: FAST_ARGON2, iv, wrapped });
}

/** Deterministic LCG, so every control image is reproducible. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0);
}

/**
 * The zsteg positive control: recognizable plaintext, in the clear, embedded
 * sequentially into the low bits. This is exactly the shape zsteg exists to find,
 * so if it does not surface here the harness is broken and every "clean" verdict
 * elsewhere is worthless.
 */
const CONTROL_TEXT =
  'BEGIN STEGOSHARD ZSTEG CONTROL. The quick brown fox jumps over the lazy dog. ';

function plaintextLsb(rgba: Buffer, text: string): Buffer {
  const out = Buffer.from(rgba);
  const msg = Buffer.from(text.repeat(20));
  const bits = msg.length * 8;
  let bit = 0;
  for (let i = 0; i < out.length && bit < bits; i += 4) {
    for (let c = 0; c < 3 && bit < bits; c++, bit++) {
      const b = (msg[bit >> 3]! >> (7 - (bit & 7))) & 1;
      out[i + c] = (out[i + c]! & 0xfe) | b;
    }
  }
  return out;
}

/** Replace the low bit of `rate` of the RGB samples, spread over the whole frame. */
function naiveLsb(rgba: Buffer, rate: number, seed: number): Buffer {
  const out = Buffer.from(rgba);
  const rnd = lcg(seed);
  for (let i = 0; i < out.length / 4; i++) {
    for (let c = 0; c < 3; c++) {
      if (rnd() / 0xffffffff >= rate) continue;
      out[i * 4 + c] = (out[i * 4 + c]! & 0xfe) | (rnd() & 1);
    }
  }
  return out;
}

function writePng(path: string, rgba: Buffer, width: number, height: number) {
  const png = new PNG({ width, height });
  rgba.copy(png.data);
  writeFileSync(path, PNG.sync.write(png));
}

const covers = readdirSync(coversDir)
  .filter((f) => /\.jpe?g$/i.test(f))
  .sort();
if (covers.length === 0) {
  console.error(`no covers found in ${coversDir}`);
  process.exit(2);
}

for (const file of covers) {
  const name = basename(file).replace(/\.jpe?g$/i, '');
  const raw = jpeg.decode(readFileSync(join(coversDir, file)), { useTArray: true });
  const { width, height } = raw;
  const clean = Buffer.from(raw.data);

  writePng(join(outDir, `${name}-clean.png`), clean, width, height);

  // The real thing: a 92-byte key block through StegoShard's own embedder.
  const stego = Buffer.from(clean);
  const keyBlock = await realKeyBlock();
  await embedKeyBlockStego(stego, width, height, keyBlock, PASSWORD, FAST_ARGON2);
  writePng(join(outDir, `${name}-stego.png`), stego, width, height);

  writePng(join(outDir, `${name}-control.png`), plaintextLsb(clean, CONTROL_TEXT), width, height);

  for (const rate of CONTROL_RATES) {
    const tag = String(Math.round(rate * 100)).padStart(2, '0');
    writePng(
      join(outDir, `${name}-naive${tag}.png`),
      naiveLsb(clean, rate, 0xc0ffee),
      width,
      height,
    );
  }

  // The JPEG DCT path. Written alongside the PNGs because Aletheia reads JPEG and
  // the two PNG detectors do not: this carrier is the one neither zsteg nor
  // StegExpose can see, and the one the store listings lean on ("a JPEG stays a
  // JPEG"). The cover is copied through untouched as the baseline.
  const coverJpeg = readFileSync(join(coversDir, file));
  writeFileSync(join(outDir, `${name}-clean.jpg`), coverJpeg);
  try {
    const carrier = await embedKeyBlockStegoJpeg(
      coverJpeg,
      await realKeyBlock(),
      PASSWORD,
      FAST_ARGON2,
    );
    writeFileSync(join(outDir, `${name}-stego.jpg`), carrier);
  } catch (err) {
    // A progressive or otherwise unsupported cover is refused by design; say so
    // rather than silently producing a set with a hole in it.
    console.error(`  ${name}: JPEG carrier skipped (${(err as Error).message})`);
  }

  const capacity = width * height * 3;
  const rate = ((KEY_BLOCK_LEN * 8) / capacity) * 100;
  console.log(
    `  ${name.padEnd(9)} ${width}x${height}  ${capacity} LSB  ` +
      `key block = ${KEY_BLOCK_LEN * 8} bits (${rate.toFixed(3)} %)`,
  );
}
