"""Non-image binary container (SPEC §8); mirrors src/core/binary-container.ts.

Two variants wrap an already-encrypted vault blob (or a key block) in a single
file: a self-labelling 'branded' blob, or a 'disguised' one that IS a complete,
valid SQLite database whose largest BLOB row holds the payload (no trailing bytes;
see sqlite_container.py).
"""

from __future__ import annotations

from .sqlite_container import SQLITE_MAGIC, pack_sqlite, unpack_sqlite

BINARY_MAGIC = b"SSBN"  # StegoShard BiNary container
BINARY_VERSION = 1


def looks_like_binary_container(head: bytes) -> bool:
    """Cheap detection from a file head (>=16 bytes): branded magic or SQLite header."""
    return head[: len(BINARY_MAGIC)] == BINARY_MAGIC or head[: len(SQLITE_MAGIC)] == SQLITE_MAGIC


def wrap_binary(payload: bytes, variant: str) -> bytes:
    if variant == "branded":
        return BINARY_MAGIC + bytes([BINARY_VERSION]) + payload
    if variant == "disguised":
        return pack_sqlite(payload)
    raise ValueError(f"unknown binary variant: {variant}")


def unwrap_binary(data: bytes) -> tuple[bytes, str] | None:
    """Strip a container to (payload, variant), or None if it is neither.

    The disguised variant needs the whole file (the blob is reassembled from the
    database); use looks_like_binary_container() for a head-only detection peek.
    """
    if data[: len(BINARY_MAGIC)] == BINARY_MAGIC:
        if len(data) <= len(BINARY_MAGIC):
            raise ValueError("binary container: truncated (no version byte)")
        version = data[len(BINARY_MAGIC)]
        if version != BINARY_VERSION:
            raise ValueError(f"binary container: unsupported version {version}")
        return data[len(BINARY_MAGIC) + 1 :], "branded"
    if data[: len(SQLITE_MAGIC)] == SQLITE_MAGIC:
        payload = unpack_sqlite(data)
        if payload is not None:
            return payload, "disguised"
    return None
