/**
 * Systematic Reed-Solomon erasure coding over GF(2^8) (see gf256.ts).
 *
 * The encoding matrix is `[ I_k ; C ]` where `I_k` is the k×k identity (so the
 * first k output shards are the data shards, unchanged) and `C` is an m×k
 * Cauchy matrix. A Cauchy matrix has the property that *every* square submatrix
 * is invertible, which makes `[ I_k ; C ]` a Maximum Distance Separable (MDS)
 * code: the original data reconstructs from *any* k of the k+m shards. That is
 * the guarantee behind "tolerate up to m missing/corrupt images" (plan §2).
 *
 * All shards share a fixed length; the matrix operations are applied
 * independently per byte position. This construction is frozen in SPEC.md so
 * the Python reference decoder can reproduce it exactly.
 */

import { gfAdd, gfMul, gfDiv } from './gf256';

/**
 * Build the m×k Cauchy matrix.
 *
 * Data columns use field elements y_j = m + j and parity rows use x_i = i, two
 * disjoint sets, so every `x_i XOR y_j` is non-zero and every submatrix is
 * invertible. Requires k + m <= 256.
 */
export function buildCauchyMatrix(k: number, m: number): Uint8Array[] {
  if (k < 1 || m < 0) throw new RangeError('reed-solomon: k must be >=1, m >=0');
  if (k + m > 256) throw new RangeError('reed-solomon: k + m must be <= 256');
  const rows: Uint8Array[] = [];
  for (let i = 0; i < m; i++) {
    const row = new Uint8Array(k);
    for (let j = 0; j < k; j++) {
      const x = i;
      const y = m + j;
      row[j] = gfDiv(1, gfAdd(x, y));
    }
    rows.push(row);
  }
  return rows;
}

/** Full (k+m)×k systematic encoding matrix: identity on top, Cauchy below. */
export function buildEncodingMatrix(k: number, m: number): Uint8Array[] {
  const rows: Uint8Array[] = [];
  for (let i = 0; i < k; i++) {
    const row = new Uint8Array(k);
    row[i] = 1;
    rows.push(row);
  }
  for (const c of buildCauchyMatrix(k, m)) rows.push(c);
  return rows;
}

/**
 * Compute the m parity shards from the k data shards. Every data shard must
 * have the same length.
 */
export function rsEncode(dataShards: Uint8Array[], m: number): Uint8Array[] {
  const k = dataShards.length;
  if (k === 0) throw new RangeError('reed-solomon: need at least one data shard');
  const shardLen = dataShards[0]!.length;
  for (const s of dataShards) {
    if (s.length !== shardLen) throw new RangeError('reed-solomon: shards differ in length');
  }
  const cauchy = buildCauchyMatrix(k, m);
  const parity: Uint8Array[] = [];
  for (let i = 0; i < m; i++) {
    const row = cauchy[i]!;
    const out = new Uint8Array(shardLen);
    for (let j = 0; j < k; j++) {
      const coeff = row[j]!;
      if (coeff === 0) continue;
      const shard = dataShards[j]!;
      for (let b = 0; b < shardLen; b++) {
        out[b] = out[b]! ^ gfMul(coeff, shard[b]!);
      }
    }
    parity.push(out);
  }
  return parity;
}

/** Invert an n×n matrix over GF(2^8) via Gauss-Jordan elimination. */
export function invertMatrix(matrix: Uint8Array[]): Uint8Array[] {
  const n = matrix.length;
  // Work on a copy augmented with the identity.
  const a = matrix.map((r) => Uint8Array.from(r));
  const inv: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const r = new Uint8Array(n);
    r[i] = 1;
    inv.push(r);
  }

  for (let col = 0; col < n; col++) {
    // Find a pivot row with a non-zero entry in this column.
    let pivot = col;
    while (pivot < n && a[pivot]![col] === 0) pivot++;
    if (pivot === n) throw new Error('reed-solomon: matrix is singular (not reconstructable)');
    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot]!, a[col]!];
      [inv[col], inv[pivot]] = [inv[pivot]!, inv[col]!];
    }

    // Normalize the pivot row so a[col][col] === 1.
    const pv = a[col]![col]!;
    for (let j = 0; j < n; j++) {
      a[col]![j] = gfDiv(a[col]![j]!, pv);
      inv[col]![j] = gfDiv(inv[col]![j]!, pv);
    }

    // Eliminate this column from all other rows.
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row]![col]!;
      if (factor === 0) continue;
      for (let j = 0; j < n; j++) {
        a[row]![j] = a[row]![j]! ^ gfMul(factor, a[col]![j]!);
        inv[row]![j] = inv[row]![j]! ^ gfMul(factor, inv[col]![j]!);
      }
    }
  }
  return inv;
}

/**
 * Reconstruct the k data shards from any k or more surviving shards.
 *
 * `shards[i]` is the shard at global index i (0..k+m-1) or null if missing.
 * Throws if fewer than k shards survive.
 */
export function rsReconstructData(
  shards: (Uint8Array | null)[],
  k: number,
  m: number,
): Uint8Array[] {
  if (shards.length !== k + m) {
    throw new RangeError(`reed-solomon: expected ${k + m} shard slots, got ${shards.length}`);
  }
  const presentIndices: number[] = [];
  let shardLen = -1;
  for (let i = 0; i < shards.length; i++) {
    const s = shards[i];
    if (s) {
      presentIndices.push(i);
      if (shardLen === -1) shardLen = s.length;
      else if (s.length !== shardLen) throw new RangeError('reed-solomon: shards differ in length');
    }
  }
  if (presentIndices.length < k) {
    throw new Error(`reed-solomon: only ${presentIndices.length} of ${k} required shards present`);
  }

  // Use the first k surviving shards.
  const use = presentIndices.slice(0, k);
  const encoding = buildEncodingMatrix(k, m);
  const sub = use.map((idx) => encoding[idx]!);
  const decodeMatrix = invertMatrix(sub);

  const dataShards: Uint8Array[] = [];
  for (let t = 0; t < k; t++) {
    const out = new Uint8Array(shardLen);
    const row = decodeMatrix[t]!;
    for (let s = 0; s < k; s++) {
      const coeff = row[s]!;
      if (coeff === 0) continue;
      const shard = shards[use[s]!]!;
      for (let b = 0; b < shardLen; b++) {
        out[b] = out[b]! ^ gfMul(coeff, shard[b]!);
      }
    }
    dataShards.push(out);
  }
  return dataShards;
}
