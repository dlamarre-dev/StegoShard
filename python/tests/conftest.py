import os
import pathlib
import sys

import pytest

# Make the `stegoshard` package importable without installation.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))


#: Set by CI. The conformance suite skips locally when its fixtures are absent,
#: which is the right default for a contributor who has not run
#: `npm run fixtures` yet. Under CI that same skip would be a silent pass over
#: the only cross-implementation check in the repository, so it is refused here,
#: once, before collection rather than as 25 identical errors.
def pytest_sessionstart(session: object) -> None:  # noqa: ARG001
    if os.environ.get("CI") != "true":
        return
    fixtures = pathlib.Path(__file__).parent / "_fixtures"
    if not fixtures.exists():
        raise pytest.UsageError(
            "conformance fixtures are missing under CI "
            "(run: npm run fixtures -- python/tests/_fixtures). "
            "Skipping them would report green while verifying nothing."
        )
