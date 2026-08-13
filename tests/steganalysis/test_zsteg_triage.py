"""zsteg: does embedding change what an off-the-shelf detector sees?

This is the half of ``docs/THREAT-MODEL.md:152`` that StegoShard *does* claim.
zsteg is the most widely used triage detector for PNG and BMP: it walks bit planes
in every channel order and bit ordering, and reports recognizable content, text,
zlib streams, file magic, and the signatures of OpenStego, Camouflage and wbStego.

Differential, not absolute
--------------------------
An untouched photograph is not quiet. On these four covers ``zsteg -a`` reports
between 13 and 26 structural findings and several hundred "text" fragments, all of
it noise pulled out of high bit planes: it announces "OpenPGP Public Key" and "PGP
Secret Sub-key" on pristine images. Asserting "no output" would therefore fail on a
clean cover and tell us nothing.

So the property under test is the real one: **the carrier must look the same to the
detector as the cover it came from.**

Structure versus noise
----------------------
Flipping 736 low bits inside a two-megabit plane does perturb the byte stream zsteg
reassembles, so a handful of its random "text" fragments shift by a character:
``" l\\t[n.*)"`` becomes ``" l\\t[nn*)"``. Measured across the four covers, that
happens on two of them and carries no information. What must not move is the
*structural* layer, the findings where zsteg claims to recognise a format, plus the
number of text fragments. Both were identical on all four covers.

The control is the point
------------------------
A clean verdict means nothing until the harness has been shown to produce a dirty
one. ``<cover>-control.png`` carries plaintext in sequential low bits, which is
precisely zsteg's target. If that is not detected, the setup is broken and every
other result here is void.

That is not hypothetical: the first version of this comparison piped zsteg through
``grep`` without ``-a``. zsteg's output contains NUL bytes, grep treated it as
binary and printed nothing, and the control read as "not detected" while the text
was in fact sitting in the image. Parsing happens in Python here for that reason.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

#: Findings where zsteg claims to recognise a format rather than echoing bytes.
STRUCTURAL = re.compile(rb"\b(file|zlib|openstego|camouflage|wbstego):[^\n]{0,80}")
TEXT_FINDING = re.compile(rb"\btext:")

CONTROL_MARKER = b"STEGOSHARD ZSTEG CONTROL"


def scan(zsteg: str, image: Path) -> bytes:
    """Run a full zsteg sweep and return raw bytes, NULs and all."""
    proc = subprocess.run([zsteg, "-a", str(image)], capture_output=True, timeout=600)
    return proc.stdout


def structural(out: bytes) -> set[bytes]:
    return set(m.group(0) for m in STRUCTURAL.finditer(out))


def text_count(out: bytes) -> int:
    return len(TEXT_FINDING.findall(out))


def test_control_is_detected(zsteg_bin: str, samples: Path, cover_names: list[str]) -> None:
    """The instrument check: plaintext in the low bits must surface.

    Runs first and on every cover. If a cover cannot show a detection it is not a
    usable cover, and no clean verdict measured on it is worth anything.
    """
    for cover in cover_names:
        out = scan(zsteg_bin, samples / f"{cover}-control.png")
        assert CONTROL_MARKER in out, (
            f"{cover}: zsteg did not surface the plaintext control. Either the "
            "harness is broken or this cover is unusable; in both cases the clean "
            "verdicts in this module mean nothing until it is fixed."
        )


def test_carrier_is_indistinguishable_from_cover(
    zsteg_bin: str, samples: Path, cover_names: list[str]
) -> None:
    """StegoShard's carrier must present the same surface as the untouched cover."""
    for cover in cover_names:
        clean = scan(zsteg_bin, samples / f"{cover}-clean.png")
        carrier = scan(zsteg_bin, samples / f"{cover}-stego.png")

        assert CONTROL_MARKER not in carrier, f"{cover}: control marker leaked into the carrier"

        s_clean, s_carrier = structural(clean), structural(carrier)
        appeared = s_carrier - s_clean
        vanished = s_clean - s_carrier
        print(
            f"\n  {cover}: {len(s_clean)} structural findings, {text_count(clean)} text fragments"
        )
        assert not appeared, (
            f"{cover}: embedding made zsteg recognise something new: "
            f"{sorted(appeared)[:3]}. That is a triage-visible leak."
        )
        assert not vanished, (
            f"{cover}: embedding removed findings the clean cover had: "
            f"{sorted(vanished)[:3]}. Unexpected, and worth understanding."
        )
        assert text_count(clean) == text_count(carrier), (
            f"{cover}: text-fragment count moved from {text_count(clean)} to "
            f"{text_count(carrier)}. Individual fragments shifting is expected noise; "
            "the count changing is not."
        )


@pytest.mark.parametrize("rate", ["40", "60"])
def test_naive_embedding_is_visible_at_high_rates(zsteg_bin: str, samples: Path, rate: str) -> None:
    """Sanity floor: a heavy naive embed should not look like a pristine cover.

    zsteg is a content detector, not a statistical one, so a heavy *random* payload
    need not light it up the way plaintext does. What must hold is that the picture
    is not identical to the clean one; if it were, this module would be measuring
    nothing at all.
    """
    cover = "church"
    clean = scan(zsteg_bin, samples / f"{cover}-clean.png")
    noisy = scan(zsteg_bin, samples / f"{cover}-naive{rate}.png")
    assert text_count(noisy) != text_count(clean) or structural(noisy) != structural(clean), (
        f"{cover} at {rate}%: a heavy naive embed produced output identical to the "
        "clean cover, which means this comparison cannot see anything."
    )
