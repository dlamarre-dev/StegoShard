/**
 * UERD embedding costs for the S1 writer (adaptive-embedding plan, step 3).
 *
 * The cost function is Guo, Ni, Su, Tang and Shi, "Using Statistical Image Model
 * for JPEG Steganography: Uniform Embedding Revisited", IEEE TIFS 10(12), 2015.
 * A change to AC mode k of block b costs
 *
 *     ρ = q_k / (D_b + ¼ · Σ D_n)        D = Σ_{k=1..63} |c_k| · q_k
 *
 * where q_k is the quantization step of the mode, D the dequantized AC energy of
 * a block and the sum runs over the (up to) eight neighbours of b in the same
 * component. A change is cheap where the block and its surroundings are busy and
 * the mode is coarsely quantized, which is where a flipped coefficient hides in
 * the texture; smooth sky pays the most. The paper's special case for the DC
 * step does not arise: S1 never writes DC.
 *
 * Costs are writer-only. The reader recovers the message from parities alone, so
 * a writer may change this function without changing the format (SPEC §9.3.1),
 * which is why it lives apart from `stc.ts` and the spec text.
 *
 * Only IEEE additions, multiplications and one division per carrier: the same
 * doubles on every engine, so the fixed-point costs `stcCosts` derives from them,
 * and with them the embed, are deterministic.
 */

import type { JpegModel } from '../jpeg-coeff';
import { parseJpegSegments } from '../jpeg-segments';
import { STC_MAX_COST } from '../stc';

const SOF0 = 0xc0;
const DQT = 0xdb;

/**
 * The 64 quantization steps of each frame component, in zig-zag order (the order
 * DQT stores them and the order `JpegModel` blocks are indexed in).
 */
export function componentQuantTables(model: JpegModel): Uint16Array[] {
  const bytes = model.bytes;
  const tables = new Map<number, Uint16Array>();
  let tq: number[] | null = null;
  for (const seg of parseJpegSegments(bytes).segments) {
    if (seg.marker === DQT) {
      let p = seg.payloadStart;
      while (p < seg.end) {
        const wide = bytes[p]! >> 4 !== 0;
        const id = bytes[p]! & 0x0f;
        p += 1;
        const t = new Uint16Array(64);
        for (let i = 0; i < 64; i++) {
          t[i] = wide ? (bytes[p + 2 * i]! << 8) | bytes[p + 2 * i + 1]! : bytes[p + i]!;
        }
        p += wide ? 128 : 64;
        tables.set(id, t); // a later definition replaces an earlier one
      }
    } else if (seg.marker === SOF0) {
      const nf = bytes[seg.payloadStart + 5]!;
      tq = [];
      for (let i = 0; i < nf; i++) tq.push(bytes[seg.payloadStart + 6 + i * 3 + 2]!);
    }
  }
  if (!tq || tq.length !== model.components.length) throw new Error('uerd: no baseline frame');
  return tq.map((id) => {
    const t = tables.get(id);
    if (!t) throw new Error(`uerd: frame names quantization table ${id}, which is not defined`);
    return t;
  });
}

/**
 * The UERD cost of every S1 carrier (AC, |v| ≥ 2), in carrier order: component,
 * then block in decode order, then zig-zag index, as `eligibleCoefficients`
 * enumerates them.
 */
export function uerdCosts(model: JpegModel): Float64Array {
  const quant = componentQuantTables(model);
  const out: number[] = [];
  model.components.forEach((comp, ci) => {
    const q = quant[ci]!;
    const n = comp.blocks.length;
    const energy = new Float64Array(n);
    for (let b = 0; b < n; b++) {
      const block = comp.blocks[b]!;
      let d = 0;
      for (let k = 1; k < 64; k++) d += Math.abs(block[k]!) * q[k]!;
      energy[b] = d;
    }

    // Blocks come in MCU order: h·v of them per MCU, raster within it. Place each
    // on the component's own block grid to find its neighbours. The decoder
    // makes every block of every MCU, so the grid has no hole.
    const per = comp.h * comp.v;
    const cols = model.mcusPerLine * comp.h;
    const rows = model.mcusPerColumn * comp.v;
    const grid = new Int32Array(cols * rows);
    for (let b = 0; b < n; b++) {
      const mcu = (b / per) | 0;
      const sub = b % per;
      const r = ((mcu / model.mcusPerLine) | 0) * comp.v + ((sub / comp.h) | 0);
      const c = (mcu % model.mcusPerLine) * comp.h + (sub % comp.h);
      grid[r * cols + c] = b;
    }

    const denom = new Float64Array(n);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const b = grid[r * cols + c]!;
        let around = 0;
        for (let dr = -1; dr <= 1; dr++) {
          if (r + dr < 0 || r + dr >= rows) continue;
          for (let dc = -1; dc <= 1; dc++) {
            if ((dr === 0 && dc === 0) || c + dc < 0 || c + dc >= cols) continue;
            around += energy[grid[(r + dr) * cols + c + dc]!]!;
          }
        }
        denom[b] = energy[b]! + 0.25 * around;
      }
    }

    for (let b = 0; b < n; b++) {
      const block = comp.blocks[b]!;
      // |v| >= 2 gives D_b >= 2q > 0, so no carrier divides by zero.
      for (let k = 1; k < 64; k++) if (Math.abs(block[k]!) >= 2) out.push(q[k]! / denom[b]!);
    }
  });
  return Float64Array.from(out);
}

/**
 * Where the median carrier's cost lands in the STC's 12-bit fixed point. The
 * range above it, 64 times the median, is where UERD sends smooth blocks; past
 * `STC_MAX_COST` they all cost the same, dear enough that the trellis only takes
 * one when nothing cheaper gives the syndrome. None is wet, so no cover a
 * uniform embed accepts is refused for want of a feasible path.
 */
const STC_MEDIAN_COST = 64;

/**
 * Real costs, one per carrier of the photo, to the fixed-point costs of the
 * `order.length` carriers the code spans, in code order.
 *
 * Scaled so that the median of those carriers costs `STC_MEDIAN_COST`: a UERD
 * cost's scale depends on the photo's quantization and texture, and only ratios
 * matter to the trellis. Rounded, then clamped to `1 .. STC_MAX_COST`; no flip is
 * free, or the trellis would take free ones for nothing. A sort and IEEE
 * arithmetic only, so the same on every engine.
 */
export function stcCosts(raw: Float64Array, order: Uint32Array): Int32Array {
  const picked = new Float64Array(order.length);
  for (let i = 0; i < order.length; i++) picked[i] = raw[order[i]!]!;
  const sorted = Float64Array.from(picked).sort();
  const median = sorted[sorted.length >> 1]!;
  // Every UERD cost is positive (a carrier's block has D ≥ 2q), so the median is.
  const scale = STC_MEDIAN_COST / median;
  const out = new Int32Array(order.length);
  for (let i = 0; i < order.length; i++) {
    out[i] = Math.min(STC_MAX_COST, Math.max(1, Math.round(picked[i]! * scale)));
  }
  return out;
}
