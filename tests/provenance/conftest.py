"""Shared fixtures for the provenance suite.

Deliberately outside ``python/`` and separate from ``tests/steganalysis/``, for
the reason that file gives: separate suites, separate dependency sets, separate
meanings when one goes red. Run with an explicit path, ``pytest tests/provenance``.

WHAT THIS SUITE IS FOR, AND WHY IT IS OPT-IN
``src/core/normalize.test.ts`` proves the surgery against synthesised JPEGs. It
cannot prove anything about what a Pixel 10, an iPhone or a Leica actually
writes, and the repository holds no photo that carries a real C2PA manifest: the
five camera JPEGs under ``tests/steganalysis/covers-jpeg/`` were run through
``jpegtran -copy none``, which stripped every metadata marker (see their
PROVENANCE.md).

Committing real originals instead is not an option worth taking. They are large,
and they carry the contributor's GPS coordinates, capture times and body serial
number into a public git history, which is precisely the class of data this
feature exists to contain.

So the suite runs against a directory the operator points it at:

    STEGOSHARD_PROVENANCE_FIXTURES=~/photos pytest tests/provenance

Without that variable it skips entirely, and it is **not** wired into CI. A
CI job would either never run (no fixtures) or would need real photos in the
runner, and a required check that never reports is worse than no check at all
(see the branch-protection note in the repo's CI docs).

The verdict half needs ``c2patool``, the C2PA project's own reader. Using a
third-party verifier is the point: a manifest this codebase's own parser says is
gone, judged gone by the tooling an adversary would actually reach for.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
TSX = REPO_ROOT / "node_modules" / ".bin" / "tsx"
CLI = REPO_ROOT / "src" / "cli" / "main.ts"

#: Set by CI. Locally a missing tool is a skip; in CI it is a failure, so a suite
#: can never quietly stop running. Same rule as tests/steganalysis.
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
    # through returns None instead.
    raise AssertionError("unreachable")


@pytest.fixture(scope="session")
def originals() -> list[Path]:
    """Real photographs to normalize, from STEGOSHARD_PROVENANCE_FIXTURES.

    The whole suite hangs off this. Unset means skip, with a message that says
    what to point it at: the value of this suite is entirely in the files being
    real, so falling back to synthesised ones would report green while measuring
    what the TypeScript suite already measured.
    """
    root = os.environ.get("STEGOSHARD_PROVENANCE_FIXTURES")
    if not root:
        pytest.skip(
            "set STEGOSHARD_PROVENANCE_FIXTURES to a directory of real camera photos "
            "(ideally one iOS, one Android and one dedicated-camera original, at least "
            "one of them carrying a C2PA manifest)"
        )
    directory = Path(root).expanduser()
    if not directory.is_dir():
        pytest.fail(f"STEGOSHARD_PROVENANCE_FIXTURES is not a directory: {directory}")
    photos = sorted(
        p for p in directory.iterdir() if p.suffix.lower() in {".jpg", ".jpeg"}
    )
    if not photos:
        pytest.fail(f"no JPEG files in {directory}")
    return photos


@pytest.fixture(scope="session")
def c2patool_bin() -> str:
    """c2patool, the C2PA project's own reader.

    Not vendored and not downloaded here: it is a Rust binary with its own
    release channel, and fetching a verifier inside a test is the supply-chain
    shape this project keeps out of its test files.
    """
    return require(
        "c2patool",
        shutil.which("c2patool"),
        "install it from https://github.com/contentauth/c2pa-rs (cargo install c2patool)",
    )


@pytest.fixture(scope="session")
def run_cli():
    """Invoke the real command line, the way a user would.

    Handed to the tests as a fixture rather than imported from this module:
    ``from conftest import ...`` works only because pytest happens to put the
    rootdir on the path, and a test that breaks when the suite is invoked from
    another directory is a test that will break eventually.
    """
    if not TSX.exists():
        require("tsx", None, "run `npm ci` first")

    def call(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(TSX), str(CLI), *args],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            env={**os.environ, "STEGOSHARD_LANG": "en"},
        )

    return call


@pytest.fixture(scope="session")
def normalized(originals: list[Path], run_cli, tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Run the real CLI over the fixtures once, and hand back the output dir."""
    out = tmp_path_factory.mktemp("normalized")
    proc = run_cli("normalize", *[str(p) for p in originals], "--out", str(out))
    if proc.returncode != 0:
        pytest.fail(f"normalize failed:\n{proc.stdout}\n{proc.stderr}")
    print(proc.stdout, file=sys.stderr)
    return out
