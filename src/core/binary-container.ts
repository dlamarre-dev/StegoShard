/**
 * Non-image "binary" delivery (SPEC §8): instead of erasure-coding the vault
 * blob (or a key block) into QR images, wrap it in a single opaque file. Two
 * variants trade findability for deniability:
 *
 *   - 'branded'   → [ MAGIC "SSBN" 4 ][ VERSION 1 ][ payload ]. A self-labelling
 *                   blob; easy for the owner to recognize, makes no attempt to
 *                   hide (extension .ssbn).
 *   - 'disguised' → [ SQLite header 16 ][ payload ]. Carries a real file-type
 *                   signature so `file(1)`/extension triage reads it as an
 *                   ordinary app database (extension .db). One extra layer of
 *                   deniability against casual inspection — NOT against a tool
 *                   that actually opens it as SQLite (see docs/CRYPTO-REVIEW.md).
 *
 * The payload is already an authenticated ciphertext (vault blob) or a wrapped
 * key block, so the wrapper adds no secrecy — only packaging. Unwrapping a file
 * that is neither variant returns null; callers may then treat the bytes as a
 * bare payload (e.g. a raw .key), letting AES-GCM be the final arbiter.
 */

import { concatBytes } from './bytes';

export type BinaryVariant = 'branded' | 'disguised';

/** "SSBN" — StegoShard BiNary container. */
export const BINARY_MAGIC = Uint8Array.from([0x53, 0x53, 0x42, 0x4e]);
export const BINARY_VERSION = 1;

/**
 * A complete, valid 100-byte SQLite 3 database header (not just the 16-byte magic
 * string). Modern `file(1)`/libmagic validates the page-size field at offset 16
 * and reads the rest of the header, so a bare magic reads as "data"; this full
 * header makes triage report a genuine "SQLite 3.x database". Fields: 4096-byte
 * pages, UTF-8 text encoding, schema format 4, change counter 1, SQLite version
 * 3.45.0 — a plausible freshly-created database. (The ciphertext that follows is
 * not a real b-tree, so a tool that actually opens it fails past the header — the
 * disguise is triage-only; see docs/CRYPTO-REVIEW.md §6b.)
 */
const SQLITE_HEADER = Uint8Array.from([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
  0x10, 0x00, 0x01, 0x01, 0x00, 0x40, 0x20, 0x20, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x2e, 0x76, 0x88,
]);

const BRANDED_PREFIX_LEN = BINARY_MAGIC.length + 1; // magic + version

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

/** Wrap an already-encrypted payload in the chosen container variant. */
export function wrapBinary(payload: Uint8Array, variant: BinaryVariant): Uint8Array {
  if (variant === 'branded') {
    return concatBytes(BINARY_MAGIC, Uint8Array.of(BINARY_VERSION), payload);
  }
  return concatBytes(SQLITE_HEADER, payload);
}

/**
 * Strip a container back to its payload. Returns the detected variant, or null
 * when the bytes match neither container (the caller decides whether to treat
 * them as a bare payload).
 */
export function unwrapBinary(
  bytes: Uint8Array,
): { payload: Uint8Array; variant: BinaryVariant } | null {
  if (startsWith(bytes, BINARY_MAGIC)) {
    const version = bytes[BINARY_MAGIC.length];
    if (version !== BINARY_VERSION)
      throw new Error(`binary container: unsupported version ${version}`);
    return { payload: bytes.slice(BRANDED_PREFIX_LEN), variant: 'branded' };
  }
  if (startsWith(bytes, SQLITE_HEADER)) {
    return { payload: bytes.slice(SQLITE_HEADER.length), variant: 'disguised' };
  }
  return null;
}

/** File extension conventionally paired with each variant. */
export function binaryExtension(variant: BinaryVariant): string {
  return variant === 'branded' ? 'ssbn' : 'db';
}

/**
 * Conventional filenames for the single-file artifacts. Branded names announce
 * the project; disguised names impersonate ordinary app databases so a folder
 * listing raises no flags. Shared across the CLI and the web/extension app.
 */
export function binaryVaultName(variant: BinaryVariant): string {
  return variant === 'branded' ? 'stegoshard-vault.ssbn' : 'cache.db';
}
export function binaryKeyName(variant: BinaryVariant): string {
  return variant === 'branded' ? 'stegoshard-key.ssbn' : 'settings.db';
}
