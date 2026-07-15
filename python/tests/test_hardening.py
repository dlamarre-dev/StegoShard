"""Unit tests for the decoder's input-validation guards (no heavy deps needed)."""

from __future__ import annotations

import struct

import pytest

from imagevault.format import KEY_MAGIC, MAGIC, parse_header, parse_key_block


def _key_block(memory_kib: int) -> bytes:
    # magic(4)+ver(1)+iter(4)+mem(4)+par(1)+salt(16)+iv(12)+len(2)+wrapped(48)
    return (
        KEY_MAGIC
        + bytes([1])
        + struct.pack(">I", 3)
        + struct.pack(">I", memory_kib)
        + bytes([1])
        + bytes(16)
        + bytes(12)
        + struct.pack(">H", 48)
        + bytes(48)
    )


def test_key_block_rejects_inflated_memory():
    with pytest.raises(ValueError, match="out of range"):
        parse_key_block(_key_block(0xFFFFFFFF))  # ~4 TiB


def test_key_block_accepts_sane_params():
    assert parse_key_block(_key_block(64 * 1024)).memory_kib == 64 * 1024


def test_key_block_rejects_truncated():
    with pytest.raises(ValueError):
        parse_key_block(b"\x00" * 10)


def test_header_rejects_out_of_range_km():
    header = (
        MAGIC
        + bytes([1])
        + bytes(8)  # set id
        + struct.pack(">HHH", 0, 200, 100)  # shardIndex, k, m  (k+m > 256)
        + bytes([0, 0])  # codec, profile
        + struct.pack(">II", 100, 50)  # shardLen, blobLen
        + bytes(4)  # hash
    )
    with pytest.raises(ValueError):
        parse_header(header)
