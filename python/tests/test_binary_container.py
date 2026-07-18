"""Unit tests for the binary container (SPEC §8) — mirrors the TS suite."""

from __future__ import annotations

import pytest

from stegoshard.binary_container import (
    BINARY_MAGIC,
    SQLITE_HEADER,
    unwrap_binary,
    wrap_binary,
)


def test_branded_round_trip():
    wrapped = wrap_binary(b"\x01\x02\x03", "branded")
    assert wrapped[:4] == BINARY_MAGIC
    payload, variant = unwrap_binary(wrapped)
    assert variant == "branded"
    assert payload == b"\x01\x02\x03"


def test_disguised_has_sqlite_header():
    wrapped = wrap_binary(b"\x09\x08", "disguised")
    assert len(SQLITE_HEADER) == 100  # full header, not just the 16-byte magic
    assert wrapped[:100] == SQLITE_HEADER
    assert wrapped[:16] == b"SQLite format 3\x00"
    assert wrapped[16:18] == b"\x10\x00"  # page size 4096 — what file(1) validates
    payload, variant = unwrap_binary(wrapped)
    assert variant == "disguised"
    assert payload == b"\x09\x08"


def test_neither_returns_none():
    assert unwrap_binary(b"\x00\x01\x02\x03\x04\x05") is None


def test_unsupported_version_raises():
    bad = bytearray(wrap_binary(b"\x01", "branded"))
    bad[4] = 99
    with pytest.raises(ValueError):
        unwrap_binary(bytes(bad))
