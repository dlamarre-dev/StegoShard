"""Non-image binary container (SPEC §8) — mirrors src/core/binary-container.ts.

Two variants wrap an already-encrypted vault blob (or a key block) in a single
file: a self-labelling 'branded' blob, or a 'disguised' one carrying a real
SQLite header so file-type triage reads it as an ordinary database.
"""

from __future__ import annotations

BINARY_MAGIC = b"SSBN"  # StegoShard BiNary container
BINARY_VERSION = 1

# A complete, valid 100-byte SQLite 3 database header (see src/core/binary-container.ts).
# Modern file(1) validates the page-size field and more, so the full header — not
# just the 16-byte magic — is what makes triage report a genuine SQLite database.
SQLITE_HEADER = (
    b"SQLite format 3\x00"
    b"\x10\x00\x01\x01\x00\x40\x20\x20"
    b"\x00\x00\x00\x01" + b"\x00\x00\x00\x00" * 4 + b"\x00\x00\x00\x04"
    b"\x00\x00\x00\x00\x00\x00\x00\x00" + b"\x00\x00\x00\x01" + b"\x00\x00\x00\x00" * 3
    + b"\x00" * 20
    + b"\x00\x00\x00\x01"
    + b"\x00\x2e\x76\x88"
)
assert len(SQLITE_HEADER) == 100


def wrap_binary(payload: bytes, variant: str) -> bytes:
    if variant == "branded":
        return BINARY_MAGIC + bytes([BINARY_VERSION]) + payload
    if variant == "disguised":
        return SQLITE_HEADER + payload
    raise ValueError(f"unknown binary variant: {variant}")


def unwrap_binary(data: bytes) -> tuple[bytes, str] | None:
    """Strip a container to (payload, variant), or None if it is neither."""
    if data[: len(BINARY_MAGIC)] == BINARY_MAGIC:
        version = data[len(BINARY_MAGIC)]
        if version != BINARY_VERSION:
            raise ValueError(f"binary container: unsupported version {version}")
        return data[len(BINARY_MAGIC) + 1 :], "branded"
    if data[: len(SQLITE_HEADER)] == SQLITE_HEADER:
        return data[len(SQLITE_HEADER) :], "disguised"
    return None
