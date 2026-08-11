/**
 * Non-image "binary" delivery (SPEC §8): instead of erasure-coding the vault
 * blob (or a key block) into QR images, wrap it in a single opaque file. Two
 * variants trade findability for deniability:
 *
 *   - 'branded'   → [ MAGIC "SSBN" 4 ][ VERSION 1 ][ payload ]. A self-labelling
 *                   blob; easy for the owner to recognize, makes no attempt to
 *                   hide (extension .ssbn).
 *   - 'disguised' → a **complete, valid SQLite database** whose largest BLOB row
 *                   *is* the payload (stored across a proper overflow-page chain).
 *                   There are no trailing bytes past the DB's logical end, so
 *                   `page_count × page_size == file size`, `PRAGMA integrity_check`
 *                   is `ok`, and `sqlite3 cache.db "SELECT * FROM cache"` works.
 *                   See src/core/sqlite-container.ts and docs/CRYPTO-REVIEW.md §6b.
 *
 * The payload is already an authenticated ciphertext (vault blob) or a wrapped
 * key block, so the wrapper adds no secrecy, only packaging. Unwrapping a file
 * that is neither variant returns null; callers may then treat the bytes as a
 * bare payload (e.g. a raw .key), letting AES-GCM be the final arbiter.
 */

import { concatBytes } from './bytes';
import { SQLITE_MAGIC, packSqlite, unpackSqlite } from './sqlite-container';

export type BinaryVariant = 'branded' | 'disguised';

/** "SSBN": StegoShard BiNary container. */
export const BINARY_MAGIC = Uint8Array.from([0x53, 0x53, 0x42, 0x4e]);
export const BINARY_VERSION = 1;

const BRANDED_PREFIX_LEN = BINARY_MAGIC.length + 1; // magic + version

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

/**
 * Cheap detection from a file head (a peek of ≥16 bytes is enough): does this
 * look like one of our binary containers? Recognises the branded magic and the
 * SQLite header of the disguised variant. Extraction still needs the whole file
 * (`unwrapBinary`), because the disguised blob is reassembled from the database.
 */
export function looksLikeBinaryContainer(head: Uint8Array): boolean {
  return startsWith(head, BINARY_MAGIC) || startsWith(head, SQLITE_MAGIC);
}

/** Wrap an already-encrypted payload in the chosen container variant. */
export function wrapBinary(payload: Uint8Array, variant: BinaryVariant): Uint8Array {
  if (variant === 'branded') {
    return concatBytes(BINARY_MAGIC, Uint8Array.of(BINARY_VERSION), payload);
  }
  return packSqlite(payload);
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
  // Disguised: recognised by the SQLite header (fits a 128-byte peek), then the
  // blob is reassembled from the database's b-tree. A foreign/real SQLite file
  // that isn't one of ours yields null from unpackSqlite → treated as non-container.
  if (startsWith(bytes, SQLITE_MAGIC)) {
    const payload = unpackSqlite(bytes);
    if (payload) return { payload, variant: 'disguised' };
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
