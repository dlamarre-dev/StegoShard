"""Reading the share files the app and the Node CLI write (SPEC §10.6).

The 38 bytes travel as a dash-grouped Crockford base32 token wrapped in
instructions, so a reader has to find the token rather than decode the file.
"""

from __future__ import annotations

import pytest
from stegoshard.shamir import (
    BASE32_ALPHABET,
    decode_share_text,
    serialize_share,
    shamir_recover,
    shamir_split,
)

SECRET = bytes(range(32))


def _grouped(share: bytes) -> str:
    """Re-encode a share the way encodeShareText does in src/core/shamir.ts."""
    bits = value = 0
    out = ""
    for b in share:
        value = (value << 8) | b
        bits += 8
        while bits >= 5:
            out += BASE32_ALPHABET[(value >> (bits - 5)) & 31]
            bits -= 5
    if bits:
        out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
    return "-".join(out[i : i + 5] for i in range(0, len(out), 5))


def test_alphabet_excludes_the_confusable_letters() -> None:
    # I/L/O/U are left out so a handwritten share cannot be mistranscribed into
    # a different valid one.
    for ch in "ILOU":
        assert ch not in BASE32_ALPHABET
    assert len(BASE32_ALPHABET) == 32


def test_decodes_a_share_round_tripped_through_the_text_form() -> None:
    share = shamir_split(SECRET, 2, 3)[0]
    assert decode_share_text(_grouped(share)) == share


def test_finds_the_token_inside_a_real_share_file() -> None:
    share = shamir_split(SECRET, 2, 3)[0]
    body = (
        "Recovery share 1 of 3\n\n"
        f"{_grouped(share)}\n\n"
        "Gather any 2 of the 3 shares and load them at restore with --share <file>.\n"
        "Holding a share makes YOU a point of pressure — keep it accordingly.\n"
    )
    assert decode_share_text(body) == share


def test_a_quorum_recovers_the_secret_from_file_text() -> None:
    shares = shamir_split(SECRET, 2, 3)
    texts = [_grouped(s) for s in shares]
    assert shamir_recover([decode_share_text(t) for t in (texts[0], texts[2])]) == SECRET


def test_separators_and_case_are_ignored() -> None:
    share = shamir_split(SECRET, 2, 3)[0]
    text = _grouped(share)
    assert decode_share_text(text.lower()) == share
    assert decode_share_text(text.replace("-", " ")) == share


def test_rejects_text_that_is_not_a_share() -> None:
    with pytest.raises(ValueError, match="expected 38 bytes"):
        decode_share_text("hello world, no token here")


def test_rejects_a_truncated_token() -> None:
    share = serialize_share(1, bytes(32))
    truncated = _grouped(share)[:20]
    with pytest.raises(ValueError, match="expected 38 bytes"):
        decode_share_text(truncated)
