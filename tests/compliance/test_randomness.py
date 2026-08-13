"""NIST statistical battery (TestU01) over ``randomBytes`` output.

Why this exists
---------------
``src/core/crypto.ts`` contains the one hand-composed construction in the project.
Everything else delegates to a vetted primitive; this does not::

    output = getRandomValues() XOR HMAC-SHA256(K, counter)
    K      = HKDF(user string, session salt from the CSPRNG)

The three cases below are smoke tests for **detectable distribution defects** in
that construction: a stuck bit, a keystream that overwrites instead of XORing, a
degenerate user string that somehow degrades the tap.

What this does NOT show
-----------------------
**It does not establish unpredictability.** A statistical battery cannot: a counter
encrypted under a fixed key passes every test in it. Nor do these cases simulate a
failed CSPRNG, so the documented claim that a worthless CSPRNG still leaves the
output unpredictable to anyone who does not know the user string is *not* under
test here. That property follows from the construction, not from these numbers.

**Nothing here says anything about steganographic detectability.** Passing a
statistical battery means the byte stream carries no first-order structure. That
is necessary and nowhere near sufficient for deniability: steganalysis compares a
carrier against a model of *natural images*, and a uniformly random bit-plane
inside a photograph is itself a tell. The deniability boundary in
``docs/THREAT-MODEL.md`` stays where it is, and this suite must never be cited as
evidence for it.

Calibration
-----------
A battery reports p-values, so some sub-test failures are expected by chance and a
zero tolerance would produce a job that fails at random. Random red jobs get
switched off, which is worse than no job. Forty consecutive 8 MiB samples of
healthy CSPRNG output gave:

===============================  ==================
failing sub-tests (of 29)        runs (of 40)
===============================  ==================
0                                38
1                                 2
2 or more                         0
===============================  ==================

Mean 0.05 failures per battery. Deliberately weak sources sit an order of magnitude
away:

===============================  =======  =======
source                           passed   failed
===============================  =======  =======
weak 32-bit LCG                       11       18
CSPRNG with the LSB forced to 0        1       28
counter                          battery aborts
===============================  =======  =======

Hence :data:`MAX_FAILED_SUBTESTS` = 2: never reached in calibration, roughly a
nine-fold margin below the weakest defect measured, and a false-alarm rate small
enough that a red job means something.

The "counter" row is why an empty result set is treated as a failure: a pathological
input can make TestU01 give up entirely, and ``test_file`` returns an empty
``ResultsDict`` without raising.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest
from _bridge import Bridge
from crypto_condor.primitives import TestU01

#: 8 MiB. One battery takes about six seconds at this size. Smaller samples make
#: the rarer sub-tests toothless.
SAMPLE_BYTES = 8 * 1024 * 1024

#: Tolerated failing sub-tests per battery. See the calibration table above: this
#: is a statistical test, and demanding a perfect sweep would make the job flaky.
MAX_FAILED_SUBTESTS = 2

#: Set by the CI job. Locally a missing TestU01 is a skip; in CI it is a failure,
#: so the group can never quietly stop running.
IN_CI = os.environ.get("CI") == "true"

TESTU01_HELP = (
    "TestU01 could not be built. It needs autoconf, automake and GNU libtool "
    "(glibtoolize), and on a modern compiler it needs CFLAGS='-std=gnu89 -w' "
    "because TestU01 still uses K&R function definitions. On macOS:\n"
    "  brew install autoconf automake libtool\n"
    "  CFLAGS='-std=gnu89 -w' python -c "
    "'from crypto_condor.primitives import TestU01; TestU01.install_testu01()'"
)


def _battery(path: Path, label: str) -> None:
    """Run the NIST battery over ``path`` and require a clean sweep."""
    results = TestU01.test_file(str(path))

    # `test_file` swallows a TestU01 crash and returns an empty dict. Treating
    # that as success would make this whole group decorative.
    if not results:
        message = f"{label}: TestU01 produced no results at all."
        if IN_CI:
            pytest.fail(f"{message} {TESTU01_HELP}")
        pytest.skip(f"{message} {TESTU01_HELP}")

    res = next(iter(results.values()))
    print(f"\n  {label}: passed={res.valid.passed} failed={res.valid.failed}")
    assert res.valid.passed > 0, f"{label}: battery reported no passing sub-test"
    assert res.valid.failed <= MAX_FAILED_SUBTESTS, (
        f"{label}: {res.valid.failed} of {res.valid.passed + res.valid.failed} NIST "
        f"sub-tests failed, above the tolerance of {MAX_FAILED_SUBTESTS}. Calibration "
        "over forty healthy samples never exceeded one, so this is a signal rather "
        "than noise. Re-run once to rule out a fluke, then investigate the entropy tap."
    )


def _sample(bridge: Bridge, tmp: Path, name: str, entropy: str | None) -> Path:
    """Draw ``SAMPLE_BYTES`` through ``randomBytes`` with the given entropy layer."""
    path = tmp / f"{name}.bin"
    kwargs = {"path": str(path), "bytes": SAMPLE_BYTES}
    if entropy is not None:
        kwargs["entropy"] = entropy
    written = bridge.call("random.write", **kwargs)["written"]
    assert written == SAMPLE_BYTES, f"{name}: bridge wrote {written} bytes"
    assert path.stat().st_size == SAMPLE_BYTES
    return path


@pytest.fixture(scope="module")
def tmp_samples() -> Path:
    with tempfile.TemporaryDirectory(prefix="stegoshard-randomness-") as d:
        yield Path(d)


def test_plain_csprng(bridge: Bridge, tmp_samples: Path) -> None:
    """The bare tap: `getRandomValues` windowed by `randomBytes`, no user layer."""
    _battery(_sample(bridge, tmp_samples, "plain", None), "randomBytes (no user entropy)")


def test_with_user_entropy(bridge: Bridge, tmp_samples: Path) -> None:
    """The XOR layer installed with a high-entropy string must not degrade the tap."""
    rich = "7f3a9c2e correct horse battery staple 4d81 dice:6 2 5 1 3 6 4 2"
    _battery(
        _sample(bridge, tmp_samples, "rich", rich),
        "randomBytes (user entropy, rich string)",
    )


def test_with_degenerate_user_entropy(bridge: Bridge, tmp_samples: Path) -> None:
    """A worthless user string must not make the output measurably worse.

    ``src/core/crypto.ts`` argues that a worthless string leaves the output exactly
    as good as the platform's, because XOR with an independent stream can only
    preserve or add uncertainty. That argument rests on the construction; what is
    checked here is narrower and empirical: feeding a degenerate string introduces
    no distribution defect the battery can see.
    """
    _battery(
        _sample(bridge, tmp_samples, "degenerate", "aaaa"),
        "randomBytes (user entropy, degenerate string)",
    )
