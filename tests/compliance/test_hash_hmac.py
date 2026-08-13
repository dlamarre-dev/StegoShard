"""SHA-256 and HMAC-SHA256 against NIST and Wycheproof vectors.

These two primitives are small but load-bearing:

- **HMAC-SHA256** is the keystream of the optional user-entropy layer
  (``src/core/crypto.ts``): ``output = getRandomValues() XOR HMAC(K, counter)``.
  That layer is the one hand-composed construction in the project.
- **SHA-256** produces the 4-byte truncated header hint (SPEC 7.4) and backs the
  HKDF used to split one secret into several keys.

Both come from ``hash-wasm`` on the TypeScript side, which until now was validated
only by agreeing with the Python stack on frozen vectors. That is the correlated
-error problem again: agreement between two implementations built the same way
proves less than it appears to. NIST vectors are an outside opinion.

Only the TypeScript side is driven here. The Python decoder uses ``hashlib`` and
``cryptography`` for these, which are the reference implementations crypto-condor
itself would be testing against; running them would test CPython, not StegoShard.
"""

from __future__ import annotations

from _bridge import Bridge
from crypto_condor.primitives import HMAC, SHA

#: Vectors exercised, measured against crypto-condor 2025.9.8 and hash-wasm. Same
#: contract philosophy as ``tests/vectors/crypto-vectors.json``: drift in either
#: direction should fail loudly rather than pass quietly. A count that *drops* is
#: the dangerous case, because a suite that silently stopped testing anything still
#: reports green.
EXPECTED_SHA256_VECTORS = 130
EXPECTED_HMAC_SHA256_VECTORS = 291


def test_sha256(bridge: Bridge) -> None:
    """hash-wasm's SHA-256 against the NIST vectors, compliance and resilience."""

    def digest(data: bytes) -> bytes:
        return bytes.fromhex(bridge.call("sha256", msg=data.hex())["digest"])

    results = SHA.test_digest(digest, SHA.Algorithm.SHA_256, compliance=True, resilience=True)

    total_failed = 0
    total_passed = 0
    for name, res in results.items():
        total_failed += res.valid.failed + res.invalid.failed
        total_passed += res.valid.passed
        print(f"\n  sha256/{name}: passed={res.valid.passed} failed={res.valid.failed}")

    assert total_failed == 0, f"SHA-256: {total_failed} vector(s) failed"
    assert total_passed == EXPECTED_SHA256_VECTORS, (
        f"SHA-256: exercised {total_passed} vectors, expected {EXPECTED_SHA256_VECTORS}. "
        "Verify the new count by hand before updating this constant."
    )


def test_hmac_sha256_digest(bridge: Bridge) -> None:
    """hash-wasm's HMAC-SHA256, the keystream behind the user-entropy layer.

    crypto-condor truncates the comparison to the length of the expected tag, so
    returning the full 32-byte digest is correct for the truncated vectors too.
    """

    def digest(key: bytes, message: bytes) -> bytes:
        return bytes.fromhex(bridge.call("hmac.sha256", key=key.hex(), msg=message.hex())["mac"])

    results = HMAC.test_digest(digest, HMAC.Hash.SHA_256, compliance=True, resilience=True)

    total_failed = 0
    total_passed = 0
    for name, res in results.items():
        total_failed += res.valid.failed + res.invalid.failed
        total_passed += res.valid.passed
        print(f"\n  hmac-sha256/{name}: passed={res.valid.passed} failed={res.valid.failed}")

    assert total_failed == 0, f"HMAC-SHA256: {total_failed} vector(s) failed"
    assert total_passed == EXPECTED_HMAC_SHA256_VECTORS, (
        f"HMAC-SHA256: exercised {total_passed} vectors, expected "
        f"{EXPECTED_HMAC_SHA256_VECTORS}. Verify the new count by hand before updating."
    )
