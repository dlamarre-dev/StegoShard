/**
 * Password entropy helpers (A2, UX only — no format impact).
 *
 * `passwordStrength` gives a deliberately conservative *estimate* of a typed
 * password's strength to nudge users away from weak secrets — Argon2id only
 * multiplies the cost of a guessing attack, so the password's own entropy is the
 * real ceiling on confidentiality. `generatePassphrase` produces a high-entropy
 * secret from the platform CSPRNG for users who would rather not invent one.
 *
 * Nothing here changes the vault format; the generated string is just typed into
 * the normal password field.
 */

import { randomBytes } from '@core';

/**
 * Crockford base32 alphabet (no I/L/O/U to avoid visual/keyboard confusion).
 * Exactly 32 symbols ⇒ 5 bits of entropy per character with no modulo bias
 * (256 / 32 = 8, so `byte & 31` is uniform).
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GROUPS = 4;
const GROUP_LEN = 5;

/** Entropy of a passphrase produced by `generatePassphrase`, in bits. */
export const GENERATED_PASSPHRASE_BITS = GROUPS * GROUP_LEN * 5; // 100

/**
 * A fresh ~100-bit passphrase like `A7F3K-9QW2M-XR4TP-H8NZ6`, drawn from the
 * platform CSPRNG. Language-neutral (works for every locale) and its entropy is
 * exact and auditable, unlike a word list.
 */
export function generatePassphrase(): string {
  const n = GROUPS * GROUP_LEN;
  const bytes = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) {
    out += ALPHABET[bytes[i]! & 31];
    if ((i + 1) % GROUP_LEN === 0 && i + 1 < n) out += '-';
  }
  bytes.fill(0);
  return out;
}

export interface PasswordStrength {
  /** Conservative estimated entropy in bits. */
  bits: number;
  /** Bucketed 0 (very weak) … 4 (strong), for a UI meter. */
  score: 0 | 1 | 2 | 3 | 4;
}

/**
 * Hard floor for a newly-created credential. No surface may waive it — not the
 * app's confirm dialog, not the CLI's --allow-weak-password.
 *
 * The whole confidentiality of a vault rests on this one secret, and the threat
 * model assumes the attacker holds the artifact and grinds it offline at their
 * leisure. A dismissible warning is the wrong control for that: the person
 * clicking through it is exactly the person who will not survive the attack.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** The advisory tier: comfortably strong rather than merely allowed. */
export const MIN_NEW_PASSWORD_LENGTH = 16;
export const MIN_NEW_PASSWORD_SCORE = 3;

/**
 * Estimate password strength from character-class diversity and length, damped
 * by the ratio of distinct characters so that runs like `aaaaaaaa` don't score
 * as if every character were independent. This is a heuristic lower bound, not a
 * dictionary/pattern analysis — the UI presents it as an estimate.
 */
export function passwordStrength(pw: string): PasswordStrength {
  if (pw.length === 0) return { bits: 0, score: 0 };
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33; // rough printable-symbol set
  const uniqueRatio = new Set(pw).size / pw.length;
  const rawBits = pw.length * Math.log2(pool || 2);
  const bits = Math.round(rawBits * Math.min(1, 0.3 + 0.7 * uniqueRatio));
  const score = bits < 40 ? 0 : bits < 60 ? 1 : bits < 80 ? 2 : bits < 100 ? 3 : 4;
  return { bits, score: score as PasswordStrength['score'] };
}

/**
 * The hard floor, checked before anything else offers to waive it.
 *
 * Deliberately **not** applied to restore/unlock: a vault created under an older
 * policy must stay openable, and refusing to try a password the user already has
 * would destroy data rather than protect it.
 */
export function meetsPasswordFloor(pw: string): boolean {
  return pw.length >= MIN_PASSWORD_LENGTH;
}

/** Policy for newly-created credentials. Restore/unlock deliberately do not use it. */
export function isStrongNewPassword(pw: string): boolean {
  return (
    pw.length >= MIN_NEW_PASSWORD_LENGTH && passwordStrength(pw).score >= MIN_NEW_PASSWORD_SCORE
  );
}

/**
 * Estimate the bits contributed by typed *extra entropy* (the expert save
 * option). `passwordStrength` alone is the wrong tool here: its repetition
 * damping is floored at 0.3, so holding one key down to fill the box — the
 * obvious degenerate input for a field that says "type randomly" — would be
 * reported as ~144 bits when it is worth nothing.
 *
 * So take the smaller of two estimates: the character-class heuristic above (a
 * ceiling: you cannot beat length × log2(alphabet)), and length × the Shannon
 * entropy of the characters actually typed, which is 0 for a single repeated
 * character and near-maximal for varied input. Order-0 only — it does not catch
 * `abababab` — but it removes the failure mode the field invites while leaving a
 * page of dice rolls scored on its real length.
 *
 * Still only an estimate, and nothing hangs on it: the CSPRNG is mixed in
 * regardless, so a low number costs the user nothing.
 */
export function extraEntropyBits(text: string): number {
  const chars = [...text];
  if (chars.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of chars) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let perChar = 0;
  for (const n of counts.values()) {
    const p = n / chars.length;
    perChar -= p * Math.log2(p);
  }
  return Math.min(passwordStrength(text).bits, Math.round(chars.length * perChar));
}
