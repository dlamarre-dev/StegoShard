"""Shared fixtures for the primitive-compliance suite.

These tests are deliberately outside ``python/``: ``pyproject.toml`` sets
``testpaths = ["python"]``, so the decoder suite keeps running exactly as before
and never pulls in crypto-condor. Run this suite with an explicit path,
``pytest tests/compliance``, which overrides ``testpaths``.

Keeping the two apart also keeps two signals apart. "Python decoder conformance"
failing means the format drifted; "primitive compliance" failing means one of the
two stacks stopped matching a published standard. Those want different reactions,
and they have different dependency sets (see ``python/requirements-compliance.in``).
"""

from __future__ import annotations

import sys
from collections.abc import Iterator

import pytest
from _bridge import REPO_ROOT, TSX, Bridge

# The decoder package lives under `python/`, which is not installed. Adding it here
# keeps `pytest tests/compliance` working with no PYTHONPATH incantation, exactly
# like `pytest python/tests` does through `pyproject.toml`.
sys.path.insert(0, str(REPO_ROOT / "python"))


@pytest.fixture(scope="session")
def bridge() -> Iterator[Bridge]:
    """The TypeScript implementation, callable from Python."""
    if not TSX.exists():
        pytest.skip("node_modules missing; run `npm ci` first")
    b = Bridge()
    try:
        b.call("ping")
        yield b
    finally:
        b.close()
