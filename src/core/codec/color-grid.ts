/**
 * Color-grid codec (SPEC §2.2, `CODEC_ID = 2`): the digital-output counterpart
 * to qr-grid. Each module carries one of eight colors (the corners of the RGB
 * cube), so a module is worth **3 bits** instead of QR's ~0.75, roughly tripling
 * the bytes per image.
 *
 * The eight colors are maximally separated in RGB, which is what lets this
 * survive JPEG. But chroma is the first thing a lossy codec throws away (4:2:0
 * halves chroma resolution, then quantizes it harder than luma), so the Cloud
 * profile uses large modules, only samples the middle of each one, and carries a
 * much higher parity ratio. Paper is deliberately unsupported: print, ink and
 * camera white balance make color a liability, so `encode` throws for it and the
 * paper path keeps using qr-grid.
 *
 * Error correction reuses the project's own Reed-Solomon (reed-solomon.ts)
 * rather than inventing a second one. That code is an *erasure* code, so every
 * block carries a CRC-32: the decoder checks each block, marks the failures as
 * erasures, and lets RS rebuild them. Blocks map to *contiguous* module runs
 * (module order is column-major, so a block is a vertical stripe), which localizes
 * damage then destroys a few blocks completely rather than lightly corrupting
 * all of them, which is what an erasure code can actually absorb.
 *
 * Everything the decoder needs is derived from the symbol geometry, so there is
 * no format-information region: the finder patterns give the module pitch, the
 * grid size follows, and the grid size selects the whole layout.
 */

import { PROFILE_CLOUD, PROFILE_DISK, CODEC_COLOR_GRID } from '../header';
import { readU32, writeU32 } from '../bytes';
import { crc32 } from '../crc32';
import { rsEncode, rsReconstructData } from '../reed-solomon';
import type { Codec, ImageDataLike } from './types';

/** Modules of white border, matching the QR convention. */
export const QUIET_ZONE = 4;
/** Side of each corner finder, in modules (QR-style 1:1:3:1:1 bullseye). */
const FINDER = 7;
/**
 * Finders reserve one extra module on their two inner sides as a white
 * separator. Without it a neighbouring dark data module merges with the outer
 * ring and destroys the run signature the detector looks for, the same reason
 * QR puts a separator around its finders.
 */
const FINDER_BOX = FINDER + 1;
/** Palette calibration run: one module per color, in canonical order. */
const CAL_LEN = 8;
/** Row holding the calibration run, immediately below the top-left finder box. */
const CAL_ROW = FINDER_BOX;
/** Payload bytes per Reed-Solomon block. */
const BLOCK_LEN = 64;
/** Each stored block is the block followed by its CRC-32. */
const CRC_LEN = 4;
const STORED_BLOCK = BLOCK_LEN + CRC_LEN;
/** u32 true-payload-length prefix at the head of the data region. */
const LEN_PREFIX = 4;

/**
 * The eight palette colors: value `v` maps to (bit2 = R, bit1 = G, bit0 = B),
 * each channel fully off or fully on.
 *
 *   0 black · 1 blue · 2 green · 3 cyan · 4 red · 5 magenta · 6 yellow · 7 white
 */
export const PALETTE: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [0, 0, 255],
  [0, 255, 0],
  [0, 255, 255],
  [255, 0, 0],
  [255, 0, 255],
  [255, 255, 0],
  [255, 255, 255],
];

const BLACK = 0;
const WHITE = 7;

/**
 * Per-profile geometry, frozen in SPEC.md §2.2. The grid size is the key: it is
 * recoverable from the image alone, and it selects every other parameter, so the
 * decoder never needs to be told which profile it is looking at.
 */
interface GridSpec {
  profile: number;
  /** Grid side in modules. */
  n: number;
  /** Pixels per module when encoding. */
  moduleScale: number;
  /** Parity fraction, as a percentage of the total block count. */
  parityPercent: number;
}

const GRIDS: readonly GridSpec[] = [
  // Cloud round-trips through JPEG re-encoding: fat modules, heavy parity.
  { profile: PROFILE_CLOUD, n: 128, moduleScale: 12, parityPercent: 35 },
  // Disk is lossless PNG, so density is the only thing that matters.
  { profile: PROFILE_DISK, n: 168, moduleScale: 4, parityPercent: 12 },
];

function gridForProfile(profile: number): GridSpec {
  const g = GRIDS.find((x) => x.profile === profile);
  if (!g) {
    throw new Error(`color-grid: profile ${profile} is not supported (paper output uses qr-grid)`);
  }
  return g;
}

/** Block counts and capacity for a grid size. A pure function of `n`. */
interface Layout {
  n: number;
  dataModules: number;
  k: number;
  m: number;
  /** Usable payload bytes (the length prefix already deducted). */
  capacity: number;
}

function layoutFor(g: GridSpec): Layout {
  const n = g.n;
  // Four finder boxes plus the calibration run are the only reserved modules.
  const dataModules = n * n - 4 * FINDER_BOX * FINDER_BOX - CAL_LEN;
  const storableBytes = Math.floor((dataModules * 3) / 8);
  const totalBlocks = Math.floor(storableBytes / STORED_BLOCK);
  const m = Math.ceil((totalBlocks * g.parityPercent) / 100);
  const k = totalBlocks - m;
  if (k < 1) throw new Error(`color-grid: grid ${n} is too small to carry data`);
  if (totalBlocks > 256) throw new Error(`color-grid: grid ${n} needs more than 256 RS shards`);
  return { n, dataModules, k, m, capacity: k * BLOCK_LEN - LEN_PREFIX };
}

function capacity(profile: number): number {
  return layoutFor(gridForProfile(profile)).capacity;
}

/** True for the modules taken by the finder boxes and the calibration run. */
function isReserved(n: number, x: number, y: number): boolean {
  const far = n - FINDER_BOX;
  const nearX = x < FINDER_BOX || x >= far;
  if ((y < FINDER_BOX || y >= far) && nearX) return true;
  if (y === CAL_ROW && x < CAL_LEN) return true;
  return false;
}

/**
 * Data modules in storage order: column-major, so consecutive bytes land in the
 * same column and each Reed-Solomon block occupies a contiguous vertical stripe.
 */
function dataModuleOrder(n: number): Int32Array {
  const order = new Int32Array(n * n - 4 * FINDER_BOX * FINDER_BOX - CAL_LEN);
  let i = 0;
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      if (!isReserved(n, x, y)) order[i++] = y * n + x;
    }
  }
  return order;
}

// --- encoding -------------------------------------------------------------

/** Lay the finders and the calibration run into a module-value grid. */
function paintFixedPatterns(cells: Uint8Array, n: number): void {
  const corners = [
    [0, 0],
    [n - FINDER, 0],
    [0, n - FINDER],
    [n - FINDER, n - FINDER],
  ];
  for (const [ox, oy] of corners) {
    for (let dy = 0; dy < FINDER; dy++) {
      for (let dx = 0; dx < FINDER; dx++) {
        // Concentric rings give the classic 1:1:3:1:1 run signature through the
        // centre line, which is what the detector scans for.
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        cells[(oy! + dy) * n + ox! + dx] = ring === 2 ? WHITE : BLACK;
      }
    }
  }
  // The separator ring needs no painting; unset cells are already white.
  for (let v = 0; v < CAL_LEN; v++) cells[CAL_ROW * n + v] = v;
}

/**
 * A tiny deterministic PRNG for the filler that pads a part-full symbol.
 *
 * The filler sits *outside* the encryption; it is codec-level padding in the
 * image, so leaving it zeroed painted a flat black band whose width advertised
 * how much of the capacity the secret actually used. Pseudo-random filler makes
 * a part-full symbol look like a full one.
 *
 * Seeded from the payload's CRC rather than a constant: a fixed seed would paint
 * the *same* pattern into every image, and two images compared side by side
 * would give the padding boundary straight back.
 */
function makeFiller(seed: number): () => number {
  let s = (seed || 1) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 24) & 0xff;
  };
}

/** Pack the k data blocks plus RS parity, each with its CRC-32 appended. */
function buildStoredBytes(payload: Uint8Array, lay: Layout): Uint8Array {
  const region = new Uint8Array(lay.k * BLOCK_LEN);
  writeU32(region, 0, payload.length);
  region.set(payload, LEN_PREFIX);
  // Filler is covered by the block CRCs and the RS parity like any other byte,
  // and the decoder never looks at it, since it slices exactly `payload.length`.
  const filler = makeFiller(crc32(payload));
  for (let i = LEN_PREFIX + payload.length; i < region.length; i++) region[i] = filler();

  const blocks: Uint8Array[] = [];
  for (let i = 0; i < lay.k; i++) {
    blocks.push(region.subarray(i * BLOCK_LEN, (i + 1) * BLOCK_LEN));
  }
  const all = [...blocks, ...rsEncode(blocks, lay.m)];

  const stored = new Uint8Array(all.length * STORED_BLOCK);
  all.forEach((block, i) => {
    const at = i * STORED_BLOCK;
    stored.set(block, at);
    writeU32(stored, at + BLOCK_LEN, crc32(block));
  });
  return stored;
}

function encode(payload: Uint8Array, profile: number): ImageDataLike {
  const grid = gridForProfile(profile);
  const lay = layoutFor(grid);
  if (payload.length > lay.capacity) {
    throw new RangeError(
      `color-grid: payload of ${payload.length} exceeds the ${lay.capacity}-byte capacity`,
    );
  }

  const n = grid.n;
  const cells = new Uint8Array(n * n).fill(WHITE);
  paintFixedPatterns(cells, n);

  // Three bits per module, MSB-first, straight off the stored byte stream.
  const stored = buildStoredBytes(payload, lay);
  const order = dataModuleOrder(n);
  const totalBits = stored.length * 8;
  // The stream never divides evenly into modules, so a handful at the end carry
  // no data. Colour them like the rest rather than leaving a white nick.
  const tail = makeFiller(crc32(stored));
  for (let i = 0; i < order.length; i++) {
    const bitAt = i * 3;
    if (bitAt >= totalBits) {
      cells[order[i]!] = tail() & 7;
      continue;
    }
    let v = 0;
    for (let b = 0; b < 3; b++) {
      // The last data-carrying module holds one or two real bits and pads the
      // rest with zero. Dropping it instead would leave the final block's CRC
      // unreadable.
      const bit = bitAt + b;
      const value = bit < totalBits ? (stored[bit >> 3]! >> (7 - (bit & 7))) & 1 : 0;
      v = (v << 1) | value;
    }
    cells[order[i]!] = v;
  }

  return renderCells(cells, n, grid.moduleScale);
}

function renderCells(cells: Uint8Array, n: number, scale: number): ImageDataLike {
  const dim = (n + QUIET_ZONE * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255); // white RGBA
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const [r, g, b] = PALETTE[cells[y * n + x]!]!;
      const x0 = (x + QUIET_ZONE) * scale;
      const y0 = (y + QUIET_ZONE) * scale;
      for (let dy = 0; dy < scale; dy++) {
        let idx = ((y0 + dy) * dim + x0) * 4;
        for (let dx = 0; dx < scale; dx++) {
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          idx += 4; // alpha stays 255
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

// --- finder detection -----------------------------------------------------

interface Point {
  x: number;
  y: number;
}

function toLuma(img: ImageDataLike): Uint8Array {
  const { data, width, height } = img;
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const p = i * 4;
    out[i] = (data[p]! * 77 + data[p + 1]! * 150 + data[p + 2]! * 29) >> 8;
  }
  return out;
}

/** Midpoint between the darkest and lightest luma; the symbol is high contrast. */
function lumaThreshold(luma: Uint8Array): number {
  let lo = 255;
  let hi = 0;
  for (const v of luma) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return (lo + hi) >> 1;
}

/**
 * Scratch buffers for the run-length scan, reused across every row and column.
 *
 * Rejecting a photo that is not a color grid is the hot path (a restore feeds
 * every image through here) and a noisy megapixel photo produces a run per
 * couple of pixels. Allocating per row (or per candidate window) turns that into
 * millions of short-lived objects, so the scan writes into these instead.
 */
interface RunScan {
  start: Int32Array;
  len: Int32Array;
  count: number;
  /** Runs strictly alternate, so one flag gives the parity of them all. */
  firstDark: boolean;
}

function makeRunScan(capacity: number): RunScan {
  return {
    start: new Int32Array(capacity),
    len: new Int32Array(capacity),
    count: 0,
    firstDark: false,
  };
}

/** Split a line of samples into alternating dark/light runs. */
function scanRuns(scan: RunScan, dark: (i: number) => boolean, length: number): void {
  scan.count = 0;
  if (length === 0) return;
  scan.firstDark = dark(0);
  let start = 0;
  let cur = scan.firstDark;
  for (let i = 1; i <= length; i++) {
    const d = i === length ? !cur : dark(i);
    if (d !== cur) {
      scan.start[scan.count] = start;
      scan.len[scan.count] = i - start;
      scan.count++;
      start = i;
      cur = d;
    }
  }
}

/** A 1:1:3:1:1 run match: where its centre is, and the module pitch it implies. */
interface PatternHit {
  centre: number;
  unit: number;
}

/**
 * Find the 1:1:3:1:1 dark-light-dark-light-dark run signature in a scanned line
 * the same signature QR uses, and the reason the finders carry a white
 * separator on their inner sides. Appends to `out`.
 */
function findPatternHits(scan: RunScan, out: PatternHit[]): void {
  out.length = 0;
  const { start, len, count, firstDark } = scan;
  for (let i = 0; i + 5 <= count; i++) {
    // Runs alternate, so the window is the right polarity iff it starts dark.
    if (firstDark !== (i % 2 === 0)) continue;
    const a = len[i]!;
    const b = len[i + 1]!;
    const c = len[i + 2]!;
    const d = len[i + 3]!;
    const e = len[i + 4]!;
    const total = a + b + c + d + e;
    const unit = total / 7;
    if (unit < 1) continue;
    // Half a module of slack per run absorbs resampling and JPEG ringing.
    const slack = unit * 0.5 + 0.5;
    if (Math.abs(a - unit) > slack) continue;
    if (Math.abs(b - unit) > slack) continue;
    if (Math.abs(c - unit * 3) > slack) continue;
    if (Math.abs(d - unit) > slack) continue;
    if (Math.abs(e - unit) > slack) continue;
    out.push({ centre: start[i]! + total / 2, unit });
  }
}

/**
 * More finder-like spots than any real symbol could contain. A color grid has
 * exactly four; anything past this is noise, and giving up early keeps the
 * clustering below from going quadratic on a megapixel photo.
 */
const MAX_CLUSTERS = 64;

/**
 * Locate the four corner finders: their centres in pixel space, plus the module
 * pitch they imply. The pitch is what lets `decode` pick the right grid size
 * straight away instead of trying each one.
 */
function locateFinders(img: ImageDataLike): { corners: Point[]; unit: number } {
  const { width, height } = img;
  const luma = toLuma(img);
  const t = lumaThreshold(luma);

  const rowScan = makeRunScan(width + 2);
  const colScan = makeRunScan(height + 2);
  const rowHits: PatternHit[] = [];
  const colHits: PatternHit[] = [];
  // Column scans are memoized: a finder is hit on several consecutive rows, and
  // re-scanning the same column each time is pure waste.
  const columnHits = new Map<number, PatternHit[]>();

  const clusters: { sx: number; sy: number; count: number }[] = [];
  const units: number[] = [];
  const radius = Math.max(4, Math.min(width, height) / 100);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    scanRuns(rowScan, (i) => luma[row + i]! < t, width);
    findPatternHits(rowScan, rowHits);
    for (const hit of rowHits) {
      // A real finder shows the same signature vertically through its centre, at
      // the same module pitch. Requiring both, and requiring them to agree,
      // is what keeps captions and brand text from posing as finders.
      const x = Math.round(hit.centre);
      if (x < 0 || x >= width) continue;
      let col = columnHits.get(x);
      if (!col) {
        scanRuns(colScan, (i) => luma[i * width + x]! < t, height);
        findPatternHits(colScan, colHits);
        col = colHits.slice();
        columnHits.set(x, col);
      }
      let square = false;
      for (const v of col) {
        if (Math.abs(v.centre - y) <= 2 && Math.abs(v.unit - hit.unit) <= hit.unit * 0.25) {
          square = true;
          break;
        }
      }
      if (!square) continue;

      units.push(hit.unit);
      // Each finder produces a candidate on every scanline crossing it; collapse
      // those into one point per finder as we go.
      let merged = false;
      for (const k of clusters) {
        if (
          Math.abs(k.sx / k.count - hit.centre) < radius &&
          Math.abs(k.sy / k.count - y) < radius
        ) {
          k.sx += hit.centre;
          k.sy += y;
          k.count++;
          merged = true;
          break;
        }
      }
      if (merged) continue;
      if (clusters.length >= MAX_CLUSTERS) {
        throw new Error('color-grid: no color grid found in image');
      }
      clusters.push({ sx: hit.centre, sy: y, count: 1 });
    }
  }
  if (clusters.length < 4) throw new Error('color-grid: no color grid found in image');

  const points = clusters.map((k) => ({ x: k.sx / k.count, y: k.sy / k.count }));
  // The four extremes of the sum/difference are the corners of the symbol.
  const pick = (score: (p: Point) => number): Point =>
    points.reduce((best, p) => (score(p) < score(best) ? p : best));
  const tl = pick((p) => p.x + p.y);
  const br = pick((p) => -(p.x + p.y));
  const tr = pick((p) => p.y - p.x);
  const bl = pick((p) => p.x - p.y);
  units.sort((a, b) => a - b);
  return { corners: [tl, tr, bl, br], unit: units[units.length >> 1] ?? 1 };
}

// --- decoding -------------------------------------------------------------

/**
 * Bilinear map from grid coordinates to pixels, anchored on the four finder
 * centres. Digital images are axis-aligned and at most uniformly rescaled, so
 * this absorbs everything they do to us without needing a homography solve,
 * and it stays trivial to mirror in the Python reference decoder.
 */
function samplePoint(corners: Point[], u: number, v: number): Point {
  const [tl, tr, bl, br] = corners as [Point, Point, Point, Point];
  const top = { x: tl.x + (tr.x - tl.x) * u, y: tl.y + (tr.y - tl.y) * u };
  const bot = { x: bl.x + (br.x - bl.x) * u, y: bl.y + (br.y - bl.y) * u };
  return { x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v };
}

/** Average the central half of a module's area, to reject edge bleed. */
function sampleModule(
  img: ImageDataLike,
  corners: Point[],
  n: number,
  mx: number,
  my: number,
  half: number,
): [number, number, number] {
  // Finder centres are the module at index 3 from each edge, so the centre-to-
  // centre span is (n - 7) modules and module 3 maps to u = 0.
  const span = n - FINDER;
  const c = samplePoint(corners, (mx - 3) / span, (my - 3) / span);
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const lo = -Math.floor(half);
  const hi = Math.floor(half);
  for (let dy = lo; dy <= hi; dy++) {
    for (let dx = lo; dx <= hi; dx++) {
      const px = Math.round(c.x + dx);
      const py = Math.round(c.y + dy);
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
      const i = (py * img.width + px) * 4;
      r += img.data[i]!;
      g += img.data[i + 1]!;
      b += img.data[i + 2]!;
      count++;
    }
  }
  if (count === 0) return [0, 0, 0];
  return [r / count, g / count, b / count];
}

/** Rotate grid coordinates by `turns` quarter-turns clockwise. */
function rotate(n: number, x: number, y: number, turns: number): [number, number] {
  switch (turns & 3) {
    case 1:
      return [n - 1 - y, x];
    case 2:
      return [n - 1 - x, n - 1 - y];
    case 3:
      return [y, n - 1 - x];
    default:
      return [x, y];
  }
}

function nearestPaletteValue(
  rgb: [number, number, number],
  refs: [number, number, number][],
): number {
  let best = 0;
  let bestDist = Infinity;
  for (let v = 0; v < refs.length; v++) {
    const ref = refs[v]!;
    const d = (rgb[0] - ref[0]) ** 2 + (rgb[1] - ref[1]) ** 2 + (rgb[2] - ref[2]) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = v;
    }
  }
  return best;
}

/**
 * Read every stored block at one candidate rotation. Blocks whose CRC fails come
 * back as null so Reed-Solomon can treat them as erasures.
 */
function readBlocks(
  img: ImageDataLike,
  corners: Point[],
  lay: Layout,
  turns: number,
  half: number,
): { blocks: (Uint8Array | null)[]; good: number } {
  const n = lay.n;
  const read = (x: number, y: number): [number, number, number] => {
    const [rx, ry] = rotate(n, x, y, turns);
    return sampleModule(img, corners, n, rx, ry, half);
  };

  // Calibrate against the palette run as *observed*, not as encoded. This is
  // what absorbs JPEG chroma shift, gamma and white-balance drift.
  const refs: [number, number, number][] = [];
  for (let v = 0; v < CAL_LEN; v++) refs.push(read(v, CAL_ROW));

  const order = dataModuleOrder(n);
  const total = (lay.k + lay.m) * STORED_BLOCK;
  const stored = new Uint8Array(total);
  const bitLimit = total * 8;
  for (let i = 0; i < order.length; i++) {
    const bitAt = i * 3;
    if (bitAt >= bitLimit) break;
    const cell = order[i]!;
    const v = nearestPaletteValue(read(cell % n, Math.floor(cell / n)), refs);
    for (let b = 0; b < 3; b++) {
      const bit = bitAt + b;
      if (bit < bitLimit && (v >> (2 - b)) & 1) {
        stored[bit >> 3] = stored[bit >> 3]! | (0x80 >> (bit & 7));
      }
    }
  }

  const blocks: (Uint8Array | null)[] = [];
  let good = 0;
  for (let i = 0; i < lay.k + lay.m; i++) {
    const at = i * STORED_BLOCK;
    const block = stored.subarray(at, at + BLOCK_LEN);
    if (crc32(block) === readU32(stored, at + BLOCK_LEN)) {
      blocks.push(block);
      good++;
    } else {
      blocks.push(null);
    }
  }
  return { blocks, good };
}

function decode(image: ImageDataLike): Uint8Array {
  const { corners, unit } = locateFinders(image);
  const [tl, tr] = corners as [Point, Point];
  const spanPx = Math.hypot(tr.x - tl.x, tr.y - tl.y);

  // Neither the grid size nor the orientation is written anywhere. The finder
  // pitch gives a good estimate of the grid size, so try the closest match
  // first; the others stay as a fallback. Only the sampling repeats,
  // Reed-Solomon runs once, at the end.
  const estimated = spanPx / unit + FINDER;
  const ordered = [...GRIDS].sort((a, b) => Math.abs(a.n - estimated) - Math.abs(b.n - estimated));

  let best: { lay: Layout; blocks: (Uint8Array | null)[]; good: number } | undefined;
  for (const spec of ordered) {
    const lay = layoutFor(spec);
    const pitch = spanPx / (lay.n - FINDER);
    if (pitch < 1) continue;
    for (let turns = 0; turns < 4; turns++) {
      const { blocks, good } = readBlocks(image, corners, lay, turns, pitch / 4);
      if (!best || good > best.good) best = { lay, blocks, good };
      // Once enough blocks survive to reconstruct, another rotation cannot help:
      // the remaining candidates are only worth sampling while we still cannot
      // read the payload at all.
      if (good >= lay.k) break;
    }
    if (best && best.good >= best.lay.k) break;
  }

  if (!best || best.good < best.lay.k) {
    throw new Error('color-grid: too much damage to reconstruct this image');
  }

  const data = rsReconstructData(best.blocks, best.lay.k, best.lay.m);
  const region = new Uint8Array(best.lay.k * BLOCK_LEN);
  data.forEach((block, i) => region.set(block, i * BLOCK_LEN));

  const len = readU32(region, 0);
  if (len > best.lay.capacity) throw new Error('color-grid: recovered length is out of range');
  return region.slice(LEN_PREFIX, LEN_PREFIX + len);
}

export const colorGridCodec: Codec = { id: CODEC_COLOR_GRID, capacity, encode, decode };
