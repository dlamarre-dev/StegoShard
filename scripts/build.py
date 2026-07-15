#!/usr/bin/env python3
"""Run ImageVault's build / package npm scripts from one place.

Usage:
    python scripts/build.py build              # npm run build (Chrome/Edge, dev)
    python scripts/build.py package            # npm run package (store zips)
    python scripts/build.py build package      # several, in order
    python scripts/build.py all                # build + build:firefox + build:web

Actions map to npm scripts:
    build    -> build            (Chrome/Edge, dev)
    edge     -> build:edge
    firefox  -> build:firefox
    web      -> build:web
    package  -> package          (store zips + dist-release/ for chrome, edge, firefox)
    all      -> build, build:edge, build:firefox, build:web
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

ACTIONS: dict[str, list[str]] = {
    "build": ["build"],
    "edge": ["build:edge"],
    "firefox": ["build:firefox"],
    "web": ["build:web"],
    "package": ["package"],
    "all": ["build", "build:edge", "build:firefox", "build:web"],
}


def run_script(name: str) -> int:
    print(f"\n>> npm run {name}", flush=True)
    # shell=True keeps this working with npm/npm.cmd on Windows and POSIX alike.
    return subprocess.run(f"npm run {name}", cwd=str(ROOT), shell=True).returncode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build or package the ImageVault extension via npm.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "actions",
        nargs="+",
        choices=sorted(ACTIONS),
        metavar="ACTION",
        help="one or more of: " + ", ".join(sorted(ACTIONS)),
    )
    args = parser.parse_args(argv)

    # Expand to npm scripts, de-duplicated, preserving order.
    scripts: list[str] = []
    for action in args.actions:
        for script in ACTIONS[action]:
            if script not in scripts:
                scripts.append(script)

    for script in scripts:
        code = run_script(script)
        if code != 0:
            print(f"npm run {script} FAILED (exit {code})", file=sys.stderr)
            return code

    print("\nDone:", ", ".join(scripts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
