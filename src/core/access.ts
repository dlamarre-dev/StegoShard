/**
 * Access-structure authoring for the §10 product modes. Composes the multi-region
 * blob builders (vault.ts / segmented.ts), the gated KEK (crypto.ts), and Shamir
 * sharing (shamir.ts).
 *
 * Mode B — Non-possession (§10.6): ONE live slot whose KEK is gated on threshold
 * material the holder does not possess, ONE real region, and NO decoy (the second
 * region is CSPRNG to the same bucket). The secret `S` is split into `n` shares
 * (any `k` recover it) and returned for out-of-band delivery to holders; the
 * writer keeps neither `S` nor the shares, and nothing about `k`/`n`/fingerprints
 * enters the container. "I cannot decrypt this" is then literally true for anyone
 * below the threshold.
 *
 * Mode A — Duress (§10.5): TWO live slots over TWO real regions — one credential
 * opens the real region, an independent duress credential opens a plausible decoy.
 * Each region has its own DEK, so the duress credential never exposes the real one.
 */

import {
  type Argon2Params,
  type SlotEntry,
  DEFAULT_ARGON2,
  DEK_LEN,
  VAULT_SALT_LEN,
  deriveSlotKek,
  gateKek,
  normalizePassword,
  randomBytes,
  slotKekRaw,
} from './crypto';
import { buildPayload } from './payload';
import { SECRET_LEN, shamirSplit } from './shamir';
import {
  MAX_FILE_BYTES_BINARY,
  VerificationError,
  type LiveRegion,
  buildMultiRegionVaultBlob,
} from './vault';
import { buildMultiRegionSegmentedBlob, decodeMultiRegionSegmentedBlobWithDek } from './segmented';
import { wrapBinary } from './binary-container';
import { DB_LADDER } from './buckets';
import type { OnProgress } from './progress';

export interface NonPossessionResult {
  /** The multi-region container blob (feed to the gallery fragmenter or SQLite packer). */
  blob: Uint8Array;
  /** `n` serialized 38-byte Shamir shares — deliver `k` to holders; never persist. */
  shares: Uint8Array[];
  /** The live region index + its DEK, for post-save verification only. */
  regionIndex: number;
  dek: Uint8Array;
}

/** Shared Mode B authoring: gated live slot + one real region + Shamir split of S. */
async function nonPossessionParts(
  filename: string,
  content: Uint8Array,
  password: string,
  k: number,
  n: number,
  params: Argon2Params,
  keyFactor: Uint8Array | null,
  bundle: boolean,
): Promise<{
  vaultSalt: Uint8Array;
  slotEntries: SlotEntry[];
  live: LiveRegion[];
  shares: Uint8Array[];
  regionIndex: number;
  dek: Uint8Array;
}> {
  const vaultSalt = randomBytes(VAULT_SALT_LEN);
  const secret = randomBytes(SECRET_LEN);
  // The base KEK optionally mixes in the keyfile/stego factor (§10.3), then is
  // gated on the threshold secret — so an unlock needs password + factor + shares.
  // This matches the decoder's slotKekCandidates (slotKekRaw → gateKek) exactly.
  const baseKek = await slotKekRaw(password, vaultSalt, keyFactor, params);
  const gatedKek = await gateKek(baseKek, secret, vaultSalt);
  baseKek.fill(0);

  const dek = randomBytes(DEK_LEN);
  const regionIndex = randomBytes(1)[0]! & 1; // real region equally likely 0 or 1
  const envelope = await buildPayload(filename, content, { bundle });
  const shares = await shamirSplit(secret, k, n);
  secret.fill(0); // writer retains nothing about the threshold secret

  return {
    vaultSalt,
    slotEntries: [{ kek: gatedKek, dek, regionIndex }],
    live: [{ regionIndex, dek, envelope }],
    shares,
    regionIndex,
    dek,
  };
}

/** Mode B on the gallery path: a threshold-gated multi-region vault blob (§10.6). */
export async function buildNonPossessionVaultBlob(
  filename: string,
  content: Uint8Array,
  password: string,
  k: number,
  n: number,
  ladder: readonly number[],
  params: Argon2Params = DEFAULT_ARGON2,
  keyFactor: Uint8Array | null = null,
  bundle = false,
): Promise<NonPossessionResult> {
  const { vaultSalt, slotEntries, live, shares, regionIndex, dek } = await nonPossessionParts(
    filename,
    content,
    password,
    k,
    n,
    params,
    keyFactor,
    bundle,
  );
  const blob = await buildMultiRegionVaultBlob(vaultSalt, slotEntries, live, ladder);
  return { blob, shares, regionIndex, dek };
}

/** Mode B on the .db path: a threshold-gated multi-region segmented blob (§10.6). */
export async function buildNonPossessionSegmentedBlob(
  filename: string,
  content: Uint8Array,
  password: string,
  k: number,
  n: number,
  ladder: readonly number[],
  params: Argon2Params = DEFAULT_ARGON2,
  onProgress?: OnProgress,
  chunkSize?: number,
  keyFactor: Uint8Array | null = null,
  bundle = false,
): Promise<NonPossessionResult> {
  const { vaultSalt, slotEntries, live, shares, regionIndex, dek } = await nonPossessionParts(
    filename,
    content,
    password,
    k,
    n,
    params,
    keyFactor,
    bundle,
  );
  const blob = await buildMultiRegionSegmentedBlob(
    vaultSalt,
    slotEntries,
    live,
    ladder,
    onProgress,
    chunkSize,
  );
  return { blob, shares, regionIndex, dek };
}

// --- Mode A — Duress (§10.5) ---------------------------------------------------

/** Why two credentials were judged too related to use as real + duress. */
export type CredentialRelation = 'equal' | 'case' | 'contains' | 'reverse' | 'near';

export interface CredentialCheck {
  ok: boolean;
  reason?: CredentialRelation;
}

/** Thrown by the duress writer when the two credentials are not independent. */
export class CredentialsNotIndependentError extends Error {
  constructor(readonly reason: CredentialRelation) {
    super(`duress and real credentials are too related (${reason})`);
    this.name = 'CredentialsNotIndependentError';
  }
}

/** Bounded Levenshtein edit distance (author-time UX only). */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[n]!;
}

const reverse = (s: string) => [...s].reverse().join('');

/**
 * Judge whether a duress password is independent enough from the real one to be
 * safe (§10.5): a cracker who recovers one MUST NOT cheaply recover the other.
 * Author-time UX ONLY — the result is never stored or encoded (any stored relation
 * would itself be a distinguisher §10.2). Compares on NFC-normalized text.
 */
export function credentialsIndependent(real: string, duress: string): CredentialCheck {
  const a = normalizePassword(real);
  const b = normalizePassword(duress);
  if (a === b) return { ok: false, reason: 'equal' };
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) return { ok: false, reason: 'case' };
  if (al.startsWith(bl) || al.endsWith(bl) || bl.startsWith(al) || bl.endsWith(al)) {
    return { ok: false, reason: 'contains' };
  }
  if (a === reverse(b) || al === reverse(bl)) return { ok: false, reason: 'reverse' };
  const nearThreshold = Math.max(2, Math.ceil(0.2 * Math.min(a.length, b.length)));
  if (levenshtein(al, bl) <= nearThreshold) return { ok: false, reason: 'near' };
  return { ok: true };
}

export interface DuressResult {
  /** The multi-region container blob (feed to the gallery fragmenter or SQLite packer). */
  blob: Uint8Array;
  /** The real region's index + DEK, and the decoy's, for post-save verification only. */
  real: { regionIndex: number; dek: Uint8Array };
  decoy: { regionIndex: number; dek: Uint8Array };
}

/** Shared Mode A authoring: two live slots (real + duress) over two real regions. */
async function duressParts(
  realFilename: string,
  realContent: Uint8Array,
  decoyFilename: string,
  decoyContent: Uint8Array,
  realPassword: string,
  duressPassword: string,
  params: Argon2Params,
  keyFactor: Uint8Array | null,
  bundle: boolean,
): Promise<{
  vaultSalt: Uint8Array;
  slotEntries: SlotEntry[];
  live: LiveRegion[];
  result: DuressResult['real'] & { decoy: DuressResult['decoy'] };
}> {
  const check = credentialsIndependent(realPassword, duressPassword);
  if (!check.ok) throw new CredentialsNotIndependentError(check.reason!);

  const vaultSalt = randomBytes(VAULT_SALT_LEN);
  const realRegionIndex = randomBytes(1)[0]! & 1; // decoy equally likely region 0 or 1
  const decoyRegionIndex = 1 - realRegionIndex;
  const dekReal = randomBytes(DEK_LEN);
  const dekDecoy = randomBytes(DEK_LEN);
  // The keyfile/stego factor (§10.3) gates the REAL slot ONLY — an extra layer on
  // the payload worth protecting. The decoy slot deliberately takes NO factor: a
  // decoy exists to be surrendered under coercion, so it must open on the duress
  // password alone (requiring an extra artifact to reveal the decoy would defeat
  // the purpose). The stego cover is keyed by the real password, so the duress
  // opener can't extract the factor anyway — and doesn't need to. With no factor
  // both derivations are byte-identical to the password-only deriveKEK.
  const kekReal = await deriveSlotKek(realPassword, vaultSalt, keyFactor, params);
  const kekDuress = await deriveSlotKek(duressPassword, vaultSalt, null, params);
  // Only the real side can be a bundle: the decoy is the single file the writer
  // nominated with --decoy.
  const realEnvelope = await buildPayload(realFilename, realContent, { bundle });
  const decoyEnvelope = await buildPayload(decoyFilename, decoyContent);

  return {
    vaultSalt,
    slotEntries: [
      { kek: kekReal, dek: dekReal, regionIndex: realRegionIndex },
      { kek: kekDuress, dek: dekDecoy, regionIndex: decoyRegionIndex },
    ],
    live: [
      { regionIndex: realRegionIndex, dek: dekReal, envelope: realEnvelope },
      { regionIndex: decoyRegionIndex, dek: dekDecoy, envelope: decoyEnvelope },
    ],
    result: {
      regionIndex: realRegionIndex,
      dek: dekReal,
      decoy: { regionIndex: decoyRegionIndex, dek: dekDecoy },
    },
  };
}

/** Mode A on the gallery path: a duress multi-region vault blob (§10.5). */
export async function buildDuressVaultBlob(
  realFilename: string,
  realContent: Uint8Array,
  decoyFilename: string,
  decoyContent: Uint8Array,
  realPassword: string,
  duressPassword: string,
  ladder: readonly number[],
  params: Argon2Params = DEFAULT_ARGON2,
  keyFactor: Uint8Array | null = null,
  bundle = false,
): Promise<DuressResult> {
  const { vaultSalt, slotEntries, live, result } = await duressParts(
    realFilename,
    realContent,
    decoyFilename,
    decoyContent,
    realPassword,
    duressPassword,
    params,
    keyFactor,
    bundle,
  );
  const blob = await buildMultiRegionVaultBlob(vaultSalt, slotEntries, live, ladder);
  return { blob, real: { regionIndex: result.regionIndex, dek: result.dek }, decoy: result.decoy };
}

/** Mode A on the .db path: a duress multi-region segmented blob (§10.5). */
export async function buildDuressSegmentedBlob(
  realFilename: string,
  realContent: Uint8Array,
  decoyFilename: string,
  decoyContent: Uint8Array,
  realPassword: string,
  duressPassword: string,
  ladder: readonly number[],
  params: Argon2Params = DEFAULT_ARGON2,
  onProgress?: OnProgress,
  chunkSize?: number,
  keyFactor: Uint8Array | null = null,
  bundle = false,
): Promise<DuressResult> {
  const { vaultSalt, slotEntries, live, result } = await duressParts(
    realFilename,
    realContent,
    decoyFilename,
    decoyContent,
    realPassword,
    duressPassword,
    params,
    keyFactor,
    bundle,
  );
  const blob = await buildMultiRegionSegmentedBlob(
    vaultSalt,
    slotEntries,
    live,
    ladder,
    onProgress,
    chunkSize,
  );
  return { blob, real: { regionIndex: result.regionIndex, dek: result.dek }, decoy: result.decoy };
}

// --- Disguised .db containers (build + self-verify + wrap) ---------------------
//
// The CLI and the app both author a disguised .db in an access mode the same way:
// build the multi-region segmented blob, prove each region round-trips with its
// authoring DEK, then wrap it as a SQLite-disguised container. That orchestration
// lives here so it can never drift between the two surfaces; each surface keeps
// only its own I/O (writing files vs. producing downloads, and delivering the key
// factor as a `.key` or a stego cover).

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Verify one region of a freshly built multi-region `.db` blob restores to the
 * expected `(filename, content)` with its authoring DEK — a self-check run before
 * the container is handed over. Throws `VerificationError` on any mismatch.
 */
export async function verifyDbRegion(
  blob: Uint8Array,
  dek: Uint8Array,
  regionIndex: number,
  filename: string,
  content: Uint8Array,
): Promise<void> {
  let got: { filename: string; content: Uint8Array };
  try {
    got = await decodeMultiRegionSegmentedBlobWithDek(
      blob,
      dek,
      regionIndex,
      MAX_FILE_BYTES_BINARY,
    );
  } catch {
    throw new VerificationError();
  }
  if (got.filename !== filename || !bytesEqual(got.content, content)) throw new VerificationError();
}

/**
 * Author a **duress** (Mode A) disguised `.db`: build the two-region blob, verify
 * both the real and decoy regions round-trip, and wrap it. `keyFactor` (a keyfile/
 * stego secret, §10.3) gates the real region only. Returns the container to deliver.
 */
export async function buildDuressDbContainer(
  realFilename: string,
  realContent: Uint8Array,
  decoyFilename: string,
  decoyContent: Uint8Array,
  realPassword: string,
  duressPassword: string,
  keyFactor: Uint8Array | null = null,
  params: Argon2Params = DEFAULT_ARGON2,
  onProgress?: OnProgress,
  chunkSize?: number,
  bundle = false,
): Promise<{ container: Uint8Array }> {
  const { blob, real, decoy } = await buildDuressSegmentedBlob(
    realFilename,
    realContent,
    decoyFilename,
    decoyContent,
    realPassword,
    duressPassword,
    DB_LADDER,
    params,
    onProgress,
    chunkSize,
    keyFactor,
    bundle,
  );
  await verifyDbRegion(blob, real.dek, real.regionIndex, realFilename, realContent);
  await verifyDbRegion(blob, decoy.dek, decoy.regionIndex, decoyFilename, decoyContent);
  return { container: wrapBinary(blob, 'disguised') };
}

/**
 * Author a **non-possession** (Mode B) disguised `.db`: build the threshold-gated
 * blob, verify the real region round-trips, and wrap it. `keyFactor` (§10.3) adds a
 * second external layer on top of the shares. Returns the container + the `n` shares.
 */
export async function buildNonPossessionDbContainer(
  filename: string,
  content: Uint8Array,
  password: string,
  k: number,
  n: number,
  keyFactor: Uint8Array | null = null,
  params: Argon2Params = DEFAULT_ARGON2,
  onProgress?: OnProgress,
  chunkSize?: number,
  bundle = false,
): Promise<{ container: Uint8Array; shares: Uint8Array[] }> {
  const { blob, shares, regionIndex, dek } = await buildNonPossessionSegmentedBlob(
    filename,
    content,
    password,
    k,
    n,
    DB_LADDER,
    params,
    onProgress,
    chunkSize,
    keyFactor,
    bundle,
  );
  await verifyDbRegion(blob, dek, regionIndex, filename, content);
  return { container: wrapBinary(blob, 'disguised'), shares };
}
