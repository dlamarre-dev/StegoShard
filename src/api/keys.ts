/**
 * Minting a vault key, in one call.
 *
 * `createKeyBlock` returns the DEK and the *parsed* key block, and every caller
 * then has to serialize it to get the `VaultKey` the export functions want. That
 * two-step is an implementation detail of the key-block format, not something a
 * consumer should have to know, so it lives here and both the orchestration layer
 * and the public surface use it.
 */

import { DEFAULT_ARGON2, createKeyBlock, serializeKeyBlock, type Argon2Params } from '../core';
import type { VaultKey } from '../core';

/**
 * Derive a vault key from a password.
 *
 * Runs Argon2id at the given parameters, which default to the production figures
 * (256 MiB, t=4). That cost is the point: it is what makes an offline password
 * search expensive, and it needs roughly 256 MiB of transient memory per call.
 * Pass cheaper parameters only in tests.
 */
export async function createVaultKey(
  password: string,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<VaultKey> {
  const { dek, block } = await createKeyBlock(password, params);
  return { dek, keyBlock: serializeKeyBlock(block) };
}
