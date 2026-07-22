"""High-level restore: image payloads + password (+ optional key block) → file.

Mirrors src/core/vault.ts `importVault` and SPEC.md §1.
"""

from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass

from .binary_container import unwrap_binary
from .crypto import decrypt_content, derive_content_key, unwrap_dek
from .format import (
    MAX_CONTENT_BYTES,
    MAX_CONTENT_BYTES_BINARY,
    decode_blob,
    parse_envelope,
    parse_key_block,
    parse_vault_blob,
    split_payload,
)


class MissingKeyError(Exception):
    """Raised when a keyfile/stego set is restored without its external key block."""


@dataclass
class RestoredFile:
    filename: str
    content: bytes


def decode_vault(
    payloads: list[bytes], password: str, key_block: bytes | None = None
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


def decode_vault_binary(
    container: bytes, password: str, key_block: bytes | None = None
) -> RestoredFile:
    """Restore from a binary container file (SPEC §8). Bytes matching neither
    variant are treated as a bare blob, letting AES-GCM be the arbiter."""
    unwrapped = unwrap_binary(container)
    blob = unwrapped[0] if unwrapped else container
    return _decode_vault_blob(blob, password, key_block, MAX_CONTENT_BYTES_BINARY)
