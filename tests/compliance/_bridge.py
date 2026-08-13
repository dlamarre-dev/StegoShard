"""Client for ``scripts/crypto-bridge.ts``.

Lives in its own module rather than in ``conftest.py`` so the test modules can
import the types without a relative import (this directory is deliberately not a
package: pytest puts it on ``sys.path`` under the default import mode).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
BRIDGE = REPO_ROOT / "scripts" / "crypto-bridge.ts"
TSX = REPO_ROOT / "node_modules" / ".bin" / "tsx"


class BridgeRefused(Exception):
    """The implementation declined the input.

    Not a defect on its own: every mainstream GCM binding refuses nonces below 64
    bits, and CAVP includes such vectors. The tests decide what a refusal means by
    looking at which vector produced it.
    """


class Bridge:
    """A long-lived ``tsx scripts/crypto-bridge.ts`` speaking JSON lines.

    One process for the whole session. The CAVP set for AES-256-GCM is 7,875
    vectors per direction; spawning Node per vector would put this suite in the
    tens of minutes.
    """

    def __init__(self) -> None:
        self._proc = subprocess.Popen(
            [str(TSX), str(BRIDGE)],
            cwd=REPO_ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=sys.stderr,
            text=True,
            bufsize=1,
        )
        self._next_id = 0

    def call(self, op: str, **kwargs: Any) -> dict[str, Any]:
        """Send one request, block for its reply.

        Raises:
            BridgeRefused: the implementation rejected the input.
            RuntimeError: the bridge died, which is never expected.
        """
        self._next_id += 1
        req = {"id": self._next_id, "op": op, **kwargs}
        assert self._proc.stdin is not None and self._proc.stdout is not None
        self._proc.stdin.write(json.dumps(req) + "\n")
        self._proc.stdin.flush()
        line = self._proc.stdout.readline()
        if not line:
            raise RuntimeError("crypto bridge closed unexpectedly")
        res = json.loads(line)
        assert res["id"] == req["id"], "bridge replies must stay in order"
        if not res["ok"]:
            raise BridgeRefused(res["error"])
        return res

    def close(self) -> None:
        if self._proc.stdin is not None:
            self._proc.stdin.close()
        self._proc.wait(timeout=30)
