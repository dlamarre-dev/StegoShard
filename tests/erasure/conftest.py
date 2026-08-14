"""Shared fixtures for the erasure-coding field suite.

Deliberately outside ``python/``: ``pyproject.toml`` sets ``testpaths =
["python"]``, so the decoder suite keeps running exactly as before and never
pulls in reedsolo. Run this suite with an explicit path, ``pytest
tests/erasure``, which overrides ``testpaths``.

Four suites, four dependency sets, four meanings when one goes red. "Python
decoder conformance" failing means the format drifted; "primitive compliance"
means a stack stopped matching a published standard; "steganalysis" means a
carrier became visible; this one means the Galois field underneath Reed-Solomon
stopped agreeing with an independent implementation of the same field.

What this suite measures, and what it does not
----------------------------------------------
It anchors **GF(2^8) arithmetic only**, in both stacks, exhaustively. The 65,536
products go against reedsolo *and* against a table-free multiply that computes
straight from the field definition; the 65,280 quotients, the 255 inverses and
the exp/log tables go against reedsolo alone.

It does **not** validate Reed-Solomon. StegoShard uses a systematic Cauchy
erasure code inverted by Gauss-Jordan (``SPEC.md`` §7.4); reedsolo is a BCH-view
codec with syndromes and Berlekamp-Massey. They are different codes and no parity
byte will ever match. The Cauchy construction, the matrix inversion and the
choice of ``(k, m)`` remain validated by nothing external. They belong with the
composition an independent audit is being asked to examine, and the audit request
does not currently name erasure coding among its numbered items.

reedsolo is also not an authority in the sense crypto-condor is. There are no
standardised vectors for this 0x11D field: NIST does publish vectors that exercise
GF(2^8), but for the 0x11B field of AES, which is a different field. reedsolo's own
tests are round-trips and algebraic properties. What carries the argument here is not reedsolo but
``gf_mult_noLUT``, a Russian-peasant carry-less multiply that uses no tables at
all: it compares our table against the *definition* of the field rather than
against another table.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
DUMPER = REPO_ROOT / "scripts" / "dump-gf-tables.ts"
TSX = REPO_ROOT / "node_modules" / ".bin" / "tsx"

# The decoder package is not installed; import it from the repository.
sys.path.insert(0, str(REPO_ROOT / "python"))

# Drop the repository root itself. `npm run test:coverage` writes a gitignored
# `coverage/` directory there, and Python resolves a bare directory as an empty
# namespace package, so `import coverage` succeeds and returns a module with no
# attributes. numba probes for coverage at import time and dies on it, which shows up
# as five errors in this file and no mention of the real cause. Sanitising the path is
# cheaper than asking every contributor to remember the ordering of two test commands.
for _stray in (str(REPO_ROOT), "", "."):
    while _stray in sys.path:
        sys.path.remove(_stray)

#: Frozen field parameters, from SPEC.md §7.1. Asserted rather than read from the
#: implementation: a constant compared against itself proves nothing.
EXPECTED_POLY = 0x11D
EXPECTED_GENERATOR = 0x02

#: Set by CI. Locally a missing tool is a skip; in CI it is a failure, so a suite
#: can never quietly stop running. Same rule as tests/compliance and
#: tests/steganalysis.
IN_CI = os.environ.get("CI") == "true"


def require(tool: str, path: str | None, hint: str) -> str:
    """Return the tool path, or skip locally / fail in CI."""
    if path:
        return path
    message = f"{tool} not found. {hint}"
    if IN_CI:
        pytest.fail(message)
    pytest.skip(message)
    # Unreachable: both calls above raise. Stated explicitly because a static
    # analyser cannot prove it, and a function annotated `-> str` that can fall
    # through returns None instead, which is the bug this line rules out.
    raise AssertionError("unreachable")


@pytest.fixture(scope="session")
def reedsolo_field() -> Any:
    """reedsolo with its globals initialised to *this* project's field.

    ``init_tables`` mutates module-level globals (``gf_exp``, ``gf_log``,
    ``field_charac``) rather than returning an object. Calling it explicitly here,
    once, with the parameters spelled out is what keeps a later import or a
    defaulted call from silently reconfiguring the field under a running test.
    The defaults happen to match, which is precisely why they are not relied on.
    """
    try:
        import reedsolo
    except ImportError:  # pragma: no cover - exercised by the CI-vs-local policy
        require(
            "reedsolo",
            None,
            "pip install --require-hashes -r python/requirements-erasure.lock",
        )
        raise
    reedsolo.init_tables(prim=EXPECTED_POLY, generator=EXPECTED_GENERATOR, c_exp=8)
    return reedsolo


@pytest.fixture(scope="session")
def ts_field(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    """The TypeScript field, dumped once through its public API."""
    tsx = require("tsx", str(TSX) if TSX.exists() else None, "run `npm ci` first")
    out = tmp_path_factory.mktemp("gf") / "tables.json"
    proc = subprocess.run(
        [tsx, str(DUMPER), str(out)],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    if proc.returncode != 0 or not out.exists():
        pytest.fail(f"dump-gf-tables.ts failed:\n{proc.stdout}\n{proc.stderr}")
    print(proc.stdout, file=sys.stderr)
    return json.loads(out.read_text())


def which(tool: str) -> str | None:
    return shutil.which(tool)
