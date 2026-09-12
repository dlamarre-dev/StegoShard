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
 * WHO OWNS A CLAIM. A claim stands from the moment it is made, and the call that
 * made it is the only thing that can undo it (`CoverClaim.release`, handed back
 * through `StegoEmbedOptions.onClaim`). A caller that ignores the handle gets the
 * safe default -- the claim stands -- which is right for a direct API user who now
 * holds the embedded bytes. The orchestration layer takes the handle, because it
 * is the only thing that knows whether the artifact reached storage: it releases
 * on a save that failed BEFORE the stego image was written, and leaves the claim
 * alone once it has landed, since a real artifact exists from that point and
 * dropping the claim would let a retry mint a second one from the same cover.
 *
 * Per call, never per realm. An earlier version kept one realm-wide set of
 * unconfirmed claims and released it wholesale on failure, which was wrong in two
 * directions at once: a save writes incrementally, so a failure after the image
 * landed released a claim for a cover that really was on disk, and two concurrent
 * saves released and confirmed each other's claims.
 *
 * THE BROWSER KEEPS THE CONSERVATIVE DEFAULT, and that is a decision rather than
 * an oversight. `src/ui/` passes no `onClaim`, so a claim it makes always stands.
 * It has to: the UI hands bytes to a browser download, which is asynchronous and
 * outside the page's control, so it genuinely cannot know whether the artifact
 * reached the user's disk. Releasing on the assumption that it did not would risk
 * permitting a second artifact from a cover whose first one downloaded fine --
 * the leak, traded for a convenience. A throw *inside* the embed still releases,
 * because that is the one case the core can see for itself.
 *
 * The cost is real and worth stating: abandon a save in the browser after the key
 * image was produced, and retrying with that photo in the same page session is
 * refused. Reloading clears it.
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

/**
 * tag (hex) -> payload digest (hex) of what was embedded into it.
 *
 * An entry is added the moment a cover is claimed, not when the embed finishes.
 * That is what closes the check-then-record window: `reserveCoverUse` computes its
 * digest first and then reads and writes this map with no `await` in between, so
 * two overlapping embeds into one cover cannot both pass the check.
 */
interface Entry {
  /** SHA-256 of the payload embedded under this cover key. */
  digest: string;
  /**
   * Identifies the call that wrote this entry.
   *
   * Ownership cannot be inferred from the digest: a byte-identical re-embed is
   * permitted, so two different calls can write the same digest, and either one's
   * release would then look like the owner's. The token makes "did I write what
   * is here now" answerable without ambiguity.
   */
  token: number;
}

const used = new Map<string, Entry>();
let nextToken = 1;

/**
 * A single cover claim, owned by the call that made it.
 *
 * Per call, not per realm, and that is the whole point. An earlier version kept
 * one realm-wide set of unconfirmed claims and released it wholesale when a save
 * failed. Two things were wrong with that, in opposite directions: a save writes
 * incrementally, so a failure *after* the stego artifact had landed released a
 * claim for a cover that really was on disk -- re-opening the exact leak §5.3
 * forbids -- and two concurrent saves in one realm would release and confirm each
 * other's claims.
 *
 * A claim stands from the moment it is made. `release` is the only undo and it is
 * idempotent. It does not simply remove the entry: because a call can legitimately
 * overwrite an earlier claim (with `allowCoverReuse`, or with a byte-identical
 * payload), removing would drop whatever it displaced and re-open the leak. It
 * RESTORES what this call displaced, and only while this call still owns the
 * entry -- ownership being the token it wrote, not the digest, since two calls can
 * write the same digest.
 *
 * Out-of-order releases between overlapping saves on one cover are resolved
 * conservatively rather than perfectly: releasing an older claim after a newer one
 * has already been released can leave the older entry standing with no artifact
 * behind it, which refuses a future save that would have been allowed. That
 * direction is a false refusal, never a leak, and concurrent saves into one cover
 * in one realm are not a workflow this is built for.
 */
export interface CoverClaim {
  /** Undo this claim, because the artifact it covers never reached storage. */
  release: () => void;
}

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
  /**
   * Receives the claim this embed made, once it has succeeded.
   *
   * An out-parameter rather than a return value, because the four public embed
   * functions return `void` or the new bytes and changing that would be a breaking
   * signature change for every embedder.
   *
   * A caller that ignores it gets the safe default: the claim stands, which is
   * right for a direct API user who now holds the embedded bytes and is going to
   * do something with them. A caller that knows whether the artifact actually
   * reached storage -- the orchestration layer, which writes it -- takes the claim
   * and releases it if the save failed before the artifact landed.
   */
  onClaim?: ((claim: CoverClaim) => void) | undefined;
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
export async function reserveCoverUse(
  tag: Uint8Array,
  payload: Uint8Array,
  opts?: StegoEmbedOptions,
): Promise<CoverClaim> {
  const key = hex(tag);
  // Every await happens before the read, so the check and the claim below are one
  // synchronous step. Computing the digest after reading `used` would reopen the
  // window this function exists to close.
  const digest = await digestOf(payload);

  const prior = used.get(key);
  if (prior !== undefined && prior.digest !== digest && !opts?.allowCoverReuse) {
    throw new StegoCoverReuseError();
  }
  if (used.size >= MAX_TRACKED && !used.has(key)) {
    const oldest = used.keys().next();
    if (!oldest.done) used.delete(oldest.value);
  }
  const token = nextToken++;
  used.set(key, { digest, token });

  return {
    release: () => {
      // Not `delete`. `used` holds ONE entry per cover, so deleting would drop
      // whatever claim this call overwrote -- and a call CAN overwrite one, either
      // with `allowCoverReuse` or with a byte-identical payload, which is
      // explicitly permitted. An earlier version deleted here, which made this
      // reachable: save 1 lands; save 2 overrides, fails before writing, and
      // releases; save 3 is then accepted, producing a second artifact from one
      // cover under one password. That is the §5.3 leak, restored by the very
      // mechanism meant to prevent a false refusal. `stego-guard.test.ts` pins it.
      //
      // So release RESTORES what this call displaced -- but only while this call
      // is still the owner. `spent` is set inside that check, not before it: a
      // release that finds someone else owning the cover has done nothing, and
      // must not count as this handle's one use.
      // The token also makes this idempotent, with no separate "already released"
      // flag: after a successful release the entry holds `prior`'s token or is
      // gone, so a second call finds no match and does nothing. An earlier version
      // kept a `spent` flag and set it BEFORE this check, which meant a release
      // that found someone else owning the cover -- and therefore did nothing --
      // still burned this handle's one use.
      const current = used.get(key);
      if (current?.token !== token) return;
      if (prior === undefined) used.delete(key);
      else used.set(key, prior);
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
