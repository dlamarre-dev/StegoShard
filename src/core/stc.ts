/**
 * Syndrome-trellis codes (STC), binary, for embedding scheme S1 (SPEC §9.3.1).
 *
 * The construction is Filler, Judas and Fridrich, "Minimizing Additive Distortion
 * in Steganography Using Syndrome-Trellis Codes", IEEE TIFS 6(3), 2011. Nothing
 * here departs from it; what this module fixes is every choice the paper leaves
 * to an implementation, because the reader must make the same ones:
 *
 *  - the constraint height, `STC_HEIGHT`;
 *  - the submatrix Ĥ, generated (not searched) from a fixed seed, so that it can
 *    be written down in the spec as a procedure rather than as a table;
 *  - the truncation of H at the end of the trellis;
 *  - the tie-break in the Viterbi pass, which decides the output when two paths
 *    cost the same, and so decides whether the embed is deterministic.
 *
 * The parity-check matrix H is m × (m·w): Ĥ (h × w) placed on the diagonal, one
 * row lower for each of the m message bits, its rows below m dropped. The
 * receiver computes the message as the syndrome H·y of the parities y it reads,
 * which needs neither the costs nor the cover; the sender finds the y of least
 * total cost with that syndrome, by a Viterbi pass over 2^h states.
 *
 * Pure and synchronous: the keyed permutation that maps these positions onto a
 * photo's coefficients lives in `stego.ts`, which owns the keystream.
 */

/**
 * Constraint height h (SPEC §9.3.1). Time is n · 2^h, memory n · 2^h bits.
 *
 * Measured on a gallery slot (m = 16 872, w = 16), random covers, desktop:
 *
 *   h =  8: 2 501 changes, 163 ms     h = 10: 2 343 changes,   642 ms
 *   h =  9: 2 388 changes, 314 ms     h = 11: 2 292 changes, 2 004 ms
 *
 * Nine keeps within 2 % of ten's changes at half its time, which is what brings
 * an embed on a phone under three seconds a photo.
 */
export const STC_HEIGHT = 9;

/**
 * Code width w: carriers per message bit, so the code spans `m · STC_WIDTH`
 * carriers of the photo (SPEC §9.3.1).
 *
 * Fixed rather than derived from the photo, and measured before it was fixed. On
 * a gallery slot (m = 16 872) at h = 9, random covers, desktop:
 *
 *   w = 16: 2 382 changes, 0.37 s     w = 32: 2 195 changes, 0.75 s
 *   w = 24: 2 284 changes, 0.56 s     w = 64: 2 028 changes, 2.05 s
 *
 * Each doubling buys under 10 % fewer changes for nearly twice the time, on a
 * desktop; a phone is several times slower. And a width that varied with the
 * photo's carrier count would make the whole message depend on the reader
 * counting carriers exactly as the writer did. Sixteen is also the write margin
 * (`GALLERY_EMBED_MARGIN`), so every cover a writer accepts has room for it.
 *
 * The code reaches about 83 % of the rate-distortion bound here (7.1 bits per
 * change against 8.5). Searching the submatrix seed moved that by 1 to 2 %, which
 * is why Ĥ is generated rather than tabulated.
 */
export const STC_WIDTH = 16;

const STATES = 1 << STC_HEIGHT;
const HALF = STATES >>> 1;

/**
 * The submatrix Ĥ for width `w`: `w` columns of `STC_HEIGHT` bits, bit `b` of a
 * column standing for the row `b` places below the current one.
 *
 * Each column is drawn from Marsaglia's xorshift32 seeded with `0x53544331`
 * ("STC1"), masked to h bits, with its first and last bit forced to 1. Forcing
 * those two is the paper's own recommendation: a column without its top bit
 * cannot reach the row being closed, and one without its bottom bit shortens the
 * code's memory. The columns for a width are the first `w` draws, so the
 * submatrix for one width is a prefix of the next one's.
 */
export function stcSubmatrix(w: number): Uint32Array {
  const cols = new Uint32Array(w);
  let s = 0x53544331;
  const mask = STATES - 1;
  for (let j = 0; j < w; j++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    cols[j] = ((s & mask) | 1 | HALF) >>> 0;
  }
  return cols;
}

/**
 * The column of H at message block `i`, width position `j`, after truncation:
 * the rows at or past `m` do not exist, so their bits are dropped.
 */
function columnAt(cols: Uint32Array, i: number, j: number, m: number): number {
  const rows = m - i;
  return rows >= STC_HEIGHT ? cols[j]! : cols[j]! & ((1 << rows) - 1);
}

/**
 * The message `H·y`, one bit per entry (0 or 1), from `y`, the parities read at
 * the permuted carrier positions. `y.length` must be `m · w`.
 */
export function stcExtract(y: Uint8Array, m: number, w: number): Uint8Array {
  if (y.length !== m * w) throw new RangeError(`stc: expected ${m * w} parities, got ${y.length}`);
  const cols = stcSubmatrix(w);
  const out = new Uint8Array(m);
  let acc = 0;
  for (let i = 0, idx = 0; i < m; i++) {
    for (let j = 0; j < w; j++, idx++) if (y[idx]) acc ^= columnAt(cols, i, j, m);
    out[i] = acc & 1;
    acc >>>= 1;
  }
  return out;
}

/** What `stcEmbed` found: the parities to write, and what writing them costs. */
export interface StcResult {
  /** Parities y with H·y equal to the message; `y[i] !== x[i]` is a change. */
  y: Uint8Array;
  /** Number of positions where y differs from x. */
  changes: number;
  /** Sum of the costs of those positions. */
  cost: number;
}

/** Largest finite cost a position may carry: costs are 12-bit fixed point. */
export const STC_MAX_COST = 4095;

/** The cost that makes a position wet: the embedder never flips it. */
export const STC_WET = 1 << 24;

/**
 * Where a path weight saturates. Everything below is chosen so that the int32
 * arithmetic of the trellis is exact, which is what makes the embedder's output
 * the same on every engine:
 *
 *  - a weight is at most `INF` at the start of a block, and a block adds at most
 *    `w · STC_WET` to it, so with `w ≤ STC_MAX_WIDTH` it stays below 2^31 and a
 *    difference of two weights never overflows;
 *  - the cheapest real path costs at most about 2 400 changes × `STC_MAX_COST`,
 *    under 2^24, so any path at or above `STC_WET` went through a wet position.
 */
const INF = 1 << 29;
const STC_MAX_WIDTH = 64;

/**
 * Find parities `y` of least total cost with `H·y = message`.
 *
 * `x` holds the cover's parities and `costs` the price of flipping each one, an
 * integer in `0 .. STC_MAX_COST` or `STC_WET` (`null` for 1 everywhere, which
 * minimizes the number of changes). `message` holds one bit per entry.
 *
 * Ties go to leaving the parity as it is (the comparison is strict), so the
 * result depends on the inputs alone.
 *
 * The inner loop has no branch, deliberately: the choice is a sign bit and a
 * mask. That keeps it fast, and keeps it fast under V8's block-coverage
 * counters too, which a branch per state multiplied several times over.
 */
export function stcEmbed(
  x: Uint8Array,
  costs: Int32Array | null,
  message: Uint8Array,
  w: number,
): StcResult {
  const m = message.length;
  const n = m * w;
  if (x.length !== n) throw new RangeError(`stc: expected ${n} cover parities, got ${x.length}`);
  if (w < 1 || w > STC_MAX_WIDTH)
    throw new RangeError(`stc: width ${w} outside 1..${STC_MAX_WIDTH}`);
  if (costs) {
    if (costs.length !== n) throw new RangeError('stc: one cost per cover parity');
    for (const c of costs) {
      if (c !== STC_WET && (c < 0 || c > STC_MAX_COST)) {
        throw new RangeError(`stc: cost ${c} outside 0..${STC_MAX_COST} and not wet`);
      }
    }
  }
  const cols = stcSubmatrix(w);

  // One bit per (position, state): whether the state was reached by writing a 1.
  const WORDS = STATES >>> 5;
  const path = new Uint32Array(n * WORDS);
  let wght = new Int32Array(STATES).fill(INF);
  let next = new Int32Array(STATES);
  wght[0] = 0;

  for (let i = 0, idx = 0; i < m; i++) {
    for (let j = 0; j < w; j++, idx++) {
      const col = columnAt(cols, i, j, m);
      const c = costs ? costs[idx]! : 1;
      // Writing 0 costs c when the cover parity is 1, and nothing when it is 0;
      // writing 1 the other way round.
      const c0 = x[idx] ? c : 0;
      const c1 = x[idx] ? 0 : c;
      const base = idx * WORDS;
      // Thirty-two states at a time, so each word of the path is written once.
      for (let kw = 0; kw < WORDS; kw++) {
        let decided = 0;
        const k0 = kw << 5;
        for (let b = 0; b < 32; b++) {
          const k = k0 | b;
          const w0 = wght[k]! + c0;
          const d = wght[k ^ col]! + c1 - w0; // w1 - w0
          const one = (d >> 31) & 1; // 1 exactly when w1 < w0
          next[k] = w0 + (d & -one);
          decided |= one << b;
        }
        path[base + kw] = decided;
      }
      const t = wght;
      wght = next;
      next = t;
    }
    // Close row i: keep the states whose bit 0 matches the message bit, and shift
    // the next row into place.
    const bit = message[i]!;
    for (let k = 0; k < HALF; k++) next[k] = Math.min(wght[(k << 1) | bit]!, INF);
    next.fill(INF, HALF);
    const t = wght;
    wght = next;
    next = t;
  }

  const cost = wght[0]!;
  if (cost >= STC_WET) throw new StcInfeasibleError();

  const y = new Uint8Array(n);
  let state = 0;
  let changes = 0;
  for (let i = m - 1; i >= 0; i--) {
    state = ((state << 1) | message[i]!) & (STATES - 1);
    for (let j = w - 1; j >= 0; j--) {
      const idx = i * w + j;
      const one = (path[idx * WORDS + (state >>> 5)]! >>> (state & 31)) & 1;
      y[idx] = one;
      if (one) state ^= columnAt(cols, i, j, m);
      if (one !== x[idx]) changes++;
    }
  }
  return { y, changes, cost };
}

/** No parities with the required syndrome avoid the wet positions. */
export class StcInfeasibleError extends Error {
  constructor() {
    super('stc: no embedding avoids every wet position');
    this.name = 'StcInfeasibleError';
  }
}

/**
 * The first `n` entries of a keyed permutation of `[0, count)`, by a partial
 * Fisher-Yates shuffle drawing big-endian u32 values from `stream`.
 *
 * Step `i` swaps position `i` with `i + r`, where `r` is uniform in
 * `[0, count - i)`: a draw at or above `floor(2^32 / (count - i)) · (count - i)`
 * is rejected, so there is no modulo bias. Throws when the stream runs out,
 * rather than returning a shorter order.
 */
export function keyedOrder(stream: Uint8Array, count: number, n: number): Uint32Array {
  if (n > count) throw new RangeError(`stc: cannot order ${n} of ${count} carriers`);
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  let o = 0;
  for (let i = 0; i < n; i++) {
    const range = count - i;
    const limit = Math.floor(0x1_0000_0000 / range) * range;
    let r: number;
    do {
      if (o + 4 > stream.length) throw new RangeError('stc: position keystream exhausted');
      r =
        ((stream[o]! << 24) | (stream[o + 1]! << 16) | (stream[o + 2]! << 8) | stream[o + 3]!) >>>
        0;
      o += 4;
    } while (r >= limit);
    const j = i + (r % range);
    const t = order[i]!;
    order[i] = order[j]!;
    order[j] = t;
  }
  return order.subarray(0, n);
}

/**
 * Keystream bytes `keyedOrder` needs for `n` draws, with room for rejections.
 *
 * A draw is rejected with probability below `count / 2^32`, under 3·10⁻⁴ for any
 * photo this decoder accepts, so `n` draws cost a few hundred rejections at most;
 * 64 KiB of slack is sixteen thousand, which a run of bad luck does not reach.
 */
export function keyedOrderStreamLen(n: number): number {
  return 4 * n + 65_536;
}
