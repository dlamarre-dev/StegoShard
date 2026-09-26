/**
 * The gallery embedding bench: what an embed changes, and what first-order and
 * calibration attacks make of it, on real photos run through the real pipeline.
 *
 * Step 0 of the adaptive-embedding plan: the reference every later scheme is
 * compared against. It measures, it does not decide. No score here is a bar a
 * scheme has to clear, because a scheme tuned until a given detector calls it
 * clean is a scheme shaped to fool that detector, and nothing more.
 *
 * What it does, per photo of the corpus:
 *   1. normalizes it exactly as a gallery save does (`fileToGalleryCover`);
 *   2. embeds `--pairs` independent slots (random payload, random position key),
 *      each at the gallery's own size and margin, the way `embedSlot` does;
 *   3. checks each slot reads back, since a bench of outputs that do not extract
 *      would measure nothing;
 *   4. compares cover and stego coefficient by coefficient (changes, transitions
 *      between magnitudes, histogram shifts against their own shot noise);
 *   5. scores cover and stego with each detector, and reports the unpaired AUC
 *      and the paired sign test over all pairs.
 *
 * The corpus stays outside git: these are personal photos, and a camera original
 * carries its owner's location. Only the numbers are written out, under an id
 * made from the file's hash, never its name.
 *
 * Deterministic: the same corpus and `--seed` give the same pairs and the same
 * report, save the timings.
 *
 * Run with:
 *   npm run bench:stego -- --corpus <dir> [--scheme s0|s1] [--pairs 3] [--label s1] [--seed <text>]
 *                          [--out tests/steganalysis/bench] [--work .bench]
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  GALLERY_EMBED_MARGIN,
  GALLERY_READ_MARGIN,
  GALLERY_SLOT_BYTES,
  decode as decodeJpeg,
  embedBytesStcJpeg,
  embedBytesStegoJpeg,
  encodeJpegProfile,
  extractBytesStcJpeg,
  extractBytesStegoJpeg,
  type JpegModel,
} from '../src/core/index';
import { fileToGalleryCover, fileToImageData } from '../src/api/node/image-io';
import { format, resolveConfig } from 'prettier';
import { isEntryModule } from './entry-module';

// --- arguments ----------------------------------------------------------------

function arg(name: string, fallback?: string): string {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  const i = process.argv.indexOf(`--${name}`);
  const value = hit ? hit.slice(name.length + 3) : i > 0 ? process.argv[i + 1] : undefined;
  if (value !== undefined) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

// --- deterministic randomness -------------------------------------------------

/** `len` bytes of SHA-256 in counter mode over `label`: reproducible, and plenty for a bench. */
function expand(label: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let block = 0, off = 0; off < len; block++) {
    const h = createHash('sha256').update(`${label}|${block}`).digest();
    out.set(h.subarray(0, Math.min(32, len - off)), off);
    off += 32;
  }
  return out;
}

const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

// --- coefficient comparison ---------------------------------------------------

/** Magnitudes are bucketed 0..MAXB, the last bucket holding everything above. */
const MAXB = 9;
const bucket = (v: number): number => Math.min(Math.abs(v), MAXB);

interface Comparison {
  totalAc: number;
  nonzeroAc: number;
  carriers: number;
  changed: number;
  changedDc: number;
  changedBelow2: number;
  notUnit: number;
  signFlips: number;
  /** transitions[from][to] over changed AC coefficients, by magnitude bucket. */
  transitions: number[][];
}

function sameGrid(a: JpegModel, b: JpegModel): boolean {
  return (
    a.components.length === b.components.length &&
    a.components.every(
      (c, i) =>
        c.blocks.length === b.components[i]!.blocks.length &&
        c.h === b.components[i]!.h &&
        c.v === b.components[i]!.v,
    )
  );
}

function compare(cover: JpegModel, stego: JpegModel): Comparison {
  const t = Array.from({ length: MAXB + 1 }, () => new Array<number>(MAXB + 1).fill(0));
  const r: Comparison = {
    totalAc: 0,
    nonzeroAc: 0,
    carriers: 0,
    changed: 0,
    changedDc: 0,
    changedBelow2: 0,
    notUnit: 0,
    signFlips: 0,
    transitions: t,
  };
  cover.components.forEach((comp, ci) => {
    comp.blocks.forEach((block, bi) => {
      const other = stego.components[ci]!.blocks[bi]!;
      if (block[0] !== other[0]) r.changedDc++;
      for (let k = 1; k < 64; k++) {
        const a = block[k]!;
        const b = other[k]!;
        r.totalAc++;
        if (a !== 0) r.nonzeroAc++;
        if (Math.abs(a) >= 2) r.carriers++;
        if (a === b) continue;
        r.changed++;
        if (Math.abs(a) < 2) r.changedBelow2++;
        if (Math.abs(a - b) !== 1) r.notUnit++;
        if (a !== 0 && b !== 0 && Math.sign(a) !== Math.sign(b)) r.signFlips++;
        t[bucket(a)]![bucket(b)]!++;
      }
    });
  });
  return r;
}

/** Count of AC coefficients by magnitude 0..MAXB, for one component or all. */
function magnitudeHistogram(model: JpegModel, component?: number): number[] {
  const h = new Array<number>(MAXB + 1).fill(0);
  model.components.forEach((comp, ci) => {
    if (component !== undefined && ci !== component) return;
    for (const block of comp.blocks) for (let k = 1; k < 64; k++) h[bucket(block[k]!)]!++;
  });
  return h;
}

/**
 * How far each magnitude's count moved, in units of that count's own sampling
 * noise: z(k) = (h_stego(k) - h_cover(k)) / sqrt(h_cover(k)), over all AC
 * coefficients of the image, for k = 1..MAXB-1. A shift well under 1 is lost in
 * the noise a warden faces estimating the cover's histogram; the reference to
 * compare it against is what calibration can actually estimate.
 */
function histogramShift(cover: JpegModel, stego: JpegModel): number[] {
  const hc = magnitudeHistogram(cover);
  const hs = magnitudeHistogram(stego);
  const z: number[] = [];
  for (let k = 1; k < MAXB; k++) z.push(hc[k]! > 0 ? (hs[k]! - hc[k]!) / Math.sqrt(hc[k]!) : 0);
  return z;
}

// --- statistics ---------------------------------------------------------------

/** ln Γ(x), Lanczos approximation (Numerical Recipes, g = 7). */
function lnGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularized lower incomplete gamma P(a, x), series or continued fraction. */
function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 1000; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

/** Mann-Whitney AUC: P(stego score > cover score), ties counting half. */
function auc(covers: number[], stegos: number[]): number {
  let wins = 0;
  for (const s of stegos) for (const c of covers) wins += s > c ? 1 : s === c ? 0.5 : 0;
  return wins / (covers.length * stegos.length);
}

/** Two-sided exact sign test on `k` successes out of `n`. */
function signTest(k: number, n: number): number {
  const lnC = (i: number) => lnGamma(n + 1) - lnGamma(i + 1) - lnGamma(n - i + 1);
  const tail = (from: number) => {
    let p = 0;
    for (let i = from; i <= n; i++) p += Math.exp(lnC(i) - n * Math.LN2);
    return p;
  };
  return Math.min(1, 2 * tail(Math.max(k, n - k)));
}

// --- detectors ----------------------------------------------------------------

/**
 * Westfeld-Pfitzmann chi-square over the magnitude pairs {2i, 2i+1} (IH 1999),
 * the pairs LSB replacement pushes toward equal counts. Returned as the
 * probability of embedding, 1 - CDF: near 1 reads as "the pairs are equalized".
 */
function chiSquarePairs(model: JpegModel): number {
  const h = new Map<number, number>();
  for (const comp of model.components) {
    for (const block of comp.blocks) {
      for (let k = 1; k < 64; k++) {
        const m = Math.abs(block[k]!);
        if (m >= 2) h.set(m, (h.get(m) ?? 0) + 1);
      }
    }
  }
  let stat = 0;
  let dof = 0;
  for (let even = 2; even < 256; even += 2) {
    const a = h.get(even) ?? 0;
    const b = h.get(even + 1) ?? 0;
    const e = (a + b) / 2;
    if (e < 5) continue;
    stat += ((a - e) * (a - e)) / e;
    dof++;
  }
  return dof > 1 ? 1 - gammaP((dof - 1) / 2, stat / 2) : 0;
}

/**
 * The calibrated image of Fridrich, Goljan and Hogea (IH 2002): decompress, crop
 * four pixels off the top and the left so the 8x8 grid no longer aligns with the
 * old one, and recompress with the same quantization. Its histograms estimate the
 * cover's. The profile encoder applies exactly the stego's tables.
 */
function calibrate(jpeg: Uint8Array): JpegModel {
  const img = fileToImageData(jpeg, 'x.jpg');
  const w = img.width - 4;
  const h = img.height - 4;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    data.set(
      img.data.subarray(((y + 4) * img.width + 4) * 4, ((y + 4) * img.width + 4 + w) * 4),
      y * w * 4,
    );
  }
  return decodeJpeg(encodeJpegProfile({ data, width: w, height: h }));
}

/**
 * F5's calibrated estimator of the modified fraction β (Fridrich et al. 2002),
 * from the counts of 0, 1 and 2 in the luma modes (0,1), (1,0) and (1,1). F5
 * shrinks magnitudes toward zero, so this watches the one signature a
 * shrinking embedder leaves.
 */
function f5Beta(stego: JpegModel, calibrated: JpegModel): number {
  const counts = (m: JpegModel, k: number) => {
    const h = [0, 0, 0];
    for (const block of m.components[0]!.blocks) {
      const a = Math.abs(block[k]!);
      if (a <= 2) h[a]!++;
    }
    return h;
  };
  const betas = [1, 2, 4].map((k) => {
    const s = counts(stego, k);
    const c = counts(calibrated, k);
    const num = c[1]! * (s[0]! - c[0]!) + (s[1]! - c[1]!) * (c[2]! - c[1]!);
    const den = c[1]! * c[1]! + (c[2]! - c[1]!) * (c[2]! - c[1]!);
    return den > 0 ? num / den : 0;
  });
  return betas.reduce((a, b) => a + b, 0) / betas.length;
}

/**
 * The calibrated pair estimator for magnitude-LSB replacement. Replacing the
 * LSB of a fraction r of the |v| ≥ 2 coefficients with random bits scales every
 * pair difference h(2i) - h(2i+1) by (1 - r), so r ≈ 1 - Σ diff_stego / Σ
 * diff_calibrated. It is the attack aimed squarely at the current scheme, which
 * is why it is the one to watch in the S0 reference.
 */
function pairRate(stego: JpegModel, calibrated: JpegModel): number {
  const diff = (m: JpegModel) => {
    const h = magnitudeHistogram(m);
    let d = 0;
    for (let even = 2; even + 1 < MAXB; even += 2) d += h[even]! - h[even + 1]!;
    return d;
  };
  const dc = diff(calibrated);
  return dc !== 0 ? 1 - diff(stego) / dc : 0;
}

/** Total-variation distance between the |v| histograms of an image and its calibration. */
function histogramShape(model: JpegModel, calibrated: JpegModel): number {
  const a = magnitudeHistogram(model);
  const b = magnitudeHistogram(calibrated);
  const sa = a.reduce((x, y) => x + y, 0);
  const sb = b.reduce((x, y) => x + y, 0);
  let tv = 0;
  for (let i = 0; i <= MAXB; i++) tv += Math.abs(a[i]! / sa - b[i]! / sb);
  return tv / 2;
}

const DETECTORS = ['chiSquarePairs', 'f5Beta', 'pairRate', 'histogramShape'] as const;
type Detector = (typeof DETECTORS)[number];
type Scores = Record<Detector, number>;

function score(model: JpegModel, jpeg: Uint8Array): Scores {
  const cal = calibrate(jpeg);
  return {
    chiSquarePairs: chiSquarePairs(model),
    f5Beta: f5Beta(model, cal),
    pairRate: pairRate(model, cal),
    histogramShape: histogramShape(model, cal),
  };
}

// --- the run --------------------------------------------------------------------

interface PairResult {
  image: string;
  pair: number;
  extracted: boolean;
  embedMs: number;
  comparison: Omit<Comparison, 'transitions'>;
  twoToOne: number;
  /** z(k) for k = 1..MAXB-1; see histogramShift. */
  histogramZ: number[];
  bitsPerChange: number;
  ratePerNonzeroAc: number;
  ratePerCarrier: number;
  cover: Scores;
  stego: Scores;
}

async function main(): Promise<void> {
  const corpus = arg('corpus');
  const pairs = Number(arg('pairs', '3'));
  const label = arg('label', 's0');
  const seed = arg('seed', 'stegoshard-bench-v1');
  // Which embedding scheme to measure (SPEC §9.3, §9.3.1). The same seed gives
  // the same payloads and keys under either, so two reports compare pair by pair.
  const scheme = arg('scheme', 's1').toUpperCase();
  if (scheme !== 'S0' && scheme !== 'S1')
    throw new Error(`--scheme must be s0 or s1, not ${scheme}`);
  const outDir = arg('out', join('tests', 'steganalysis', 'bench'));
  const workDir = arg('work', '.bench');
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(workDir, label), { recursive: true });

  const limit = Number(arg('limit', '0'));
  const all = readdirSync(corpus)
    .filter((f) => /\.jpe?g$/i.test(f))
    .sort();
  const files = limit > 0 ? all.slice(0, limit) : all;
  if (files.length === 0) throw new Error(`no JPEG in ${corpus}`);

  const payloadBits = GALLERY_SLOT_BYTES * 8;
  const results: PairResult[] = [];
  const images: Record<string, unknown>[] = [];
  const transitions = Array.from({ length: MAXB + 1 }, () => new Array<number>(MAXB + 1).fill(0));
  let peakRss = 0;
  const sampleRss = () => (peakRss = Math.max(peakRss, process.memoryUsage().rss));

  for (const file of files) {
    const original = new Uint8Array(readFileSync(join(corpus, file)));
    const id = `img-${sha256Hex(original).slice(0, 12)}`;
    const t0 = performance.now();
    const normalized = fileToGalleryCover(original, basename(file));
    if (normalized.kind !== 'jpeg') throw new Error(`${file}: the pipeline did not produce a JPEG`);
    const coverJpeg = normalized.jpeg;
    const normalizeMs = performance.now() - t0;
    const cover = decodeJpeg(coverJpeg);
    writeFileSync(join(workDir, label, `${id}-cover.jpg`), coverJpeg);

    // The transitions a 2 -> 1 claim would have to come from: the camera
    // original against its normalized cover, when the two share a block grid.
    let originalTwoToOne: number | null = null;
    try {
      const orig = decodeJpeg(original);
      if (sameGrid(orig, cover)) originalTwoToOne = compare(orig, cover).transitions[2]![1]!;
    } catch {
      // not baseline, or not decodable here: reported as n/a
    }
    const coverScores = score(cover, coverJpeg);
    sampleRss();
    images.push({
      id,
      width: cover.width,
      height: cover.height,
      normalizeMs: Math.round(normalizeMs),
      originalToCoverTwoToOne: originalTwoToOne,
    });

    for (let p = 0; p < pairs; p++) {
      const tag = `${seed}|${id}|${p}`;
      const payload = expand(`${tag}|payload`, GALLERY_SLOT_BYTES);
      const posKey = expand(`${tag}|pos`, 32);
      const e0 = performance.now();
      const stegoJpeg =
        scheme === 'S1'
          ? await embedBytesStcJpeg(coverJpeg, payload, posKey, GALLERY_EMBED_MARGIN)
          : await embedBytesStegoJpeg(coverJpeg, payload, posKey, GALLERY_EMBED_MARGIN);
      const embedMs = performance.now() - e0;
      sampleRss();
      writeFileSync(join(workDir, label, `${id}-stego-${p}.jpg`), stegoJpeg);

      const back =
        scheme === 'S1'
          ? await extractBytesStcJpeg(stegoJpeg, posKey, GALLERY_SLOT_BYTES)
          : await extractBytesStegoJpeg(stegoJpeg, posKey, GALLERY_SLOT_BYTES, GALLERY_READ_MARGIN);
      const extracted = back !== null && Buffer.from(back).equals(Buffer.from(payload));
      const stego = decodeJpeg(stegoJpeg);
      const cmp = compare(cover, stego);
      cmp.transitions.forEach((row, i) => row.forEach((n, j) => (transitions[i]![j]! += n)));
      const { transitions: _t, ...counts } = cmp;
      results.push({
        image: id,
        pair: p,
        extracted,
        embedMs: Math.round(embedMs),
        comparison: counts,
        twoToOne: cmp.transitions[2]![1]!,
        histogramZ: histogramShift(cover, stego),
        bitsPerChange: payloadBits / cmp.changed,
        ratePerNonzeroAc: payloadBits / cmp.nonzeroAc,
        ratePerCarrier: payloadBits / cmp.carriers,
        cover: coverScores,
        stego: score(stego, stegoJpeg),
      });
      sampleRss();
      process.stderr.write(`  ${id} pair ${p}: ${cmp.changed} changes, extracted=${extracted}\n`);
    }
  }

  const detectors = Object.fromEntries(
    DETECTORS.map((d) => {
      const c = results.map((r) => r.cover[d]);
      const s = results.map((r) => r.stego[d]);
      const higher = results.filter((r) => r.stego[d] > r.cover[d]).length;
      const ties = results.filter((r) => r.stego[d] === r.cover[d]).length;
      const n = results.length - ties;
      return [
        d,
        {
          aucUnpaired: auc(c, s),
          pairedStegoHigher: higher,
          pairedN: n,
          signTestP: n > 0 ? signTest(higher, n) : 1,
          meanPairedDelta:
            results.reduce((a, r) => a + (r.stego[d] - r.cover[d]), 0) / results.length,
          sdCover: sd(c),
        },
      ];
    }),
  );

  const mean = (f: (r: PairResult) => number) =>
    results.reduce((a, r) => a + f(r), 0) / results.length;
  const report = {
    label,
    commit: gitCommit(),
    seed,
    corpus: { images: files.length, pairsPerImage: pairs },
    scheme,
    slot: { bytes: GALLERY_SLOT_BYTES, bits: payloadBits, embedMargin: GALLERY_EMBED_MARGIN },
    summary: {
      pairs: results.length,
      extractionFailures: results.filter((r) => !r.extracted).length,
      meanChanges: mean((r) => r.comparison.changed),
      minChanges: Math.min(...results.map((r) => r.comparison.changed)),
      maxChanges: Math.max(...results.map((r) => r.comparison.changed)),
      meanBitsPerChange: mean((r) => r.bitsPerChange),
      ratePerNonzeroAc: [
        Math.min(...results.map((r) => r.ratePerNonzeroAc)),
        Math.max(...results.map((r) => r.ratePerNonzeroAc)),
      ],
      ratePerCarrier: [
        Math.min(...results.map((r) => r.ratePerCarrier)),
        Math.max(...results.map((r) => r.ratePerCarrier)),
      ],
      twoToOne: results.reduce((a, r) => a + r.twoToOne, 0),
      changedDc: results.reduce((a, r) => a + r.comparison.changedDc, 0),
      changedBelow2: results.reduce((a, r) => a + r.comparison.changedBelow2, 0),
      notUnit: results.reduce((a, r) => a + r.comparison.notUnit, 0),
      meanHistogramZ: Array.from({ length: MAXB - 1 }, (_, i) => mean((r) => r.histogramZ[i]!)),
      meanEmbedMs: mean((r) => r.embedMs),
      peakRssMiB: Math.round(peakRss / 2 ** 20),
    },
    transitions,
    detectors,
    images,
    pairs: results,
  };
  // Both formatted here so a committed report passes the repository's format
  // check as written, instead of needing a second pass by hand after every run.
  // With the repository's own options, or `format:check` disagrees with the file.
  const write = async (name: string, text: string, parser: string): Promise<void> => {
    const path = join(outDir, name);
    const options = (await resolveConfig(path)) ?? {};
    writeFileSync(path, await format(text, { ...options, parser }));
  };
  await write(`${label}.json`, JSON.stringify(report), 'json');
  await write(`${label}.md`, markdown(report), 'markdown');
  process.stderr.write(`report written to ${join(outDir, label)}.{json,md}\n`);
}

function sd(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
}

function gitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

const fmt = (x: number, d = 3): string => (Number.isInteger(x) ? String(x) : x.toFixed(d));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function markdown(r: any): string {
  const s = r.summary;
  const rows = DETECTORS.map((d) => {
    const x = r.detectors[d];
    return `| ${d} | ${fmt(x.aucUnpaired)} | ${x.pairedStegoHigher}/${x.pairedN} | ${fmt(x.signTestP)} | ${fmt(x.meanPairedDelta, 5)} | ${fmt(x.sdCover, 5)} |`;
  });
  const head = `| from \\ to | ${Array.from({ length: MAXB + 1 }, (_, i) => (i === MAXB ? `${i}+` : i)).join(' | ')} |`;
  const sep = `|${'---|'.repeat(MAXB + 2)}`;
  const trans = r.transitions.map(
    (row: number[], i: number) => `| **${i === MAXB ? `${i}+` : i}** | ${row.join(' | ')} |`,
  );
  const imgs = r.images.map(
    (im: {
      id: string;
      width: number;
      height: number;
      normalizeMs: number;
      originalToCoverTwoToOne: number | null;
    }) =>
      `| ${im.id} | ${im.width}×${im.height} | ${im.normalizeMs} | ${im.originalToCoverTwoToOne ?? 'n/a (grid differs)'} |`,
  );
  return `# Stego bench: \`${r.label}\`

Generated by \`scripts/stego-bench.ts\` at commit \`${r.commit}\`, seed \`${r.seed}\`.
${r.corpus.images} photos, ${r.corpus.pairsPerImage} pairs each (${s.pairs} pairs), one gallery slot
of ${r.slot.bytes} bytes (${r.slot.bits} bits) per pair, embed margin ${r.slot.embedMargin}, embedding scheme ${r.scheme}.
The corpus is not in git; images are named by the first 12 hex digits of their SHA-256.

This measures. It is not a bar to clear: see the header of the script.

## What an embed changes

| measure | value |
|---|---|
| extraction failures | ${s.extractionFailures} / ${s.pairs} |
| coefficients changed per image (mean, min, max) | ${fmt(s.meanChanges, 0)}, ${s.minChanges}, ${s.maxChanges} |
| payload bits per change | ${fmt(s.meanBitsPerChange)} |
| rate, bits per nonzero AC | ${fmt(s.ratePerNonzeroAc[0], 4)} to ${fmt(s.ratePerNonzeroAc[1], 4)} |
| rate, bits per carrier (\\|v\\| ≥ 2) | ${fmt(s.ratePerCarrier[0], 4)} to ${fmt(s.ratePerCarrier[1], 4)} |
| transitions 2 → 1 | ${s.twoToOne} |
| DC coefficients changed | ${s.changedDc} |
| coefficients changed with \\|v\\| < 2 | ${s.changedBelow2} |
| changes other than ±1 | ${s.notUnit} |
| count shift per magnitude k = 1..${MAXB - 1}, mean z = Δh(k)/√h(k) | ${s.meanHistogramZ.map((z: number) => fmt(z, 2)).join(', ')} |
| embed time per image, mean | ${fmt(s.meanEmbedMs, 0)} ms |
| peak RSS | ${s.peakRssMiB} MiB |

## Transitions of changed AC coefficients, by magnitude

${head}
${sep}
${trans.join('\n')}

## Detectors

Unpaired AUC is the chance a stego score exceeds a cover score over all pairs
(0.5 is chance). Paired counts the pairs whose stego scores above its own cover;
the sign test is two-sided and exact.

| detector | AUC unpaired | paired stego > cover | sign test p | mean paired Δ | cover score s.d. |
|---|---|---|---|---|---|
${rows.join('\n')}

## Photos

| id | size | normalize ms | original → cover 2 → 1 |
|---|---|---|---|
${imgs.join('\n')}
`;
}

if (isEntryModule(import.meta)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
