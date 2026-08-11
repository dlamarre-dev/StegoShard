/**
 * Shamir secret sharing over GF(2^8) (SPEC §10.6.1) — the threshold material for
 * Mode B (non-possession). A 32-byte secret `S` is split into `n` shares such that
 * any `k` reconstruct it and any `k-1` reveal **zero** information (not a partial
 * key). Built on the same field as Reed-Solomon (gf256.ts) — no new field math.
 *
 * Share wire format (38 bytes):
 *   [ version 1 ][ share_index 1 ][ share_value 32 ][ checksum 4 ]
 *
 * `checksum = SHA-256(version || index || value)[0..4]`. It detects transcription
 * errors in a share; it does NOT authenticate the share against any container and
 * MUST NOT be usable to test a candidate share (§10.6.1). Below the threshold,
 * `shamirRecover` has no notion of `k` and simply interpolates the supplied shares
 * to a wrong value — the "inability, not fallback" property. The writer keeps
 * neither `S` nor any share, and nothing about count/threshold enters a container.
 *
 * Mirrored by the Python reference decoder (python/stegoshard/shamir.py).
 */

import { concatBytes } from './bytes';
import { gfAdd, gfDiv, gfMul } from './gf256';
import { randomBytes } from './crypto';

const subtle = globalThis.crypto.subtle;

export const SHARE_VERSION = 1;
export const SECRET_LEN = 32;
/** version(1) + share_index(1) + share_value(32) + checksum(4). */
export const SHARE_LEN = 1 + 1 + SECRET_LEN + 4;
const SHARE_BODY_LEN = 1 + 1 + SECRET_LEN; // the bytes the checksum covers

/** Thrown when a share's checksum fails — a transcription error, not an auth failure. */
export class ShareChecksumError extends Error {
  constructor() {
    super('share checksum mismatch (likely a transcription error)');
    this.name = 'ShareChecksumError';
  }
}

/** Thrown when the shares to recover from are not a valid distinct set. */
export class ShareSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareSetError';
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function shareChecksum(body: Uint8Array): Promise<Uint8Array> {
  const digest = await subtle.digest('SHA-256', body as BufferSource);
  return new Uint8Array(digest).slice(0, 4);
}

// --- Transcribable share text (Crockford base32) -------------------------------

/** Crockford base32 (no I/L/O/U) — the same alphabet the passphrase generator uses. */
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[^0-9A-Z]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = BASE32.indexOf(c);
    if (idx < 0) continue; // skip a stray non-alphabet character
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** A 38-byte share as a grouped, transcribable string (e.g. `A7F3K-9QW2M-…`). */
export function encodeShareText(share: Uint8Array): string {
  return base32Encode(share)
    .match(/.{1,5}/g)!
    .join('-');
}

/**
 * Wording of the share file's first line.
 *
 * The deniable destinations (disguised `.db`, gallery) name nothing after the
 * project — a generically named `.txt` whose first line reads "StegoShard"
 * would give the whole set away the moment anyone opened it. The overt
 * destinations keep the branded heading, which is a useful self-identifying cue
 * when you find a share years later.
 */
export type ShareTextStyle = 'branded' | 'neutral';

/**
 * The body of a per-holder share `.txt` (§10.8 item 4): the encoded share, how to
 * gather + load a quorum, and the "holding a share makes you a target" warning.
 * `loadHint` is the one surface-specific line (e.g. the CLI's `--share` vs the app's
 * unlock flow), so the CLI and the app produce byte-identical files otherwise.
 *
 * Only the heading varies with `style`; the encoded body and both warning lines
 * are identical either way, so a share stays parseable regardless of which
 * destination wrote it.
 */
export function shareFileText(
  share: Uint8Array,
  index: number,
  n: number,
  k: number,
  loadHint: string,
  style: ShareTextStyle = 'branded',
): string {
  const heading =
    style === 'neutral'
      ? `Recovery share ${index} of ${n}`
      : `StegoShard threshold share ${index} of ${n}`;
  return (
    `${heading}\n\n` +
    `${encodeShareText(share)}\n\n` +
    `Gather any ${k} of the ${n} shares ${loadHint}\n` +
    `Holding a share makes YOU a point of pressure; keep it accordingly.\n`
  );
}

/** Parse a share string (dashes/whitespace ignored) back to its 38 bytes. */
export function decodeShareText(text: string): Uint8Array {
  return base32Decode(text);
}

/** Evaluate p(x) = s0 + c1·x + c2·x² + … over GF(2^8) at `x` (Horner). */
function evalPoly(coeffs: Uint8Array, s0: number, x: number): number {
  let acc = 0;
  for (let t = coeffs.length - 1; t >= 0; t--) acc = gfAdd(coeffs[t]!, gfMul(acc, x));
  return gfAdd(s0, gfMul(acc, x));
}

/** Serialize one share (index in 1..255, 32-byte value) with its checksum. */
export async function serializeShare(index: number, value: Uint8Array): Promise<Uint8Array> {
  if (index < 1 || index > 255) throw new RangeError(`share: index ${index} out of range`);
  if (value.length !== SECRET_LEN) throw new RangeError('share: bad value length');
  const body = concatBytes(Uint8Array.of(SHARE_VERSION, index), value);
  return concatBytes(body, await shareChecksum(body));
}

/** Parse and checksum-verify a serialized share. */
export async function parseShare(share: Uint8Array): Promise<{ index: number; value: Uint8Array }> {
  if (share.length !== SHARE_LEN) throw new RangeError('share: bad length');
  if (share[0] !== SHARE_VERSION) throw new Error(`share: unsupported version ${share[0]}`);
  const body = share.subarray(0, SHARE_BODY_LEN);
  if (!bytesEqual(share.subarray(SHARE_BODY_LEN), await shareChecksum(body))) {
    throw new ShareChecksumError();
  }
  return { index: share[1]!, value: share.slice(2, SHARE_BODY_LEN) };
}

/**
 * Split a 32-byte secret into `n` serialized shares, any `k` of which recover it.
 * Coefficients are CSPRNG per secret byte. The caller MUST zeroize `secret` and
 * MUST NOT persist it or the returned shares beyond delivery.
 */
export async function shamirSplit(secret: Uint8Array, k: number, n: number): Promise<Uint8Array[]> {
  if (secret.length !== SECRET_LEN) throw new RangeError('shamir: secret must be 32 bytes');
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 1 || n < k || n > 255) {
    throw new RangeError(`shamir: bad k/n (${k}/${n})`);
  }
  // One degree-(k-1) polynomial per secret byte; the constant term is that byte.
  const coeffs: Uint8Array[] = [];
  for (let j = 0; j < SECRET_LEN; j++) coeffs.push(randomBytes(k - 1)); // empty when k=1
  const shares: Uint8Array[] = [];
  for (let index = 1; index <= n; index++) {
    const value = new Uint8Array(SECRET_LEN);
    for (let j = 0; j < SECRET_LEN; j++) value[j] = evalPoly(coeffs[j]!, secret[j]!, index);
    shares.push(await serializeShare(index, value));
    value.fill(0);
  }
  for (const c of coeffs) c.fill(0); // zeroize the random coefficients
  return shares;
}

/**
 * Recover the 32-byte secret by Lagrange interpolation at x=0 over the supplied
 * shares. Has NO notion of `k`: with fewer than the threshold it returns a wrong
 * value (zero information); with ≥ k distinct shares it returns the true secret.
 * Requires distinct share indices (duplicates → division by zero).
 */
export async function shamirRecover(shares: Uint8Array[]): Promise<Uint8Array> {
  if (shares.length < 1) throw new RangeError('shamir: no shares');
  const parsed = await Promise.all(shares.map(parseShare));
  const xs = parsed.map((p) => p.index);
  // Distinct, non-zero indices are required: a repeated index (the same share
  // loaded twice) makes a Lagrange denominator term (x_i XOR x_m) zero → a raw
  // GF(256) division-by-zero. Fail with a clear, catchable error instead. (x=0 is
  // the secret itself and never a valid share index; parseShare already bounds ≥1.)
  if (new Set(xs).size !== xs.length) {
    throw new ShareSetError('duplicate shares: each share must have a distinct index');
  }
  const secret = new Uint8Array(SECRET_LEN);
  for (let i = 0; i < parsed.length; i++) {
    // Lagrange basis at 0: L_i(0) = ∏_{m≠i} x_m / (x_i − x_m); in GF(2^8), −x = x
    // and subtraction is XOR, so the denominator term is (x_i XOR x_m).
    let num = 1;
    let den = 1;
    for (let m = 0; m < parsed.length; m++) {
      if (m === i) continue;
      num = gfMul(num, xs[m]!);
      den = gfMul(den, gfAdd(xs[i]!, xs[m]!));
    }
    const li = gfDiv(num, den);
    const yi = parsed[i]!.value;
    for (let j = 0; j < SECRET_LEN; j++) secret[j] = gfAdd(secret[j]!, gfMul(yi[j]!, li));
  }
  return secret;
}
