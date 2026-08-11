"""Segmented binary vault format (SPEC §8); mirrors src/core/segmented.ts.

The non-image ".ssbn"/".db" payload is a self-describing header followed by a
sequence of AES-256-GCM chunks sealed under a STREAM nonce discipline (the
construction `age` uses). This reference decoder verifies and reassembles them.

Blob layout:
  [ SEG_MAGIC "SSCS" 4 ][ SEG_VERSION 1 ][ FLAGS 1 ][ KB_LEN u16 ]
  [ keyBlock KB_LEN ][ contentSalt 16 ][ noncePrefix 7 ]
  [ chunkSize u32 ][ plaintextLen u64 ]
  [ chunk_0 ] .. [ chunk_{n-1} ]        chunk_i = ciphertext_i || tag_i(16)

Nonce_i = noncePrefix(7) || u32_be(i) || finalByte (0x01 only on the last chunk).
AAD = the entire header prefix. See src/core/segmented.ts for the security rationale.
"""

from __future__ import annotations

import struct

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .crypto import (
    derive_content_key,
    derive_region_key,
    open_slot_array,
    slot_kek_candidates,
    unwrap_dek,
)
from .format import (
    CONTENT_SALT_LEN,
    REGION_COUNT,
    REGION_LEN_FIELD,
    SLOT_ARRAY_LEN,
    VAULT_SALT_LEN,
    parse_envelope,
    parse_key_block,
    parse_region_plaintext,
)

SEG_MAGIC = b"SSCS"  # StegoShard Chunked Segments
SEG_VERSION = 1
NONCE_PREFIX_LEN = 7
GCM_TAG_LEN = 16
MIN_CHUNK_SIZE = 4096
MAX_CHUNK_SIZE = 16 * 1024 * 1024

_HEAD_FIXED = len(SEG_MAGIC) + 1 + 1 + 2  # magic + ver + flags + kbLen = 8
_TAIL_FIXED = CONTENT_SALT_LEN + NONCE_PREFIX_LEN + 4 + 8  # salt+prefix+chunkSize+len = 35


def looks_like_segmented(data: bytes) -> bool:
    return data[: len(SEG_MAGIC)] == SEG_MAGIC


def _parse_header(blob: bytes):
    if len(blob) < _HEAD_FIXED:
        raise ValueError("segmented vault: too short")
    if blob[0:4] != SEG_MAGIC:
        raise ValueError("segmented vault: bad magic")
    version = blob[4]
    if version != SEG_VERSION:
        raise ValueError(f"segmented vault: unsupported version {version}")
    (kb_len,) = struct.unpack(">H", blob[6:8])
    o = _HEAD_FIXED
    header_len = o + kb_len + _TAIL_FIXED
    if len(blob) < header_len:
        raise ValueError("segmented vault: truncated header")
    key_block = blob[o : o + kb_len]
    o += kb_len
    content_salt = blob[o : o + CONTENT_SALT_LEN]
    o += CONTENT_SALT_LEN
    nonce_prefix = blob[o : o + NONCE_PREFIX_LEN]
    o += NONCE_PREFIX_LEN
    (chunk_size,) = struct.unpack(">I", blob[o : o + 4])
    o += 4
    (plaintext_len,) = struct.unpack(">Q", blob[o : o + 8])
    o += 8
    if not (MIN_CHUNK_SIZE <= chunk_size <= MAX_CHUNK_SIZE):
        raise ValueError(f"segmented vault: chunk size out of range ({chunk_size})")
    header = blob[0:header_len]
    return header, header_len, key_block, content_salt, nonce_prefix, chunk_size, plaintext_len


def _nonce(prefix: bytes, index: int, final: bool) -> bytes:
    return prefix + struct.pack(">I", index) + bytes([1 if final else 0])


def _decrypt_chunks(
    blob: bytes,
    header: bytes,
    header_len: int,
    cek: bytes,
    nonce_prefix: bytes,
    chunk_size: int,
    plaintext_len: int,
    max_content_bytes: int,
) -> bytes:
    if plaintext_len > max_content_bytes + chunk_size:
        raise ValueError("segmented vault: declared length exceeds the allowed size")
    n = max(1, (plaintext_len + chunk_size - 1) // chunk_size)
    last_seg_len = plaintext_len - (n - 1) * chunk_size
    expected_body = (n - 1) * (chunk_size + GCM_TAG_LEN) + (last_seg_len + GCM_TAG_LEN)
    if len(blob) - header_len != expected_body:
        raise ValueError("segmented vault: container length does not match header")

    aead = AESGCM(cek)
    out = bytearray()
    in_off = header_len
    for i in range(n):
        seg_len = last_seg_len if i == n - 1 else chunk_size
        ct = blob[in_off : in_off + seg_len + GCM_TAG_LEN]
        in_off += seg_len + GCM_TAG_LEN
        nonce = _nonce(nonce_prefix, i, i == n - 1)
        try:
            out += aead.decrypt(nonce, ct, header)
        except Exception as exc:  # noqa: BLE001 - normalize to a clear error
            raise ValueError(f"segmented vault: chunk {i} failed authentication") from exc
    return bytes(out)


def decode_segmented_blob(
    blob: bytes, password: str, key_block: bytes | None, max_content_bytes: int
):
    """Decode a segmented blob with a password. Returns (filename, content, bundled).

    Raises MissingKeyError when the key block is neither embedded nor supplied.
    """
    (
        header,
        header_len,
        embedded_kb,
        content_salt,
        nonce_prefix,
        chunk_size,
        plaintext_len,
    ) = _parse_header(blob)
    kb_bytes = embedded_kb if len(embedded_kb) > 0 else key_block
    if not kb_bytes:
        # Imported lazily to avoid a circular import (pipeline imports this module).
        from .pipeline import MissingKeyError

        raise MissingKeyError("this vault needs a separate key to restore")
    dek = unwrap_dek(parse_key_block(kb_bytes), password)
    cek = derive_content_key(dek, content_salt)
    envelope = _decrypt_chunks(
        blob, header, header_len, cek, nonce_prefix, chunk_size, plaintext_len, max_content_bytes
    )
    return parse_envelope(envelope, max_content_bytes)


# --- Multi-region segmented blob (SPEC §10.7, the `.db` path) ------------------

_MULTI_HEAD_LEN = len(SEG_MAGIC) + 1 + 1 + VAULT_SALT_LEN + SLOT_ARRAY_LEN + 4 + 8  # 334
_REGION_PREFIX_LEN = CONTENT_SALT_LEN + NONCE_PREFIX_LEN  # 23
_MULTI_MAX_BUCKET = 64 * 1024 * 1024  # the .db ladder top


def _multi_stream_len(bucket: int, chunk_size: int) -> int:
    n = max(1, (bucket + chunk_size - 1) // chunk_size)
    return _REGION_PREFIX_LEN + bucket + n * GCM_TAG_LEN


def _parse_multi_head(blob: bytes, max_content_bytes: int):
    if len(blob) < _MULTI_HEAD_LEN:
        raise ValueError("segmented vault: too short")
    if blob[0:4] != SEG_MAGIC:
        raise ValueError("segmented vault: bad magic")
    if blob[4] != SEG_VERSION:
        raise ValueError(f"segmented vault: unsupported version {blob[4]}")
    o = 6  # skip magic(4) + version(1) + flags(1)
    vault_salt = blob[o : o + VAULT_SALT_LEN]
    o += VAULT_SALT_LEN
    slot_array = blob[o : o + SLOT_ARRAY_LEN]
    o += SLOT_ARRAY_LEN
    (chunk_size,) = struct.unpack(">I", blob[o : o + 4])
    o += 4
    (bucket_len,) = struct.unpack(">Q", blob[o : o + 8])
    if not (MIN_CHUNK_SIZE <= chunk_size <= MAX_CHUNK_SIZE):
        raise ValueError(f"segmented vault: chunk size out of range ({chunk_size})")
    if (
        bucket_len <= 0
        or bucket_len > _MULTI_MAX_BUCKET
        or bucket_len > max_content_bytes + REGION_LEN_FIELD
    ):
        raise ValueError(f"segmented vault: region length out of range ({bucket_len})")
    stream_len = _multi_stream_len(bucket_len, chunk_size)
    if len(blob) != _MULTI_HEAD_LEN + REGION_COUNT * stream_len:
        raise ValueError("segmented vault: container length does not match header")
    return blob[:_MULTI_HEAD_LEN], vault_salt, slot_array, chunk_size, bucket_len, stream_len


def _decrypt_region_stream(
    head: bytes,
    stream: bytes,
    region_index: int,
    dek: bytes,
    chunk_size: int,
    bucket_len: int,
    max_content_bytes: int,
) -> bytes:
    content_salt = stream[:CONTENT_SALT_LEN]
    nonce_prefix = stream[CONTENT_SALT_LEN:_REGION_PREFIX_LEN]
    cek = derive_region_key(dek, content_salt, region_index)
    aad = head + bytes([region_index]) + content_salt + nonce_prefix
    n = max(1, (bucket_len + chunk_size - 1) // chunk_size)
    last_seg_len = bucket_len - (n - 1) * chunk_size
    aead = AESGCM(cek)
    out = bytearray()
    in_off = _REGION_PREFIX_LEN
    for i in range(n):
        seg_len = last_seg_len if i == n - 1 else chunk_size
        ct = stream[in_off : in_off + seg_len + GCM_TAG_LEN]
        in_off += seg_len + GCM_TAG_LEN
        try:
            out += aead.decrypt(_nonce(nonce_prefix, i, i == n - 1), ct, aad)
        except Exception as exc:  # noqa: BLE001 - normalize to a clear error
            raise ValueError(f"segmented vault: region chunk {i} failed authentication") from exc
    return parse_region_plaintext(bytes(out), max_content_bytes)


def decode_multiregion_segmented_blob(
    blob: bytes,
    password: str,
    key_factor: bytes | None,
    max_content_bytes: int,
    iterations: int,
    memory_kib: int,
    parallelism: int,
    secret: bytes | None = None,
) -> tuple[str, bytes, bool]:
    """Decode a multi-region segmented blob (SPEC §10.7): open the slot array
    (constant-work), then decrypt ONLY the one region the credential unlocks.
    `secret` is the recovered Shamir S for a Mode B (threshold-gated) slot."""
    head, vault_salt, slot_array, chunk_size, bucket_len, stream_len = _parse_multi_head(
        blob, max_content_bytes
    )
    candidates = slot_kek_candidates(
        password, vault_salt, key_factor, secret, iterations, memory_kib, parallelism
    )
    dek, region_index = open_slot_array(slot_array, candidates)
    start = _MULTI_HEAD_LEN + region_index * stream_len
    stream = blob[start : start + stream_len]
    envelope = _decrypt_region_stream(
        head, stream, region_index, dek, chunk_size, bucket_len, max_content_bytes
    )
    return parse_envelope(envelope, max_content_bytes)
