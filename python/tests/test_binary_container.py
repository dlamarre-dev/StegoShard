"""Unit tests for the binary container (SPEC §8) — mirrors the TS suite."""

from __future__ import annotations

import os
import sqlite3
import tempfile

import pytest
from stegoshard.binary_container import (
    BINARY_MAGIC,
    unwrap_binary,
    wrap_binary,
)


def test_branded_round_trip():
    wrapped = wrap_binary(b"\x01\x02\x03", "branded")
    assert wrapped[:4] == BINARY_MAGIC
    payload, variant = unwrap_binary(wrapped)
    assert variant == "branded"
    assert payload == b"\x01\x02\x03"


def test_disguised_is_valid_sqlite_with_no_trailing_bytes():
    wrapped = wrap_binary(b"\x09\x08", "disguised")
    assert wrapped[:16] == b"SQLite format 3\x00"
    assert wrapped[16:18] == b"\x10\x00"  # page size 4096
    page_count = int.from_bytes(wrapped[28:32], "big")
    assert len(wrapped) == page_count * 4096  # no unreferenced trailing bytes
    payload, variant = unwrap_binary(wrapped)
    assert variant == "disguised"
    assert payload == b"\x09\x08"


def test_disguised_opens_in_sqlite():
    """The disguised container is a real DB whose `cache` table holds the payload
    split across `page_cache_NNNN` rows; sqlite3 opens it, integrity_check passes,
    and concatenating those rows in key order reproduces the blob."""
    blob = os.urandom(200_000)  # large enough to span several chunk rows
    wrapped = wrap_binary(blob, "disguised")
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        with open(path, "wb") as f:
            f.write(wrapped)
        con = sqlite3.connect(path)
        assert con.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        rows = con.execute(
            "SELECT v FROM cache WHERE k LIKE 'page_cache\\_%' ESCAPE '\\' ORDER BY k"
        ).fetchall()
        con.close()
        assert len(rows) >= 2  # actually spread across multiple rows
        assert b"".join(r[0] for r in rows) == blob
    finally:
        os.remove(path)


def test_neither_returns_none():
    assert unwrap_binary(b"\x00\x01\x02\x03\x04\x05") is None


def test_unsupported_version_raises():
    bad = bytearray(wrap_binary(b"\x01", "branded"))
    bad[4] = 99
    with pytest.raises(ValueError):
        unwrap_binary(bytes(bad))
