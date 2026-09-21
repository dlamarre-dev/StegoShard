"""Cover normalization measured on real camera photographs.

Three things are checked, and they are checked with tools that are not the
implementation under test:

1. **A third-party verifier finds no manifest.** ``c2patool`` is the C2PA
   project's own reader. "Our parser says the segment is gone" is a weaker claim
   than "the tooling an adversary would reach for finds nothing", and the second
   is the one the threat model depends on.
2. **The DCT coefficients survive, compared in Python.** ``stegoshard.jpeg_coeff``
   is the independent decoder that already backs the cross-implementation
   conformance suite. Comparing coefficients with the same TypeScript code that
   performed the surgery would only prove it is self-consistent, and a pixel
   comparison would pass on a re-quantized file, which is the failure that
   silently destroys a payload.
3. **Everything else survives byte for byte**: the entropy-coded scan, and the
   whole trailer after EOI (an Ultra HDR gain map, a motion-photo video).

Plus the properties the synthesised suite also asserts, restated here because
they are about real files: idempotence, and a photo with no manifest coming back
unchanged.

See ``conftest.py`` for why this suite is opt-in and absent from CI.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

from stegoshard import jpeg_coeff  # noqa: E402


def coefficients(data: bytes) -> list[list[int]]:
    """Every quantized block, in decode order, via the independent decoder."""
    model = jpeg_coeff.decode(data)
    return [list(block) for comp in model.components for block in comp["blocks"]]


def scan_start(data: bytes) -> int:
    """Offset of the first entropy byte, i.e. just past the SOS header.

    Walked here rather than read off the decoder, which does not expose it, and
    deliberately not imported from the TypeScript side: the value of this suite
    is that nothing in it is the code that performed the surgery.
    """
    o = 2
    while o < len(data) - 1:
        assert data[o] == 0xFF, f"lost marker alignment at {o}"
        marker = data[o + 1]
        if marker == 0x01 or 0xD0 <= marker <= 0xD7:
            o += 2
            continue
        length = (data[o + 2] << 8) | data[o + 3]
        if marker == 0xDA:
            return o + 2 + length
        o += 2 + length
    raise AssertionError("no SOS in the file")


def eoi_offset(data: bytes) -> int:
    """Offset one past the **outer** EOI, i.e. where the trailer begins.

    Walked forward from the scan rather than searched backwards for the last
    ``FF D9``. An Ultra HDR gain map is itself a JPEG and carries its own EOI, so
    a backwards search finds the gain map's and reports a trailer of zero bytes,
    which is a trailer test that passes without looking at the trailer.
    """
    p = scan_start(data)
    while p < len(data) - 1:
        if data[p] == 0xFF:
            marker = data[p + 1]
            if marker == 0x00 or 0xD0 <= marker <= 0xD7:
                p += 2  # stuffed byte or restart marker: still inside the scan
                continue
            assert marker == 0xD9, f"unexpected marker 0x{marker:02x} ending the scan"
            return p + 2
        p += 1
    raise AssertionError("no EOI after the scan")


def c2pa_claims(tool: str, path: Path) -> dict | None:
    """What c2patool reads out of a file, or None when it finds no claim."""
    proc = subprocess.run([tool, str(path)], capture_output=True, text=True)
    if proc.returncode != 0:
        # c2patool exits non-zero when there is no manifest, which is the
        # outcome this suite is usually asserting.
        return None
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None


@pytest.fixture(scope="session")
def pairs(originals: list[Path], normalized: Path) -> list[tuple[Path, Path]]:
    """Each original beside its normalized copy, skipping any that was skipped."""
    out = []
    for original in originals:
        copy = normalized / original.name
        if copy.exists():
            out.append((original, copy))
    assert out, "normalize produced no output for any fixture"
    return out


def test_at_least_one_fixture_carried_a_manifest(
    c2patool_bin: str, originals: list[Path]
) -> None:
    """The instrument check: a suite with no positive proves nothing.

    If none of the supplied photos carried a manifest to begin with, every
    assertion below passes vacuously. Fail loudly and say what to supply instead,
    rather than reporting green on a measurement that never happened. Same rule
    as the outguess control in tests/steganalysis.
    """
    carrying = [p for p in originals if c2pa_claims(c2patool_bin, p) is not None]
    assert carrying, (
        "none of the supplied photos carries a C2PA manifest, so this suite would "
        "pass without testing anything. Supply at least one straight-off-the-camera "
        "original from a device that signs (recent Pixel, iPhone, or a Leica/Nikon/"
        "Sony body with C2PA firmware)."
    )
    print(f"{len(carrying)} of {len(originals)} fixtures carry a manifest", file=sys.stderr)


def test_no_manifest_survives(c2patool_bin: str, pairs) -> None:
    """A third-party verifier finds nothing in any normalized copy."""
    for original, copy in pairs:
        assert c2pa_claims(c2patool_bin, copy) is None, (
            f"{original.name}: c2patool still reads a claim after normalization"
        )


def test_dct_coefficients_are_identical(pairs) -> None:
    """The property the ordering decision rests on, on real files."""
    for original, copy in pairs:
        before = coefficients(original.read_bytes())
        after = coefficients(copy.read_bytes())
        assert len(after) == len(before), f"{original.name}: block count changed"
        assert after == before, f"{original.name}: quantized coefficients changed"


def test_the_entropy_scan_is_byte_identical(pairs) -> None:
    """Segment surgery must not touch a single byte of the scan."""
    for original, copy in pairs:
        src = original.read_bytes()
        dst = copy.read_bytes()
        raw_a = src[scan_start(src) : eoi_offset(src) - 2]
        raw_b = dst[scan_start(dst) : eoi_offset(dst) - 2]
        assert raw_a == raw_b, f"{original.name}: the entropy scan changed"


def test_the_trailer_survives_byte_for_byte(pairs) -> None:
    """Gain maps and motion-photo videos come out unchanged, or there was none."""
    for original, copy in pairs:
        src = original.read_bytes()
        dst = copy.read_bytes()
        trailer_before = src[eoi_offset(src) :]
        trailer_after = dst[eoi_offset(dst) :]
        assert trailer_after == trailer_before, (
            f"{original.name}: the {len(trailer_before)}-byte trailer changed"
        )


def test_a_photo_with_no_manifest_is_unchanged(c2patool_bin: str, pairs) -> None:
    """Byte for byte, not merely equivalent."""
    for original, copy in pairs:
        if c2pa_claims(c2patool_bin, original) is not None:
            continue
        assert copy.read_bytes() == original.read_bytes(), (
            f"{original.name} carried no manifest but was rewritten anyway"
        )


def test_normalization_is_idempotent(normalized: Path, run_cli, tmp_path: Path) -> None:
    """A second pass over the output changes nothing."""
    again = tmp_path / "again"
    proc = run_cli("normalize", str(normalized), "--out", str(again))
    assert proc.returncode == 0, f"second pass failed:\n{proc.stdout}\n{proc.stderr}"
    for produced in sorted(again.iterdir()):
        assert produced.read_bytes() == (normalized / produced.name).read_bytes(), (
            f"{produced.name} changed on a second normalization pass"
        )


def test_the_report_inventories_what_is_left(originals: list[Path], run_cli) -> None:
    """The part that answers the open question, rather than asserting on it.

    The policy for XMP and EXIF identifiers is deliberately not implemented yet
    (SPEC §9.7), because it cannot be written from the schema; it has to be
    written from what devices actually emit. This test does not assert what is
    found. It fails only if the inventory comes back empty, which would mean the
    report is not doing its job, and otherwise prints it for a human to read.
    """
    proc = run_cli("normalize", *[str(p) for p in originals], "--report", "--json")
    assert proc.returncode == 0, f"report failed:\n{proc.stdout}\n{proc.stderr}"
    doc = json.loads(proc.stdout)
    result = doc["result"]
    profiles = [c["profile"] for c in result["covers"] if c.get("profile")]
    assert profiles, "the report found no readable JPEG among the fixtures"

    print(json.dumps(result["set"], indent=2), file=sys.stderr)
    for cover, profile in zip(result["covers"], profiles):
        print(
            f"{cover['name']}: classes={profile['classes']} "
            f"c2pa={profile['c2pa']['segments']} trailer={profile['trailer']}",
            file=sys.stderr,
        )
