/**
 * Length buckets (SPEC §10.4) — the padding ladders for the access-structure
 * paths (Gallery Mode and the .db/SQLite decoy wrapper).
 *
 * On those two paths a container always carries REGION_COUNT payload regions,
 * and both regions are padded to a single shared bucket so that ciphertext
 * length reveals only the bucket, never the true payload length or which region
 * is real. The writer compresses each region first, then picks ONE bucket ≥ the
 * larger of the two compressed lengths and pads both to it — so neither region's
 * compression ratio is recoverable from the container (§10.4 rule 4).
 *
 * The ladders are deliberately capped below what the draft envisioned, to real
 * per-path capacity:
 *  - Gallery: the vault blob is `vault_salt(16) + slot_array(304) + 2·(44+bucket)`
 *    and must fit `GALLERY_MAX_BLOB` (= GALLERY_SLOT_DATA × GALLERY_K_MAX). With
 *    two regions that caps the usable bucket at 64 KiB/region on a ×4 ladder.
 *  - .db: the SQLite writer allocates the whole database in one buffer, so the
 *    ~2-region blob must stay well under the browser worker's memory ceiling
 *    (MAX_FILE_BYTES_BINARY_UI = 256 MiB). Capped at 64 MiB/region.
 *
 * These caps and the ladder values are part of the frozen v1 format on those two
 * paths and are mirrored by the Python reference decoder (python/stegoshard/
 * buckets.py). See the freeze checklist in the plan before changing them.
 */

const KiB = 1024;
const MiB = 1024 * 1024;

/**
 * Gallery Mode ladder (§10.4), ×4 steps. Capped at 64 KiB/region: a larger
 * bucket would push the doubled vault blob past what GALLERY_K_MAX data shards
 * can carry. The draft's 256 KiB–16 MiB rungs are unreachable on this path until
 * the gallery shard limits are raised, so they are intentionally omitted.
 */
export const GALLERY_LADDER: readonly number[] = [4 * KiB, 16 * KiB, 64 * KiB];

/**
 * Decoy-DB ladder (§10.4): 64 KiB then ×4. Capped at 64 MiB/region so the
 * two-region `packSqlite` buffer (a single Uint8Array) stays clear of the
 * browser worker's 256 MiB cap and the ~2 GiB ArrayBuffer limit. The draft's
 * 256 MiB–1 GiB rungs are out until `packSqlite` output is streamed.
 */
export const DB_LADDER: readonly number[] = [
  64 * KiB,
  256 * KiB,
  1 * MiB,
  4 * MiB,
  16 * MiB,
  64 * MiB,
];

/** Thrown when neither region fits any rung of the chosen ladder. */
export class BucketTooLargeError extends Error {
  constructor(
    readonly needed: number,
    readonly limit: number,
  ) {
    super(`payload too large for this path: ${needed} bytes (bucket limit ${limit})`);
    this.name = 'BucketTooLargeError';
  }
}

/**
 * Pick the shared bucket for two (already-compressed) region plaintext lengths:
 * the smallest ladder rung ≥ max(len0, len1). A dead region contributes 0 to the
 * max, so it never bumps the bucket. Throws `BucketTooLargeError` if the larger
 * region exceeds the ladder's top rung.
 */
export function pickBucket(len0: number, len1: number, ladder: readonly number[]): number {
  const need = Math.max(len0, len1);
  for (const rung of ladder) {
    if (rung >= need) return rung;
  }
  throw new BucketTooLargeError(need, ladder[ladder.length - 1]!);
}
