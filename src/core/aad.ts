/**
 * Additional authenticated data (AAD) for every AEAD site in the format.
 *
 * GCM authenticates its ciphertext, but on its own it says nothing about the
 * *context* that ciphertext was written in. Without AAD, a container's fields
 * are individually sealed and collectively unbound: a key block can be stripped
 * or swapped, a region block transplanted between containers, a salt or IV moved
 * onto someone else's ciphertext. None of that yields wrong plaintext (the tag
 * still fails), but "fails to decrypt" is a weaker property than "is
 * authenticated", and the difference is exactly what an authenticated-vault
 * claim rests on.
 *
 * The segmented binary path (SPEC §8.1) already bound its chunks to the whole
 * header. This module is that pattern, generalized: one AAD builder per site,
 * so no site can be left unbound by omission.
 *
 * CANONICALIZATION RULES, which every builder here obeys:
 *
 *  1. Every AAD opens with a UNIQUE ASCII LABEL. AAD is never stored, so a label
 *     is free, and it makes cross-site confusion impossible: a ciphertext sealed
 *     at one site cannot be opened at another even under an identical key. This
 *     is domain separation, and it is why sites whose context is otherwise empty
 *     (the gallery fragment) still get an AAD.
 *  2. Integers are big-endian and fixed-width, matching the rest of the format.
 *  3. Every variable-length field is either fixed-length by construction or
 *     immediately preceded by its length. No two distinct field tuples may
 *     encode to the same byte string, or the AAD would authenticate an ambiguity.
 *
 * Builders are pure and synchronous, so they are directly unit-testable and
 * pinned by cross-language vectors rather than only exercised through a
 * round-trip. Mirrored byte-for-byte by python/stegoshard/aad.py.
 */

import { concatBytes, writeU16, writeU32 } from './bytes';

/** No additional data. Passed explicitly at the sites that deliberately have none. */
export const EMPTY_AAD = new Uint8Array(0);

const enc = new TextEncoder();

/**
 * The labels. Version-tagged so that a future format revision which changes a
 * layout can change its label in the same move, making old and new ciphertexts
 * mutually unopenable rather than silently mismatched.
 */
const LABEL_KEY_BLOCK = enc.encode('stegoshard/v2/aad/key-block');
const LABEL_VAULT_BLOB = enc.encode('stegoshard/v2/aad/vault-blob');
const LABEL_SLOT_ARRAY = enc.encode('stegoshard/v2/aad/slot-array');
const LABEL_VAULT_REGION = enc.encode('stegoshard/v2/aad/vault-region');
const LABEL_GALLERY_FRAG = enc.encode('stegoshard/v2/aad/gallery-frag');

/**
 * Which container a slot array belongs to. Not stored anywhere: the decoder
 * knows it from the path it entered by, so binding it costs no bytes and stops
 * a slot array being transplanted between the gallery and `.db` containers.
 */
export type ContainerKind = 'gallery-multiregion' | 'segmented-multiregion';

const KIND_BYTE: Record<ContainerKind, number> = {
  'gallery-multiregion': 0x01,
  'segmented-multiregion': 0x02,
};

/**
 * Key block (SPEC §5.1): binds the wrapped DEK to its own header.
 *
 * Self-binding only, and deliberately so. The key block travels alone in
 * keyfile/stego mode and may serve several vaults, so binding it to any
 * container would destroy that mode. What this does close is the Argon2 cost
 * parameters, the salt and the IV: they were protected only *incidentally*
 * before (editing them changes the derived KEK, so the unwrap fails), which
 * produced the wrong diagnosis — "wrong password" for a block that was edited.
 */
export function keyBlockAad(
  magic: Uint8Array,
  version: number,
  iterations: number,
  memoryKiB: number,
  parallelism: number,
  salt: Uint8Array,
  iv: Uint8Array,
): Uint8Array {
  const fixed = new Uint8Array(1 + 4 + 4 + 1);
  fixed[0] = version;
  writeU32(fixed, 1, iterations);
  writeU32(fixed, 5, memoryKiB);
  fixed[9] = parallelism;
  return concatBytes(LABEL_KEY_BLOCK, magic, fixed, salt, iv);
}

/**
 * Single-shot vault blob (SPEC §6): binds the content ciphertext to everything
 * that precedes it — magic, version, the key-block length field, the embedded
 * key block if any, the content salt and the IV.
 *
 * `KB_LEN` is what makes the *key mode* authenticated: an attacker can no longer
 * strip an embedded key block and re-present the vault as keyfile-mode. In
 * keyfile/stego mode `keyBlock` is empty and only the zero length field is
 * bound, which is the right amount: the external `.key` is deliberately not
 * bound, because it is re-serialized by a password change and binding it would
 * silently orphan every vault exported before one.
 */
export function vaultBlobAad(
  magic: Uint8Array,
  version: number,
  keyBlock: Uint8Array,
  contentSalt: Uint8Array,
  iv: Uint8Array,
): Uint8Array {
  const head = new Uint8Array(1 + 2);
  head[0] = version;
  writeU16(head, 1, keyBlock.length);
  return concatBytes(LABEL_VAULT_BLOB, magic, head, keyBlock, contentSalt, iv);
}

/**
 * Slot array (SPEC §10.1): binds every slot to its container kind and vault salt.
 *
 * One AAD for all four slots, not one per index: slot position is meaningless by
 * design (`buildSlotArray` shuffles), so an index-dependent AAD would contradict
 * that for no gain. The geometry constants are bound so that a reader cannot be
 * talked into a different slot/region count. Region blocks are deliberately NOT
 * bound — the region AAD already includes the slot array, and binding both ways
 * would be circular.
 */
export function slotArrayAad(
  kind: ContainerKind,
  slotCount: number,
  regionCount: number,
  vaultSalt: Uint8Array,
): Uint8Array {
  return concatBytes(
    LABEL_SLOT_ARRAY,
    Uint8Array.of(KIND_BYTE[kind], slotCount, regionCount),
    vaultSalt,
  );
}

/**
 * Multi-region vault blob region block (SPEC §10.6, the single-shot gallery path).
 *
 * Binds each region to its container (vault salt + slot array), to its own index,
 * and to its geometry. `regionLen` is derivable from the blob length, but
 * authenticating it makes the geometry a signed statement rather than an
 * inference. Nothing here is stored, so a dead region stays exactly `regionLen`
 * bytes of CSPRNG and the two blocks remain indistinguishable.
 */
export function regionBlockAad(
  vaultSalt: Uint8Array,
  slotArray: Uint8Array,
  regionIndex: number,
  regionLen: number,
  contentSalt: Uint8Array,
  iv: Uint8Array,
): Uint8Array {
  const tail = new Uint8Array(1 + 4);
  tail[0] = regionIndex;
  writeU32(tail, 1, regionLen);
  return concatBytes(LABEL_VAULT_REGION, vaultSalt, slotArray, tail, contentSalt, iv);
}

/**
 * Gallery per-photo fragment (SPEC §9.2): a constant.
 *
 * Nothing else can go in here. Blind winnowing trial-opens every photo with no
 * prior knowledge, so `setId` and `shardIndex` are only recoverable *after* the
 * tag verifies; an AAD depending on them would have to be guessed. And they are
 * already authenticated, because the SSHD header sits inside the sealed
 * plaintext. The cover bytes cannot be bound either: carriers are lossy and may
 * be re-encoded. So the value here is purely domain separation — real, but
 * smaller than the other sites, and this site was never meaningfully unbound.
 */
export function galleryFragAad(): Uint8Array {
  return LABEL_GALLERY_FRAG;
}

/**
 * Segmented multi-region chunk AAD (SPEC §8.1 / §10.7). Moved here verbatim from
 * segmented.ts; the byte layout is unchanged, and it carries no label because
 * `head` already opens with the "SSCS" magic and a version, which serves the
 * same separating purpose.
 */
export function segmentedRegionAad(
  head: Uint8Array,
  regionIndex: number,
  contentSalt: Uint8Array,
  noncePrefix: Uint8Array,
): Uint8Array {
  return concatBytes(head, Uint8Array.of(regionIndex), contentSalt, noncePrefix);
}
