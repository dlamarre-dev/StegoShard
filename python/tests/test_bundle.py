"""SPEC §4 FLAGS bit 1: several files carried as one .zip payload."""

from __future__ import annotations

import io
import zipfile

import pytest
from stegoshard.format import FLAG_BUNDLE, is_bundle, unpack_bundle


def _zip(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


def test_flag_bit_is_read_from_the_envelope() -> None:
    assert is_bundle(bytes([FLAG_BUNDLE, 0, 0]))
    assert not is_bundle(bytes([0x01, 0, 0]))  # compressed only
    assert is_bundle(bytes([0x03, 0, 0]))  # composes with compression


def test_round_trips_several_files() -> None:
    out = dict(unpack_bundle(_zip({"a.txt": b"one", "b.bin": b"two"})))
    assert out == {"a.txt": b"one", "b.bin": b"two"}


def test_strips_path_traversal_from_entry_names() -> None:
    # The archive is decrypted from a vault, but its entry names were chosen by
    # whoever wrote that vault; a traversal must not escape the output dir.
    out = dict(unpack_bundle(_zip({"../../etc/passwd": b"nope", "sub/ok.txt": b"yes"})))
    assert set(out) == {"passwd", "ok.txt"}
    for name in out:
        assert "/" not in name and ".." not in name


def test_rejects_an_archive_with_nothing_readable() -> None:
    with pytest.raises(ValueError, match="no readable entries"):
        unpack_bundle(_zip({}))


def _bomb(size: int) -> bytes:
    """A small archive that expands to `size` bytes; zeroes deflate to nothing."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("big.bin", b"\x00" * size)
    return buf.getvalue()


def test_refuses_an_archive_that_expands_past_the_budget() -> None:
    bomb = _bomb(2_000_000)
    assert len(bomb) < 100_000  # small on the wire, large in memory
    with pytest.raises(ValueError, match="expands past"):
        unpack_bundle(bomb, max_total_bytes=1000)


def test_refuses_an_archive_with_too_many_entries() -> None:
    entries = {f"f-{i}.bin": b"x" for i in range(50)}
    with pytest.raises(ValueError, match="more than 10 entries"):
        unpack_bundle(_zip(entries), max_entries=10)


def test_bounds_the_total_across_entries_not_just_each_one() -> None:
    entries = {f"f-{i}.bin": b"y" * 400 for i in range(5)}
    with pytest.raises(ValueError, match="expands past"):
        unpack_bundle(_zip(entries), max_total_bytes=1000)


def test_still_accepts_an_archive_inside_the_budget() -> None:
    assert len(unpack_bundle(_zip({"a.txt": b"small"}), max_total_bytes=1 << 20)) == 1
