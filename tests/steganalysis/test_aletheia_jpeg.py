"""Aletheia over the JPEG DCT carrier, the one zsteg and StegExpose cannot see.

`test_zsteg_triage.py` and `test_stegexpose_rates.py` read PNG only. The JPEG path
carries the "a JPEG stays a JPEG" argument in the store listings and was the least
verified part of the project; this module measures it.

Runs in a container (`aletheia.Dockerfile`) because Aletheia needs Octave, three
toolboxes, TensorFlow and two steganography binaries. Nightly rather than per pull
request: the image is 7 GB and a full sweep took **47 minutes** on a GitHub runner,
measured on the first green run. The workflow allows 120.

What is measured
----------------
**A differential**, exactly as in the zsteg module. Absolute scores here are close
to worthless: on this cover set three of Aletheia's four JPEG detectors saturate,
reporting 0.6-1.0 on *untouched* photographs with confidence around 0.5. Only the
Steghide detector discriminates, and only on three of five covers.

So the assertion is that **the carrier scores the same as the cover it was made
from**, on every detector, saturated or not, to within the 0.1 granularity Aletheia
reports at. Measured on all five covers:

===========  ==========================  ==========================
cover        clean (OG/SH/nsF5/JUNI)     carrier (OG/SH/nsF5/JUNI)
===========  ==========================  ==========================
lake         1.0 / 0.0 / 0.9 / 0.8       1.0 / 0.0 / 0.9 / 0.9
night        1.0 / 0.0 / 0.8 / 0.8       1.0 / 0.0 / 0.9 / 0.8
beach        1.0 / 0.1 / 0.9 / 0.6       1.0 / 0.2 / 1.0 / 0.6
park         1.0 / 0.1 / 0.8 / 0.9       1.0 / 0.1 / 0.8 / 0.9
mountain     1.0 / 0.7 / 1.0 / 0.7       1.0 / 0.7 / 1.0 / 0.7
===========  ==========================  ==========================

`park` and `mountain` are identical across all four. Elsewhere nothing moves by
more than 0.1, which is the reporting granularity.

The instrument check
--------------------
Runs first, and only two covers can carry it here. An outguess-embedded JPEG must be
flagged by the Steghide detector, which trained on that family:

- `lake` 0.0 -> 1.0 and `beach` 0.1 -> 0.6: enforced, and both are required.
- `night` 0.0 -> 0.8 locally, but outguess has declined that cover reproducibly on
  GitHub runners, so it is measured and not counted. See CONTROL_COVERS below.
- `park` 0.1 -> 0.2: the control is not detected, so a clean verdict on this cover
  proves nothing.
- `mountain` scores 0.7 while untouched: a false positive before any embedding.

Those three still contribute to the differential but are barred from the instrument
check. See `covers-jpeg/PROVENANCE.md`.

What this does not establish
----------------------------
Three of four detectors carry no information on this set, so the "carrier is
indistinguishable" result rests on the differential plus one working detector over
two enforced covers. It is not a general claim of resistance to JPEG steganalysis, and the
learned detectors add a second caveat: a low score may mean undetectable, or merely
outside the training distribution. Targeted steganalysis of *this* scheme remains
the second item of the independent audit request.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

#: Nightly only. The per-PR job deselects this marker: the image is 7 GB and a full
#: sweep takes about half an hour, which does not belong on a pull request.
pytestmark = pytest.mark.nightly

IMAGE_TAG = "stegoshard-aletheia"
DOCKERFILE = Path(__file__).resolve().parent / "aletheia.Dockerfile"
COVERS_JPEG = Path(__file__).resolve().parent / "covers-jpeg"

#: Aletheia prints "name.jpg  [0.9] (0.5)  0.0 (1.0) ..." with brackets on values it
#: considers positive. Brackets are stripped; the confidence is not asserted on.
ROW = re.compile(
    r"^\s*(?P<name>\S+\.jpg)\s+(?P<scores>(?:\[?\d\.\d\]?\s+\(\d\.\d\)\s*)+)", re.MULTILINE
)
VALUE = re.compile(r"\[?(\d\.\d)\]?\s+\(\d\.\d\)")

#: Column order printed by `aletheia.py auto` for JPEG input.
DETECTORS = ("outguess", "steghide", "nsf5", "juniward")

#: The only detector that discriminates on this cover set.
DISCRIMINATOR = "steghide"

#: Covers that can carry the instrument check. `night` is deliberately absent: it
#: works locally but outguess has declined it on every runner, so listing it would
#: mean tolerating a control that never arrives. `mountain` is absent because its
#: clean cover is already flagged. Both still feed the differential below, which is
#: the measurement; what they cannot do is show the detector was awake.
CONTROL_COVERS = ("lake", "beach")

#: A control must land at or above this, a clean cover below it.
CONTROL_FLOOR = 0.5

#: Every listed control must work. Deliberately equal to len(CONTROL_COVERS) rather
#: than lower: slack there would let a control quietly stop arriving while the suite
#: stayed green on the remainder, which is the failure mode this module exists to
#: refuse. A decline is still reported rather than raising a KeyError, but it is
#: fatal.
MIN_CONTROLS = len(CONTROL_COVERS)

#: Aletheia reports to one decimal, so this permits the reporting granularity and
#: nothing more.
MAX_DRIFT = 0.11


#: Mirrors conftest.require(): locally a missing tool is a skip, in CI it is a
#: failure. Without this the nightly job would go green with both tests skipped if a
#: runner image ever dropped Docker, which is the same silent-pass the rest of this
#: suite is built to refuse.
IN_CI = os.environ.get("CI") == "true"


def _docker() -> str:
    found = shutil.which("docker")
    if found:
        return found
    message = "docker not found; this suite runs in a container (see the nightly workflow)"
    if IN_CI:
        pytest.fail(message)
    pytest.skip(message)
    raise AssertionError("unreachable")


def _parse(out: str) -> dict[str, dict[str, float]]:
    table: dict[str, dict[str, float]] = {}
    for m in ROW.finditer(out):
        values = [float(v) for v in VALUE.findall(m.group("scores"))]
        if len(values) != len(DETECTORS):
            continue
        table[m.group("name")] = dict(zip(DETECTORS, values, strict=True))
    return table


@pytest.fixture(scope="module")
def scores(tmp_path_factory: pytest.TempPathFactory) -> dict[str, dict[str, float]]:
    """Build samples, embed the outguess controls, and run Aletheia over the lot."""
    docker = _docker()
    work = tmp_path_factory.mktemp("aletheia")

    build = subprocess.run(
        [docker, "build", "-f", str(DOCKERFILE), "-t", IMAGE_TAG, str(DOCKERFILE.parent)],
        capture_output=True,
        text=True,
    )
    if build.returncode != 0:
        pytest.fail(f"image build failed:\n{build.stderr[-3000:]}")

    gen = subprocess.run(
        [
            str(DOCKERFILE.parents[2] / "node_modules/.bin/tsx"),
            str(DOCKERFILE.parents[2] / "scripts/gen-stego-samples.ts"),
            str(COVERS_JPEG),
            str(work),
        ],
        capture_output=True,
        text=True,
    )
    if gen.returncode != 0:
        pytest.fail(f"sample generation failed:\n{gen.stderr}")
    for png in work.glob("*.png"):  # Aletheia is only asked about the JPEG path here
        png.unlink()

    script = (
        "cd /work && python3 -c \"open('/tmp/m.txt','w')"
        ".write('STEGOSHARD OUTGUESS CONTROL '*30)\" && "
        'for f in *-clean.jpg; do n="${f%-clean.jpg}"; '
        'outguess -d /tmp/m.txt "$f" "${n}-outguess.jpg" >/dev/null 2>&1 || true; done && '
        "yes y | aletheia.py auto ."
    )
    run = subprocess.run(
        [docker, "run", "--rm", "-i", "-v", f"{work}:/work", IMAGE_TAG, "bash", "-c", script],
        capture_output=True,
        text=True,
        timeout=7200,
    )
    table = _parse(run.stdout + run.stderr)
    if not table:
        pytest.fail(
            "Aletheia produced no parseable scores. Treating that as success would make "
            f"this module decorative.\n{(run.stdout + run.stderr)[-3000:]}"
        )
    print(json.dumps(table, indent=2, sort_keys=True))
    return table


def test_outguess_control_is_flagged(scores: dict[str, dict[str, float]]) -> None:
    """The instrument check. Nothing below is trustworthy until this passes.

    Only the two covers whose control arrives reliably in CI are checked; `night`,
    `park` and `mountain` are excluded with the reasons recorded in
    covers-jpeg/PROVENANCE.md rather than silently dropped.
    """
    built = 0
    for cover in CONTROL_COVERS:
        clean = scores[f"{cover}-clean.jpg"][DISCRIMINATOR]
        control = scores.get(f"{cover}-outguess.jpg")
        if control is None:
            # outguess refuses a cover whose usable coefficients cannot hold the
            # message, and whether it does so varies with its build. That is not a
            # failure by itself, but it does mean this cover proves nothing today.
            print(f"\n  {cover}: outguess declined this cover, no control available")
            continue
        built += 1
        print(f"\n  {cover}: clean={clean:.1f} control={control[DISCRIMINATOR]:.1f}")
        assert control[DISCRIMINATOR] >= CONTROL_FLOOR > clean, (
            f"{cover}: the {DISCRIMINATOR} detector no longer separates an outguess "
            f"carrier ({control[DISCRIMINATOR]:.1f}) from a clean cover ({clean:.1f}). "
            "Until it does, every clean verdict in this module is meaningless."
        )

    assert built >= MIN_CONTROLS, (
        f"only {built} of {len(CONTROL_COVERS)} covers produced an outguess control, "
        f"below the minimum of {MIN_CONTROLS}. Without enough working controls the "
        "differential below cannot be trusted, because nothing shows the detector is "
        "awake."
    )


def test_carrier_matches_its_cover(scores: dict[str, dict[str, float]]) -> None:
    """The measurement: embedding must not move any detector, on any cover.

    Applied to all five covers including the two that cannot carry the instrument
    check, because a differential is still a differential; what those two cannot do
    is prove the detector was awake.
    """
    for cover_path in sorted(COVERS_JPEG.glob("*.jpg")):
        cover = cover_path.stem
        clean = scores[f"{cover}-clean.jpg"]
        carrier = scores[f"{cover}-stego.jpg"]
        drift = {d: abs(carrier[d] - clean[d]) for d in DETECTORS}
        print(
            f"\n  {cover}: " + " ".join(f"{d}={clean[d]:.1f}->{carrier[d]:.1f}" for d in DETECTORS)
        )
        worst = max(drift, key=lambda d: drift[d])
        assert drift[worst] <= MAX_DRIFT, (
            f"{cover}: embedding moved the {worst} detector from {clean[worst]:.1f} to "
            f"{carrier[worst]:.1f}. The carrier is no longer indistinguishable from its "
            "own cover, which is the property this module exists to check."
        )
