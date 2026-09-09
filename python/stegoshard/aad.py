"""Additional authenticated data (AAD) for every AEAD site in the format.

Byte-for-byte twin of src/core/aad.ts, which carries the design rationale. The
short version: GCM authenticates its ciphertext but says nothing about the
context that ciphertext was written in, so without AAD a container's fields are
individually sealed and collectively unbound.

Canonicalization rules, obeyed by every builder here:

 1. Every AAD opens with a unique ASCII label. AAD is never stored, so a label
    costs nothing on disk and makes cross-site confusion impossible.
 2. Integers are big-endian and fixed-width.
 3. Every variable-length field is fixed-length by construction or immediately
    preceded by its length, so no two distinct field tuples can encode alike.

Any divergence from the TypeScript side is a decode failure rather than a silent
mismatch, and the cross-language vectors pin each label.
"""

from __future__ import annotations

import struct

#: No additional data. Passed explicitly where a site deliberately has none.
EMPTY_AAD = b""

_LABEL_KEY_BLOCK = b"stegoshard/v2/aad/key-block"
_LABEL_VAULT_BLOB = b"stegoshard/v2/aad/vault-blob"
_LABEL_SLOT_ARRAY = b"stegoshard/v2/aad/slot-array"
_LABEL_VAULT_REGION = b"stegoshard/v2/aad/vault-region"
_LABEL_GALLERY_FRAG = b"stegoshard/v2/aad/gallery-frag"

#: Which container a slot array belongs to. Never stored: the decoder knows it
#: from the path it entered by, so binding it costs no bytes and stops a slot
#: array being transplanted between the gallery and .db containers.
KIND_GALLERY = 0x01
KIND_SEGMENTED = 0x02


def key_block_aad(
    magic: bytes,
    version: int,
    iterations: int,
    memory_kib: int,
    parallelism: int,
    salt: bytes,
    iv: bytes,
) -> bytes:
    """Key block (SPEC §5.1): binds the wrapped DEK to its own header.

    Self-binding only. The block travels alone in keyfile/stego mode and may
    serve several vaults, so binding it to any container would destroy that mode.
    """
    return (
        _LABEL_KEY_BLOCK
        + magic
        + struct.pack(">BIIB", version, iterations, memory_kib, parallelism)
        + salt
        + iv
    )


def vault_blob_aad(
    magic: bytes, version: int, key_block: bytes, content_salt: bytes, iv: bytes
) -> bytes:
    """Single-shot vault blob (SPEC §6): binds the ciphertext to everything before it.

    KB_LEN is what makes the key *mode* authenticated: an embedded key block
    cannot be stripped and the vault re-presented as keyfile-mode.
    """
    return (
        _LABEL_VAULT_BLOB
        + magic
        + struct.pack(">BH", version, len(key_block))
        + key_block
        + content_salt
        + iv
    )


def slot_array_aad(kind: int, slot_count: int, region_count: int, vault_salt: bytes) -> bytes:
    """Slot array (SPEC §10.1): binds every slot to its container kind and vault salt.

    One AAD for all slots, not one per index: slot position is meaningless by
    design (the writer shuffles), so an index-dependent AAD would contradict that.
    """
    return _LABEL_SLOT_ARRAY + bytes([kind, slot_count, region_count]) + vault_salt


def region_block_aad(
    vault_salt: bytes,
    slot_array: bytes,
    region_index: int,
    region_len: int,
    content_salt: bytes,
    iv: bytes,
) -> bytes:
    """Multi-region vault blob region block (SPEC §10.6, single-shot gallery path).

    `region_len` is derivable from the blob length, but authenticating it makes
    the geometry a signed statement rather than an inference.
    """
    return (
        _LABEL_VAULT_REGION
        + vault_salt
        + slot_array
        + struct.pack(">BI", region_index, region_len)
        + content_salt
        + iv
    )


def gallery_frag_aad() -> bytes:
    """Gallery per-photo fragment (SPEC §9.2): a constant, and nothing else can be.

    Blind winnowing trial-opens every photo with no prior knowledge, so set id
    and shard index are only recoverable *after* the tag verifies; and they are
    already authenticated inside the sealed plaintext.
    """
    return _LABEL_GALLERY_FRAG


def segmented_region_aad(
    head: bytes, region_index: int, content_salt: bytes, nonce_prefix: bytes
) -> bytes:
    """Segmented chunk AAD (SPEC §8.1 / §10.7).

    No label: `head` already opens with the "SSCS" magic and a version, which
    serves the same separating purpose.
    """
    return head + bytes([region_index]) + content_salt + nonce_prefix
