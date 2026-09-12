/**
 * Refuse a second payload into a cover that has already carried one, under the
 * same password, in this realm.
 *
 * THE RULE, AND WHY IT EXISTS. The §5.3/§5.4 derivation is a pure function of the
 * password and the cover's embedding-invariant bits. There is no nonce anywhere:
 * the fingerprint must survive embedding so a blind extractor can recompute it,
 * which is exactly why it cannot differ between two embeddings into one cover. So
 * a second payload under the same password reuses the whitening pad *and* the
 * carrier positions, and the two artifacts differ at precisely the carriers where
 * the payloads differ. An observer holding both learns the Hamming distance
 * between them and that many positions of the secret layout, more with every
 * reuse. `stego.binding.test.ts` measures it: one payload bit flipped moves
 * exactly one image bit, against 763 for the same cover under a different
 * password.
 *
 * SPEC §5.3 states this as a MUST NOT. This module is what enforces it, and what
 * it can enforce is narrower than the rule.
 *
 * WHAT IT KEYS ON, which is the design decision worth checking. Not the
 * fingerprint: that would refuse the same cover under a *different* password,
 * which is safe and legitimate — a different password means a different Argon2
 * seed, a different derived key, an independent pad and layout. It keys on a tag
 * derived from the per-cover key itself, so identical tag ⟺ identical pad and
 * identical positions, which is the exact equivalence class of the leak. It also
 * absorbs the Argon2 parameters for free: one cover embedded under the production
 * cost and again under a test cost derives two independent keystreams and is not
 * reuse.
 *
 * The tag is `HKDF-Expand(ckey, "stegoshard/stego/guard", 16)`. It is retained for
 * the realm's lifetime, which sits against this codebase's habit of zeroizing key
 * material, so: it is one-way, 16 bytes, under an info label distinct from every
 * other use of that key, and it does not permit recomputation of the pad. `ckey`
 * itself is still zeroed by the caller.
 *
 * WHY IN MEMORY, AND NOT A FILE. A durable registry of used covers would catch
 * far more — the same photo tomorrow, on another machine, from a second pristine
 * copy. It would also be a file on disk proving that stego covers exist and
 * naming them, which is the one kind of state this path refuses to keep; it is
 * the same artifact `--export-number` is refused for on every deniable
 * destination (docs/THREAT-MODEL.md). So this catches reuse **within one run or
 * one batch** — an operator saving twice into one photo, a script looping over a
 * folder, an agent looping a save tool over one cover — and nothing beyond that.
 * The MUST NOT remains the operator's to keep. This is a backstop, not a proof,
 * and docs/CLAIMS.md says so.
 *
 * SCOPE IS PER REALM, not per process. The CLI and the MCP server are processes;
 * the extension and the web app are page bundles. Both are one module instance,
 * which is what the map's lifetime actually follows.
 *
 * EXTRACTION IS NEVER GUARDED and never records. A reader has no way to know how
 * a carrier was produced, and refusing to read would deny recovery. If a
 * "preview the key image" feature ever appears, it must not record either, or it
 * will refuse the real save that follows.
 */

import { hkdf } from './crypto';

/** Info label for the guard tag. Distinct from every other use of `ckey`. */
const GUARD_INFO = new TextEncoder().encode('stegoshard/stego/guard');

/**
 * How many covers are remembered before the oldest is forgotten.
 *
 * Bounded on purpose. Unbounded growth in a long-lived MCP server is the
 * alternative and is worse, and past this point the guard simply forgets — which
 * is honest, because it was never a proof. 4096 entries is about 200 KB.
 */
const MAX_TRACKED = 4096;

/** tag (hex) -> payload digest (hex) of what was embedded into it. */
const used = new Map<string, string>();

/** Options accepted by every stego embedding entry point. */
export interface StegoEmbedOptions {
  /**
   * Proceed even though this cover already carried a different payload under this
   * password in this realm.
   *
   * Per call, deliberately, and there is no global switch to turn the guard off:
   * an embedder who means it says so where a reviewer will see it. The CLI spells
   * this `--allow-cover-reuse`, never `--force` — `--force` means "overwrite an
   * existing output file", and letting a file-overwrite convenience waive a
   * cryptographic constraint would be a category error.
   */
  allowCoverReuse?: boolean | undefined;
}

/**
 * A cover was about to carry a second, different payload under one password.
 *
 * Carries no details. A fingerprint or a filename on this error would travel into
 * the `--json` envelope and the MCP result as a machine-readable identifier of a
 * stego cover, which is the durable trace this whole design refuses to create.
 */
export class StegoCoverReuseError extends Error {
  constructor() {
    super('stego: this cover was already used with this password in this session');
    this.name = 'StegoCoverReuseError';
  }
}

/** Derive the guard tag from the per-cover key. */
export async function coverGuardTag(coverKey: Uint8Array): Promise<Uint8Array> {
  return hkdf(coverKey, GUARD_INFO, 16);
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

async function digestOf(payload: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', payload as BufferSource);
  return hex(new Uint8Array(d));
}

/**
 * Check a cover before it is written to. Throws `StegoCoverReuseError` unless the
 * embedding is allowed.
 *
 * Re-embedding a **byte-identical** payload is permitted, and that allowance is
 * load-bearing rather than a convenience. The output is bit-identical — the
 * fingerprint is invariant under embedding, so the second write moves nothing —
 * which means there is no second artifact and no Hamming distance to leak.
 * `stego.binding.test.ts` measures exactly that ("re-embedding the same key block
 * changes nothing at all"). Refusing it would be theatre, and would break retry
 * tolerance for no gain.
 */
export async function checkCoverUse(
  tag: Uint8Array,
  payload: Uint8Array,
  opts?: StegoEmbedOptions,
): Promise<{ commit: () => void }> {
  const key = hex(tag);
  const digest = await digestOf(payload);
  const prior = used.get(key);
  if (prior !== undefined && prior !== digest && !opts?.allowCoverReuse) {
    throw new StegoCoverReuseError();
  }
  // Recorded by the caller only once the write has succeeded, so a capacity
  // failure or a throwing encoder does not poison the tag and refuse the retry.
  return {
    commit: () => {
      if (used.size >= MAX_TRACKED && !used.has(key)) {
        const oldest = used.keys().next();
        if (!oldest.done) used.delete(oldest.value);
      }
      used.set(key, digest);
    },
  };
}

/**
 * Forget every cover seen so far.
 *
 * For tests, and for a long-lived embedder that genuinely starts a new session in
 * one realm. Exported from `src/core` but deliberately **not** re-exported from
 * the public `src/api` surface: publishing a one-call "turn the safety off" is
 * the foot-gun the per-call option exists to avoid.
 */
export function resetStegoCoverGuard(): void {
  used.clear();
}
