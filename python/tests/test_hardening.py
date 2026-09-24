"""Unit tests for the decoder's input-validation guards (no heavy deps needed)."""

from __future__ import annotations

import struct

import pytest
from stegoshard.format import KEY_BLOCK_VERSION, KEY_MAGIC, MAGIC, parse_header, parse_key_block


def _key_block(memory_kib: int) -> bytes:
    # magic(4)+ver(1)+iter(4)+mem(4)+par(1)+salt(16)+iv(12)+len(2)+wrapped(48)
    return (
        KEY_MAGIC
        + bytes([KEY_BLOCK_VERSION])
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


def test_key_block_rejects_trailing_bytes():
    with pytest.raises(ValueError, match="trailing"):
        parse_key_block(_key_block(64 * 1024) + b"\x00")


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


def _forged_jpeg(width: int, height: int) -> bytes:
    """Tables where the all-ones code means DC 0 and EOB, and no entropy data.

    Mirrors ``forgedJpeg`` in jpeg-coeff.test.ts.
    """

    def seg(marker: int, body: bytes) -> bytes:
        return bytes([0xFF, marker]) + struct.pack(">H", len(body) + 2) + body

    def table(tc: int) -> bytes:
        return bytes([tc << 4, 2] + [0] * 15 + [0, 0])

    sof = bytes([8]) + struct.pack(">HH", height, width) + bytes([1, 1, 0x11, 0])
    sos = bytes([1, 1, 0x00, 0, 63, 0])
    return (
        b"\xff\xd8"
        + seg(0xC0, sof)
        + seg(0xC4, table(0) + table(1))
        + seg(0xDA, sos)
        + b"\xff\xd9"
    )


def test_jpeg_refuses_scan_decoded_from_padding():
    from stegoshard.jpeg_coeff import JpegUnsupported, decode

    with pytest.raises(JpegUnsupported, match="past its data"):
        decode(_forged_jpeg(64, 64))


def test_jpeg_refuses_frame_past_pixel_ceiling():
    from stegoshard.jpeg_coeff import JpegUnsupported, decode

    with pytest.raises(JpegUnsupported, match="pixel ceiling"):
        decode(_forged_jpeg(65535, 65535))


def test_sqlite_forged_offsets_are_none_not_an_exception():
    """Mirrors the forged-length cases in sqlite-container.test.ts."""
    from stegoshard.sqlite_container import PAGE_SIZE, pack_sqlite, unpack_sqlite

    db = bytearray(pack_sqlite(bytes(range(256)) * 16))
    db[PAGE_SIZE + 12 : PAGE_SIZE + 14] = b"\xff\xfe"  # root cell pointer past its page
    assert unpack_sqlite(bytes(db)) is None
