"""Shamir secret sharing over GF(2^8) (SPEC §10.6.1) — mirrors src/core/shamir.ts.

The reference decoder only needs to RECOVER the 32-byte threshold secret `S` from
`k` shares in order to open a Mode B (non-possession) slot; `shamir_split` is
included for symmetry and cross-implementation tests. Below the threshold,
`shamir_recover` has no notion of `k` and interpolates the supplied shares to a
wrong value (zero information).

Share wire format (38 bytes): version[1] || index[1] || value[32] || checksum[4],
checksum = SHA-256(version||index||value)[0:4] (transcription detection only).
"""

from __future__ import annotations

import hashlib

from .gf256 import gf_add, gf_div, gf_mul

SHARE_VERSION = 1
SECRET_LEN = 32
SHARE_LEN = 1 + 1 + SECRET_LEN + 4
_SHARE_BODY_LEN = 1 + 1 + SECRET_LEN


class ShareChecksumError(Exception):
    """Raised when a share's checksum fails — a transcription error, not auth."""


def _checksum(body: bytes) -> bytes:
    return hashlib.sha256(body).digest()[:4]


def _eval_poly(coeffs: bytes, s0: int, x: int) -> int:
    acc = 0
    for c in reversed(coeffs):
        acc = gf_add(c, gf_mul(acc, x))
    return gf_add(s0, gf_mul(acc, x))


def serialize_share(index: int, value: bytes) -> bytes:
    if not (1 <= index <= 255):
        raise ValueError(f"share: index {index} out of range")
    if len(value) != SECRET_LEN:
        raise ValueError("share: bad value length")
    body = bytes([SHARE_VERSION, index]) + value
    return body + _checksum(body)


def parse_share(share: bytes) -> tuple[int, bytes]:
    if len(share) != SHARE_LEN:
        raise ValueError("share: bad length")
    if share[0] != SHARE_VERSION:
        raise ValueError(f"share: unsupported version {share[0]}")
    body = share[:_SHARE_BODY_LEN]
    if share[_SHARE_BODY_LEN:] != _checksum(body):
        raise ShareChecksumError("share checksum mismatch (likely a transcription error)")
    return share[1], share[2:_SHARE_BODY_LEN]


def shamir_split(secret: bytes, k: int, n: int) -> list[bytes]:
    if len(secret) != SECRET_LEN:
        raise ValueError("shamir: secret must be 32 bytes")
    if not (1 <= k <= n <= 255):
        raise ValueError(f"shamir: bad k/n ({k}/{n})")
    import os

    coeffs = [os.urandom(k - 1) for _ in range(SECRET_LEN)]
    shares: list[bytes] = []
    for index in range(1, n + 1):
        value = bytes(_eval_poly(coeffs[j], secret[j], index) for j in range(SECRET_LEN))
        shares.append(serialize_share(index, value))
    return shares


class ShareSetError(ValueError):
    """The shares to recover from are not a valid distinct set (e.g. duplicates)."""


def shamir_recover(shares: list[bytes]) -> bytes:
    """Lagrange interpolation at x=0 over the supplied shares. No notion of `k`."""
    if not shares:
        raise ValueError("shamir: no shares")
    parsed = [parse_share(s) for s in shares]
    xs = [p[0] for p in parsed]
    # Distinct, non-zero indices required: a repeated index zeroes a Lagrange
    # denominator term → a raw GF(256) division-by-zero. Fail clearly instead.
    if len(set(xs)) != len(xs):
        raise ShareSetError("duplicate shares: each share must have a distinct index")
    secret = bytearray(SECRET_LEN)
    for i in range(len(parsed)):
        num = 1
        den = 1
        for m in range(len(parsed)):
            if m == i:
                continue
            num = gf_mul(num, xs[m])
            den = gf_mul(den, gf_add(xs[i], xs[m]))
        li = gf_div(num, den)
        yi = parsed[i][1]
        for j in range(SECRET_LEN):
            secret[j] = gf_add(secret[j], gf_mul(yi[j], li))
    return bytes(secret)
