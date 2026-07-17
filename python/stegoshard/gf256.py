"""Arithmetic over GF(2^8) — the field used by the Reed-Solomon erasure coding.

Mirrors src/core/gf256.ts and SPEC.md §7.1:
  reducing polynomial 0x11D (x^8 + x^4 + x^3 + x^2 + 1), generator 0x02.
"""

POLY = 0x11D
GENERATOR = 0x02

_EXP = [0] * 512
_LOG = [0] * 256


def _mul_no_table(a: int, b: int) -> int:
    """Carry-less multiply with polynomial reduction (only used to seed tables)."""
    result = 0
    while b > 0:
        if b & 1:
            result ^= a
        b >>= 1
        a <<= 1
        if a & 0x100:
            a ^= POLY
    return result & 0xFF


def _build_tables() -> None:
    x = 1
    for i in range(255):
        _EXP[i] = x
        _LOG[x] = i
        x = _mul_no_table(x, GENERATOR)
    for i in range(255, 512):
        _EXP[i] = _EXP[i - 255]


_build_tables()


def gf_add(a: int, b: int) -> int:
    return (a ^ b) & 0xFF


def gf_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _EXP[_LOG[a] + _LOG[b]]


def gf_inv(a: int) -> int:
    if a == 0:
        raise ValueError("GF(256): 0 has no multiplicative inverse")
    return _EXP[255 - _LOG[a]]


def gf_div(a: int, b: int) -> int:
    if b == 0:
        raise ValueError("GF(256): division by zero")
    if a == 0:
        return 0
    return _EXP[(_LOG[a] - _LOG[b] + 255) % 255]
