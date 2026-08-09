"""High-level restore: image payloads + password (+ optional key block) → file.

Mirrors src/core/vault.ts `importVault` and SPEC.md §1.
"""

from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .binary_container import unwrap_binary
from .crypto import (
    decrypt_content,
    derive_content_key,
    derive_region_key,
    open_slot_array,
    slot_kek_candidates,
    unwrap_dek,
)
from .format import (
    CONTENT_SALT_LEN,
    IV_LEN,
    MAX_CONTENT_BYTES,
    MAX_CONTENT_BYTES_BINARY,
    decode_blob,
    parse_envelope,
    parse_key_block,
    parse_region_plaintext,
    parse_vault_blob,
    split_multiregion_vault_blob,
    split_payload,
)
from .segmented import decode_multiregion_segmented_blob, decode_segmented_blob

# Frozen slot-KEK Argon2 defaults (SPEC §10.2 / §5.1). Not stored in the container,
# so the decoder supplies them; tests override with cheaper values.
DEFAULT_ITERATIONS = 4
DEFAULT_MEMORY_KIB = 256 * 1024
DEFAULT_PARALLELISM = 1


class MissingKeyError(Exception):
    """Raised when a keyfile/stego set is restored without its external key block."""


@dataclass
class RestoredFile:
    filename: str
    content: bytes


def decode_vault(
    payloads: list[bytes],
    password: str,
    key_block: bytes | None = None,
    *,
    multiregion: bool = False,
    key_factor: bytes | None = None,
    secret: bytes | None = None,
    iterations: int = DEFAULT_ITERATIONS,
    memory_kib: int = DEFAULT_MEMORY_KIB,
    parallelism: int = DEFAULT_PARALLELISM,
) -> RestoredFile:
    if not payloads:
        raise ValueError("import: no images provided")

    # Decode defensively: drop images that are not valid StegoShard payloads
    # (a foreign QR, a corrupt header) rather than aborting the whole restore.
    decoded: list[tuple] = []
    for payload in payloads:
        try:
            decoded.append(split_payload(payload))
        except (ValueError, IndexError, struct.error):
            continue
    if not decoded:
        raise ValueError("import: no valid StegoShard images found")

    # Use the majority set so a stray/first-listed foreign image can't derail it.
    counts: dict[bytes, int] = {}
    for header, _shard in decoded:
        counts[header.set_id] = counts.get(header.set_id, 0) + 1
    best_set = max(counts, key=lambda s: counts[s])
    members = [(h, s) for (h, s) in decoded if h.set_id == best_set]
    first = members[0][0]
    k, m, blob_len = first.k, first.m, first.blob_len

    slots: list[bytes | None] = [None] * (k + m)
    for header, shard in members:
        if 0 <= header.shard_index < k + m:
            slots[header.shard_index] = shard

    blob = decode_blob(slots, k, m, blob_len)
    if hashlib.sha256(blob).digest()[:4] != first.hash:
        raise ValueError("import: reconstructed blob failed its integrity check")

    if multiregion:
        return decode_multiregion_vault_blob(
            blob,
            password,
            key_factor,
            MAX_CONTENT_BYTES,
            iterations,
            memory_kib,
            parallelism,
            secret,
        )
    return _decode_vault_blob(blob, password, key_block, MAX_CONTENT_BYTES)


def _decode_vault_blob(
    blob: bytes, password: str, key_block: bytes | None, max_content_bytes: int
) -> RestoredFile:
    embedded_kb, content_salt, iv, ciphertext = parse_vault_blob(blob)
    kb_bytes = embedded_kb if len(embedded_kb) > 0 else key_block
    if not kb_bytes:
        raise MissingKeyError("this vault needs a separate key to restore")

    dek = unwrap_dek(parse_key_block(kb_bytes), password)
    cek = derive_content_key(dek, content_salt)
    envelope = decrypt_content(cek, iv, ciphertext)
    filename, content = parse_envelope(envelope, max_content_bytes)
    return RestoredFile(filename, content)


def decode_multiregion_vault_blob(
    blob: bytes,
    password: str,
    key_factor: bytes | None,
    max_content_bytes: int,
    iterations: int = DEFAULT_ITERATIONS,
    memory_kib: int = DEFAULT_MEMORY_KIB,
    parallelism: int = DEFAULT_PARALLELISM,
    secret: bytes | None = None,
) -> RestoredFile:
    """Decode a multi-region vault blob (SPEC §10.6, the gallery geometry): open the
    slot array (constant-work), then decrypt ONLY the region the credential unlocks.
    `secret` is the recovered Shamir S for a Mode B (threshold-gated) slot."""
    vault_salt, slot_array, region_area, r = split_multiregion_vault_blob(blob)
    candidates = slot_kek_candidates(
        password, vault_salt, key_factor, secret, iterations, memory_kib, parallelism
    )
    dek, region_index = open_slot_array(slot_array, candidates)
    block = region_area[region_index * r : (region_index + 1) * r]
    content_salt = block[:CONTENT_SALT_LEN]
    iv = block[CONTENT_SALT_LEN : CONTENT_SALT_LEN + IV_LEN]
    ciphertext = block[CONTENT_SALT_LEN + IV_LEN :]
    cek = derive_region_key(dek, content_salt, region_index)
    plaintext = AESGCM(cek).decrypt(iv, ciphertext, None)
    envelope = parse_region_plaintext(plaintext, max_content_bytes)
    filename, content = parse_envelope(envelope, max_content_bytes)
    return RestoredFile(filename, content)


def decode_vault_binary(
    container: bytes,
    password: str,
    key_block: bytes | None = None,
    *,
    key_factor: bytes | None = None,
    secret: bytes | None = None,
    iterations: int = DEFAULT_ITERATIONS,
    memory_kib: int = DEFAULT_MEMORY_KIB,
    parallelism: int = DEFAULT_PARALLELISM,
) -> RestoredFile:
    """Restore from a binary container file (SPEC §8). Geometry is chosen by the
    recovered variant (§10 governing decision 2): a disguised `.db` is a multi-region
    container (§10.7); branded `.ssbn` and bare payloads are single-region (§8.1).

    `key_factor` is the keyfile/stego secret (§10.3); `secret` is the recovered Shamir
    S for a Mode B (threshold-gated) .db vault — the two compose as extra layers."""
    unwrapped = unwrap_binary(container)
    if unwrapped is not None and unwrapped[1] == "disguised":
        filename, content = decode_multiregion_segmented_blob(
            unwrapped[0],
            password,
            key_factor,
            MAX_CONTENT_BYTES_BINARY,
            iterations,
            memory_kib,
            parallelism,
            secret,
        )
        return RestoredFile(filename, content)
    blob = unwrapped[0] if unwrapped else container
    filename, content = decode_segmented_blob(blob, password, key_block, MAX_CONTENT_BYTES_BINARY)
    return RestoredFile(filename, content)
