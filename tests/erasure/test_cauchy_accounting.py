"""A test for the test: does the matrix comparison still detect a wrong construction?

``test_cauchy_code.py`` compares matrices for equality, and equality comparisons have a
quiet failure mode. If ``real_layouts()`` returned an empty list, if ``cauchy_reference``
started returning the implementation's own output, or if a shape mismatch stopped being
an assertion, every check there would pass while looking at nothing.

So the comparison gets its own adversarial probes. Each one is a *plausible* alternative,
taken from a real library rather than invented, because a probe that is obviously absurd
proves less: the question is whether this suite can tell StegoShard's construction from
the one it would most likely have been confused with.

The counts are pinned. "It failed" would also be satisfied by a harness that fails on
everything, which is why ``test_correct_construction_is_accepted`` runs last and must
pass in silence.
"""

from __future__ import annotations

from typing import Any, Callable

import numpy as np
import pytest

from conftest import EXPECTED_GENERATOR, EXPECTED_POLY
from test_cauchy_code import cauchy_reference

#: The layouts every probe is measured over. Three sizes, 162 matrix entries in total.
PROBE_LAYOUTS = [(4, 3), (10, 3), (20, 6)]
PROBE_ENTRIES = 162

#: ISA-L's Cauchy assignment: x_i = k + i, y_j = j. A perfectly good erasure code, and
#: a completely different matrix. Every single entry differs, which is the answer one
#: would hope for and not the one to assume.
ISAL_DISAGREEMENTS = 162

#: A Vandermonde matrix, the Backblaze and klauspost family, and the construction behind
#: every Reed-Solomon library that could plausibly have been reached for here.
#:
#: 160 of 162, not 162. Two entries coincide. That is the reason this suite compares
#: whole matrices rather than spot-checking a few cells: a spot check that happened to
#: land on those two would have reported agreement.
VANDERMONDE_DISAGREEMENTS = 160


@pytest.fixture(scope="module")
def GF() -> Any:
    galois = pytest.importorskip("galois", reason="galois missing; see requirements-erasure.lock")
    return galois.GF(2**8, irreducible_poly=EXPECTED_POLY, primitive_element=EXPECTED_GENERATOR)


def ours(k: int, m: int) -> np.ndarray:
    from stegoshard.reedsolomon import build_cauchy

    return np.array(build_cauchy(k, m), dtype=np.uint8)


def cauchy_with(GF: Any, k: int, m: int, xs: list[int], ys: list[int]) -> np.ndarray:
    x = GF(np.array(xs, dtype=np.uint8).reshape(len(xs), 1))
    y = GF(np.array(ys, dtype=np.uint8).reshape(1, len(ys)))
    return np.array(GF(np.ones((len(xs), len(ys)), dtype=np.uint8)) / (x + y), dtype=np.uint8)


def count_disagreements(build: Callable[[int, int], np.ndarray]) -> int:
    total = 0
    for k, m in PROBE_LAYOUTS:
        total += int((ours(k, m) != build(k, m)).sum())
    return total


def test_isal_assignment_is_caught(GF: Any) -> None:
    """x_i = k + i, y_j = j. Valid code, wrong matrix."""
    n = count_disagreements(
        lambda k, m: cauchy_with(GF, k, m, [k + i for i in range(m)], list(range(k)))
    )
    print(f"\n  ISA-L assignment: {n} of {PROBE_ENTRIES} entries differ")
    assert n == ISAL_DISAGREEMENTS, (
        f"the ISA-L assignment now differs in {n} places, not {ISAL_DISAGREEMENTS}. "
        "This number is a property of two fixed constructions and has no reason to move; "
        "verify by hand before updating it."
    )


def test_vandermonde_is_caught(GF: Any) -> None:
    """The Backblaze and klauspost family. Two entries coincide, 160 do not."""
    n = count_disagreements(
        lambda k, m: np.array(
            GF([[GF(i + 1) ** j for j in range(k)] for i in range(m)]), dtype=np.uint8
        )
    )
    print(f"\n  Vandermonde: {n} of {PROBE_ENTRIES} entries differ")
    assert n == VANDERMONDE_DISAGREEMENTS, (
        f"a Vandermonde matrix now differs in {n} places, not {VANDERMONDE_DISAGREEMENTS}."
    )


def test_overlapping_x_and_y_cannot_even_be_built(GF: Any) -> None:
    """Why SPEC.md §7.4 insists the two index sets are disjoint.

    Take x_i = m + i with y_j = j and the sets collide, so some entry needs the inverse
    of zero and the matrix does not exist at all. Worth a test of its own: the
    disjointness clause reads like housekeeping, and it is what makes every entry
    defined in the first place.
    """
    for k, m in PROBE_LAYOUTS:
        overlap = sorted(set(range(m, 2 * m)) & set(range(k)))
        assert overlap, f"k={k} m={m}: expected the probe's index sets to collide"
        with pytest.raises(ZeroDivisionError):
            cauchy_with(GF, k, m, [m + i for i in range(m)], list(range(k)))


def test_correct_construction_is_accepted(GF: Any) -> None:
    """Last, and it must pass in silence.

    Without it, every assertion above would also be satisfied by a comparison that
    rejects everything, which detects nothing while looking rigorous.
    """
    n = count_disagreements(lambda k, m: np.array(cauchy_reference(GF, k, m), dtype=np.uint8))
    assert n == 0, f"the specification's own formula disagrees with the implementation in {n} places"
