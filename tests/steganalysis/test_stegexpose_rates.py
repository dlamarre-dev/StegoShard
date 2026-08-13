"""StegExpose: where does statistical detection actually start on these covers?

This module tests the half of ``docs/THREAT-MODEL.md:152`` that StegoShard
explicitly does **not** claim: resistance to targeted steganalysis. StegExpose
fuses four classical attacks (RS analysis, Sample Pairs, chi-square, Primary Sets)
and reports a continuous score, with 0.2 the usual threshold.

Why this is a sweep and not a pass/fail
---------------------------------------
StegExpose's authors validated it on embedding rates from 2.5% to 25.3%, averaging
13.8%. StegoShard's spatial carrier hides a 92-byte key block, which on these
960x720 covers is 736 bits in 2,073,600 low bits: **0.035%**, two orders of
magnitude below the tool's validated band.

A "clean" verdict there says nothing about the design. It says the payload is far
too small for these detectors to see, which is a fact about payload size. Reporting
it as "StegExpose finds nothing" would be false assurance of exactly the kind this
project keeps having to remove.

So the module measures the curve instead, and states where StegoShard sits on it.
Calibrated on these four covers:

===========  =======  =======  =======  =======  =======  =======
cover        clean    real     5%       10%      20%      40%
===========  =======  =======  =======  =======  =======  =======
car          0.096    0.096    0.130    0.177    0.200    0.320
ceiling      0.031    0.031    0.069    0.109    0.196    0.334
church       0.042    0.042    0.078    0.114    0.188    0.289
square       0.034    0.034    0.071    0.106    0.181    0.290
===========  =======  =======  =======  =======  =======  =======

Two things to read off it. StegoShard's carrier scores **identically to the
untouched cover, to three decimals**. And detection only becomes reliable at 40%:
at 20% just one of four covers reaches the threshold, and only exactly. The control
here is therefore 40%, not the 20% first assumed.

A further caution, measured rather than assumed: at 100% embedding the fusion score
*falls back* (0.25-0.28, with RS analysis collapsing to 0.000). Saturation degenerates
the estimator, so "more payload always scores higher" is untrue and no assertion
here may rely on it.
"""

from __future__ import annotations

import csv
import subprocess
from pathlib import Path

import pytest

THRESHOLD = 0.2

#: The control rate at which every cover must be detected. Below this the signal is
#: not reliable across covers; see the table above.
CONTROL_RATE = "40"

#: Highest score any untouched cover reached during calibration, plus headroom. The
#: real carrier must stay inside this band, since it must look like a clean cover.
CLEAN_CEILING = 0.15


def run_stegexpose(java: str, jar: str, directory: Path, out_csv: Path) -> dict[str, float]:
    """Scan a directory and return {filename: fusion score}."""
    proc = subprocess.run(
        [java, "-jar", jar, str(directory), "default", str(THRESHOLD), str(out_csv)],
        capture_output=True,
        text=True,
        timeout=1800,
        cwd=jar and Path(jar).parent,
    )
    if not out_csv.exists():
        pytest.fail(f"StegExpose produced no CSV:\n{proc.stdout}\n{proc.stderr}")

    scores: dict[str, float] = {}
    with out_csv.open() as fh:
        for row in csv.reader(fh):
            if not row or not row[0] or row[0] == "File name":
                continue
            try:
                scores[row[0]] = float(row[-1])
            except ValueError:
                continue
    if not scores:
        pytest.fail(
            "StegExpose returned an empty result set. Treating that as success would "
            "make this module decorative."
        )
    return scores


@pytest.fixture(scope="module")
def scores(java_bin: str, stegexpose_jar: str, samples: Path, tmp_path_factory) -> dict[str, float]:
    out = tmp_path_factory.mktemp("stegexpose") / "results.csv"
    return run_stegexpose(java_bin, stegexpose_jar, samples, out)


def test_control_is_detected_on_every_cover(
    scores: dict[str, float], cover_names: list[str]
) -> None:
    """The instrument check, and it runs before any clean verdict is trusted.

    A naive embed at the calibrated control rate must cross the threshold on every
    cover. A cover that fails this is unusable: it cannot show a positive, so its
    negatives carry no information. Drop it and record why in covers/PROVENANCE.md.
    """
    failures = []
    for cover in cover_names:
        key = f"{cover}-naive{CONTROL_RATE}.png"
        score = scores.get(key)
        assert score is not None, f"{key} missing from the StegExpose output"
        print(f"\n  control {cover:9} {score:.3f}")
        if score <= THRESHOLD:
            failures.append(f"{cover}={score:.3f}")
    assert not failures, (
        f"StegExpose failed to flag a {CONTROL_RATE}% naive embed on: {', '.join(failures)}. "
        "Those covers cannot demonstrate a positive, so nothing measured on them counts."
    )


def test_clean_covers_sit_below_the_threshold(
    scores: dict[str, float], cover_names: list[str]
) -> None:
    """Untouched photographs must not trip the detector, or the baseline is useless.

    This is what rules out the LCG-noise fixtures the project generates elsewhere:
    they score 0.667 before anything is embedded. See covers/PROVENANCE.md.
    """
    for cover in cover_names:
        score = scores[f"{cover}-clean.png"]
        print(f"\n  clean   {cover:9} {score:.3f}")
        assert score < CLEAN_CEILING, (
            f"{cover}: the untouched cover scores {score:.3f}, at or above the "
            f"{CLEAN_CEILING} ceiling. A cover that already looks steganographic "
            "cannot serve as a baseline."
        )


def test_carrier_matches_its_cover(scores: dict[str, float], cover_names: list[str]) -> None:
    """The measurement: StegoShard's carrier against the cover it was made from.

    Asserted as a difference, not an absolute. What matters is that embedding moved
    nothing, and the calibration showed the two scores agreeing to three decimals.
    """
    for cover in cover_names:
        clean = scores[f"{cover}-clean.png"]
        carrier = scores[f"{cover}-stego.png"]
        print(f"\n  carrier {cover:9} clean={clean:.3f} carrier={carrier:.3f}")
        assert carrier < THRESHOLD, (
            f"{cover}: the real carrier scores {carrier:.3f}, above the {THRESHOLD} "
            "threshold. That would contradict the triage claim outright."
        )
        assert abs(carrier - clean) < 0.01, (
            f"{cover}: embedding moved the score from {clean:.3f} to {carrier:.3f}. "
            "Calibration had them identical to three decimals, so any real movement "
            "is a change in the carrier's statistical footprint."
        )


def test_detection_rises_with_payload(scores: dict[str, float]) -> None:
    """The sweep must actually be a sweep, monotonic over the calibrated band.

    Guards the interpretation rather than the product: if the low rates stopped
    separating from the high ones, the curve reported in docs/CRYPTO-REVIEW.md would
    no longer describe reality. Bounded at 40% on purpose, because saturation makes
    the estimator fall back again.
    """
    cover = "church"
    ladder = [scores[f"{cover}-naive{r}.png"] for r in ("05", "10", "20", "40")]
    print(f"\n  ladder  {cover:9} " + " ".join(f"{s:.3f}" for s in ladder))
    assert ladder == sorted(ladder), (
        f"{cover}: detection did not rise with payload ({ladder}). The documented "
        "curve no longer holds and the numbers in CRYPTO-REVIEW.md need remeasuring."
    )
    assert ladder[-1] > THRESHOLD > ladder[0], (
        f"{cover}: the ladder no longer straddles the threshold ({ladder}), so it "
        "cannot show where detection begins."
    )
