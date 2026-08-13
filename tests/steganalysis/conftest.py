"""Shared fixtures for the steganalysis suite.

Deliberately outside ``python/`` and separate from ``tests/compliance/``: three
suites, three dependency sets, three meanings when one goes red. Run with an
explicit path, ``pytest tests/steganalysis``.

What this suite measures, and what it does not
----------------------------------------------
``docs/THREAT-MODEL.md`` claims Deniable Storage "defeats triage and casual
inspection, not targeted steganalysis". Two halves:

- **zsteg** tests the half that *is* claimed. It looks for recognizable content in
  extracted bit planes: text, zlib, file magic, OpenStego and Camouflage
  signatures. PNG and BMP only.
- **StegExpose** tests the half explicitly *not* claimed, with classical
  statistical attacks (RS analysis, Sample Pairs, chi-square, Primary Sets).

Neither closes the question. Both are blind to the JPEG DCT carrier and to the
`.db` container, and StegExpose runs an order of magnitude below its validated
sensitivity band at StegoShard's real payload size. See the module docstrings.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
COVERS = Path(__file__).resolve().parent / "covers"
GENERATOR = REPO_ROOT / "scripts" / "gen-stego-samples.ts"
TSX = REPO_ROOT / "node_modules" / ".bin" / "tsx"

#: Set by CI. Locally a missing tool is a skip; in CI it is a failure, so a suite
#: can never quietly stop running. Same rule as tests/compliance.
IN_CI = os.environ.get("CI") == "true"


def require(tool: str, path: str | None, hint: str) -> str:
    """Return the tool path, or skip locally / fail in CI."""
    if path:
        return path
    message = f"{tool} not found. {hint}"
    if IN_CI:
        pytest.fail(message)
    pytest.skip(message)


@pytest.fixture(scope="session")
def samples(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Generate the image set once per session and hand back its directory.

    Regenerated rather than committed: the PNGs are ~40 MB in total, and the
    generator is deterministic apart from the key block, which is random by design
    and must not be frozen.
    """
    if not TSX.exists():
        require("tsx", None, "run `npm ci` first")
    out = tmp_path_factory.mktemp("stego-samples")
    proc = subprocess.run(
        [str(TSX), str(GENERATOR), str(COVERS), str(out)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        pytest.fail(f"sample generation failed:\n{proc.stdout}\n{proc.stderr}")
    print(proc.stdout, file=sys.stderr)
    return out


@pytest.fixture(scope="session")
def cover_names() -> list[str]:
    return sorted(p.stem for p in COVERS.glob("*.jpg"))


@pytest.fixture(scope="session")
def zsteg_bin() -> str:
    """zsteg, from PATH or from the user gem directory."""
    found = shutil.which("zsteg")
    if not found:
        try:
            gem_dir = subprocess.run(
                ["ruby", "-e", "puts Gem.user_dir"], capture_output=True, text=True, check=True
            ).stdout.strip()
            candidate = Path(gem_dir) / "bin" / "zsteg"
            found = str(candidate) if candidate.exists() else None
        except (OSError, subprocess.CalledProcessError):
            found = None
    return require("zsteg", found, "install with `gem install zsteg`")


@pytest.fixture(scope="session")
def stegexpose_jar() -> str:
    """StegExpose, located via STEGEXPOSE_JAR.

    Not vendored and not downloaded here on purpose. The jar is unlicensed and the
    project has been archived since 2018; the CI job fetches it with a pinned
    SHA-256 and exports the path, so the check lives where the supply-chain rules
    already are rather than inside a test.
    """
    jar = os.environ.get("STEGEXPOSE_JAR")
    if jar and not Path(jar).exists():
        jar = None
    return require(
        "StegExpose",
        jar,
        "set STEGEXPOSE_JAR to a verified StegExpose.jar (see the CI job for the pinned hash)",
    )


@pytest.fixture(scope="session")
def java_bin() -> str:
    return require("java", shutil.which("java"), "install a JRE")


@pytest.fixture(scope="session")
def _unused() -> Iterator[None]:  # pragma: no cover - placeholder for symmetry
    yield None
