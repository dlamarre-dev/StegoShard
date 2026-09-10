/**
 * Internal content envelope (plan §4), the plaintext that gets encrypted:
 *
 *   [ FLAGS 1 ][ NAME_LEN 2 ][ FILENAME (UTF-8) ]
 *   [ VAULT_ID 16 ][ SEQUENCE 4 ]   (present iff FLAGS bit2)
 *   [ CONTENT ]
 *
 * FLAGS bit0 = CONTENT is gzip-compressed.
 * FLAGS bit1 = CONTENT is a .zip holding several files (SPEC §4).
 * FLAGS bit2 = the envelope carries a vault identity (below).
 *
 * The filename is carried *inside* the encrypted envelope, so neither the name
 * nor the file type ever leaks.
 *
 * WHY THE IDENTITY LIVES HERE, and nowhere else. A vault id is what makes a
 * rollback detectable: two exports of the same logical vault share it, and the
 * sequence says which is newer. Put that in any container header and it becomes
 * a linkability disaster — it would publicly prove two artifacts are re-exports
 * of one vault, to an adversary who cannot decrypt either, and on the deniable
 * paths it would be an outright distinguisher. Inside the envelope it is
 * ciphertext, covered by GCM and by the AAD above it, adds no container field
 * whose presence could vary by mode, and is readable only after unlock — which
 * is exactly when the check is wanted, since only the legitimate holder can act
 * on it.
 *
 * Zipping itself is left to the callers: this module reaches only for the
 * platform streams API, which is what lets the Python reference decoder inflate
 * a payload with its standard library. A decoder written before bit1 existed
 * ignores it and hands back the .zip: degraded, never wrong.
 */

import { compressOpportunistic, gzipDecompress } from './compress';
import { concatBytes, readU16, readU32, writeU16, writeU32 } from './bytes';

const FLAG_COMPRESSED = 0x01;
const FLAG_BUNDLE = 0x02;
const FLAG_IDENTITY = 0x04;
const MAX_NAME_LEN = 0xffff;

/** Bytes the identity block occupies when present. */
const VAULT_ID_LEN = 16;
const IDENTITY_LEN = VAULT_ID_LEN + 4;

/**
 * Which logical vault this export belongs to, and where it sits in that vault's
 * history. Written only on the open (non-deniable) paths, and only when the
 * caller is tracking; see `docs/THREAT-MODEL.md`.
 */
export interface VaultIdentity {
  /** 16 CSPRNG bytes, stable across re-exports of the same logical vault. */
  vaultId: Uint8Array;
  /** Monotonic per-vault export counter, starting at 1. */
  sequence: number;
}

/**
 * Build the (plaintext) envelope for a file, compressing content when it helps.
 *
 * `bundle` marks CONTENT as a .zip of several files. A single-file save never
 * sets it, so by far the commonest case still produces byte-for-byte the
 * envelope it always did.
 */
export async function buildPayload(
  filename: string,
  content: Uint8Array,
  opts: { bundle?: boolean; identity?: VaultIdentity | undefined } = {},
): Promise<Uint8Array> {
  const nameBytes = new TextEncoder().encode(filename);
  if (nameBytes.length > MAX_NAME_LEN) throw new RangeError('payload: filename too long');

  const { data, compressed } = await compressOpportunistic(content);
  const flags =
    (compressed ? FLAG_COMPRESSED : 0) |
    (opts.bundle ? FLAG_BUNDLE : 0) |
    (opts.identity ? FLAG_IDENTITY : 0);

  const header = new Uint8Array(1 + 2);
  header[0] = flags;
  writeU16(header, 1, nameBytes.length);
  if (!opts.identity) return concatBytes(header, nameBytes, data);

  const { vaultId, sequence } = opts.identity;
  if (vaultId.length !== VAULT_ID_LEN) throw new RangeError('payload: bad vault id length');
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 0xffffffff) {
    throw new RangeError(`payload: sequence out of range (${sequence})`);
  }
  const identity = new Uint8Array(IDENTITY_LEN);
  identity.set(vaultId, 0);
  writeU32(identity, VAULT_ID_LEN, sequence);
  return concatBytes(header, nameBytes, identity, data);
}

/**
 * Parse an envelope back into filename + original content. `maxContentBytes`
 * bounds decompression of the (untrusted) content to guard against a gzip bomb.
 */
export async function parsePayload(
  bytes: Uint8Array,
  maxContentBytes: number,
): Promise<{
  filename: string;
  content: Uint8Array;
  bundled: boolean;
  identity?: VaultIdentity | undefined;
}> {
  if (bytes.length < 3) throw new Error('payload: too short');
  const flags = bytes[0]!;
  const nameLen = readU16(bytes, 1);
  const nameEnd = 3 + nameLen;
  if (bytes.length < nameEnd) throw new Error('payload: truncated filename');
  const filename = new TextDecoder().decode(bytes.slice(3, nameEnd));

  let o = nameEnd;
  let identity: VaultIdentity | undefined;
  if (flags & FLAG_IDENTITY) {
    if (bytes.length < o + IDENTITY_LEN) throw new Error('payload: truncated identity');
    const sequence = readU32(bytes, o + VAULT_ID_LEN);
    // `buildPayload` will not emit a sequence below 1, so 0 here is not an older
    // export — it is a container this code did not write correctly. Rejecting it
    // rather than passing it on keeps the registry's arithmetic on the range the
    // builder guarantees; the AAD binding means it cannot be an attacker's edit.
    if (sequence < 1) throw new Error(`payload: sequence out of range (${sequence})`);
    identity = { vaultId: bytes.slice(o, o + VAULT_ID_LEN), sequence };
    o += IDENTITY_LEN;
  }

  const stored = bytes.slice(o);
  const content = flags & FLAG_COMPRESSED ? await gzipDecompress(stored, maxContentBytes) : stored;
  return { filename, content, bundled: Boolean(flags & FLAG_BUNDLE), identity };
}
