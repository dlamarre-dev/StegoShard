"""Binary format parsing — mirrors SPEC.md §3–§7 (all integers big-endian)."""

from __future__ import annotations

import gzip
import io
import struct
import zipfile
from dataclasses import dataclass
from pathlib import PurePosixPath

from .reedsolomon import reconstruct_data

MAGIC = b"SSHD"  # StegoShard
FORMAT_VERSION = 1
HEADER_LEN = 33

KEY_MAGIC = b"SSKY"  # StegoShard KeY
KEY_BLOCK_VERSION = 1
KEY_BLOCK_PREFIX_LEN = 44  # magic+ver+iter+mem+par+salt+iv+len (before wrapped)

IV_LEN = 12
FLAG_COMPRESSED = 0x01
FLAG_BUNDLE = 0x02

# Guards for untrusted input (mirror the TypeScript decoder).
MAX_CONTENT_BYTES = 1024 * 1024  # image/PDF export cap; bounds gzip on that path
# Binary (non-image) export cap. The reference decoder must accept the largest
# artifact the tools can produce, i.e. the CLI cap (the browser UI caps lower).
MAX_CONTENT_BYTES_BINARY = 1024 * 1024 * 1024  # 1 GiB
ARGON2_LIMITS = {
    "iterations": (1, 4),
    "memory_kib": (8, 256 * 1024),  # <= 256 MiB
    # Preserve v1 compatibility; committed vectors legitimately use 2 and 4.
    "parallelism": (1, 4),
}


@dataclass
class Header:
    version: int
    set_id: bytes
    shard_index: int
    k: int
    m: int
    codec_id: int
    profile: int
    shard_len: int
    blob_len: int
    hash: bytes


def parse_header(payload: bytes) -> Header:
    if len(payload) < HEADER_LEN:
        raise ValueError("header: too short")
    if payload[0:4] != MAGIC:
        raise ValueError("header: bad magic")
    version = payload[4]
    if version != FORMAT_VERSION:
        raise ValueError(f"header: unsupported version {version}")
    set_id = payload[5:13]
    shard_index, k, m = struct.unpack(">HHH", payload[13:19])
    codec_id = payload[19]
    profile = payload[20]
    shard_len, blob_len = struct.unpack(">II", payload[21:29])
    hash_ = payload[29:33]
    # Validate untrusted parameters before any downstream allocation.
    if k < 1 or m < 0 or k + m > 256:
        raise ValueError(f"header: invalid k/m ({k}/{m})")
    if shard_index >= k + m:
        raise ValueError(f"header: shard index {shard_index} out of range")
    if shard_len < 1 or blob_len < 1 or blob_len > k * shard_len:
        raise ValueError("header: invalid shard/blob length")
    return Header(version, set_id, shard_index, k, m, codec_id, profile, shard_len, blob_len, hash_)


def split_payload(payload: bytes) -> tuple[Header, bytes]:
    header = parse_header(payload)
    shard = payload[HEADER_LEN : HEADER_LEN + header.shard_len]
    if len(shard) != header.shard_len:
        raise ValueError("header: truncated shard")
    return header, shard


def decode_blob(shards: list[bytes | None], k: int, m: int, blob_len: int) -> bytes:
    data = reconstruct_data(shards, k, m)
    joined = b"".join(data)
    return joined[:blob_len]


@dataclass
class KeyBlock:
    salt: bytes
    iterations: int
    memory_kib: int
    parallelism: int
    iv: bytes
    wrapped: bytes


def parse_key_block(data: bytes) -> KeyBlock:
    if len(data) < KEY_BLOCK_PREFIX_LEN:
        raise ValueError("key block: too short")
    if data[0:4] != KEY_MAGIC:
        raise ValueError("key block: bad magic")
    version = data[4]
    if version != KEY_BLOCK_VERSION:
        raise ValueError(f"key block: unsupported version {version}")
    iterations, memory_kib = struct.unpack(">II", data[5:13])
    parallelism = data[13]
    salt = data[14:30]
    iv = data[30:42]
    (wrapped_len,) = struct.unpack(">H", data[42:44])
    wrapped = data[44 : 44 + wrapped_len]
    if len(wrapped) != wrapped_len:
        raise ValueError("key block: truncated")
    # Canonical encoding: exactly one byte sequence parses to a given block.
    if len(data) != 44 + wrapped_len:
        raise ValueError("key block: trailing bytes")
    # Reject attacker-controlled Argon2id parameters (DoS before authentication).
    for name, value in (
        ("iterations", iterations),
        ("memory_kib", memory_kib),
        ("parallelism", parallelism),
    ):
        low, high = ARGON2_LIMITS[name]
        if not (low <= value <= high):
            raise ValueError(f"key block: Argon2id {name} out of range ({value})")
    return KeyBlock(salt, iterations, memory_kib, parallelism, iv, wrapped)


CONTENT_SALT_LEN = 16

# --- Access structures (SPEC §10): multi-region geometry (gallery + .db) -------

SLOT_COUNT = 4
SLOT_SIZE = 76  # nonce[12] || AES-GCM(48) = ct[48] || tag[16]
SLOT_PLAINTEXT_LEN = 48  # dek[32] || region_index[1] || reserved[15]
SLOT_ARRAY_LEN = SLOT_COUNT * SLOT_SIZE  # 304
REGION_INDEX_OFF = 32  # within the slot plaintext
REGION_COUNT = 2
VAULT_SALT_LEN = 16
REGION_LEN_FIELD = 4  # u32 true-length prefix inside a region plaintext
GCM_TAG_LEN = 16
REGION_OVERHEAD = CONTENT_SALT_LEN + IV_LEN + GCM_TAG_LEN  # 44 (bucket adds the rest)


def parse_region_plaintext(plaintext: bytes, max_content_bytes: int) -> bytes:
    """Recover the envelope from a decrypted region plaintext (SPEC §10.5). The
    true length is bounded against the bucket and the cap BEFORE slicing."""
    if len(plaintext) < REGION_LEN_FIELD:
        raise ValueError("region: too short")
    (length,) = struct.unpack(">I", plaintext[:REGION_LEN_FIELD])
    if length > len(plaintext) - REGION_LEN_FIELD:
        raise ValueError("region: length exceeds bucket")
    if length > max_content_bytes:
        raise ValueError("region: declared length exceeds the allowed size")
    return plaintext[REGION_LEN_FIELD : REGION_LEN_FIELD + length]


def split_multiregion_vault_blob(blob: bytes) -> tuple[bytes, bytes, bytes, int]:
    """Split a multi-region vault blob (§10.6) into (vault_salt, slot_array,
    region_area, R). Validates geometry before any use."""
    head = VAULT_SALT_LEN + SLOT_ARRAY_LEN
    if len(blob) < head + REGION_COUNT * (REGION_OVERHEAD + 1):
        raise ValueError("multi-region blob: too short")
    region_area = blob[head:]
    if len(region_area) % REGION_COUNT != 0:
        raise ValueError("multi-region blob: odd region area")
    r = len(region_area) // REGION_COUNT
    if r < REGION_OVERHEAD + 1:
        raise ValueError("multi-region blob: region too small")
    return blob[:VAULT_SALT_LEN], blob[VAULT_SALT_LEN:head], region_area, r


def parse_vault_blob(blob: bytes) -> tuple[bytes, bytes, bytes, bytes]:
    """Return (key_block_bytes, content_salt, iv, ciphertext). key_block_bytes is
    empty when the key is external (keyfile/stego modes). content_salt feeds the
    per-export content-key derivation (SPEC §6)."""
    (kb_len,) = struct.unpack(">H", blob[0:2])
    o = 2
    key_block = blob[o : o + kb_len]
    o += kb_len
    content_salt = blob[o : o + CONTENT_SALT_LEN]
    o += CONTENT_SALT_LEN
    iv = blob[o : o + IV_LEN]
    o += IV_LEN
    ciphertext = blob[o:]
    return key_block, content_salt, iv, ciphertext


def is_bundle(envelope: bytes) -> bool:
    """True when CONTENT is a .zip of several files (SPEC §4 FLAGS bit 1)."""
    if len(envelope) < 1:
        raise ValueError("payload: too short")
    return bool(envelope[0] & FLAG_BUNDLE)


def unpack_bundle(content: bytes) -> list[tuple[str, bytes]]:
    """Split a bundle's .zip back into (name, bytes) pairs.

    Each entry is reduced to a basename. The archive comes out of a decrypted
    vault, but its entry names were chosen by whoever wrote that vault, so a
    `../` entry must not be able to escape the output directory.
    """
    out: list[tuple[str, bytes]] = []
    with zipfile.ZipFile(io.BytesIO(content)) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            name = PurePosixPath(info.filename.replace("\\", "/")).name
            if not name or name in (".", ".."):
                continue
            out.append((name, zf.read(info)))
    if not out:
        raise ValueError("bundle: no readable entries")
    return out


def parse_envelope(
    envelope: bytes, max_content_bytes: int = MAX_CONTENT_BYTES
) -> tuple[str, bytes, bool]:
    """Split an envelope into (filename, content, bundled) — SPEC §4.

    `bundled` reports FLAGS bit 1; the caller decides whether to `unpack_bundle`
    the content. A reader that ignores the bit entirely still recovers the .zip
    intact, which `test_bundle.py` asserts — that is the property that let the
    bit be added without a format version bump.
    """
    if len(envelope) < 3:
        raise ValueError("payload: too short")
    flags = envelope[0]
    (name_len,) = struct.unpack(">H", envelope[1:3])
    name_end = 3 + name_len
    if len(envelope) < name_end:
        raise ValueError("payload: truncated filename")
    filename = envelope[3:name_end].decode("utf-8")
    stored = envelope[name_end:]
    if flags & FLAG_COMPRESSED:
        # Bounded inflate: read at most the cap + 1 byte to detect a gzip bomb
        # without materializing the whole (possibly huge) output.
        with gzip.GzipFile(fileobj=io.BytesIO(stored)) as gz:
            content = gz.read(max_content_bytes + 1)
        if len(content) > max_content_bytes:
            raise ValueError("decompressed data exceeds the allowed size")
    else:
        content = stored
    return filename, content, bool(flags & FLAG_BUNDLE)
