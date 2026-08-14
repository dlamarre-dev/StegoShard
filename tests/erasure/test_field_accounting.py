"""A test for the test: does the comparison harness still detect a wrong field?

``test_gf256_field.py`` is a pile of equality sweeps, and equality sweeps have a
quiet failure mode. If ``ts_field`` ever returned an empty dump, if a helper
looped over an empty range, or if a future refactor turned ``_report`` into a
warning, every sweep would pass while checking nothing. That shape of green is
what this repository keeps finding and removing, so the mechanism gets its own
adversarial probe, run in CI rather than left as a note in a pull request.

Each probe below feeds a deliberately wrong field through the *real* helpers and
asserts they fail, with the number of disagreements pinned. A probe that starts
reporting a different count means the harness changed what it looks at.

The counts are not decoration. "It failed" would also be satisfied by a harness
that fails on everything, which is why ``test_correct_field_is_accepted`` runs
last and must pass silently.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest
from _pytest.outcomes import Failed
from conftest import EXPECTED_POLY
from test_gf256_field import PRODUCTS, check_products

#: Disagreements a 0x12D field produces against the real one, out of 65,536.
#: 0x12D is primitive with generator 2, so it is a perfectly good GF(2^8): the
#: round-trip tests in src/core/gf256.test.ts pass under it, and so does every
#: other test in the repository. That is the exact defect this suite was built
#: for, and this number is what detecting it looks like.
WRONG_POLY_DISAGREEMENTS = 63232

#: Disagreements a generator-3 field produces. 3 is primitive in the AES field
#: 0x11B but has order 51 in 0x11D, so it does not enumerate the field and the
#: tables come out malformed rather than merely rebased. Worth keeping distinct
#: from the case above: a different *primitive* generator would produce zero
#: disagreements here, which is why the generator is pinned by the exp/log
#: tables and not by products.
BROKEN_GENERATOR_DISAGREEMENTS = 62220

#: Another primitive polynomial, so the probe cannot be dismissed as testing a
#: malformed field.
WRONG_POLY = 0x12D


def carryless_mul(poly: int) -> Callable[[int, int], int]:
    """A table-free multiply reducing by an arbitrary polynomial."""

    def mul(a: int, b: int) -> int:
        r = 0
        while b:
            if b & 1:
                r ^= a
            b >>= 1
            a <<= 1
            if a & 0x100:
                a ^= poly
        return r & 0xFF

    return mul


def table_mul(poly: int, generator: int) -> Callable[[int, int], int]:
    """Log/exp multiply built exactly the way gf256.ts builds it.

    Including the part that matters: if the generator does not enumerate the
    field, the tables are built anyway and the resulting multiply is wrong rather
    than absent. An implementation bug does not announce itself.
    """
    raw = carryless_mul(poly)
    exp = [0] * 512
    log = [0] * 256
    x = 1
    for i in range(255):
        exp[i] = x
        log[x] = i
        x = raw(x, generator)
    for i in range(255, 512):
        exp[i] = exp[i - 255]

    def mul(a: int, b: int) -> int:
        if a == 0 or b == 0:
            return 0
        return exp[log[a] + log[b]]

    return mul


def count_disagreements(mul: Callable[[int, int], int], reference: object) -> int:
    ref = reference.gf_mul
    return sum(1 for a in range(256) for b in range(256) if mul(a, b) != ref(a, b))


def test_wrong_polynomial_is_caught(reedsolo_field: object) -> None:
    """A valid but different field must be rejected, and by the real helper."""
    mul = carryless_mul(WRONG_POLY)
    n = count_disagreements(mul, reedsolo_field)
    print(f"\n  poly {WRONG_POLY:#x}: {n} of {PRODUCTS} products disagree")
    assert n == WRONG_POLY_DISAGREEMENTS, (
        f"a {WRONG_POLY:#x} field now disagrees in {n} places, not "
        f"{WRONG_POLY_DISAGREEMENTS}. Verify by hand before updating: this number "
        "is a property of two fixed fields and has no reason to move."
    )
    with pytest.raises(Failed, match="multiplication vs reedsolo"):
        check_products("probe", mul, reedsolo_field)


def test_broken_generator_is_caught(reedsolo_field: object) -> None:
    """Tables built from a non-primitive element must be rejected too."""
    mul = table_mul(EXPECTED_POLY, 3)
    n = count_disagreements(mul, reedsolo_field)
    print(f"\n  generator 3 in {EXPECTED_POLY:#x}: {n} of {PRODUCTS} products disagree")
    assert n == BROKEN_GENERATOR_DISAGREEMENTS, (
        f"a generator-3 field now disagrees in {n} places, not "
        f"{BROKEN_GENERATOR_DISAGREEMENTS}. Verify by hand before updating."
    )
    with pytest.raises(Failed, match="multiplication vs reedsolo"):
        check_products("probe", mul, reedsolo_field)


def test_table_free_oracle_catches_it_independently(reedsolo_field: object) -> None:
    """The table-free arm has to bite on its own.

    reedsolo's tabled multiply and its Russian-peasant multiply are two separate
    algorithms, and the whole argument for this suite is that the second one
    compares against the definition of the field rather than against a table. If
    only the tabled arm ever fired, that argument would be untested.
    """
    mul = carryless_mul(WRONG_POLY)

    class TabledButAgreeing:
        """Passes the tabled arm by construction, so only the raw arm can fail."""

        gf_mul = staticmethod(mul)
        gf_mult_noLUT = staticmethod(reedsolo_field.gf_mult_noLUT)  # type: ignore[attr-defined]

    with pytest.raises(Failed, match="table-free reference"):
        check_products("probe", mul, TabledButAgreeing())


def test_correct_field_is_accepted(reedsolo_field: object) -> None:
    """Last, and it must pass silently.

    Without it every assertion above would also be satisfied by a harness that
    rejects everything, which detects nothing while looking rigorous.
    """
    check_products("probe", carryless_mul(EXPECTED_POLY), reedsolo_field)
